// Pure save-format module for P1 (PERSISTENCE_PLAN.md). No DOM, no storage, no clock.
//
// SCHEMA_VERSION describes the JSON layout of the records below.
// RULES_VERSION describes everything that decides the FUTURE turns of a stored state:
// generator.mjs, the colour curve and debut constants, the drought/rescue constants, the
// search budgets and candidate ordering in game.mjs (legalTrialActions, selectTrialPreview,
// findTrialWitness, suggestAction). Bump it whenever a change makes the same stored state
// continue differently; old records are then rejected and a new game starts (the best score
// is a separate record and survives). The golden test in tests/persistence.test.mjs fails
// with that instruction when such a change slips in.
import { movePieceAlongPath, previewMovePath, previewRotation, rotatePiece } from './game.mjs';

export const SCHEMA_VERSION = 1;
export const RULES_VERSION = 1;
export const MAX_GAME_RECORD_BYTES = 64 * 1024;
export const MAX_PIECES = 200;
export const TRIAL_SIZE = Object.freeze({ cols: 8, rows: 12 });
export const CLASSIC_SIZE = Object.freeze({ cols: 10, rows: 20 });
const MAX_PIECE_CELLS = 4;
const MAX_NUMBER = 1_000_000_000;
const MAX_PATH = 64;
const MAX_DEBUT_ROWS = 2;
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
  };
}

// Returns a plain JSON-safe record. Throws only on a state that is not a game state at all
// (callers wrap it); parseGame is the gatekeeper for everything read back.
export function serializeGame(state, { bestAtStart = 0, savedAt = 0 } = {}) {
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
    out._debutRowsReserved = state._debutRowsReserved ?? 0;
    out._droughtTurns = state._droughtTurns ?? 0;
    out._droughtRescueIssued = state._droughtRescueIssued === true;
  }
  out._rng = state._rng;
  out._nextId = state._nextId;
  if (state._witness !== undefined) out._witness = serializeWitness(state._witness);
  return {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    savedAt: Number.isSafeInteger(savedAt) && savedAt >= 0 ? savedAt : 0,
    bestAtStart: Number.isSafeInteger(bestAtStart) && bestAtStart >= 0 ? bestAtStart : 0,
    state: out,
  };
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
function validateRow(row, cols, palette) {
  need(Array.isArray(row) && row.length >= 1 && row.length <= cols, 'row-size');
  let cursor = 0;
  return row.map((segment) => {
    onlyKeys(segment, ['x', 'length', 'color']);
    need(isInt(segment.x, 0, cols - 1) && isInt(segment.length, 1, MAX_PIECE_CELLS), 'row-segment');
    need(segment.x >= cursor && segment.x + segment.length <= cols, 'row-overlap');
    need(palette.includes(segment.color), 'row-color');
    cursor = segment.x + segment.length;
    return { x: segment.x, length: segment.length, color: segment.color };
  });
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

function validatePieces(pieces, cols, rows, palette) {
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
    need(palette.includes(piece.color), 'piece-color');
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
  onlyKeys(witness, ['steps', 'first', 'second', 'continuationMode', 'continuationRow', 'continuationRng',
    'continuationKind', 'continuationDebutRowsReserved']);
  need(witness.continuationMode === 'reserved' || witness.continuationMode === 'generated', 'witness-mode');
  need(witness.continuationKind === 'regular' || witness.continuationKind === 'rescue', 'witness-kind');
  need(isUint32(witness.continuationRng), 'witness-rng');
  need(isInt(witness.continuationDebutRowsReserved, 0, MAX_DEBUT_ROWS), 'witness-debut');
  return {
    first: validateSignature(witness.first, context),
    second: validateSignature(witness.second, { ...context, idLimit: context.idLimit + 64 }),
    steps: 2,
    continuationRow: validateRow(witness.continuationRow, context.cols, context.palette),
    continuationRng: witness.continuationRng,
    continuationKind: witness.continuationKind,
    continuationMode: witness.continuationMode,
    continuationDebutRowsReserved: witness.continuationDebutRowsReserved,
  };
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
    || next._debutRowsReserved !== witness.continuationDebutRowsReserved) return false;
  return actionFromSignature(next, witness.second) !== null;
}

