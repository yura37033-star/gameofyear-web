// Economy of package B (DEMO_PLAN.md section 24). Pure functions: no DOM, no storage, no clock, no randomness.
// A current wallet is { v: 2, coins, stock: { hammer, arrow, cannon, areaHammer } }. Every function returns a new object
// and never changes its arguments, so the page can keep the old wallet until the new one is saved.
//
// Rules (approved by the owner, November 18): coins are paid once when a game ends (a loss, or a replacement through
// "Нова гра"): 5 per full 100 points plus 10 per full 1000. A new player gets 200 coins and 3 hammer charges, once.
// A game takes at most 2 tool kinds and at most 6 charges in total, chosen by the player (zero tools is allowed). Unused
// charges go back to the stock when the game ends. Charges are bought one at a time; at the stock limit nothing is sold.
import { MAX_TOOL_CARRY, MAX_TOOL_KINDS, TOOL_ORDER } from './core/game.mjs?v=a2-858196272c';

export const WALLET_VERSION = 2;
export const TOOL_KINDS = TOOL_ORDER; // slot order is always hammer, arrow, cannon, area hammer
export const PRICES = Object.freeze({ hammer: 50, arrow: 150, cannon: 150, areaHammer: 200 });
export const STOCK_LIMITS = Object.freeze({ hammer: 10, arrow: 6, cannon: 6, areaHammer: 3 });
export const MAX_CARRY = MAX_TOOL_CARRY;
export const MAX_KINDS = MAX_TOOL_KINDS;
export const STARTER = Object.freeze({ coins: 200, stock: Object.freeze({ hammer: 3, arrow: 0, cannon: 0, areaHammer: 0 }) });
export const MAX_COINS = 1_000_000_000; // far above any real wallet; keeps every sum a safe integer
const LEGACY_WALLET_VERSION = 1;
const LEGACY_TOOL_KINDS = Object.freeze(['hammer', 'arrow', 'cannon']);
const LEGACY_STOCK_LIMITS = Object.freeze({ hammer: 10, arrow: 6, cannon: 6 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const isKind = (kind) => typeof kind === 'string' && Object.hasOwn(PRICES, kind);
const copyWallet = (wallet) => ({ v: WALLET_VERSION, coins: wallet.coins, stock: { hammer: wallet.stock.hammer, arrow: wallet.stock.arrow, cannon: wallet.stock.cannon, areaHammer: wallet.stock.areaHammer } });
const fail = (reason) => ({ ok: false, reason });

// 5 per full 100 points plus 10 per full 1000 (4730 points: 235 + 40 = 275). Anything that is not a score pays nothing.
export function coinsForScore(score) {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0) return 0;
  const points = Math.floor(score);
  return Math.floor(points / 100) * 5 + Math.floor(points / 1000) * 10;
}

export function createStarterWallet() {
  return { v: WALLET_VERSION, coins: STARTER.coins, stock: { ...STARTER.stock } };
}

// { ok: true } or { ok: false, reason }. Strict: exact keys, integers, coins 0..MAX_COINS, stock 0..limit of each kind.
// Reasons: wallet, wallet-key, wallet-version, coins, stock, stock-key, stock-count.
export function validateWallet(value) {
  if (!isObject(value)) return fail('wallet');
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['v', 'coins', 'stock'].every((key) => Object.hasOwn(value, key))) return fail('wallet-key');
  if (value.v !== WALLET_VERSION) return fail('wallet-version');
  if (!isCount(value.coins, MAX_COINS)) return fail('coins');
  if (!isObject(value.stock)) return fail('stock');
  const stockKeys = Object.keys(value.stock);
  if (stockKeys.length !== TOOL_KINDS.length || !TOOL_KINDS.every((kind) => Object.hasOwn(value.stock, kind))) return fail('stock-key');
  if (!TOOL_KINDS.every((kind) => isCount(value.stock[kind], STOCK_LIMITS[kind]))) return fail('stock-count');
  return { ok: true };
}

function validateLegacyWallet(value) {
  if (!isObject(value)) return fail('wallet');
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['v', 'coins', 'stock'].every((key) => Object.hasOwn(value, key))) return fail('wallet-key');
  if (value.v !== LEGACY_WALLET_VERSION) return fail('wallet-version');
  if (!isCount(value.coins, MAX_COINS)) return fail('coins');
  if (!isObject(value.stock)) return fail('stock');
  const stockKeys = Object.keys(value.stock);
  if (stockKeys.length !== LEGACY_TOOL_KINDS.length || !LEGACY_TOOL_KINDS.every((kind) => Object.hasOwn(value.stock, kind))) return fail('stock-key');
  if (!LEGACY_TOOL_KINDS.every((kind) => isCount(value.stock[kind], LEGACY_STOCK_LIMITS[kind]))) return fail('stock-count');
  return { ok: true };
}

