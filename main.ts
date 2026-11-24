// Pump.fun Paper Sprint — momentum trend-follower, v3 (LONG ONLY).
// Protocol: agent-fun/replay/v2 — NDJSON on stdin (hello, batch, done),
// one {"type":"reply","seq":N,"orders":[...]} per batch on stdout.
// Price per mint = virtual quote reserves / virtual token reserves
// (lamports of SOL per token), from each batch's marks, falling back to
// the latest TradeEvent reserves for that mint.
// One batch arrives per slot that carries universe records, so all
// lookbacks below are measured in SLOTS (~2.5 slots per second).
// v2 lesson (dev grade): the buy filter was far too strict — only
// 5 round trips in 24h, below the 20-coin guardrail — and orders sized
// blind at 0.25 SOL were rejected against small real reserves. v3:
// looser momentum gates, a fresh-spike trigger for young runners, and
// sizing from each mint's tracked real reserves (small when unknown).
// (v4 tried tighter exits + smaller size: PnL improved to -0.21 SOL
// but coin count collapsed to exactly 20 — too close to the guardrail
// for the 6h final window — so v4 was reverted to these v3 values.)
// Strategy: buy a young coin ONCE, only while it is rising; sell on
// take-profit, stop-loss, a max hold, or completion. Never re-buy a
// mint we already traded.
// Deterministic: no randomness, no clock, no network. Fixed thresholds,
// mints processed in sorted order.

import * as readline from "node:readline";

const BUY_LAMPORTS = 150_000_000; // 0.15 SOL per buy (>= 0.01 SOL round-trip gate).
const SMALL_BUY_LAMPORTS = 50_000_000; // 0.05 SOL when real reserves unknown.
const MAX_SLIPPAGE_BPS = 500;
const MOMENTUM_LONG_SLOTS = 375; // ~2.5 min
const MOMENTUM_SHORT_SLOTS = 150; // ~1 min
const MOMENTUM_LONG_MIN = 0.05; // +5% over the long window to buy
const MOMENTUM_SHORT_MIN = 0.0; // flat-or-better over the short window
const SPIKE_MIN = 0.15; // +15% from first price: fresh-spike trigger
const SPIKE_MAX_AGE_SLOTS = 1500; // fresh spikes only within ~10 min
const MAX_AGE_SLOTS = 18000; // only buy coins first seen within ~2 hours
const MIN_HISTORY = 5; // observations before a mint is buyable
const TAKE_PROFIT = 0.4; // +40% from entry
const STOP_LOSS = -0.12; // -12% from entry
const MAX_HOLD_SLOTS = 3600; // ~24 min, then exit
const MAX_POSITIONS_FALLBACK = 5;
const MAX_ORDERS_FALLBACK = 16;
const ORDER_CAP_BPS = 90; // stay under the 100 bps of real reserve cap
const HISTORY_CAP = 96; // price samples kept per mint

interface Sample {
  slot: number;
  price: number;
}

interface Coin {
  price: number;
  realQuote: number; // latest real quote reserves (lamports), 0 if unknown
  firstSlot: number;
  firstPrice: number;
  seen: number;
  history: Sample[]; // (slot, price), oldest first, one per batch observed
  entryPrice: number; // our cost per token, 0 when flat
  entrySlot: number;
}

const coins = new Map<string, Coin>();
const everBought = new Set<string>();
let maxOpenPositions = MAX_POSITIONS_FALLBACK;
let maxOrdersPerBatch = MAX_ORDERS_FALLBACK;
let cashLamports = 10_000_000_000;
let orderCounter = 0;

function coinFor(mint: string, slot: number, price: number): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      price: 0,
      realQuote: 0,
      firstSlot: slot,
      firstPrice: price,
      seen: 0,
      history: [],
      entryPrice: 0,
      entrySlot: 0,
    };
    coins.set(mint, c);
  }
  return c;
}

