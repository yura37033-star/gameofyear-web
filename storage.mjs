// localStorage adapter for P1 (PERSISTENCE_PLAN.md). Every browser call is wrapped in
// try/catch (private mode, quota, disabled storage). When the browser store fails, values stay
// in a memory fallback so the game keeps working; `available` is false when the store cannot
// be probed or read, and `onUnavailable` fires once on the first failure (read, write or quota).
// Operations run strictly in call order (one queue); a snapshot is serialized at call time, so a later save always wins and a stale one can never overwrite it.

export const STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game', journal: 'kr.journal' });
export const HAMMER_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.hammer', journal: 'kr.journal.hammer' });
export const RULES_V2_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.hammer.v2', journal: 'kr.journal.hammer.v2' });
export const RULES_V3_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.tools.v3', journal: 'kr.journal.tools.v3' });
// Economy (rules 4): a game and its journal move to new keys because the published rules-3 build reads the version-3 keys
// and would reject a rulesVersion 4 record. The page reads v4, then v3, v2, hammer and legacy; older keys are never deleted.
export const RULES_V4_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.economy.v4', journal: 'kr.journal.economy.v4' });
// Area hammer (rules 5): preserve the older game and wallet keys for the published economy build.
export const RULES_V5_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.area.v5', journal: 'kr.journal.area.v5' });
// Tools v2 (rules 6): the cannon removes two columns and the area hammer a 3 x 3 square. The published rules-5 build reads the
// version-5 keys and would reject a rulesVersion 6 record, so games and journals move to new keys. The page reads v6, then v5, v4, v3,
// v2, hammer and legacy; older keys are never deleted.
export const RULES_V6_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.reach.v6', journal: 'kr.journal.reach.v6' });
// Two-row arrow (rules 7): the arrow removes the tapped row and the one below it. The published rules-6 build reads the version-6 keys
// and would reject a rulesVersion 7 record, so games and journals move to new keys. The page reads v7, then v6, v5, v4, v3, v2,
// hammer and legacy; older keys are never deleted.
export const RULES_V7_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.arrow.v7', journal: 'kr.journal.arrow.v7' });
// Floor-layer doubling (rules 8): use separate keys so the published rules-7 page
// can still read its own saves. Read v8 first, then v7 and all older keys; never delete them.
export const RULES_V8_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.layer.v8', journal: 'kr.journal.layer.v8' });
// Balance 3000+ (rules 9): second colour 15% after the debut and the rainbow strip from 3000 points. The published rules-7 page and any
// rules-8 build keep reading their own keys. Read v9 first, then v8, v7 and all older keys; never delete them.
export const RULES_V9_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.balance.v9', journal: 'kr.journal.balance.v9' });
// Fields (rules 10): one active game across the presets; only personal records are per field.
// Keep every previous game/journal key intact for rollback. The small-field best keeps kr.best.
export const RULES_V10_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.fields.v10', journal: 'kr.journal.fields.v10' });
// Third colour (rules 11): green from 5000 points. Rules-10 saves migrate (the palette gets the third colour, the third debut counts as done);
// the published rules-10 page keeps reading its own keys. Read v11 first, then v10 and all older keys; never delete them.
export const RULES_V11_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.third.v11', journal: 'kr.journal.third.v11' });
// Random colour order (rules 12): older game/journal keys are read without overwriting or deleting them.
export const RULES_V12_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.order.v12', journal: 'kr.journal.order.v12' });
export const LEGACY_WALLET_STORAGE_KEY = 'kr.wallet.v1';
export const WALLET_STORAGE_KEY = 'kr.wallet.v2';
export const STORAGE_LIMITS = Object.freeze({
  'kr.best': 1024,
  'kr.best.10x15': 1024,
  'kr.best.12x18': 1024,
  'kr.game': 64 * 1024,
  'kr.journal': 600 * 1024,
  'kr.game.hammer': 64 * 1024,
  'kr.journal.hammer': 600 * 1024,
  'kr.game.hammer.v2': 64 * 1024,
  'kr.journal.hammer.v2': 600 * 1024,
  'kr.game.tools.v3': 64 * 1024,
  'kr.journal.tools.v3': 600 * 1024,
  'kr.game.economy.v4': 64 * 1024,
  'kr.journal.economy.v4': 600 * 1024,
  'kr.wallet.v1': 1024,
  'kr.wallet.v2': 1024,
  'kr.game.area.v5': 64 * 1024,
  'kr.journal.area.v5': 600 * 1024,
  'kr.game.reach.v6': 64 * 1024,
  'kr.journal.reach.v6': 600 * 1024,
  'kr.game.arrow.v7': 64 * 1024,
  'kr.journal.arrow.v7': 600 * 1024,
  'kr.game.layer.v8': 64 * 1024,
  'kr.journal.layer.v8': 600 * 1024,
  'kr.game.balance.v9': 64 * 1024,
  'kr.journal.balance.v9': 600 * 1024,
  'kr.game.fields.v10': 64 * 1024,
  'kr.journal.fields.v10': 600 * 1024,
  'kr.game.third.v11': 64 * 1024,
  'kr.journal.third.v11': 600 * 1024,
  'kr.game.order.v12': 64 * 1024,
  'kr.journal.order.v12': 600 * 1024,
});
const PROBE_KEY = 'kr.probe';
const DEFAULT_LIMIT = 64 * 1024;

