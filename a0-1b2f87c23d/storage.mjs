// localStorage adapter for P1 (PERSISTENCE_PLAN.md). Every browser call is wrapped in
// try/catch (private mode, quota, disabled storage). When the browser store fails, values stay
// in a memory fallback so the game keeps working; `available` is false when the store cannot
// be probed or read, and `onUnavailable` fires once on the first failure (read, write or quota).
// Operations run strictly in call order (one queue); a snapshot is serialized at call time, so a later save always wins and a stale one can never overwrite it.

export const STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game', journal: 'kr.journal' });
export const HAMMER_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.hammer', journal: 'kr.journal.hammer' });
export const RULES_V2_STORAGE_KEYS = Object.freeze({ best: 'kr.best', game: 'kr.game.hammer.v2', journal: 'kr.journal.hammer.v2' });
export const STORAGE_LIMITS = Object.freeze({
  'kr.best': 1024,
  'kr.game': 64 * 1024,
  'kr.journal': 600 * 1024,
  'kr.game.hammer': 64 * 1024,
  'kr.journal.hammer': 600 * 1024,
  'kr.game.hammer.v2': 64 * 1024,
  'kr.journal.hammer.v2': 600 * 1024,
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
