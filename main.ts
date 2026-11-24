// Pump.fun paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win".
//
// Strategy: launch sniper. A coin becomes a candidate on its CreateEvent. Within its first
// 8 slots we watch its opening tape: we buy only when the launch looks clean — the creator
// bought at most 5 SOL and has not sold, at least 4 distinct non-creator buyers showed up,
// other sellers sold at most 20% of what buyers bought, net inflow is at least 0.3 SOL,
// the curve holds 1-30 real SOL, and the price sits within -10% / +50% of its create price.
// One 0.05 SOL buy per coin, never more than 5 open positions.
//
// Exits (checked every batch on the position's cost basis, fees included): take profit at
// +15%, stop loss at -10%, an 8% trailing stop once the position is up 10%, a 200-slot max
// hold, and an immediate exit if the creator sells after we bought. If the sniper filter
// starves us (fewer than 20 round trips after 3000 batches), small 0.02 SOL probes on
// creator-clean coins that failed the full filter keep the 20-coin guardrail in reach.
//
// Deterministic: insertion-ordered maps only, no clock, no randomness, no environment.
// The harness replays the bot twice and the two action logs must match byte for byte.
//
// Performance (round-2 fix for a dev-phase run_completes timeout): the per-batch work
// is O(coins in their 8-slot decision window), not O(every coin ever created) —
// decided tapes leave the pending set and are pruned from the tape map unless held
// or kept as a guardrail probe, and each curve's price is computed once per batch
// and cached. The dev window grades identically to before the fix (same
// result_sha256), only faster; the timeout was most likely grader-side load, but
// the final 6-hour window carries ~4x the dev window's events, where the old
// quadratic scan would have cost ~16x the bot time.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n
const STAKE = SOL / 20n; // 0.05 SOL per sniper buy
const PROBE_STAKE = SOL / 50n; // 0.02 SOL per guardrail probe
const MIN_BUY = SOL / 100n; // 0.01 SOL: a round trip below this does not count
const MAX_SLIPPAGE_BPS = 10_000;

const ENTRY_MAX_AGE_SLOTS = 8; // reverted: the 12-slot window admitted 4 extra coins and lost 0.017 SOL more on dev
const CREATOR_MAX_BUY_SOL = 5n * SOL;
const MIN_BUYERS = 4; // distinct non-creator buyers required — one more buyer filters weaker launches
const MAX_SELL_SHARE_BPS = 2_000; // others' sells at most 20% of buys
const MIN_NET_INFLOW = (3n * SOL) / 10n; // 0.3 SOL
const MIN_REAL_SOL = SOL; // 1 SOL
const MAX_REAL_SOL = 30n * SOL;
const PRICE_LOW_BPS = 9_000; // -10% vs create price
const PRICE_HIGH_BPS = 15_000; // +50% vs create price

const TAKE_PROFIT_BPS = 11_500; // +15% on cost
const STOP_LOSS_BPS = 9_000; // -10% on cost
const TRAIL_TRIGGER_BPS = 11_000; // trailing arms once up 10%
const TRAIL_DROP_BPS = 9_200; // sell 8% below the peak value
const MAX_HOLD_SLOTS = 200;

const PROBE_AFTER_BATCHES = 3_000;
const PROBE_EVERY_BATCHES = 20;

/** Opening tape of one coin, from its own CreateEvent and TradeEvents. */
interface Tape {
  creator: string;
  createdSlot: number;
  createPrice: number; // SOL per token at creation (virtual reserves ratio)
  buyers: Set<string>;
  creatorBuySol: bigint;
  creatorSold: boolean;
  buySol: bigint;
  sellSol: bigint;
  decided: boolean;
}

/** A position we hold, with the exit bookkeeping the harness does not keep. */
interface Held {
  mint: string;
  entrySlot: number;
  costSol: number; // SOL spent on the tokens still held, fees included
  peakSol: number; // highest marked value since entry, in SOL
  creatorSoldAfterBuy: boolean;
}

/** Price of one token in SOL from a curve's virtual reserves, cached per batch:
 * the same curve is priced once for the exit check, once for the entry filter and
 * once when a new position is recorded, and the BigInt->Number division is the most
 * expensive arithmetic in the hot path. Cleared at the top of every onBatch, so a
 * cached price never survives into a batch with newer reserves. */
