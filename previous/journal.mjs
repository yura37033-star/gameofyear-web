// Local in-memory game journal (DEMO_PLAN.md section 18, packages B1-B4).
// Pure functions: no DOM, no storage, no network, no randomness, no clock reads.
// The journal lives outside the core. It never mutates its inputs and keeps only
// primitive values derived from them, so it cannot perturb the game.

export const BUILD_ID = 'lamp-91fcf373ec';
// Same value as RAINBOW_COLOR in core/game.mjs (a test keeps them equal); the journal stays free of imports.
const RAINBOW_COLOR = 'rainbow';
// A game carries at most 6 charges of at most 2 kinds (DEMO_PLAN.md section 24), so a kind is used at most 6 times; the
// journal stays free of imports, so these numbers repeat MAX_TOOL_CARRY / MAX_TOOL_KINDS of core/game.mjs (a test keeps them equal).
const TOOL_LIMITS = { hammer: { cells: 4, charges: 6 }, arrow: { cells: 8, charges: 6 }, cannon: { cells: 12, charges: 6 }, areaHammer: { cells: 4, charges: 3 } };
const TOOL_ORDER = ['hammer', 'arrow', 'cannon', 'areaHammer'];
const TOOL_LETTER = { hammer: 'H', arrow: 'A', cannon: 'C', areaHammer: 'Q' };
const MAX_GAME_CHARGES = 6;
const MAX_GAME_KINDS = 2;
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

// The starting set of a game as a short text: kinds in the fixed order, a letter and the charge count each ('H3A2'), '' for
// no tools. null when the slots are not a valid set (then the game simply records no start set).
export function encodeStartSet(tools) {
  if (!Array.isArray(tools)) return null;
  let text = '';
  let total = 0;
  let last = -1;
  for (const slot of tools) {
    const index = TOOL_ORDER.indexOf(slot?.kind);
    if (index <= last || !isCount(slot.charges, TOOL_LIMITS[slot.kind].charges)) return null;
    last = index;
    total += slot.charges;
    if (slot.charges > 0) text += `${TOOL_LETTER[slot.kind]}${slot.charges}`;
  }
  return total <= MAX_GAME_CHARGES && tools.length <= MAX_GAME_KINDS ? text : null;
}

// Back from the short text to counts per tool kind, or null when the text is not a start set.
function decodeStartSet(text) {
  if (typeof text !== 'string' || !/^(?:H[1-6])?(?:A[1-6])?(?:C[1-6])?(?:Q[1-3])?$/.test(text)) return null;
  const counts = {};
  let total = 0;
  for (const [, letter, count] of text.matchAll(/([HACQ])([1-6])/g)) {
    counts[TOOL_ORDER.find((kind) => TOOL_LETTER[kind] === letter)] = Number(count);
    total += Number(count);
  }
  return Object.keys(counts).length <= MAX_GAME_KINDS && total <= MAX_GAME_CHARGES ? counts : null;
}