function defaultBackend() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function createStorage({ backend = defaultBackend(), onUnavailable = null } = {}) {
  const memory = new Map();
  let available = false;
  let warned = false;
  let pending = 0;
  let tail = Promise.resolve();

  function warnOnce() {
    if (!warned) {
      warned = true;
      try { onUnavailable?.(); } catch { /* the callback must not break storage */ }
    }
  }

  function markUnavailable() { available = false; warnOnce(); }

  // Free-standing probe: a browser that cannot write (private mode, disabled) is reported up front.
  try {
    if (backend) {
      backend.setItem(PROBE_KEY, '1');
      backend.removeItem(PROBE_KEY);
      available = true;
    }
  } catch { available = false; }

  function enqueue(task) {
    const run = () => {
      try { return Promise.resolve(task()); } catch { return Promise.resolve({ ok: false, reason: 'error' }); }
    };
    const result = pending === 0 ? run() : tail.then(run);
    pending += 1;
    tail = result.then(() => { pending -= 1; });
    return result;
  }

  function readText(key) {
    if (available) {
      try { return backend.getItem(key); } catch { markUnavailable(); }
    }
    return memory.get(key) ?? null;
  }

  return {
    get available() { return available; },
    // { ok:true, value } | { ok:false, reason: 'missing' | 'corrupt' | 'too-large' | 'error' }
    load(key) {
      return enqueue(() => {
        const text = readText(key);
        if (text === null || text === undefined) return { ok: false, reason: 'missing' };
        if (typeof text !== 'string') return { ok: false, reason: 'corrupt' };
        if (text.length > (STORAGE_LIMITS[key] ?? DEFAULT_LIMIT)) return { ok: false, reason: 'too-large' };
        try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, reason: 'corrupt' }; }
      });
    },
    // { ok:true, persisted } | { ok:false, reason:'too-large' | 'error' }. persisted=false means memory only.
    save(key, value) {
      let text;
      try { text = JSON.stringify(value); } catch { return Promise.resolve({ ok: false, reason: 'error' }); }
      if (typeof text !== 'string') return Promise.resolve({ ok: false, reason: 'error' });
      if (text.length > (STORAGE_LIMITS[key] ?? DEFAULT_LIMIT)) return Promise.resolve({ ok: false, reason: 'too-large' });
      return enqueue(() => {
        memory.set(key, text);
        if (available) {
          try { backend.setItem(key, text); return { ok: true, persisted: true }; } catch { warnOnce(); } // quota: keep trying later writes
        }
        return { ok: true, persisted: false };
      });
    },
    remove(key) {
      return enqueue(() => {
        memory.delete(key);
        if (available) {
          try { backend.removeItem(key); } catch { warnOnce(); return { ok: true, persisted: false }; }
          return { ok: true, persisted: true };
        }
        return { ok: true, persisted: false };
      });
    },
    // Resolves when every queued operation has finished.
    flush() { return tail.then(() => undefined); },
  };
}