const priceCache = new Map<string, number>();
function priceSol(mint: string, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  const cached = priceCache.get(mint);
  if (cached !== undefined) return cached;
  const price = curve.virtual_token_reserves === 0n
    ? 0
    : Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
  priceCache.set(mint, price);
  return price;
}

/** Marked value of a holding in SOL at the curve's current price. */
function valueSol(tokens: bigint, mint: string, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): number {
  return Number(tokens) * priceSol(mint, curve);
}

const tapes = new Map<string, Tape>();
// Undecided coins only: the entries loop scans this map every batch, so keeping
// decided coins out of it keeps the per-batch scan O(coins inside their 8-slot
// decision window) instead of O(every coin ever created) — the difference between
// finishing the 6-hour final window and timing out in the grader's 1800 s budget.
const pending = new Map<string, Tape>();
const held = new Map<string, Held>();
const probePool = new Map<string, Tape>(); // creator-clean coins that failed the sniper filter
let batchesSeen = 0;
let roundTrips = 0;
let lastProbeBatch = -PROBE_EVERY_BATCHES;

/** Fold this batch's events into the per-mint tapes. */
function updateTapes(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      const createPrice = e.virtual_token_reserves === '0'
        ? 0
        : Number(BigInt(e.virtual_quote_reserves)) / Number(BigInt(e.virtual_token_reserves));
      const tape: Tape = {
        creator: e.creator,
        createdSlot: e.slot,
        createPrice,
        buyers: new Set<string>(),
        creatorBuySol: 0n,
        creatorSold: false,
        buySol: 0n,
        sellSol: 0n,
        decided: false,
      };
      tapes.set(e.mint, tape);
      pending.set(e.mint, tape);
    } else if (e.event === 'TradeEvent') {
      const tape = tapes.get(e.mint);
      if (tape === undefined) continue;
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) {
        tape.buySol += sol;
        if (e.user === tape.creator) {
          tape.creatorBuySol += sol;
        } else {
          tape.buyers.add(e.user);
        }
      } else {
        tape.sellSol += sol;
        if (e.user === tape.creator) tape.creatorSold = true;
      }
      const h = held.get(e.mint);
      if (h !== undefined && e.user === tape.creator && !e.is_buy && e.slot > h.entrySlot) {
        h.creatorSoldAfterBuy = true;
      }
    }
  }
}

