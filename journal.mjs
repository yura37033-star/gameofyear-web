// Local in-memory game journal (DEMO_PLAN.md section 18, packages B1-B4).
// Pure functions: no DOM, no storage, no network, no randomness, no clock reads.
// The journal lives outside the core. It never mutates its inputs and keeps only
// primitive values derived from them, so it cannot perturb the game.

export const BUILD_ID = 'b1-573199a';
export const JOURNAL_CAPACITY = 5; // the game in progress plus up to four finished ones

export function createJournal() {
  return { capacity: JOURNAL_CAPACITY, games: [] }; // oldest first
}

export function latestGame(journal) {
  return journal.games.at(-1) ?? null;
}

// Short browser/OS label without personal data, e.g. 'iOS 27.0 Safari'.
export function parseDevice(userAgent) {
  try {
    const ua = typeof userAgent === 'string' ? userAgent : '';
    const browser = /(?:CriOS|Chrome)\//.test(ua) && !/(?:EdgiOS|Edg)\//.test(ua) ? 'Chrome'
      : /(?:EdgiOS|Edg)\//.test(ua) ? 'Edge'
        : /(?:FxiOS|Firefox)\//.test(ua) ? 'Firefox'
          : /Safari\//.test(ua) && /Version\//.test(ua) ? `Safari ${(ua.match(/Version\/(\d+(?:\.\d+)?)/) ?? [])[1] ?? ''}`.trim() : '';
    const ios = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)/);
    if (ios) return `iOS ${ios[1]}.${ios[2]} ${browser || 'WebView'}`;
    const android = ua.match(/Android (\d+(?:\.\d+)?)/);
    if (android) return `Android ${android[1]} ${browser || 'WebView'}`;
    if (/Windows/.test(ua)) return `Windows ${browser || 'browser'}`;
    if (/Macintosh/.test(ua)) return `macOS ${browser || 'browser'}`;
    if (/Linux|X11/.test(ua)) return `Linux ${browser || 'browser'}`;
  } catch { /* fall through */ }
  return 'unknown';
}

export function stackHeight(state) {
  let top = Infinity;
  for (const piece of state?.pieces ?? []) for (const cell of piece.cells) if (cell.y < top) top = cell.y;
  return top === Infinity ? 0 : state.rows - top;
}

function colorCount(state) {
  return new Set((state?.pieces ?? []).map((piece) => piece.color)).size;
}

export function startGameLog(journal, { seed, mode, startedAt, startedLabel, device, build = BUILD_ID } = {}) {
  const previous = latestGame(journal);
  if (previous && !previous.end && previous.turns.length === 0) journal.games.pop(); // an untouched game is not worth a journal slot
  else if (previous && !previous.end) previous.end = { reason: 'abandoned', endedAt: startedAt ?? null, score: null };
  const game = {
    build: String(build), seed: seed >>> 0, mode: String(mode ?? ''), startedAt: startedAt ?? null,
    startedLabel: startedLabel == null ? null : String(startedLabel), device: String(device ?? 'unknown'),
    turns: [], end: null,
  };
  journal.games.push(game);
  while (journal.games.length > journal.capacity) journal.games.shift();
  return game;
}

// Records one successful action. `before`/`after` are core states, `result` is the core
// result. Only primitives derived from them are stored.
export function recordTurn(journal, {
  before, after, result, kind, pathLength = 0, pieceLength = 0, direction = null,
  ms = 0, hintsPressed = 0, followedHint = false,
} = {}) {
  const game = latestGame(journal);
  if (!game || game.end) return null;
  const events = result?.events ?? [];
  const types = new Set(events.map((event) => event.type));
  const rise = types.has('rise');
  const doubled = types.has('double') ? (rise ? 'after-rise' : 'replace') : null;
  const gameOver = events.find((event) => event.type === 'gameover');
  let clearedRows = 0;
  for (const event of events) if (event.type === 'clear') clearedRows += event.rows.length;
  const turn = {
    n: after.turn,
    kind: kind === 'rotate' ? 'rotate' : 'move',
    pathLength: kind === 'rotate' ? 0 : pathLength,
    pieceLength: kind === 'rotate' ? 0 : pieceLength,
    direction: kind === 'rotate' ? (direction === 'counterclockwise' ? 'ccw' : 'cw') : null,
    ms: Math.max(0, Math.round(ms)),
    score: after.score,
    gain: after.score - before.score,
    rows: clearedRows,
    hBefore: stackHeight(before),
    hAfter: stackHeight(after),
    rise,
    doubled,
    pause: before.skipNextRise === true && after.skipNextRise !== true && !rise,
    rescueInserted: rise && before.nextRowKind === 'rescue',
    next: after.nextRowKind === 'rescue' ? 'res' : 'reg',
    colors: colorCount(after),
    w: after._witness?.steps === 1 || after._witness?.steps === 2 ? after._witness.steps : 0, // verified path for the shown row
    hints: hintsPressed,
    followed: Boolean(followedHint),
    over: gameOver ? (gameOver.reason ?? 'top-row') : null,
  };
  game.turns.push(turn);
  return turn;
}

