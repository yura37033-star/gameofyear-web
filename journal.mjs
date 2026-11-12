// Local in-memory game journal (DEMO_PLAN.md section 18, packages B1-B4).
// Pure functions: no DOM, no storage, no network, no randomness, no clock reads.
// The journal lives outside the core. It never mutates its inputs and keeps only
// primitive values derived from them, so it cannot perturb the game.

export const BUILD_ID = 'b1-37b1194';
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
  if (previous && !previous.end) previous.end = { reason: 'abandoned', endedAt: startedAt ?? null, score: null };
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
  + 'move: M<cells incl. start>/<pieceLen> or Rcw|Rccw; sec: think time; rN: rows cleared; h: stack height; '
  + 'events (joined by +): U rise, Da double after rise, Dr double instead of rise, P pause turn, X game over; '
  + 'next: reg|res(cue) row; cN: colours on board; HN: hints pressed, f: first step of last hint followed';

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
    turn.next,
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