// `tools` is the loadout the game starts with ({ kind, charges } slots, zero to two, as given to createGame); it is stored as
// the short text `st`. Without it (restored games) the start set stays unknown.
export function startGameLog(journal, { seed, mode, startedAt, startedLabel, device, build = BUILD_ID, tools } = {}) {
  const previous = latestGame(journal);
  if (previous && !previous.end && previous.turns.length === 0 && !previous.tools?.length) journal.games.pop(); // an untouched game is not worth a journal slot
  else if (previous && !previous.end) previous.end = { reason: 'abandoned', endedAt: startedAt ?? null, score: null };
  const game = {
    build: String(build), seed: seed >>> 0, mode: String(mode ?? ''), startedAt: startedAt ?? null,
    startedLabel: startedLabel == null ? null : String(startedLabel), device: String(device ?? 'unknown'),
    turns: [], end: null,
  };
  const startSet = tools === undefined ? null : encodeStartSet(tools);
  if (startSet !== null) game.st = startSet;
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

// Successful tools are recorded separately from turns, in the order they were used.
export function recordTool(journal, { before, after, result } = {}) {
  const game = latestGame(journal);
  if (!game || game.end || !result?.changed || !before || !after || before.turn !== after.turn) return null;
  const events = result?.events ?? [];
  const strike = events[0];
  const kind = strike?.type === 'hammer' ? 'hammer' : strike?.type === 'tool' ? strike.kind : null;
  if (!Object.hasOwn(TOOL_LIMITS, kind) || !Array.isArray(strike.cells)) return null;
  const cells = strike.cells.length;
  const remaining = after.tools?.find((slot) => slot.kind === kind)?.charges;
  if (!isCount(remaining, TOOL_LIMITS[kind].charges - 1) || cells < 1 || cells > TOOL_LIMITS[kind].cells) return null;
  if (before.tools?.find((slot) => slot.kind === kind)?.charges !== remaining + 1) return null; // exactly one charge was spent
  if (!toolFits(game.tools ?? [], kind, decodeStartSet(game.st))) return null;

  let rows = 0;
  for (const event of events) if (event.type === 'clear' && Array.isArray(event.rows)) rows += event.rows.length;
  const gameOver = events.find((event) => event.type === 'gameover');
  const entry = {
    n: after.turn,
    kind,
    cells,
    ...(kind === 'hammer' ? {} : { target: strike.target }),
    score: after.score,
    gain: after.score - before.score,
    rows,
    hBefore: stackHeight(before),
    hAfter: stackHeight(after),
    refill: events.some((event) => event.type === 'refill'),
    colors: colorCount(after),
    remaining,
    over: gameOver ? (gameOver.reason ?? 'top-row') : null,
  };
  (game.tools ??= []).push(entry);
  return entry;
}

function latestAction(turns, tools) {
  const turn = turns.at(-1) ?? null;
  const tool = tools.at(-1) ?? null;
  // An ordinary action is logged before any tool on the same turn.
  return tool && (!turn || tool.n >= turn.n) ? tool : turn;
}

// `coins` (optional) is what the wallet received for this game; it is printed as coins=N and absent when unknown.
export function finishGameLog(journal, finalState, { endedAt = null, coins } = {}) {
  const game = latestGame(journal);
  if (!game || game.end) return null;
  const last = latestAction(game.turns, game.tools ?? []);
  const reason = last?.over ?? (finalState?.status === 'gameover' ? 'top-row' : 'abandoned');
  game.end = { reason, endedAt, score: finalState?.score ?? last?.score ?? 0 };
  if (isCount(coins)) game.end.coins = coins;
  return game;
}

export function summarizeGame(game) {
  const turns = game.turns;
  const tools = game.tools ?? [];
  const first = (predicate) => turns.find(predicate)?.n ?? null;
  const durationMs = game.end?.endedAt != null && game.startedAt != null ? game.end.endedAt - game.startedAt : null;
  const last = latestAction(turns, tools);
  const earliest = (...values) => {
    const candidates = values.filter((value) => value != null);
    return candidates.length ? Math.min(...candidates) : null;
  };
  const summary = {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, device: game.device,
    turns: turns.length,
    score: game.end?.score ?? last?.score ?? 0,
    rows: turns.reduce((sum, turn) => sum + turn.rows, 0) + tools.reduce((sum, tool) => sum + tool.rows, 0),
    reason: game.end?.reason ?? 'playing',
    maxStack: Math.max(turns.reduce((max, turn) => Math.max(max, turn.hBefore, turn.hAfter), 0), tools.reduce((max, tool) => Math.max(max, tool.hBefore, tool.hAfter), 0)),
    firstClear: earliest(first((turn) => turn.rows > 0), tools.find((tool) => tool.rows > 0)?.n),
    secondColor: earliest(first((turn) => turn.colors > 1), tools.find((tool) => tool.colors > 1)?.n),
    rotations: turns.filter((turn) => turn.kind === 'rotate').length,
    hints: turns.reduce((sum, turn) => sum + turn.hints, 0),
    rescueRows: turns.filter((turn) => turn.rescueInserted).length,
    doublings: turns.filter((turn) => turn.doubled).length,
    pauseTurn: first((turn) => turn.pause),
    durationMs,
  };
  if (game.st !== undefined) summary.startSet = game.st;
  if (game.end?.coins !== undefined) summary.coins = game.end.coins;
  const hammers = tools.filter((tool) => tool.kind === 'hammer');
  if (hammers.length) {
    summary.hammers = hammers.length;
    summary.hammerRows = hammers.reduce((sum, hammer) => sum + hammer.rows, 0);
  }
  for (const kind of ['arrow', 'cannon', 'areaHammer']) {
    const count = tools.filter((tool) => tool.kind === kind).length;
    if (count) summary[kind] = count;
  }
  return summary;
}

// Columns of a turn line, explained once and kept short: the whole report must stay under 3 KB for 60 turns.
export const LEGEND = 'L n, M<cells>/<len> move|Rcw|Rccw, sec think, +gain, rN rows cleared, h<from>><to> stack, '
  + 'U rise, Da/Dr double after/instead of rise, P pause, X over, next reg|res +1|2 verified path ~ rainbow strip, cN colours, HN hints f followed';

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

function formatTool(tool) {
  let target = `B${tool.n}`;
  if (tool.kind === 'arrow') target = `A${tool.n} r${tool.target + 1}`;
  if (tool.kind === 'cannon') target = `C${tool.n} c${tool.target + 1}`;
  if (tool.kind === 'areaHammer') target = `Q${tool.n} r${Math.floor(tool.target / 8) + 1} c${tool.target % 8 + 1}`;
  return `${target} x${tool.cells} +${tool.gain} r${tool.rows} h${tool.hBefore}>${tool.hAfter}${tool.refill ? ' F' : ''}${tool.over ? ' X' : ''} left=${tool.remaining}`;
}

// The tool part of the legend is printed only for what the games contain; the shared tail of a tool line is explained once.
function reportLegend(games) {
  const tools = games.flatMap((game) => game.tools ?? []);
  const parts = [];
  if (tools.some((tool) => tool.kind === 'hammer')) parts.push('hammer B<n> x<cells>');
  if (tools.some((tool) => tool.kind === 'arrow' || tool.kind === 'cannon')) parts.push('A<n> r<row>, C<n> c<col> x<cells>');
  if (tools.some((tool) => tool.kind === 'areaHammer')) parts.push('Q<n> r<row> c<col> 2x2 x<cells>');
  let legend = LEGEND;
  if (parts.length) legend += ` | ${parts.join('; ')}; then +gain rN h<from>><to> F refill X over left=charges`;
  const notes = [];
  if (games.some((game) => game.st !== undefined)) notes.push('st start set');
  if (games.some((game) => game.end?.coins !== undefined)) notes.push('coins paid');
  return notes.length ? `${legend} | ${notes.join(', ')}` : legend;
}

function reportActions(game) {
  const lines = [];
  let turnIndex = 0;
  let toolIndex = 0;
  const tools = game.tools ?? [];
  while (turnIndex < game.turns.length || toolIndex < tools.length) {
    const turn = game.turns[turnIndex];
    const tool = tools[toolIndex];
    if (tool && (!turn || tool.n < turn.n)) {
      lines.push(formatTool(tool));
      toolIndex += 1;
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
    + (s.startSet !== undefined ? ` st=${s.startSet || '-'}` : '')
    + (s.hammers ? ` hammer=${s.hammers} hrows=${s.hammerRows}` : '')
    + (s.arrow ? ` arrow=${s.arrow}` : '')
    + (s.cannon ? ` cannon=${s.cannon}` : '')
    + (s.areaHammer ? ` area=${s.areaHammer}` : '')
    + ` dur=${s.durationMs == null ? '-' : `${Math.round(s.durationMs / 1000)}s`}`
    + (s.coins !== undefined ? ` coins=${s.coins}` : '')
    + ` dev=${s.device}`;
}

export function formatReport(game, { legend = true } = {}) {
  const lines = [];
  if (legend) lines.push(reportLegend([game]));
  lines.push(formatHeader(game), ...reportActions(game));
  return `${lines.join('\n')}\n`;
}

// All stored games, latest first, one legend.
export function formatAll(journal) {
  const games = [...journal.games].reverse();
  if (!games.length) return `${LEGEND}\n`;
  const legend = reportLegend(games);
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

// May one more use of `kind` follow `entries`? A game holds at most 6 uses of at most 2 kinds, never more of a kind than its
// per-kind ceiling and, when the start set is known (`start`: counts per kind), never a kind or a count the start set lacked.
function toolFits(entries, kind, start = null) {
  const used = entries.filter((entry) => entry.kind === kind).length;
  const kinds = new Set([...entries.map((entry) => entry.kind), kind]);
  if (entries.length >= MAX_GAME_CHARGES || kinds.size > MAX_GAME_KINDS || used >= TOOL_LIMITS[kind].charges) return false;
  return start === null || used < (start[kind] ?? 0);
}

function importTools(tools, legacyHammers, start = null) {
  const legacy = legacyHammers !== undefined;
  if (legacy && tools !== undefined) return null;
  const source = legacy ? legacyHammers : tools;
  if (!Array.isArray(source) || source.length > (legacy ? 3 : MAX_GAME_CHARGES)) return null;
  const baseKeys = ['n', 'score', 'gain', 'rows', 'hBefore', 'hAfter', 'refill', 'colors', 'remaining', 'over'];
  const accepted = [];
  for (const entry of source) {
    const kind = legacy ? 'hammer' : entry?.kind;
    if (!Object.hasOwn(TOOL_LIMITS, kind) || !toolFits(accepted, kind, start)) return null;
    const fields = legacy ? ['pieceLength'] : kind === 'hammer' ? ['kind', 'cells'] : ['kind', 'cells', 'target'];
    if (!onlyKeys(entry, [...baseKeys, ...fields])) return null;
    if (!['n', 'score', 'gain', 'rows', 'hBefore', 'hAfter'].every((key) => isCount(entry[key]))) return null;
    const cells = legacy ? entry.pieceLength : entry.cells;
    const limits = TOOL_LIMITS[kind];
    if (!isCount(cells, limits.cells) || cells === 0 || !isCount(entry.colors, 4) || !isCount(entry.remaining, limits.charges - 1)) return null;
    if (kind === 'areaHammer') {
      if (!isCount(entry.target, 86) || entry.target % 8 > 6) return null;
    } else if (kind !== 'hammer' && !isCount(entry.target, kind === 'arrow' ? 11 : 7)) return null;
    if (typeof entry.refill !== 'boolean' || (entry.over !== null && !isText(entry.over, 24))) return null;
    if (accepted.length && entry.n < accepted.at(-1).n) return null;
    const { pieceLength, ...fieldsWithoutLegacy } = entry;
    accepted.push({ ...fieldsWithoutLegacy, kind, cells });
  }
  return accepted;
}

function importGame(game) {
  const { hammers, tools, st, ...baseGame } = game ?? {};
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
  // `st` (start set, e.g. 'H3A2') is optional: journals saved before the economy have none.
  const start = st === undefined ? null : decodeStartSet(st);
  if (st !== undefined && start === null) return null;
  const importedTools = tools !== undefined || hammers !== undefined ? importTools(tools, hammers, start) : undefined;
  if (importedTools === null) return null;
  let end = null;
  if (game.end !== null) {
    const { coins, ...endKeys } = game.end ?? {};
    if (coins !== undefined && !isCount(coins)) return null; // optional: absent before the economy and for games closed without a payout
    if (!onlyKeys(endKeys, ['reason', 'endedAt', 'score']) || !isText(game.end.reason, 24)) return null;
    if (game.end.endedAt !== null && !(Number.isSafeInteger(game.end.endedAt) && game.end.endedAt >= 0)) return null;
    if (game.end.score !== null && !isCount(game.end.score)) return null;
    end = { reason: game.end.reason, endedAt: game.end.endedAt, score: game.end.score };
    if (coins !== undefined) end.coins = coins;
  }
  const imported = {
    build: game.build, seed: game.seed, mode: game.mode, startedAt: game.startedAt, startedLabel: game.startedLabel,
    device: game.device, turns, end,
  };
  if (st !== undefined) imported.st = st;
  if (importedTools !== undefined) imported.tools = importedTools;
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
