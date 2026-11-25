// Pure save-format module for P1 (PERSISTENCE_PLAN.md). No DOM, no storage, no clock.
//
// SCHEMA_VERSION describes the JSON layout of the records below.
// RULES_VERSION describes everything that decides the FUTURE turns of a stored state:
// generator.mjs, the colour curve and debut constants, the drought/rescue constants, the
// search budgets and candidate ordering in game.mjs (legalTrialActions, selectTrialPreview,
// findTrialWitness, suggestAction). Bump it whenever a change makes the same stored state
// continue differently. Explicit migrations preserve compatible records. The golden test
// in tests/persistence.test.mjs detects changes in a game's continuation.
//
// Rules 4 (economy) added a payout marker; rules 5 added the area hammer tool; rules 6 changed tool effects (the cannon removes two
// neighbouring columns, the area hammer a 3 x 3 square); rules 7 makes the arrow remove two neighbouring rows, which decides the
// future turns of a stored game. The rules-version bump keeps older builds from loading a state they would continue differently.
// Rules 8 doubles a floor layer even when it includes vertical strips. Rules 9 lowers the second-colour share after the debut
// (3000 points) to 15% and lets the rainbow strip appear from 3000 points instead of 4000. Rules 11 adds a third colour (green) from
// 5000 points: two forced debut rows, then a 25% non-base share split between the second and the third colour, and a new counter
// `_debut3RowsReserved`. Versions 1-10 migrate with their pieces, score, shown row, counters, tool charges and payout marker preserved
// (a trial palette of the two default colours gets the third colour appended, the third debut counts as done from 5000 points); an old
// hint is dropped only when it no longer replays.
import { FIELD_SIZES, fieldForSize } from './fields.mjs?v=third-edd6382dd2';
import {
  HAMMER_CHARGES, RAINBOW_COLOR, RAINBOW_MAX_IN_WINDOW, RAINBOW_MAX_LENGTH, RAINBOW_MIN_BETWEEN, RAINBOW_MIN_LENGTH, RAINBOW_SCORE,
  THIRD_COLOR, THIRD_COLOR_DEBUT_ROWS, THIRD_COLOR_SCORE, TOOL_CELL_POINTS, hasThirdColor, makeToolSlots, movePieceAlongPath, previewMovePath,
  previewRotation, rotatePiece, validateToolSlots,
} from './game.mjs?v=third-edd6382dd2';

export const SCHEMA_VERSION = 1;
// Rules 10 adds approved field sizes and separate save keys; rules-9 gameplay is unchanged. Rules 11 adds the third colour (from 5000 points).
export const RULES_VERSION = 11;
// The two colours of every trial record before rules 11; the migration appends THIRD_COLOR to exactly this palette.
const PALETTE_BEFORE_RULES_11 = Object.freeze(['#5D8FE8', '#F3C969']);
// Before rules 9 the first rainbow strip needed 4000 points; a record of an older version must still satisfy that rule.
const RAINBOW_SCORE_BEFORE_RULES_9 = 4000;
const rainbowScoreFor = (version) => (version >= 9 ? RAINBOW_SCORE : RAINBOW_SCORE_BEFORE_RULES_9);
export const MAX_GAME_RECORD_BYTES = 64 * 1024;
export const MAX_PIECES = Math.max(200, ...FIELD_SIZES.map(({ cols, rows }) => cols * rows));
export const TRIAL_SIZE = Object.freeze({ cols: 8, rows: 12 });
export const CLASSIC_SIZE = Object.freeze({ cols: 10, rows: 20 });
const MAX_PIECE_CELLS = 4;
const MAX_NUMBER = 1_000_000_000;
const MAX_PATH = 64;
const MAX_DEBUT_ROWS = 2;
const MAX_DEBUT3_ROWS = THIRD_COLOR_DEBUT_ROWS;
const MAX_DROUGHT_TURNS = 6;
const COLOR_DEBUT_SCORE = 3000;
const ID_PATTERN = /^p[1-9]\d{0,8}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInt = (value, min = 0, max = MAX_NUMBER) => Number.isSafeInteger(value) && value >= min && value <= max;
const isUint32 = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 0xFFFFFFFF;
const fail = (reason) => ({ ok: false, reason });