// One observation per mint per batch. History is slot-stamped so lookbacks
// are time-based even when a mint is marked irregularly.
function observe(
  mint: string,
  price: number,
  realQuote: number,
  slot: number,
): void {
  if (!(price > 0) || !Number.isFinite(price)) return;
  const c = coinFor(mint, slot, price);
  c.price = price;
  if (realQuote > 0) c.realQuote = realQuote;
  c.seen += 1;
  const last = c.history[c.history.length - 1];
  if (!last || last.slot !== slot) {
    c.history.push({ slot, price });
    if (c.history.length > HISTORY_CAP) c.history.shift();
  } else {
    last.price = price;
  }
}

// Price at or before (slot - back): the newest sample no later than that.
function priceBack(c: Coin, slot: number, back: number): number {
  const target = slot - back;
  for (let i = c.history.length - 1; i >= 0; i--) {
    if (c.history[i].slot <= target) return c.history[i].price;
  }
  return 0;
}

function reply(seq: number, orders: unknown[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function handleBatch(msg: any): void {
  const seq: number = msg.seq;
  const slot: number = msg.slot;
  const orders: any[] = [];
  const seenThisBatch = new Set<string>();

  // 1. Marks first: the freshest reserves per mint this batch.
  const marks: any[] = Array.isArray(msg.marks) ? msg.marks : [];
  for (const m of marks) {
    if (typeof m.mint !== "string") continue;
    const vt = Number(m.virtual_token_reserves);
    const vq = Number(m.virtual_quote_reserves);
    if (vt > 0 && vq > 0) {
      observe(m.mint, vq / vt, Number(m.real_quote_reserves ?? "0"), slot);
      seenThisBatch.add(m.mint);
    }
  }
  // 2. TradeEvents for mints with no mark this batch (latest event wins).
  const events: any[] = Array.isArray(msg.events) ? msg.events : [];
  const completed = new Set<string>();
  for (const e of events) {
    if (!e || typeof e.mint !== "string") continue;
    if (e.event === "CompleteEvent") {
      completed.add(e.mint);
      continue;
    }
    if (e.event !== "TradeEvent") continue;
    if (seenThisBatch.has(e.mint)) continue;
    const vt = Number(e.virtual_token_reserves);
    const vs = Number(e.virtual_sol_reserves);
    if (vt > 0 && vs > 0) {
      observe(e.mint, vs / vt, Number(e.real_sol_reserves ?? "0"), slot);
      seenThisBatch.add(e.mint);
    }
  }

  // 3. Positions as the harness reports them (source of truth).
  const account = msg.account ?? { cash_lamports: "0", positions: [] };
  cashLamports = Number(account.cash_lamports ?? "0");
  const positions: any[] = Array.isArray(account.positions) ? account.positions : [];
  const held = new Map<string, bigint>();
  for (const p of positions) {
    if (typeof p.mint === "string") held.set(p.mint, BigInt(p.token_amount ?? "0"));
  }

  // 4. Fills: refresh entry prices from our own buy fills.
  const fills: any[] = Array.isArray(msg.fills) ? msg.fills : [];
  for (const f of fills) {
    if (!f || f.status !== "filled" || f.side !== "buy") continue;
    const c = coins.get(f.mint);
    if (!c) continue;
    const quote = Number(f.quote_lamports ?? "0");
    const tokens = Number(f.token_amount ?? "0");
    if (quote > 0 && tokens > 0) {
      c.entryPrice = quote / tokens;
      c.entrySlot = slot;
    }
  }

  // 5. Sells first: take-profit, stop-loss, max hold, completion.
  const sellMints = [...held.keys()].sort();
  for (const mint of sellMints) {
    if (orders.length >= maxOrdersPerBatch) break;
    const tokens = held.get(mint) ?? 0n;
    if (tokens <= 0n) continue;
    const c = coins.get(mint);
    if (!c || !(c.price > 0)) continue;
    let sell = false;
    if (completed.has(mint)) sell = true;
    if (c.entryPrice > 0) {
      const ret = c.price / c.entryPrice - 1;
      if (ret <= STOP_LOSS || ret >= TAKE_PROFIT) sell = true;
    }
    if (c.entrySlot > 0 && slot - c.entrySlot >= MAX_HOLD_SLOTS) sell = true;
    if (sell) {
      orderCounter += 1;
      orders.push({
        side: "sell",
        client_id: `s-${seq}-${orderCounter}`,
        mint,
        token_amount: tokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      held.delete(mint);
      c.entryPrice = 0;
      c.entrySlot = 0;
    }
  }

  // 6. Buys: young coin, rising on both windows or a fresh spike,
  // never bought before.
  const freeSlots = maxOpenPositions - held.size;
  if (freeSlots > 0 && cashLamports > BUY_LAMPORTS) {
    const candidates: { mint: string; mom: number }[] = [];
    for (const mint of [...coins.keys()].sort()) {
      if (held.has(mint)) continue;
      if (everBought.has(mint)) continue;
      const c = coins.get(mint)!;
      if (c.seen < MIN_HISTORY) continue;
      if (slot - c.firstSlot > MAX_AGE_SLOTS) continue;
      if (!(c.price > 0) || !(c.firstPrice > 0)) continue;
      const longAgo = priceBack(c, slot, MOMENTUM_LONG_SLOTS);
      const shortAgo = priceBack(c, slot, MOMENTUM_SHORT_SLOTS);
      const momLong = longAgo > 0 ? c.price / longAgo - 1 : 0;
      const momShort = shortAgo > 0 ? c.price / shortAgo - 1 : 0;
      const spike = c.price / c.firstPrice - 1;
      const momentumOk =
        longAgo > 0 &&
        shortAgo > 0 &&
        momLong >= MOMENTUM_LONG_MIN &&
        momShort >= MOMENTUM_SHORT_MIN;
      const spikeOk =
        slot - c.firstSlot <= SPIKE_MAX_AGE_SLOTS && spike >= SPIKE_MIN;
      if (!momentumOk && !spikeOk) continue;
      candidates.push({ mint, mom: Math.max(momLong, spike) });
    }
    // Strongest move first; deterministic tie-break by mint.
    candidates.sort((a, b) => b.mom - a.mom || (a.mint < b.mint ? -1 : 1));
    for (const cand of candidates) {
      if (orders.length >= maxOrdersPerBatch) break;
      if (held.size >= maxOpenPositions) break;
      if (cashLamports <= BUY_LAMPORTS) break;
      const c = coins.get(cand.mint)!;
      // Size from the mint's tracked real reserves; small when unknown.
      let size = c.realQuote > 0 ? BUY_LAMPORTS : SMALL_BUY_LAMPORTS;
      if (c.realQuote > 0) {
        const cap = Math.floor((c.realQuote * ORDER_CAP_BPS) / 10000);
        if (cap < size) size = cap;
      }
      if (size < 10_000_000) continue; // keep every round trip >= 0.01 SOL
      if (size > cashLamports) continue;
      orderCounter += 1;
      orders.push({
        side: "buy",
        client_id: `b-${seq}-${orderCounter}`,
        mint: cand.mint,
        quote_lamports: String(size),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      held.set(cand.mint, 0n); // reserve the slot for this batch
      everBought.add(cand.mint);
      cashLamports -= size;
      c.entryPrice = c.price; // provisional; corrected by the fill
      c.entrySlot = slot;
    }
  }

  reply(seq, orders);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    if (msg.caps) {
      if (typeof msg.caps.max_open_positions === "number") {
        maxOpenPositions = msg.caps.max_open_positions;
      }
      if (typeof msg.caps.max_orders_per_batch === "number") {
        maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      }
    }
    if (msg.capital && typeof msg.capital.lamports === "string") {
      cashLamports = Number(msg.capital.lamports);
    }
    return; // hello takes no reply
  }
  if (msg.type === "batch") {
    handleBatch(msg);
    return;
  }
  if (msg.type === "done") {
    rl.close();
    process.exit(0);
  }
});
