# Pump Sprint — Momentum Paper Trader

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Wanxt27/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Wanxt27/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Referral code: `qzc860x6`

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program, `main.ts` (Node 22), speaking the `agent-fun/replay/v2` protocol: it reads `hello` / `batch` / `done` NDJSON on stdin and answers each batch with one `reply` carrying its orders. Paper trading only — no real funds, ever.

## Strategy

Long-only momentum trend-follower, one buy per mint, ever:

- **Price** per mint = virtual quote reserves / virtual token reserves, from each batch's `marks` (falling back to the latest `TradeEvent`).
- **Buy** a young coin (first seen within ~2 hours) when it is rising: +5% over the last ~2.5 min (375 slots) and flat-or-better over the last ~1 min (150 slots) — or a fresh spike of +15% from its first price within ~10 min of first sight.
- **Size** 0.15 SOL per buy (0.05 SOL when the mint's real reserves are unknown), always capped under 100 bps of the mint's real quote reserves, never below the 0.01 SOL round-trip gate.
- **Sell** on take-profit +40%, stop-loss −12%, a ~24 min max hold, or a `CompleteEvent`.
- **Never re-buys** a mint it already traded, and never shorts. Deterministic: no randomness, no clock, no network; mints processed in sorted order.

## Dev grade (kit's `grade-local`, `--driver process`)

- Net PnL **−0.914 SOL** on the 24 h dev window (90% interval −1.57 … −0.34 SOL), return −9.1%
- **112 coins** traded, 112 round trips (≥ 0.01 SOL each), 219 fills, win rate 17.9%
- Max drawdown **9.1%** — guardrails met (≥ 20 coins, drawdown ≤ 50%)
- Two executions reproduce byte for byte (deterministic)
- Fees: 0.199 SOL curve + 0.024 SOL tx; net PnL at 2× fees −1.124 SOL

The dev window is a hard tape for momentum (most coins fade after their first spike), so the bot is built to survive it with a small drawdown and a wide coin count rather than to chase a single runner.

## Run

```sh
node main.ts  # reads agent-fun/replay/v2 NDJSON on stdin, replies on stdout
```

## License

MIT — see [LICENSE](LICENSE).