export function finishGameLog(journal, finalState, { endedAt = null } = {}) {
  const game = latestGame(journal);
  if (!game || game.end) return null;
  const last = game.turns.at(-1);
  const reason = last?.over ?? (finalState?.status === 'gameover' ? 'top-row' : 'abandoned');
  game.end = { reason, endedAt, score: finalState?.score ?? last?.score ?? 0 };
  return game;
}

export function summarizeGame(game) {
  const turns = game.turns;
  const first = (predicate) => turns.find(predicate)?.n ?? null;
  const durationMs = game.end?.endedAt != null && game.startedAt != null ? game.end.endedAt - game.startedAt : null;
  return {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, device: game.device,
    turns: turns.length,
    score: game.end?.score ?? turns.at(-1)?.score ?? 0,
    rows: turns.reduce((sum, turn) => sum + turn.rows, 0),
    reason: game.end?.reason ?? 'playing',
    maxStack: turns.reduce((max, turn) => Math.max(max, turn.hBefore, turn.hAfter), 0),
    firstClear: first((turn) => turn.rows > 0),
    secondColor: first((turn) => turn.colors > 1),
    rotations: turns.filter((turn) => turn.kind === 'rotate').length,
    hints: turns.reduce((sum, turn) => sum + turn.hints, 0),
    rescueRows: turns.filter((turn) => turn.rescueInserted).length,
    doublings: turns.filter((turn) => turn.doubled).length,
    pauseTurn: first((turn) => turn.pause),
    durationMs,
  };
}

export const LEGEND = 'L n move sec +gain rN h<before>><after> events next cN HN[f] | '
  + 'move: M<cells incl. start>/<pieceLen> or Rcw|Rccw; sec: think time; rN: rows cleared; h: stack; '
  + 'events (+ joined): U rise, Da/Dr double after/instead of rise, P pause, X game over; '
  + 'next: reg|res(cue) row, +1|2 verified path (none: no path); cN: colours; HN: hints pressed, f: first step of last hint followed';

function seconds(ms) {
  return (Math.min(ms, 999900) / 1000).toFixed(1);
}

export function formatTurn(turn) {
  const events = [];
  if (turn.rise) events.push('U');
  if (turn.doubled) events.push(turn.doubled === 'after-rise' ? 'Da' : 'Dr');
  if (turn.pause) events.push('P');
  if (turn.over) events.push('X');
  return [
    turn.n,
    turn.kind === 'rotate' ? `R${turn.direction}` : `M${turn.pathLength}/${turn.pieceLength}`,
    seconds(turn.ms),
    `+${turn.gain}`,
    `r${turn.rows}`,
    `${turn.hBefore}>${turn.hAfter}`,
    events.length ? events.join('+') : '-',
    `${turn.next}${turn.w ? turn.w : ''}`,
    `c${turn.colors}`,
    `H${turn.hints}${turn.followed ? 'f' : ''}`,
  ].join(' ');
}

export function formatHeader(game) {
  const s = summarizeGame(game);
  const orDash = (value) => value ?? '-';
  return `G ${s.build} seed=${s.seed} mode=${s.mode.replace(/\s+/g, '')} at=${game.startedLabel ?? (s.startedAt == null ? '-' : new Date(s.startedAt).toISOString().slice(0, 16))}`
    + ` | turns=${s.turns} score=${s.score} rows=${s.rows} end=${s.reason} hmax=${s.maxStack}`
    + ` clear1=${orDash(s.firstClear)} col2=${orDash(s.secondColor)} rot=${s.rotations} hint=${s.hints}`
    + ` resc=${s.rescueRows} dbl=${s.doublings} pause=${orDash(s.pauseTurn)}`
    + ` dur=${s.durationMs == null ? '-' : `${Math.round(s.durationMs / 1000)}s`} dev=${s.device}`;
}

export function formatReport(game, { legend = true } = {}) {
  const lines = [];
  if (legend) lines.push(LEGEND);
  lines.push(formatHeader(game), ...game.turns.map(formatTurn));
  return `${lines.join('\n')}\n`;
}

// All stored games, latest first, one legend.
export function formatAll(journal) {
  const games = [...journal.games].reverse();
  if (!games.length) return `${LEGEND}\n`;
  return `${LEGEND}\n${games.map((game) => formatReport(game, { legend: false })).join('\n')}`;
}