/** True when the opening tape passes every sniper filter. */
function tapeIsClean(tape: Tape, mint: string, curve: { real_quote_reserves: bigint }): boolean {
  if (tape.creatorBuySol > CREATOR_MAX_BUY_SOL) return false;
  if (tape.creatorSold) return false;
  if (tape.buyers.size < MIN_BUYERS) return false;
  if (tape.buySol === 0n) return false;
  if (tape.sellSol * 10_000n > tape.buySol * BigInt(MAX_SELL_SHARE_BPS)) return false;
  if (tape.buySol - tape.sellSol < MIN_NET_INFLOW) return false;
  const realSol = curve.real_quote_reserves;
  if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) return false;
  if (tape.createPrice <= 0) return false;
  const now = priceSol(mint, curve);
  const low = (tape.createPrice * PRICE_LOW_BPS) / 10_000;
  const high = (tape.createPrice * PRICE_HIGH_BPS) / 10_000;
  if (now < low || now > high) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    batchesSeen += 1;
    priceCache.clear();
    updateTapes(batch);

    // Sync exit bookkeeping with the account: a position the harness closed
    // (curve completed, replay flattened) leaves our book, and its tape — decided,
    // never traded again — leaves with it. No array copy: deleting from a Map
    // while iterating its keys is safe.
    for (const mint of held.keys()) {
      if (!state.positions.has(mint)) {
        held.delete(mint);
        tapes.delete(mint);
      }
    }
    // Count round trips from our own sell fills.
    for (const f of batch.fills) {
      if (f.side === 'sell' && f.status === 'filled' && !f.client_id.startsWith('_')) roundTrips += 1;
    }

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }

    const tryBuy = (mint: string, amount: bigint): void => {
      if (orders.length >= maxOrders || slots <= 0) return;
      if (state.positions.has(mint)) return;
      if (free < amount + tx) return;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY) return;
      const spend = amount < cap ? amount : cap;
      if (spend < MIN_BUY) return;
      const buy: BuyInput = { side: 'buy', mint, quote_lamports: spend, max_slippage_bps: MAX_SLIPPAGE_BPS };
      orders.push(buy);
      free -= spend + tx;
      slots -= 1;
    };

    // --- exits first: a coin we hold gets sold on TP / SL / trailing / hold / creator-sell.
    for (const [mint, h] of held) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined || curve === undefined || curve.complete) continue;
      const value = valueSol(pos.token_amount, mint, curve);
      if (value > h.peakSol) h.peakSol = value;
      const cost = h.costSol > 0 ? h.costSol : Number(pos.cost_lamports) / 1e9;
      const sellAll =
        value >= (cost * TAKE_PROFIT_BPS) / 10_000 ||
        value <= (cost * STOP_LOSS_BPS) / 10_000 ||
        (h.peakSol >= (cost * TRAIL_TRIGGER_BPS) / 10_000 && value <= (h.peakSol * TRAIL_DROP_BPS) / 10_000) ||
        batch.slot - h.entrySlot >= MAX_HOLD_SLOTS ||
        h.creatorSoldAfterBuy;
      if (!sellAll) continue;
      const sell: SellInput = { side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: MAX_SLIPPAGE_BPS };
      orders.push(sell);
      pendingSell.add(mint);
    }

    // --- entries: decide each undecided candidate once, inside its first 8 slots.
    // Only pending (undecided) tapes are scanned; a decided tape leaves pending, and
    // leaves tapes too unless it is bought (creator-sell tracking needs it) or kept
    // as a guardrail probe (its tape must keep folding trades). This keeps tapes
    // bounded to the live decision window + held + probe coins instead of growing
    // with every coin the replay ever created.
    for (const [mint, tape] of pending) {
      if (orders.length >= maxOrders || slots <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        tape.decided = true;
        pending.delete(mint);
        tapes.delete(mint);
        continue;
      }
      const age = batch.slot - tape.createdSlot;
      if (age > ENTRY_MAX_AGE_SLOTS) {
        tape.decided = true;
        pending.delete(mint);
        // Creator-clean coins that failed the full filter stay available as probes.
        if (tape.creatorBuySol <= CREATOR_MAX_BUY_SOL && !tape.creatorSold && tape.buyers.size >= 2) {
          probePool.set(mint, tape);
        } else {
          tapes.delete(mint);
        }
        continue;
      }
      if (!tapeIsClean(tape, mint, curve)) continue;
      tape.decided = true;
      pending.delete(mint);
      tryBuy(mint, STAKE);
    }

    // Once 20 round trips are banked the guardrail is met for good, so the probe
    // pool is dead state: drop it (and its tapes) instead of carrying it to the
    // end of the window. Probes can never fire again after this point, so the
    // trading behaviour is unchanged.
    if (roundTrips >= 20 && probePool.size > 0) {
      for (const mint of probePool.keys()) tapes.delete(mint);
      probePool.clear();
    }
    // --- guardrail probes: only while under 20 round trips, at most one per 20 batches.
    if (
      roundTrips < 20 &&
      batchesSeen > PROBE_AFTER_BATCHES &&
      batchesSeen - lastProbeBatch >= PROBE_EVERY_BATCHES &&
      orders.length < maxOrders &&
      slots > 0
    ) {
      for (const [mint, tape] of probePool) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || state.positions.has(mint)) {
          probePool.delete(mint);
          // Only drop the tape when we hold nothing on it: a held coin's tape
          // still feeds the creator-sell exit.
          if (!state.positions.has(mint)) tapes.delete(mint);
          continue;
        }
        if (tape.creatorSold) {
          probePool.delete(mint);
          tapes.delete(mint);
          continue;
        }
        tryBuy(mint, PROBE_STAKE);
        lastProbeBatch = batchesSeen;
        probePool.delete(mint);
        break;
      }
    }

    // --- record entries for the exit bookkeeping on the next batch.
    // A buy decided now fills two slots later; the position shows up in
    // state.positions then, and onBatch picks it up below on that batch.
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const curve = state.curves.get(mint);
        const cost = Number(pos.cost_lamports) / 1e9;
        const value = curve === undefined ? cost : valueSol(pos.token_amount, mint, curve);
        held.set(mint, { mint, entrySlot: batch.slot, costSol: cost, peakSol: value, creatorSoldAfterBuy: false });
      } else {
        const h = held.get(mint);
        if (h !== undefined) h.costSol = Number(pos.cost_lamports) / 1e9;
      }
    }

    return orders;
  },
});
