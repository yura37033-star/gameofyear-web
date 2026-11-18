// Local in-memory game journal (DEMO_PLAN.md section 18, packages B1-B4).
// Pure functions: no DOM, no storage, no network, no randomness, no clock reads.
// The journal lives outside the core. It never mutates its inputs and keeps only
// primitive values derived from them, so it cannot perturb the game.

export const BUILD_ID = 'rainbow-8b400d4828';
// Same value as RAINBOW_COLOR in core/game.mjs (a test keeps them equal); the journal stays free of imports.
const RAINBOW_COLOR = 'rainbow';
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

// Ordinary colours only: the rainbow strip is a wildcard, not a colour of its own.
function colorCount(state) {
  return new Set((state?.pieces ?? []).map((piece) => piece.color).filter((color) => color !== RAINBOW_COLOR)).size;
}

const hasRainbowRow = (state) => Array.isArray(state?.nextRow) && state.nextRow.some((segment) => segment?.color === RAINBOW_COLOR);

export function startGameLog(journal, { seed, mode, startedAt, startedLabel, device, build = BUILD_ID } = {}) {
  const previous = latestGame(journal);
  if (previous && !previous.end && previous.turns.length === 0 && !previous.hammers?.length) journal.games.pop(); // an untouched game is not worth a journal slot
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
  if (hasRainbowRow(after)) turn.rb = true; // the shown row carries a rainbow strip (absent = none)
  game.turns.push(turn);
  return turn;
}

// A hammer is a successful bonus action outside the ordinary turn counter.
// Keep it separate from moves/rotations and retain only primitive values.
export function recordHammer(journal, { before, after, result } = {}) {
  const game = latestGame(journal);
  if (!game || game.end || (game.hammers?.length ?? 0) >= 3 || !before || !after || before.turn !== after.turn) return null;
  const events = result?.events ?? [];
  const hammer = events[0];
  if (hammer?.type !== 'hammer' || !Array.isArray(hammer.pieces)) return null;
  if (!Number.isSafeInteger(after.hammersRemaining) || after.hammersRemaining < 0 || after.hammersRemaining > 2) return null;
  const target = before.pieces?.find((item) => item.id === hammer.pieceId);
  if (!target || !Array.isArray(target.cells) || target.cells.length < 1 || target.cells.length > 4) return null;

  let rows = 0;
  for (const event of events) if (event.type === 'clear' && Array.isArray(event.rows)) rows += event.rows.length;
  const gameOver = events.find((event) => event.type === 'gameover');
  const entry = {
    n: after.turn,
    pieceLength: target.cells.length,
    score: after.score,
    gain: after.score - before.score,
    rows,
    hBefore: stackHeight(before),
    hAfter: stackHeight(after),
    refill: events.some((event) => event.type === 'refill'),
    colors: colorCount(after),
    remaining: after.hammersRemaining,
    over: gameOver ? (gameOver.reason ?? 'top-row') : null,
  };
  (game.hammers ??= []).push(entry);
  return entry;
}

function latestAction(turns, hammers) {
  const turn = turns.at(-1) ?? null;
  const hammer = hammers.at(-1) ?? null;
  // Hammer follows the ordinary move when both actions share the same turn number.
  return hammer && (!turn || hammer.n >= turn.n) ? hammer : turn;
}

export function finishGameLog(journal, finalState, { endedAt = null } = {}) {
  const game = latestGame(journal);
  if (!game || game.end) return null;
  const last = latestAction(game.turns, game.hammers ?? []);
  const reason = last?.over ?? (finalState?.status === 'gameover' ? 'top-row' : 'abandoned');
  game.end = { reason, endedAt, score: finalState?.score ?? last?.score ?? 0 };
  return game;
}

export function summarizeGame(game) {
  const turns = game.turns;
  const hammers = game.hammers ?? [];
  const first = (predicate) => turns.find(predicate)?.n ?? null;
  const durationMs = game.end?.endedAt != null && game.startedAt != null ? game.end.endedAt - game.startedAt : null;
  const last = latestAction(turns, hammers);
  const earliest = (...values) => {
    const candidates = values.filter((value) => value != null);
    return candidates.length ? Math.min(...candidates) : null;
  };
  const summary = {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, device: game.device,
    turns: turns.length,
    score: game.end?.score ?? last?.score ?? 0,
    rows: turns.reduce((sum, turn) => sum + turn.rows, 0) + hammers.reduce((sum, hammer) => sum + hammer.rows, 0),
    reason: game.end?.reason ?? 'playing',
    maxStack: Math.max(turns.reduce((max, turn) => Math.max(max, turn.hBefore, turn.hAfter), 0), hammers.reduce((max, hammer) => Math.max(max, hammer.hBefore, hammer.hAfter), 0)),
    firstClear: earliest(first((turn) => turn.rows > 0), hammers.find((hammer) => hammer.rows > 0)?.n),
    secondColor: earliest(first((turn) => turn.colors > 1), hammers.find((hammer) => hammer.colors > 1)?.n),
    rotations: turns.filter((turn) => turn.kind === 'rotate').length,
    hints: turns.reduce((sum, turn) => sum + turn.hints, 0),
    rescueRows: turns.filter((turn) => turn.rescueInserted).length,
    doublings: turns.filter((turn) => turn.doubled).length,
    pauseTurn: first((turn) => turn.pause),
    durationMs,
  };
  if (hammers.length) {
    summary.hammers = hammers.length;
    summary.hammerRows = hammers.reduce((sum, hammer) => sum + hammer.rows, 0);
  }
  return summary;
}