class Invalid extends Error {}
function need(condition, reason) {
  if (!condition) throw new Invalid(reason);
}
function onlyKeys(object, required, optional = []) {
  need(isObject(object), 'not-object');
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) need(allowed.has(key), `unknown-key:${key}`);
  for (const key of required) need(Object.hasOwn(object, key), `missing-key:${key}`);
}

const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const sortCells = (cells) => cells.map(({ x, y }) => ({ x, y })).sort((a, b) => a.y - b.y || a.x - b.x);
const sameCells = (first, second) => first.length === second.length
  && sortCells(first).every((cell, index) => cell.x === sortCells(second)[index].x && cell.y === sortCells(second)[index].y);

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
function serializeSignature(signature) {
  const out = { type: signature.type, pieceId: signature.pieceId };
  if (signature.type === 'rotate') out.direction = signature.direction;
  if (signature.type === 'move') out.path = signature.path.map(({ x, y }) => ({ x, y }));
  out.cells = signature.cells.map(({ x, y }) => ({ x, y }));
  return out;
}

function serializeWitness(witness) {
  if (!witness) return null;
  if (witness.steps === 1) return { steps: 1, first: serializeSignature(witness.first) };
  return {
    steps: 2,
    first: serializeSignature(witness.first),
    second: serializeSignature(witness.second),
    continuationMode: witness.continuationMode,
    continuationRow: witness.continuationRow.map(({ x, length, color }) => ({ x, length, color })),
    continuationRng: witness.continuationRng,
    continuationKind: witness.continuationKind,
    continuationDebutRowsReserved: witness.continuationDebutRowsReserved,
    continuationDebut3RowsReserved: witness.continuationDebut3RowsReserved,
    continuationRowsPrepared: witness.continuationRowsPrepared,
    continuationRainbowRows: [...witness.continuationRainbowRows],
    continuationRainbowFirstDone: witness.continuationRainbowFirstDone,
  };
}

// Returns a plain JSON-safe record. Throws only on a state that is not a game state at all
// (callers wrap it); parseGame is the gatekeeper for everything read back.
// `coinsPaid` (integer >= 0) marks a game whose coins were already paid out to the wallet; leave it undefined for a game
// still in progress. The field is written only when given, so a record without it means "not paid yet".
export function serializeGame(state, { bestAtStart = 0, savedAt = 0, coinsPaid } = {}) {
  const out = {
    cols: state.cols,
    rows: state.rows,
    palette: [...state.palette],
    pieces: state.pieces.map((piece) => ({
      id: piece.id,
      color: piece.color,
      cells: piece.cells.map(({ x, y }) => ({ x, y })),
      frame: { x: piece.frame.x, y: piece.frame.y, size: piece.frame.size },
    })),
    nextRow: state.nextRow.map(({ x, length, color }) => ({ x, length, color })),
    nextRowKind: state.nextRowKind,
    score: state.score,
    turn: state.turn,
    status: state.status,
    trial: state.trial === true,
    skipNextRise: state.skipNextRise === true,
    skipRiseUsed: state.skipRiseUsed === true,
    _trialColor: state._trialColor ?? null,
  };
  if (state.trial === true) {
    out.tools = state.tools.map(({ kind, charges }) => ({ kind, charges }));
    out._debutRowsReserved = state._debutRowsReserved ?? 0;
    out._debut3RowsReserved = state._debut3RowsReserved ?? 0;
    out._droughtTurns = state._droughtTurns ?? 0;
    out._droughtRescueIssued = state._droughtRescueIssued === true;
    out._rowsPrepared = state._rowsPrepared ?? 0;
    out._rainbowRows = [...(state._rainbowRows ?? [])];
    out._rainbowFirstDone = state._rainbowFirstDone === true;
  }
  out._rng = state._rng;
  out._nextId = state._nextId;
  if (state._witness !== undefined) out._witness = serializeWitness(state._witness);
  const record = {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    savedAt: Number.isSafeInteger(savedAt) && savedAt >= 0 ? savedAt : 0,
    bestAtStart: Number.isSafeInteger(bestAtStart) && bestAtStart >= 0 ? bestAtStart : 0,
  };
  if (Number.isSafeInteger(coinsPaid) && coinsPaid >= 0) record.coinsPaid = coinsPaid;
  record.state = out;
  return record;
}

