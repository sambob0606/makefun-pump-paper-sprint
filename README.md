# makefun-pump-paper-sprint

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sambob0606/makefun-pump-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/sambob0606/makefun-pump-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch-sniper paper-trading bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 in USDC). It watches each new pump.fun coin's opening tape and buys 0.05 SOL only when the launch looks clean — small creator buy, no creator sell, at least 3 distinct buyers, sells at most 20% of buys, net inflow of at least 0.3 SOL — then exits on take-profit +15%, stop-loss -10%, a 12% trailing stop, a 200-slot max hold, or a creator sell.

## Run it

The grader runs the bot as `node /bot/main.ts`; it speaks the agent-fun/replay/v2 protocol on stdin/stdout. Grade it locally with the bounty kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

Dev-window grade: net PnL -0.391 SOL over 231 coins (231 round trips, win rate 14.3%, max drawdown 4.1%), guardrails met, deterministic across replays.

---

<sub>Entered on [make.fun](https://make.fun/?ref=w3shbtmr&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