// --- Persistence (P1): the journal is stored as primitives only. ---
export const JOURNAL_SCHEMA_VERSION = 1;
export const MAX_JOURNAL_TURNS = 1500; // per game; a typical game has 50-300
const TURN_INTEGERS = ['n', 'pathLength', 'pieceLength', 'ms', 'score', 'gain', 'rows', 'hBefore', 'hAfter', 'colors', 'hints'];

function isCount(value, max = 1e9) { return Number.isSafeInteger(value) && value >= 0 && value <= max; }
function isText(value, max) { return typeof value === 'string' && value.length <= max; }
function onlyKeys(object, keys) {
  return object !== null && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => Object.hasOwn(object, key));
}

function importTurn(turn) {
  const keys = [...TURN_INTEGERS, 'kind', 'direction', 'rise', 'doubled', 'pause', 'rescueInserted', 'next', 'followed', 'over'];
  const { w, ...rest } = turn ?? {};
  if (w !== undefined && w !== 0 && w !== 1 && w !== 2) return null;
  if (!onlyKeys(rest, keys)) return null;
  if (!TURN_INTEGERS.every((key) => isCount(turn[key]))) return null;
  if (turn.kind !== 'move' && turn.kind !== 'rotate') return null;
  if (turn.direction !== null && turn.direction !== 'cw' && turn.direction !== 'ccw') return null;
  if (typeof turn.rise !== 'boolean' || typeof turn.pause !== 'boolean' || typeof turn.rescueInserted !== 'boolean' || typeof turn.followed !== 'boolean') return null;
  if (turn.doubled !== null && turn.doubled !== 'after-rise' && turn.doubled !== 'replace') return null;
  if (turn.next !== 'reg' && turn.next !== 'res') return null;
  if (turn.over !== null && !isText(turn.over, 24)) return null;
  const copy = {};
  for (const key of keys) copy[key] = turn[key];
  copy.w = turn.w === 1 || turn.w === 2 ? turn.w : 0; // absent in journals saved by the previous build
  return copy;
}

function importGame(game) {
  if (!onlyKeys(game, ['build', 'seed', 'mode', 'startedAt', 'startedLabel', 'device', 'turns', 'end'])) return null;
  if (!isText(game.build, 40) || !isText(game.mode, 40) || !isText(game.device, 80)) return null;
  if (!Number.isSafeInteger(game.seed) || game.seed < 0 || game.seed > 0xFFFFFFFF) return null;
  if (game.startedAt !== null && !(Number.isSafeInteger(game.startedAt) && game.startedAt >= 0)) return null;
  if (game.startedLabel !== null && !isText(game.startedLabel, 40)) return null;
  if (!Array.isArray(game.turns) || game.turns.length > MAX_JOURNAL_TURNS) return null;
  const turns = [];
  for (const turn of game.turns) {
    const imported = importTurn(turn);
    if (!imported) return null;
    turns.push(imported);
  }
  let end = null;
  if (game.end !== null) {
    if (!onlyKeys(game.end, ['reason', 'endedAt', 'score']) || !isText(game.end.reason, 24)) return null;
    if (game.end.endedAt !== null && !(Number.isSafeInteger(game.end.endedAt) && game.end.endedAt >= 0)) return null;
    if (game.end.score !== null && !isCount(game.end.score)) return null;
    end = { reason: game.end.reason, endedAt: game.end.endedAt, score: game.end.score };
  }
  return {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, startedLabel: game.startedLabel,
    device: game.device, turns, end,
  };
}

// Plain JSON-safe copy of the newest `maxGames` games (oldest first). Never throws on a well-formed journal.
export function exportJournal(journal, { maxGames = JOURNAL_CAPACITY } = {}) {
  const keep = Math.max(0, Math.min(JOURNAL_CAPACITY, maxGames));
  const games = keep === 0 ? [] : journal.games.slice(-keep);
  return { version: JOURNAL_SCHEMA_VERSION, games: JSON.parse(JSON.stringify(games)) };
}

// { ok:true, journal } or { ok:false, reason }. A game still in progress (end === null) is kept
// open, so recordTurn / finishGameLog keep appending to it after a restore.
export function importJournal(value) {
  try {
    if (!onlyKeys(value, ['version', 'games']) || value.version !== JOURNAL_SCHEMA_VERSION) return { ok: false, reason: 'version' };
    if (!Array.isArray(value.games) || value.games.length > JOURNAL_CAPACITY) return { ok: false, reason: 'games' };
    const journal = createJournal();
    for (const game of value.games) {
      const imported = importGame(game);
      if (!imported) return { ok: false, reason: 'game' };
      journal.games.push(imported);
    }
    // Only the newest game can still be open.
    if (journal.games.slice(0, -1).some((game) => game.end === null)) return { ok: false, reason: 'open-game' };
    return { ok: true, journal };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