export const LEGEND = 'L n move sec +gain rN h<before>><after> events next cN HN[f] | '
  + 'move: M<cells incl. start>/<pieceLen> or Rcw|Rccw; sec: think time; rN: rows cleared; h: stack; '
  + 'events (+ joined): U rise, Da/Dr double after/instead of rise, P pause, X game over; '
  + 'next: reg|res row, +1|2 verified path, ~ rainbow strip; cN: colours; HN: hints pressed, f: hint step followed';

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
    `${turn.next}${turn.w ? turn.w : ''}${turn.rb ? '~' : ''}`,
    `c${turn.colors}`,
    `H${turn.hints}${turn.followed ? 'f' : ''}`,
  ].join(' ');
}

export function formatHammer(hammer) {
  return `B${hammer.n} x${hammer.pieceLength} +${hammer.gain} r${hammer.rows} h${hammer.hBefore}>${hammer.hAfter}${hammer.refill ? ' F' : ''}${hammer.over ? ' X' : ''} left=${hammer.remaining}`;
}

function hasHammers(game) { return (game.hammers?.length ?? 0) > 0; }

function hammerLegend() {
  return 'B<n> x<size> +gain rN h<before>><after> F refill, X game over, left=remaining';
}

function reportActions(game) {
  const lines = [];
  let turnIndex = 0;
  let hammerIndex = 0;
  const hammers = game.hammers ?? [];
  while (turnIndex < game.turns.length || hammerIndex < hammers.length) {
    const turn = game.turns[turnIndex];
    const hammer = hammers[hammerIndex];
    // A hammer follows the preceding normal action when both share a turn number.
    if (hammer && (!turn || hammer.n < turn.n)) {
      lines.push(formatHammer(hammer));
      hammerIndex += 1;
    } else {
      lines.push(formatTurn(turn));
      turnIndex += 1;
    }
  }
  return lines;
}

export function formatHeader(game) {
  const s = summarizeGame(game);
  const orDash = (value) => value ?? '-';
  return `G ${s.build} seed=${s.seed} mode=${s.mode.replace(/\s+/g, '')} at=${game.startedLabel ?? (s.startedAt == null ? '-' : new Date(s.startedAt).toISOString().slice(0, 16))}`
    + ` | turns=${s.turns} score=${s.score} rows=${s.rows} end=${s.reason} hmax=${s.maxStack}`
    + ` clear1=${orDash(s.firstClear)} col2=${orDash(s.secondColor)} rot=${s.rotations} hint=${s.hints}`
    + ` resc=${s.rescueRows} dbl=${s.doublings} pause=${orDash(s.pauseTurn)}`
    + (s.hammers ? ` hammer=${s.hammers} hrows=${s.hammerRows}` : '')
    + ` dur=${s.durationMs == null ? '-' : `${Math.round(s.durationMs / 1000)}s`} dev=${s.device}`;
}

export function formatReport(game, { legend = true } = {}) {
  const lines = [];
  if (legend) lines.push(hasHammers(game) ? `${LEGEND} | hammer: ${hammerLegend()}` : LEGEND);
  lines.push(formatHeader(game), ...reportActions(game));
  return `${lines.join('\n')}\n`;
}

// All stored games, latest first, one legend.
export function formatAll(journal) {
  const games = [...journal.games].reverse();
  if (!games.length) return `${LEGEND}\n`;
  const legend = games.some(hasHammers) ? `${LEGEND} | hammer: ${hammerLegend()}` : LEGEND;
  return `${legend}\n${games.map((game) => formatReport(game, { legend: false })).join('\n')}`;
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
  const { w, rb, ...rest } = turn ?? {};
  if (w !== undefined && w !== 0 && w !== 1 && w !== 2) return null;
  if (rb !== undefined && rb !== true) return null; // optional marker, written only when the shown row has a strip
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
  if (turn.rb === true) copy.rb = true; // absent in journals saved before the rainbow strip
  return copy;
}

function importGame(game) {
  const { hammers, ...baseGame } = game ?? {};
  if (!onlyKeys(baseGame, ['build', 'seed', 'mode', 'startedAt', 'startedLabel', 'device', 'turns', 'end'])) return null;
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
  let importedHammers;
  if (hammers !== undefined) {
    if (!Array.isArray(hammers) || hammers.length > 3) return null;
    importedHammers = [];
    for (const hammer of hammers) {
      if (!onlyKeys(hammer, ['n', 'pieceLength', 'score', 'gain', 'rows', 'hBefore', 'hAfter', 'refill', 'colors', 'remaining', 'over'])) return null;
      if (!['n', 'pieceLength', 'score', 'rows', 'hBefore', 'hAfter', 'colors', 'remaining'].every((key) => isCount(hammer[key]))) return null;
      if (!isCount(hammer.gain) || hammer.pieceLength < 1 || hammer.pieceLength > 4 || hammer.remaining > 2 || hammer.colors > 4) return null;
      if (typeof hammer.refill !== 'boolean') return null;
      if (hammer.over !== null && !isText(hammer.over, 24)) return null;
      if (importedHammers.length && hammer.n < importedHammers.at(-1).n) return null;
      importedHammers.push({ ...hammer });
    }
  }
  let end = null;
  if (game.end !== null) {
    if (!onlyKeys(game.end, ['reason', 'endedAt', 'score']) || !isText(game.end.reason, 24)) return null;
    if (game.end.endedAt !== null && !(Number.isSafeInteger(game.end.endedAt) && game.end.endedAt >= 0)) return null;
    if (game.end.score !== null && !isCount(game.end.score)) return null;
    end = { reason: game.end.reason, endedAt: game.end.endedAt, score: game.end.score };
  }
  const imported = {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, startedLabel: game.startedLabel,
    device: game.device, turns, end,
  };
  if (importedHammers !== undefined) imported.hammers = importedHammers;
  return imported;
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