export function serializeBest(score) {
  return { schemaVersion: SCHEMA_VERSION, score: Number.isSafeInteger(score) && score >= 0 ? score : 0 };
}

// Record rule: the best score only ever grows; a game sets a new record when it beats the best score at its start.
export const nextBest = (best, score) => (Number.isSafeInteger(score) && score > best ? score : best);
export const isNewRecord = (score, bestAtStart) => Number.isSafeInteger(score) && score > bestAtStart;

export function parseBest(value) {
  try {
    onlyKeys(value, ['schemaVersion', 'score']);
    need(value.schemaVersion === SCHEMA_VERSION, 'schema-version');
    need(isInt(value.score), 'score');
    return { ok: true, score: value.score };
  } catch (error) {
    return fail(error instanceof Invalid ? error.message : 'invalid');
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
// A rainbow strip may appear only in a trial row: one strip of 2-4 cells next to at least one ordinary segment.
function validateRow(row, cols, palette, allowRainbow = false) {
  need(Array.isArray(row) && row.length >= 1 && row.length <= cols, 'row-size');
  let cursor = 0;
  let rainbowSegments = 0;
  const result = row.map((segment) => {
    onlyKeys(segment, ['x', 'length', 'color']);
    need(isInt(segment.x, 0, cols - 1) && isInt(segment.length, 1, MAX_PIECE_CELLS), 'row-segment');
    need(segment.x >= cursor && segment.x + segment.length <= cols, 'row-overlap');
    if (allowRainbow && segment.color === RAINBOW_COLOR) {
      rainbowSegments += 1;
      need(segment.length >= RAINBOW_MIN_LENGTH && segment.length <= RAINBOW_MAX_LENGTH, 'row-rainbow-length');
    } else {
      need(palette.includes(segment.color), 'row-color');
    }
    cursor = segment.x + segment.length;
    return { x: segment.x, length: segment.length, color: segment.color };
  });
  need(rainbowSegments <= 1, 'row-rainbow-count');
  need(rainbowSegments === 0 || result.length >= 2, 'row-rainbow-only');
  return result;
}

const rowHasRainbow = (row) => row.some((segment) => segment.color === RAINBOW_COLOR);

// Counters of the rainbow limit: the latest appearances (at most RAINBOW_MAX_IN_WINDOW) (ascending row numbers), the first-appearance flag and
// the number of prepared rows. `rowsPrepared` > every listed row; gaps respect the minimum spacing.
function validateRainbowCounters({ rowsPrepared, rainbowRows, firstDone }, reasonPrefix) {
  need(isInt(rowsPrepared), `${reasonPrefix}rows-prepared`);
  need(Array.isArray(rainbowRows) && rainbowRows.length <= RAINBOW_MAX_IN_WINDOW, `${reasonPrefix}rainbow-rows`);
  rainbowRows.forEach((value, index) => {
    need(isInt(value) && value < rowsPrepared, `${reasonPrefix}rainbow-rows`);
    need(index === 0 || value - rainbowRows[index - 1] > RAINBOW_MIN_BETWEEN, `${reasonPrefix}rainbow-rows`);
  });
  need(typeof firstDone === 'boolean', `${reasonPrefix}rainbow-first`);
  need(rainbowRows.length === 0 || firstDone, `${reasonPrefix}rainbow-first`);
  return { rowsPrepared, rainbowRows: [...rainbowRows], firstDone };
}

function validateCells(cells, cols, rows, lengthMin = 1) {
  need(Array.isArray(cells) && cells.length >= lengthMin && cells.length <= MAX_PIECE_CELLS, 'cells-size');
  return cells.map((cell) => {
    onlyKeys(cell, ['x', 'y']);
    need(isInt(cell.x, 0, cols - 1) && isInt(cell.y, 0, rows - 1), 'cell-bounds');
    return { x: cell.x, y: cell.y };
  });
}

function isStraightLine(cells) {
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  if (minX !== maxX && minY !== maxY) return false;
  return (maxX - minX + 1) * (maxY - minY + 1) === cells.length;
}

function validatePieces(pieces, cols, rows, palette, allowRainbow = false) {
  need(Array.isArray(pieces) && pieces.length <= MAX_PIECES, 'pieces-size');
  const ids = new Set();
  const occupied = new Set();
  let maxId = 0;
  const result = pieces.map((piece) => {
    onlyKeys(piece, ['id', 'color', 'cells', 'frame']);
    need(typeof piece.id === 'string' && ID_PATTERN.test(piece.id), 'piece-id');
    need(!ids.has(piece.id), 'piece-id-duplicate');
    ids.add(piece.id);
    maxId = Math.max(maxId, Number(piece.id.slice(1)));
    need(palette.includes(piece.color) || (allowRainbow && piece.color === RAINBOW_COLOR), 'piece-color');
    const cells = validateCells(piece.cells, cols, rows);
    need(isStraightLine(cells), 'piece-shape');
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;
      need(!occupied.has(key), 'cell-overlap');
      occupied.add(key);
    }
    onlyKeys(piece.frame, ['x', 'y', 'size']);
    const { x, y, size } = piece.frame;
    need(isInt(size, 1, MAX_PIECE_CELLS) && isInt(x, -8, cols + 8) && isInt(y, -8, rows + 8), 'frame-values');
    for (const cell of cells) need(cell.x >= x && cell.x < x + size && cell.y >= y && cell.y < y + size, 'frame-cells');
    return { id: piece.id, color: piece.color, cells, frame: { x, y, size } };
  });
  return { pieces: result, maxId };
}

function validateSignature(signature, { cols, rows, idLimit }) {
  need(isObject(signature), 'signature');
  const isMove = signature.type === 'move';
  need(isMove || signature.type === 'rotate', 'signature-type');
  onlyKeys(signature, ['type', 'pieceId', 'cells', isMove ? 'path' : 'direction']);
  need(typeof signature.pieceId === 'string' && ID_PATTERN.test(signature.pieceId)
    && Number(signature.pieceId.slice(1)) < idLimit, 'signature-piece');
  const cells = validateCells(signature.cells, cols, rows);
  const sorted = sortCells(cells);
  need(cells.every((cell, index) => cell.x === sorted[index].x && cell.y === sorted[index].y), 'signature-cells-order');
  const out = { type: signature.type, pieceId: signature.pieceId };
  if (isMove) {
    need(Array.isArray(signature.path) && signature.path.length >= 1 && signature.path.length <= MAX_PATH, 'signature-path');
    out.path = signature.path.map((point) => {
      onlyKeys(point, ['x', 'y']);
      need(isInt(point.x, -64, 64) && isInt(point.y, -64, 64), 'signature-path-point');
      return { x: point.x, y: point.y };
    });
  } else {
    need(signature.direction === 'clockwise' || signature.direction === 'counterclockwise', 'signature-direction');
    out.direction = signature.direction;
  }
  out.cells = cells;
  return out;
}

function validateWitness(witness, context) {
  if (witness === null) return null;
  need(isObject(witness), 'witness');
  need(witness.steps === 1 || witness.steps === 2, 'witness-steps');
  if (witness.steps === 1) {
    onlyKeys(witness, ['steps', 'first']);
    return { first: validateSignature(witness.first, context), steps: 1 };
  }
  // Rules 11 adds the third-colour debut counter; a witness of an older record has none and continues from the state's own.
  const hasDebut3 = context.version >= 11;
  onlyKeys(witness, ['steps', 'first', 'second', 'continuationMode', 'continuationRow', 'continuationRng',
    'continuationKind', 'continuationDebutRowsReserved', ...(hasDebut3 ? ['continuationDebut3RowsReserved'] : [])],
  ['continuationRowsPrepared', 'continuationRainbowRows', 'continuationRainbowFirstDone']);
  need(witness.continuationMode === 'reserved' || witness.continuationMode === 'generated', 'witness-mode');
  need(witness.continuationKind === 'regular' || witness.continuationKind === 'rescue', 'witness-kind');
  need(isUint32(witness.continuationRng), 'witness-rng');
  need(isInt(witness.continuationDebutRowsReserved, 0, MAX_DEBUT_ROWS), 'witness-debut');
  const debut3 = hasDebut3 ? witness.continuationDebut3RowsReserved : context.debut3;
  need(isInt(debut3, 0, MAX_DEBUT3_ROWS), 'witness-debut3');
  // The three rainbow counters are optional on read: a witness saved before the strip existed continues
  // from the state's own counters (one more prepared row when the continuation row is newly generated).
  const hasCounters = ['continuationRowsPrepared', 'continuationRainbowRows', 'continuationRainbowFirstDone']
    .map((key) => Object.hasOwn(witness, key));
  need(hasCounters.every(Boolean) || !hasCounters.some(Boolean), 'witness-rainbow-keys');
  const counters = hasCounters[0]
    ? validateRainbowCounters({
      rowsPrepared: witness.continuationRowsPrepared,
      rainbowRows: witness.continuationRainbowRows,
      firstDone: witness.continuationRainbowFirstDone,
    }, 'witness-')
    : {
      rowsPrepared: context.counters.rowsPrepared + (witness.continuationMode === 'generated' ? 1 : 0),
      rainbowRows: [...context.counters.rainbowRows],
      firstDone: context.counters.firstDone,
    };
  return {
    first: validateSignature(witness.first, context),
    second: validateSignature(witness.second, { ...context, idLimit: context.idLimit + 64 }),
    steps: 2,
    continuationRow: validateRow(witness.continuationRow, context.cols, context.palette, true),
    continuationRng: witness.continuationRng,
    continuationKind: witness.continuationKind,
    continuationMode: witness.continuationMode,
    continuationDebutRowsReserved: witness.continuationDebutRowsReserved,
    continuationDebut3RowsReserved: debut3,
    continuationRowsPrepared: counters.rowsPrepared,
    continuationRainbowRows: counters.rainbowRows,
    continuationRainbowFirstDone: counters.firstDone,
  };
}

// The continuation counters must follow from the state's own: a reserved row is the one already shown, a generated row
// is one more prepared row that either carries a strip (and is then the newest appearance) or leaves them as they are.
function checkWitnessRainbow(state, witness, version) {
  const { _rowsPrepared: prepared, _rainbowRows: recent } = state;
  const generated = witness.continuationMode === 'generated';
  need(witness.continuationRowsPrepared === prepared + (generated ? 1 : 0), 'witness-rainbow-counters');
  const placed = rowHasRainbow(witness.continuationRow);
  const expected = generated && placed ? [...recent, prepared].slice(-RAINBOW_MAX_IN_WINDOW) : recent;
  need(JSON.stringify(witness.continuationRainbowRows) === JSON.stringify(expected), 'witness-rainbow-counters');
  need(witness.continuationRainbowFirstDone === (state._rainbowFirstDone || expected.length > 0), 'witness-rainbow-counters');
  need(!placed || witness.continuationKind === 'regular', 'witness-rainbow-counters');
  need(!placed || witness.continuationRainbowRows.at(-1) === witness.continuationRowsPrepared - 1, 'witness-rainbow-counters');
  if (placed) need(state.score >= rainbowScoreFor(version), 'witness-rainbow-score');
}

function actionFromSignature(state, signature) {
  if (signature.type === 'rotate') {
    const preview = previewRotation(state, signature.pieceId, signature.direction);
    return preview.valid && sameCells(preview.cells, signature.cells) ? { type: 'rotate', direction: signature.direction } : null;
  }
  const preview = previewMovePath(state, signature.pieceId, signature.path);
  const last = signature.path.at(-1);
  if (!preview.valid || preview.lastValidOffset.x !== last.x || preview.lastValidOffset.y !== last.y
    || !sameCells(preview.cells, signature.cells)) return null;
  return { type: 'move', path: signature.path };
}

function applyAction(state, pieceId, action) {
  return action.type === 'rotate'
    ? rotatePiece(state, pieceId, action.direction)
    : movePieceAlongPath(state, pieceId, action.path);
}

// Replays the first stored action on a copy of the state through the core API, so a
// witness that the live game would never have produced is rejected.
function witnessReplays(state) {
  const witness = state._witness;
  if (!witness) return true;
  const copy = cloneJson(state);
  const first = actionFromSignature(copy, witness.first);
  if (!first) return false;
  const result = applyAction(copy, witness.first.pieceId, first);
  if (!result.changed || result.state.status !== 'playing') return false;
  if (witness.steps === 1) return result.state.score > state.score;
  if (result.state.score !== state.score) return false;
  const next = result.state;
  if (JSON.stringify(next.nextRow) !== JSON.stringify(witness.continuationRow)
    || next.nextRowKind !== witness.continuationKind || next._rng !== witness.continuationRng
    || next._debutRowsReserved !== witness.continuationDebutRowsReserved
    || (next._debut3RowsReserved ?? 0) !== witness.continuationDebut3RowsReserved
    || next._rowsPrepared !== witness.continuationRowsPrepared
    || JSON.stringify(next._rainbowRows) !== JSON.stringify(witness.continuationRainbowRows)
    || next._rainbowFirstDone !== witness.continuationRainbowFirstDone) return false;
  return actionFromSignature(next, witness.second) !== null;
}

// Slot shape and kinds are checked by the core (validateToolSlots); a record keeps its own reason codes, and the key
// checks come first so that the detailed reasons (unknown-key, missing-key, not-object) stay available. Rules 3 records
// can only come from the fixed A1 set, so they keep the old strict shape: a hammer first and then an arrow or a cannon,
// at most 3 hammer charges and 1 charge of the line tool.
function validateRecordTools(tools, version) {
  need(Array.isArray(tools) && tools.length <= 2, 'tools');
  for (const slot of tools) onlyKeys(slot, ['kind', 'charges']);
  const checked = validateToolSlots(tools);
  need(checked.ok, checked.reason);
  if (version === 3) {
    need(checked.tools.length === 2, 'tools');
    const [hammer, line] = checked.tools;
    need(hammer.kind === 'hammer' && (line.kind === 'arrow' || line.kind === 'cannon'), 'tool-kind');
    need(hammer.charges <= HAMMER_CHARGES && line.charges <= 1, 'tool-charges');
  } else if (version === 4) {
    need(checked.tools.every((slot) => slot.kind !== 'areaHammer'), 'tool-kind');
  }
  return checked.tools;
}

function validateState(raw, version) {
  need(isObject(raw), 'state');
  const trial = raw.trial;
  const oldRules = version < 3; // rules 1 and 2 stored `hammersRemaining` instead of the tool slots and scored in hundreds
  need(typeof trial === 'boolean', 'trial');
  onlyKeys(raw,
    ['cols', 'rows', 'palette', 'pieces', 'nextRow', 'nextRowKind', 'score', 'turn', 'status', 'trial',
      'skipNextRise', 'skipRiseUsed', '_trialColor', '_rng', '_nextId',
      ...(trial ? ['_debutRowsReserved', '_droughtTurns', '_droughtRescueIssued', '_witness', ...(oldRules ? [] : ['tools']),
        ...(version >= 11 ? ['_debut3RowsReserved'] : [])] : [])],
    trial ? ['_rowsPrepared', '_rainbowRows', '_rainbowFirstDone', ...(oldRules ? ['hammersRemaining'] : [])] : ['_witness']);
  const size = trial && version >= 10 ? fieldForSize(raw.cols, raw.rows) : (trial ? TRIAL_SIZE : CLASSIC_SIZE);
  need(size !== null && raw.cols === size.cols && raw.rows === size.rows, 'size');
  const { cols, rows } = size;
  need(Array.isArray(raw.palette) && raw.palette.length >= 2 && raw.palette.length <= 4, 'palette');
  need(raw.palette.every((color) => typeof color === 'string' && COLOR_PATTERN.test(color)), 'palette-color');
  need(new Set(raw.palette).size === raw.palette.length, 'palette-duplicate');
  let palette = [...raw.palette];
  // Migration (version <= 10): a trial record with exactly the two default colours gets the third colour appended; its pieces and
  // rows keep their colours, so the board is never altered.
  if (trial && version < 11 && palette.length === PALETTE_BEFORE_RULES_11.length && palette.every((color, index) => color === PALETTE_BEFORE_RULES_11[index])) {
    palette = [...palette, THIRD_COLOR];
  }
  const thirdActive = trial && hasThirdColor(palette);
  need(raw.status === 'playing' || raw.status === 'gameover', 'status');
  need(typeof raw.skipNextRise === 'boolean' && typeof raw.skipRiseUsed === 'boolean', 'flags');
  need(raw.nextRowKind === 'regular' || raw.nextRowKind === 'rescue', 'next-row-kind');
  need(isInt(raw.score) && raw.score % (trial && !oldRules ? TOOL_CELL_POINTS : 100) === 0, 'score');
  need(isInt(raw.turn), 'turn');
  need(isUint32(raw._rng), 'rng');
  need(isInt(raw._nextId, 1, MAX_NUMBER), 'next-id');
  if (trial) need(typeof raw._trialColor === 'string' && palette.includes(raw._trialColor) && !(thirdActive && raw._trialColor === palette[2]), 'trial-color');
  else need(raw._trialColor === null, 'trial-color');
  const { pieces, maxId } = validatePieces(raw.pieces, cols, rows, palette, trial);
  need(raw._nextId > maxId, 'next-id-low');
  const nextRow = validateRow(raw.nextRow, cols, palette, trial);
  const isThird = (item) => thirdActive && item.color === palette[2];
  need(!(raw.skipNextRise && raw.skipRiseUsed), 'skip-flags');
  need(!(raw.skipNextRise && raw.nextRowKind === 'rescue'), 'skip-rescue');
  need(trial || (!raw.skipNextRise && !raw.skipRiseUsed && raw.nextRowKind === 'regular'), 'classic-flags');
  if (trial && raw.status === 'playing') {
    need(!pieces.some((piece) => piece.cells.some((cell) => cell.y === 0)), 'top-occupied');
  }

  const state = {
    cols, rows, palette, pieces, nextRow, score: raw.score, turn: raw.turn, status: raw.status, trial,
    skipNextRise: raw.skipNextRise, skipRiseUsed: raw.skipRiseUsed, nextRowKind: raw.nextRowKind,
    _trialColor: raw._trialColor,
  };
  if (trial) {
    let tools;
    if (oldRules) {
      const hammersRemaining = raw.hammersRemaining === undefined ? HAMMER_CHARGES : raw.hammersRemaining;
      need(isInt(hammersRemaining, 0, HAMMER_CHARGES), 'hammers-remaining');
      tools = makeToolSlots('arrow', hammersRemaining);
    } else {
      tools = validateRecordTools(raw.tools, version);
    }
    need(isInt(raw._debutRowsReserved, 0, MAX_DEBUT_ROWS), 'debut-rows');
    need(raw._debutRowsReserved === 0 || raw.score >= COLOR_DEBUT_SCORE, 'debut-score');
    // The third debut counts as done for an older record that is already past THIRD_COLOR_SCORE: no forced rows appear mid-game.
    const debut3 = version >= 11 ? raw._debut3RowsReserved : (thirdActive && raw.score >= THIRD_COLOR_SCORE ? THIRD_COLOR_DEBUT_ROWS : 0);
    need(isInt(raw._droughtTurns, 0, MAX_DROUGHT_TURNS), 'drought-turns');
    need(typeof raw._droughtRescueIssued === 'boolean', 'drought-issued');
    need(!raw._droughtRescueIssued || raw._droughtTurns === MAX_DROUGHT_TURNS, 'drought-issued-turns');
    state._debutRowsReserved = raw._debutRowsReserved;
    state._debut3RowsReserved = debut3;
    state.tools = tools;
    state._droughtTurns = raw._droughtTurns;
    state._droughtRescueIssued = raw._droughtRescueIssued;

    // Rainbow counters are optional on read: a save made before the strip existed starts counting at its first new row.
    const counters = validateRainbowCounters({
      rowsPrepared: raw._rowsPrepared === undefined ? 0 : raw._rowsPrepared,
      rainbowRows: raw._rainbowRows === undefined ? [] : raw._rainbowRows,
      firstDone: raw._rainbowFirstDone === undefined ? false : raw._rainbowFirstDone,
    }, '');
    const hasRainbow = pieces.some((piece) => piece.color === RAINBOW_COLOR) || rowHasRainbow(nextRow);
    need(!hasRainbow || counters.firstDone, 'rainbow-first');
    need(!counters.firstDone || raw.score >= rainbowScoreFor(version), 'rainbow-score');
    // The shown row is always the newest prepared row, so a strip in it is the newest appearance.
    need(!rowHasRainbow(nextRow) || (raw.nextRowKind === 'regular' && counters.rainbowRows.at(-1) === counters.rowsPrepared - 1), 'rainbow-next-row');
    state._rowsPrepared = counters.rowsPrepared;
    state._rainbowRows = counters.rainbowRows;
    state._rainbowFirstDone = counters.firstDone;
    need(isInt(debut3, 0, MAX_DEBUT3_ROWS), 'debut3-rows');
    need(debut3 === 0 || (thirdActive && raw.score >= THIRD_COLOR_SCORE), 'debut3-score');
  }
  // The third colour appears only from THIRD_COLOR_SCORE on (the score never decreases), so earlier it cannot be on the board or in the row.
  need(!thirdActive || raw.score >= THIRD_COLOR_SCORE || !(pieces.some(isThird) || nextRow.some(isThird)), 'third-color-score');
  state._rng = raw._rng;
  state._nextId = raw._nextId;
  if (trial) {
    state._witness = validateWitness(raw._witness, {
      cols, rows, palette, idLimit: raw._nextId, version, debut3: state._debut3RowsReserved,
      counters: { rowsPrepared: state._rowsPrepared, rainbowRows: state._rainbowRows, firstDone: state._rainbowFirstDone },
    });
    if (state._witness?.steps === 2) {
      need(state._witness.continuationDebutRowsReserved === 0 || raw.score >= COLOR_DEBUT_SCORE, 'witness-debut-score');
      need(state._witness.continuationDebut3RowsReserved === 0 || (thirdActive && raw.score >= THIRD_COLOR_SCORE), 'witness-debut3-score');
      need(state._witness.continuationDebut3RowsReserved >= state._debut3RowsReserved, 'witness-debut3');
      need(!thirdActive || raw.score >= THIRD_COLOR_SCORE || !state._witness.continuationRow.some(isThird), 'third-color-score');
      checkWitnessRainbow(state, state._witness, version);
    }
    if (state.status === 'playing' && !witnessReplays(state)) {
      // Older rules can plan a rise where rules 8 now doubles a floor layer, and rules 8 hints were searched with the old
      // second-colour share and rainbow threshold (a continuation row generated at 3000+ points differs under rules 9).
      // Keep the game; a stale, structurally valid hint must not reject an older save.
      // Field profiles do not alter future turns, and rules 11 changes the rows only from THIRD_COLOR_SCORE on: below it a false hint of a
      // rules-9 or rules-10 record is still rejected; from it on such a hint is dropped like an older one. A rules-11 record is always checked.
      need(version < 9 || (version < RULES_VERSION && raw.score >= THIRD_COLOR_SCORE), 'witness-replay');
      state._witness = null;
    }
  } else {
    need(raw._witness === undefined || raw._witness === null, 'witness');
    if (raw._witness === null) state._witness = null;
  }
  return state;
}

export function parseGame(value) {
  try {
    onlyKeys(value, ['schemaVersion', 'rulesVersion', 'savedAt', 'bestAtStart', 'state'], ['coinsPaid']);
    need(value.schemaVersion === SCHEMA_VERSION, 'schema-version');
    const migrating = Number.isInteger(value.rulesVersion) && value.rulesVersion >= 1 && value.rulesVersion < RULES_VERSION;
    need(migrating || value.rulesVersion === RULES_VERSION, 'rules-version');
    need(isInt(value.savedAt, 0, Number.MAX_SAFE_INTEGER) && isInt(value.bestAtStart), 'record-numbers');
    need(isObject(value.state) && Array.isArray(value.state.pieces) && value.state.pieces.length <= MAX_PIECES, 'pieces-size');
    need(JSON.stringify(value).length <= MAX_GAME_RECORD_BYTES, 'too-large');
    // coinsPaid exists only from rules 4 on; absent means the coins of this game were not paid yet.
    need(value.coinsPaid === undefined || (value.rulesVersion >= 4 && isInt(value.coinsPaid)), 'coins-paid');
    const state = validateState(value.state, value.rulesVersion);
    // The payout is 5 per full 100 points plus 10 per full 1000, so it can never exceed 6% of the score.
    need(value.coinsPaid === undefined || (state.trial && value.coinsPaid * 100 <= state.score * 6), 'coins-paid');
    const parsed = { ok: true, state, bestAtStart: value.bestAtStart, savedAt: value.savedAt, migrated: migrating };
    if (value.coinsPaid !== undefined) parsed.coinsPaid = value.coinsPaid;
    return parsed;
  } catch (error) {
    return fail(error instanceof Invalid ? error.message : 'invalid');
  }
}