// A value read back from storage (already JSON-parsed) becomes { ok: true, wallet } with fresh objects, or { ok: false, reason }.
export function parseWallet(value) {
  if (isObject(value) && value.v === LEGACY_WALLET_VERSION) {
    const checked = validateLegacyWallet(value);
    if (!checked.ok) return checked;
    return {
      ok: true,
      migrated: true,
      wallet: { v: WALLET_VERSION, coins: value.coins, stock: { ...value.stock, areaHammer: 0 } },
    };
  }
  const checked = validateWallet(value);
  return checked.ok ? { ok: true, wallet: copyWallet(value) } : checked;
}

// The plain record to save under kr.wallet.v2. A wallet that is not valid is a programming error, so this throws.
export function serializeWallet(wallet) {
  const checked = validateWallet(wallet);
  if (!checked.ok) throw new RangeError(`Invalid wallet: ${checked.reason}`);
  return copyWallet(wallet);
}

// Buys one charge: { ok: true, wallet } or { ok: false, reason: 'unknown-kind' | 'at-limit' | 'no-coins' | 'invalid-wallet' }.
export function buyCharge(wallet, kind) {
  if (!validateWallet(wallet).ok) return fail('invalid-wallet');
  if (!isKind(kind)) return fail('unknown-kind');
  if (wallet.stock[kind] >= STOCK_LIMITS[kind]) return fail('at-limit');
  if (wallet.coins < PRICES[kind]) return fail('no-coins');
  const next = copyWallet(wallet);
  next.coins -= PRICES[kind];
  next.stock[kind] += 1;
  return { ok: true, wallet: next };
}

// Chooses the charges that go into a game. `picks` is { kind: count }; a count of 0 means "not chosen" and is ignored.
// Success: { ok: true, wallet, tools } where wallet is the stock after taking and tools is the slot list for createGame, in
// the fixed order hammer, arrow, cannon, areaHammer, every slot with at least one charge. The game is not started and nothing is saved:
// the page saves `wallet` first and only then starts the game.
// Failure reasons: invalid-wallet, invalid-picks (not an object), unknown-kind, invalid-count (not an integer 0..6),
// too-many-kinds (more than 2 kinds), too-many-charges (more than 6 together), not-in-stock (more than the stock holds).
export function planLoadout(wallet, picks) {
  if (!validateWallet(wallet).ok) return fail('invalid-wallet');
  if (!isObject(picks)) return fail('invalid-picks');
  const entries = Object.entries(picks);
  if (entries.some(([kind]) => !isKind(kind))) return fail('unknown-kind');
  if (entries.some(([, count]) => !isCount(count, MAX_CARRY))) return fail('invalid-count');
  const chosen = TOOL_KINDS.filter((kind) => Object.hasOwn(picks, kind) && picks[kind] > 0);
  if (chosen.length > MAX_KINDS) return fail('too-many-kinds');
  if (chosen.reduce((sum, kind) => sum + picks[kind], 0) > MAX_CARRY) return fail('too-many-charges');
  if (chosen.some((kind) => picks[kind] > wallet.stock[kind])) return fail('not-in-stock');
  const next = copyWallet(wallet);
  for (const kind of chosen) next.stock[kind] -= picks[kind];
  return { ok: true, wallet: next, tools: chosen.map((kind) => ({ kind, charges: picks[kind] })) };
}

// Same check and result as planLoadout. The name marks the moment of commitment: the page calls planLoadout while the
// player adjusts the numbers and takeLoadout when the game starts.
export function takeLoadout(wallet, picks) {
  return planLoadout(wallet, picks);
}

// Closes a game: unused charges return to the stock (never above the stock limit) and the coins for `score` are added
// (never above MAX_COINS). Returns { wallet, coins } with the coins earned by this game. Slots that are not valid
// ({ kind, charges } with a known kind and an integer charge count) are ignored. The caller must pay each game only once;
// the saved game record carries `coinsPaid` for that.
export function settleGame(wallet, tools, score) {
  const parsed = parseWallet(wallet);
  if (!parsed.ok) throw new RangeError(`Invalid wallet: ${parsed.reason}`);
  const next = parsed.wallet;
  if (Array.isArray(tools)) {
    for (const slot of tools) {
      if (!isObject(slot) || !isKind(slot.kind) || !isCount(slot.charges, MAX_CARRY)) continue;
      next.stock[slot.kind] = Math.min(STOCK_LIMITS[slot.kind], next.stock[slot.kind] + slot.charges);
    }
  }
  const coins = Math.min(coinsForScore(score), MAX_COINS - next.coins);
  next.coins += coins;
  return { wallet: next, coins };
}