function validateState(raw) {
  need(isObject(raw), 'state');
  const trial = raw.trial;
  need(typeof trial === 'boolean', 'trial');
  onlyKeys(raw,
    ['cols', 'rows', 'palette', 'pieces', 'nextRow', 'nextRowKind', 'score', 'turn', 'status', 'trial',
      'skipNextRise', 'skipRiseUsed', '_trialColor', '_rng', '_nextId', ...(trial ? ['_debutRowsReserved', '_droughtTurns', '_droughtRescueIssued', '_witness'] : [])],
    trial ? [] : ['_witness']);
  const size = trial ? TRIAL_SIZE : CLASSIC_SIZE;
  need(raw.cols === size.cols && raw.rows === size.rows, 'size');
  const { cols, rows } = size;
  need(Array.isArray(raw.palette) && raw.palette.length >= 2 && raw.palette.length <= 4, 'palette');
  need(raw.palette.every((color) => typeof color === 'string' && COLOR_PATTERN.test(color)), 'palette-color');
  need(new Set(raw.palette).size === raw.palette.length, 'palette-duplicate');
  const palette = [...raw.palette];
  need(raw.status === 'playing' || raw.status === 'gameover', 'status');
  need(typeof raw.skipNextRise === 'boolean' && typeof raw.skipRiseUsed === 'boolean', 'flags');
  need(raw.nextRowKind === 'regular' || raw.nextRowKind === 'rescue', 'next-row-kind');
  need(isInt(raw.score) && raw.score % 100 === 0, 'score');
  need(isInt(raw.turn), 'turn');
  need(isUint32(raw._rng), 'rng');
  need(isInt(raw._nextId, 1, MAX_NUMBER), 'next-id');
  if (trial) need(typeof raw._trialColor === 'string' && palette.includes(raw._trialColor), 'trial-color');
  else need(raw._trialColor === null, 'trial-color');
  const { pieces, maxId } = validatePieces(raw.pieces, cols, rows, palette);
  need(raw._nextId > maxId, 'next-id-low');
  const nextRow = validateRow(raw.nextRow, cols, palette);
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
    need(isInt(raw._debutRowsReserved, 0, MAX_DEBUT_ROWS), 'debut-rows');
    need(raw._debutRowsReserved === 0 || raw.score >= COLOR_DEBUT_SCORE, 'debut-score');
    need(isInt(raw._droughtTurns, 0, MAX_DROUGHT_TURNS), 'drought-turns');
    need(typeof raw._droughtRescueIssued === 'boolean', 'drought-issued');
    need(!raw._droughtRescueIssued || raw._droughtTurns === MAX_DROUGHT_TURNS, 'drought-issued-turns');
    state._debutRowsReserved = raw._debutRowsReserved;
    state._droughtTurns = raw._droughtTurns;
    state._droughtRescueIssued = raw._droughtRescueIssued;
  }
  state._rng = raw._rng;
  state._nextId = raw._nextId;
  if (trial) {
    state._witness = validateWitness(raw._witness, { cols, rows, palette, idLimit: raw._nextId });
    if (state._witness?.steps === 2) {
      need(state._witness.continuationDebutRowsReserved === 0 || raw.score >= COLOR_DEBUT_SCORE, 'witness-debut-score');
    }
    if (state.status === 'playing') need(witnessReplays(state), 'witness-replay');
  } else {
    need(raw._witness === undefined || raw._witness === null, 'witness');
    if (raw._witness === null) state._witness = null;
  }
  return state;
}

export function parseGame(value) {
  try {
    onlyKeys(value, ['schemaVersion', 'rulesVersion', 'savedAt', 'bestAtStart', 'state']);
    need(value.schemaVersion === SCHEMA_VERSION, 'schema-version');
    need(value.rulesVersion === RULES_VERSION, 'rules-version');
    need(isInt(value.savedAt, 0, Number.MAX_SAFE_INTEGER) && isInt(value.bestAtStart), 'record-numbers');
    need(isObject(value.state) && Array.isArray(value.state.pieces) && value.state.pieces.length <= MAX_PIECES, 'pieces-size');
    need(JSON.stringify(value).length <= MAX_GAME_RECORD_BYTES, 'too-large');
    const state = validateState(value.state);
    return { ok: true, state, bestAtStart: value.bestAtStart, savedAt: value.savedAt };
  } catch (error) {
    return fail(error instanceof Invalid ? error.message : 'invalid');
  }
}
