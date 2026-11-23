import { createRandom, generateRow, generateStartPieces } from './generator.mjs?v=tools-v2-97d156fe48';

const DEFAULT_PALETTE = ['#5D8FE8', '#F3C969'];
export const HAMMER_CHARGES = 3; // hammer charges of the fixed A1 set (trial default and the migration of older records)
// Tool slots of one game (DEMO_PLAN.md section 24): up to two different kinds in the fixed order below, at most
// MAX_TOOL_CARRY charges in total. TOOL_CHARGES is the per-game ceiling for each kind (the wallet stock limits live in economy.mjs).
// The area hammer has its own ceiling of three; all tools still share the six-charge total.
export const TOOL_ORDER = Object.freeze(['hammer', 'arrow', 'cannon', 'areaHammer']);
export const MAX_TOOL_CARRY = 6;
export const MAX_TOOL_KINDS = 2;
export const TOOL_CHARGES = Object.freeze({ hammer: MAX_TOOL_CARRY, arrow: MAX_TOOL_CARRY, cannon: MAX_TOOL_CARRY, areaHammer: 3 });
export const TOOL_CELL_POINTS = 10;
// Tool effects (rules 6). The cannon removes CANNON_WIDTH neighbouring columns (the tap sets the left one); the area hammer removes
// an AREA_SIZE x AREA_SIZE square (the tap sets its top-left cell). Near the right and bottom edges both shift inside the board.
export const CANNON_WIDTH = 2;
export const AREA_SIZE = 3;
export const COLOR_DEBUT_SCORE = 3000;
const COLOR_DEBUT_ROWS = 2;
// Rainbow strip (DEMO_PLAN.md section 13). RAINBOW_COLOR is not a palette colour: it is a
// wildcard value of segment/piece `color` and is never counted as a colour of its own.
export const RAINBOW_COLOR = 'rainbow';
export const RAINBOW_SCORE = 4000;
export const RAINBOW_CHANCE = 0.2;
export const RAINBOW_WINDOW = 20; // at most RAINBOW_MAX_IN_WINDOW in any 20 consecutive prepared rows
export const RAINBOW_MAX_IN_WINDOW = 3;
export const RAINBOW_MIN_BETWEEN = 3; // other prepared rows between two appearances
export const RAINBOW_MIN_LENGTH = 2;
export const RAINBOW_MAX_LENGTH = 4;
const DROUGHT_RESCUE_TURNS = 6;

const cloneCell = ({ x, y }) => ({ x, y });
const cloneFrame = ({ x, y, size }) => ({ x, y, size });
const clonePiece = (piece) => ({
  id: piece.id,
  color: piece.color,
  cells: piece.cells.map(cloneCell),
  frame: cloneFrame(piece.frame),
});
const cloneOffset = ({ x, y }) => ({ x, y });

function addSnapshotEvent(events, event, pieces) {
  if (!events) return;
  events.push({ ...event, pieces: pieces.map(clonePiece) });
}

function makeFrame(cells) {
  const minX = Math.min(...cells.map((cell) => cell.x));
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y));
  const maxY = Math.max(...cells.map((cell) => cell.y));
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const size = Math.max(width, height);
  return {
    x: minX - Math.floor((size - width) / 2),
    y: minY - Math.floor((size - height) / 2),
    size,
  };
}

function translateCells(cells, dx, dy = 0) {
  return cells.map(({ x, y }) => ({ x: x + dx, y: y + dy }));
}

function occupiedByOthers(pieces, excludedId) {
  const occupied = new Map();
  for (const piece of pieces) {
    if (piece.id === excludedId) continue;
    for (const cell of piece.cells) occupied.set(`${cell.x},${cell.y}`, piece.id);
  }
  return occupied;
}

function findPiece(state, pieceId) {
  return state.pieces.find((piece) => piece.id === pieceId);
}

function invalidPreview(reason, frame = { x: 0, y: 0, size: 1 }, cells = [], blockedCells = []) {
  return {
    valid: false,
    cells,
    blockedCells,
    reason,
    frame,
    acceptedPath: [{ x: 0, y: 0 }],
    lastValidOffset: { x: 0, y: 0 },
  };
}

function blockedCoordinates(cells, cols, rows, occupied) {
  const blocked = new Map();
  for (const cell of cells) {
    if (cell.x < 0 || cell.x >= cols || cell.y < 0 || cell.y >= rows || occupied.has(`${cell.x},${cell.y}`)) {
      blocked.set(`${cell.x},${cell.y}`, cell);
    }
  }
  return [...blocked.values()];
}

function invalidPathPreview(state, piece, reason, endpoint = { x: 0, y: 0 }, acceptedPath = [{ x: 0, y: 0 }], blockedCells = []) {
  return {
    valid: false,
    cells: piece ? translateCells(piece.cells, endpoint.x, endpoint.y) : [],
    blockedCells,
    reason,
    frame: piece ? { ...piece.frame, x: piece.frame.x + endpoint.x, y: piece.frame.y + endpoint.y } : { x: 0, y: 0, size: 1 },
    acceptedPath: acceptedPath.map(cloneOffset),
    lastValidOffset: cloneOffset(acceptedPath.at(-1) ?? { x: 0, y: 0 }),
  };
}

function* segmentSteps(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const stepX = Math.sign(dx);
  const stepY = Math.sign(dy);
  let x = start.x;
  let y = start.y;
  let nextX = absX ? 0.5 / absX : Number.POSITIVE_INFINITY;
  let nextY = absY ? 0.5 / absY : Number.POSITIVE_INFINITY;
  while (x !== end.x || y !== end.y) {
    if (Math.abs(nextX - nextY) < 1e-12) {
      const adjacentX = { x: x + stepX, y };
      const adjacentY = { x, y: y + stepY };
      x += stepX;
      y += stepY;
      yield { offset: { x, y }, guards: [adjacentX, adjacentY] };
      nextX += 1 / absX;
      nextY += 1 / absY;
    } else if (nextX < nextY) {
      x += stepX;
      yield { offset: { x, y }, guards: [] };
      nextX += 1 / absX;
    } else {
      y += stepY;
      yield { offset: { x, y }, guards: [] };
      nextY += 1 / absY;
    }
  }

}

export function previewMovePath(state, pieceId, path) {
  const piece = findPiece(state, pieceId);
  if (!piece) return invalidPreview('piece-not-found');
  if (state.status !== 'playing') return invalidPreview('game-over', piece.frame);

  if (!Array.isArray(path)) return invalidPathPreview(state, piece, 'invalid-path');

  const waypoints = [];
  let endpoint = { x: 0, y: 0 };
  for (const waypoint of path) {
    if (!waypoint || typeof waypoint !== 'object' || !Number.isSafeInteger(waypoint.x) || !Number.isSafeInteger(waypoint.y)) {
      return invalidPathPreview(state, piece, 'invalid-distance', endpoint);
    }
    endpoint = { x: waypoint.x, y: waypoint.y };
    waypoints.push(endpoint);
  }

  if (waypoints.length && waypoints[0].x === 0 && waypoints[0].y === 0) waypoints.shift();

  const occupied = occupiedByOthers(state.pieces, pieceId);
  const acceptedPath = [{ x: 0, y: 0 }];
  const blocked = new Map();
  let current = { x: 0, y: 0 };
  let stopped = false;

  for (const waypoint of waypoints) {
    for (const step of segmentSteps(current, waypoint)) {
      const placements = [...step.guards, step.offset];
      const stepBlocked = new Map();
      for (const offset of placements) {
        const shifted = translateCells(piece.cells, offset.x, offset.y);
        for (const cell of blockedCoordinates(shifted, state.cols, state.rows, occupied)) {
          stepBlocked.set(`${cell.x},${cell.y}`, cell);
        }
      }
      if (stepBlocked.size) {
        for (const [key, cell] of stepBlocked) blocked.set(key, cell);
        stopped = true;
        break;
      }
      current = step.offset;
      acceptedPath.push(cloneOffset(current));
    }
    if (stopped) break;
    current = waypoint;
  }

  const cells = translateCells(piece.cells, endpoint.x, endpoint.y);
  const frame = { ...piece.frame, x: piece.frame.x + endpoint.x, y: piece.frame.y + endpoint.y };
  const blockedCells = [...blocked.values()];
  const moved = endpoint.x !== 0 || endpoint.y !== 0;
  return {
    valid: blockedCells.length === 0 && moved,
    cells,
    blockedCells,
    reason: blockedCells.length ? 'path-blocked' : moved ? null : 'no-movement',
    frame,
    acceptedPath: acceptedPath.map(cloneOffset),
    lastValidOffset: cloneOffset(acceptedPath.at(-1)),
  };
}

export function previewMove(state, pieceId, deltaX) {
  if (!Number.isSafeInteger(deltaX)) {
    const piece = findPiece(state, pieceId);
    if (!piece) return invalidPreview('piece-not-found');
    return invalidPathPreview(state, piece, 'invalid-distance');
  }
  return previewMovePath(state, pieceId, [{ x: deltaX, y: 0 }]);
}

function sameOccupiedCells(first, second) {
  if (first.length !== second.length) return false;
  const keys = new Set(first.map(({ x, y }) => `${x},${y}`));
  return second.every(({ x, y }) => keys.has(`${x},${y}`));
}

export function previewRotation(state, pieceId, direction = 'clockwise') {
  const piece = findPiece(state, pieceId);
  if (!piece) return invalidPreview('piece-not-found');
  if (state.status !== 'playing') return invalidPreview('game-over', piece.frame);
  if (direction !== 'clockwise' && direction !== 'counterclockwise') {
    return invalidPathPreview(state, piece, 'invalid-direction');
  }

  const { x: frameX, y: frameY, size } = piece.frame;
  let cells = piece.cells.map(({ x, y }) => {
    const localX = x - frameX;
    const localY = y - frameY;
    return direction === 'clockwise'
      ? { x: frameX + size - 1 - localY, y: frameY + localX }
      : { x: frameX + localY, y: frameY + size - 1 - localX };
  });

  const minX = Math.min(...cells.map((cell) => cell.x));
  const maxX = Math.max(...cells.map((cell) => cell.x));
  const minY = Math.min(...cells.map((cell) => cell.y));
  const maxY = Math.max(...cells.map((cell) => cell.y));
  const correctionX = minX < 0 ? -minX : maxX >= state.cols ? state.cols - 1 - maxX : 0;
  const correctionY = minY < 0 ? -minY : maxY >= state.rows ? state.rows - 1 - maxY : 0;
  if (correctionX || correctionY) cells = translateCells(cells, correctionX, correctionY);

  const frame = { x: frameX + correctionX, y: frameY + correctionY, size };
  if (sameOccupiedCells(piece.cells, cells)) {
    return {
      valid: false,
      cells,
      blockedCells: [],
      reason: 'no-rotation',
      frame,
      acceptedPath: [{ x: 0, y: 0 }],
      lastValidOffset: { x: 0, y: 0 },
    };
  }
  const others = occupiedByOthers(state.pieces, pieceId);
  let blockedCells = blockedCoordinates(cells, state.cols, state.rows, others);
  let finalCells = cells;
  let finalFrame = frame;
  if (blockedCells.length) {
    // Variant B: retry with the rotated piece lifted upward by the smallest shift that fits.
    for (let shift = 1; shift < size; shift += 1) {
      const lifted = translateCells(cells, 0, -shift);
      if (lifted.some((cell) => cell.y < 0)) break;
      if (blockedCoordinates(lifted, state.cols, state.rows, others).length === 0) {
        finalCells = lifted;
        finalFrame = { ...frame, y: frame.y - shift };
        blockedCells = [];
        break;
      }
    }
  }
  return {
    valid: blockedCells.length === 0,
    cells: finalCells,
    blockedCells,
    reason: blockedCells.length ? 'rotation-overlap' : null,
    frame: finalFrame,
    acceptedPath: [{ x: 0, y: 0 }],
    lastValidOffset: { x: 0, y: 0 },
  };
}

function settle(pieces, rows, events) {
  let current = pieces;
  while (true) {
    const occupied = occupiedByOthers(current, null);
    const movingIds = new Set();
    for (const piece of current) {
      const canFall = piece.cells.every((cell) => {
        const below = `${cell.x},${cell.y + 1}`;
        const belowOwner = occupied.get(below);
        return cell.y + 1 < rows && (belowOwner === undefined || belowOwner === piece.id);
      });
      if (canFall) movingIds.add(piece.id);
    }
    if (!movingIds.size) return current;
    current = current.map((piece) => movingIds.has(piece.id)
      ? { ...piece, cells: translateCells(piece.cells, 0, 1), frame: { ...piece.frame, y: piece.frame.y + 1 } }
      : piece);
    addSnapshotEvent(events, { type: 'fall', pieceIds: [...movingIds] }, current);
  }
}

function connectedComponents(cells) {
  const remaining = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const components = [];
  while (remaining.size) {
    const [firstKey, firstCell] = remaining.entries().next().value;
    remaining.delete(firstKey);
    const queue = [firstCell];
    const component = [];
    while (queue.length) {
      const cell = queue.shift();
      component.push(cell);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const key = `${cell.x + dx},${cell.y + dy}`;
        if (remaining.has(key)) {
          queue.push(remaining.get(key));
          remaining.delete(key);
        }
      }
    }
    components.push(component);
  }
  return components;
}

function findClearableRows(pieces, cols, rows) {
  const byRow = Array.from({ length: rows }, () => new Map());
  for (const piece of pieces) {
    for (const cell of piece.cells) byRow[cell.y].set(cell.x, piece.color);
  }
  return byRow.flatMap((cells, y) => {
    if (cells.size !== cols) return [];
    const colors = new Set(cells.values());
    return colors.size === 1 || colors.has(RAINBOW_COLOR) ? [y] : [];
  });
}

function removeCells(pieces, shouldRemove, nextId) {
  const nextPieces = [];
  for (const piece of pieces) {
    const remaining = piece.cells.filter((cell) => !shouldRemove(cell));
    if (!remaining.length) continue;
    if (remaining.length === piece.cells.length) {
      nextPieces.push(clonePiece(piece));
      continue;
    }
    const components = connectedComponents(remaining);
    components.forEach((cells, index) => {
      nextPieces.push({
        id: index === 0 ? piece.id : nextId(),
        color: piece.color,
        cells: cells.map(cloneCell),
        frame: makeFrame(cells),
      });
    });
  }
  return nextPieces;
}

function resolvePhysics(pieces, state, events, idFactory) {
  let current = pieces;
  let score = 0;
  while (true) {
    current = settle(current, state.rows, events);
    const rows = findClearableRows(current, state.cols, state.rows);
    if (!rows.length) break;
    const clearedRows = new Set(rows);
    current = removeCells(current, (cell) => clearedRows.has(cell.y), idFactory);
    score += rows.length * 100;
    addSnapshotEvent(events, { type: 'clear', rows: [...rows] }, current);
  }
  return { pieces: current, score };
}

function makeIdFactory(start) {
  let next = start;
  return {
    next: () => `p${next++}`,
    value: () => next,
  };
}

function firstAvailableMove(state) {
  return state.pieces.some((piece) => previewMove(state, piece.id, -1).valid || previewMove(state, piece.id, 1).valid);
}

function hasReadyRows(pieces, cols, rows) {
  return findClearableRows(pieces, cols, rows).length > 0;
}

function insertRowAtBottom(state, row) {
  for (const segment of row) {
    const cells = Array.from({ length: segment.length }, (_, index) => ({ x: segment.x + index, y: state.rows - 1 }));
    state.pieces.push({ id: `p${state._nextId++}`, color: segment.color, cells, frame: makeFrame(cells) });
  }
}

function fallbackStart(cols, rows, palette) {
  const pieces = [];
  const firstY = rows - Math.min(3, rows);
  let serial = 1;
  for (let y = firstY; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 2) {
      const pieceCells = [{ x, y }];
      pieces.push({ id: `p${serial++}`, color: palette[(y - firstY) % palette.length], cells: pieceCells, frame: { x, y, size: 1 } });
    }
  }
  return pieces;
}

function secondColorChance(score, incomingTurn) {
  if (incomingTurn <= 4) return 0;
  if (score <= 1000) return 0.1;
  if (score >= 2000) return 0.35;
  return 0.1 + ((score - 1000) / 1000) * 0.25;
}

function easySelectionChance(score) {
  if (score <= 1000) return 1;
  if (score >= 2000) return 0;
  return (2000 - score) / 1000;
}

function generateTrialRow(cols, palette, random, incomingTurn, score, baseColor, forcedColor = null) {
  const row = generateRow(cols, palette, random);
  if (forcedColor) return row.map((segment) => ({ ...segment, color: forcedColor }));
  const chance = secondColorChance(score, incomingTurn);
  for (const segment of row) {
    segment.color = baseColor;
    if (chance && palette.length > 1 && random() < chance) {
      const alternatives = [...new Set(palette.filter((color) => color !== baseColor))];
      if (alternatives.length) segment.color = alternatives[Math.floor(random() * alternatives.length)];
    }
  }
  if (score >= COLOR_DEBUT_SCORE && row.length) {
    const rowColor = row[0].color;
    return row.map((segment) => ({ ...segment, color: rowColor }));
  }
  return row;
}

function chooseCompatibleGaps(state, row, seed) {
  const rowColor = row[0]?.color;
  if (!row.length || row.some((segment) => segment.color !== rowColor)) return row;
  const gapCount = state.cols - row.reduce((total, segment) => total + segment.length, 0);
  const shifted = state.pieces.map((item) => ({
    ...item,
    cells: translateCells(item.cells, 0, -1),
    frame: { ...item.frame, y: item.frame.y - 1 },
  }));
  const foreignBottomCount = (segments) => {
    const inserted = segments.map((segment, index) => {
      const cells = Array.from({ length: segment.length }, (_, x) => ({ x: segment.x + x, y: state.rows - 1 }));
      return { id: `compat-${index}`, color: rowColor, cells, frame: makeFrame(cells) };
    });
    let count = 0;
    for (const item of settle([...shifted, ...inserted], state.rows, null)) {
      if (item.color !== rowColor && item.color !== RAINBOW_COLOR) count += item.cells.filter((cell) => cell.y === state.rows - 1).length;
    }
    return count;
  };

  let best = row;
  let lowestForeign = foreignBottomCount(row);
  if (!lowestForeign) return row;
  const mirrored = row.map((segment) => ({
    ...segment,
    x: state.cols - segment.x - segment.length,
  })).reverse();
  const alternatives = [mirrored];
  const layoutRandom = createRandom((seed ^ 0x9e3779b1) >>> 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const gaps = Array(row.length + 1).fill(0);
    for (let gap = 0; gap < gapCount; gap += 1) gaps[Math.floor(layoutRandom() * gaps.length)] += 1;
    let position = 0;
    alternatives.push(row.map((segment, index) => {
      position += gaps[index];
      const x = position;
      position += segment.length;
      return { ...segment, x };
    }));
  }
  for (const candidate of alternatives) {
    const foreignCount = foreignBottomCount(candidate);
    if (foreignCount < lowestForeign) {
      best = candidate;
      lowestForeign = foreignCount;
    }
    if (!lowestForeign) break;
  }
  return best;
}

function trialRowColorMode(state, debutCount = state._debutRowsReserved ?? 0) {
  const baseColor = state._trialColor ?? state.palette[0];
  const secondColor = state.palette.find((color) => color !== baseColor) ?? state.palette[1];
  const forcedSecondColor = state.score >= COLOR_DEBUT_SCORE && debutCount < COLOR_DEBUT_ROWS ? secondColor : null;
  return {
    baseColor,
    forcedSecondColor,
    forcedRowColor: forcedSecondColor ?? (state.score < COLOR_DEBUT_SCORE ? baseColor : null),
  };
}

function copyRow(row) {
  return row.map((segment) => ({ ...segment }));
}

// ---------------------------------------------------------------------------
// Rainbow strip planning. The decision for the row about to be prepared comes from its own
// reproducible stream (root state of the generator at the start of the preparation and the
// row number); it never consumes the game's main generator, so rows, layouts and every later
// draw stay exactly as they were before the strip existed.
// ---------------------------------------------------------------------------
const rainbowSuitableSegments = (row) => (row.length >= 2
  ? row.flatMap((segment, index) => (segment.length >= RAINBOW_MIN_LENGTH && segment.length <= RAINBOW_MAX_LENGTH ? [index] : []))
  : []);

export const rowHasRainbow = (row) => Array.isArray(row) && row.some((segment) => segment.color === RAINBOW_COLOR);

// null: no strip may appear in the row about to be prepared. Otherwise { index, pick }:
// `index` is the number of this row among all prepared rows, `pick` in [0, 1) chooses the segment.
function planRainbow(state, rootSeed) {
  if (!state.trial || state.score < RAINBOW_SCORE) return null;
  const index = state._rowsPrepared ?? 0;
  const recent = state._rainbowRows ?? [];
  if (recent.length && index - recent.at(-1) <= RAINBOW_MIN_BETWEEN) return null;
  if (recent.length >= RAINBOW_MAX_IN_WINDOW && index - recent.at(-RAINBOW_MAX_IN_WINDOW) < RAINBOW_WINDOW) return null;
  const stream = createRandom((rootSeed ^ Math.imul(index + 29, 0x27d4eb2f)) >>> 0);
  stream(); stream();
  const roll = stream();
  const pick = stream();
  if (state._rainbowFirstDone === true && roll >= RAINBOW_CHANCE) return null;
  return { index, pick };
}

// Returns the row unchanged when it has no suitable segment (the appearance then does not count).
function placeRainbow(row, plan) {
  const suitable = plan ? rainbowSuitableSegments(row) : [];
  if (!suitable.length) return row;
  const chosen = suitable[Math.min(suitable.length - 1, Math.floor(plan.pick * suitable.length))];
  return row.map((segment, index) => (index === chosen ? { ...segment, color: RAINBOW_COLOR } : { ...segment }));
}

// Counters of a state after one more row was prepared, with or without a strip.
function rainbowCountersAfter(state, row) {
  const placed = rowHasRainbow(row);
  const recent = state._rainbowRows ?? [];
  return {
    _rowsPrepared: (state._rowsPrepared ?? 0) + 1,
    _rainbowRows: placed ? [...recent, state._rowsPrepared ?? 0].slice(-RAINBOW_MAX_IN_WINDOW) : [...recent],
    _rainbowFirstDone: state._rainbowFirstDone === true || placed,
  };
}

function stackHeight(pieces, rows) {
  let top = rows;
  for (const piece of pieces) for (const cell of piece.cells) top = Math.min(top, cell.y);
  return rows - top;
}

function updateDroughtCounters(nextState, startingState) {
  if (nextState.score > startingState.score) {
    nextState._droughtTurns = 0;
    nextState._droughtRescueIssued = false;
  } else {
    nextState._droughtTurns = Math.min(DROUGHT_RESCUE_TURNS, (startingState._droughtTurns ?? 0) + 1);
    nextState._droughtRescueIssued = startingState._droughtRescueIssued ?? false;
  }
}

// Trial doubling: copies every piece of the single occupied row one row higher.
// Deterministic (no RNG, no score); new ids come from the shared counter.
function doubleSingleRow(state, nextId, events) {
  const bottom = state.rows - 1;
  const copies = state.pieces.map((piece) => ({
    id: nextId(),
    color: piece.color,
    cells: piece.cells.map(({ x, y }) => ({ x, y: y - 1 })),
    frame: { ...piece.frame, y: piece.frame.y - 1 },
  }));
  if (copies.some((piece) => piece.cells.some((cell) => cell.y !== bottom - 1))) {
    throw new Error('doubling requires a single occupied row');
  }
  state.pieces = [...state.pieces, ...copies];
  addSnapshotEvent(events, { type: 'double', rows: 1 }, state.pieces);
}

function topOccupied(pieces) {
  return pieces.some((piece) => piece.cells.some((cell) => cell.y === 0));
}

function actionSignature(type, pieceId, direction, cells, path = null) {
  return {
    type,
    pieceId,
    ...(type === 'rotate' ? { direction } : {}),
    ...(type === 'move' && path ? { path: path.map(cloneOffset) } : {}),
    cells: cells.map(cloneCell).sort((a, b) => a.y - b.y || a.x - b.x),
  };
}

function signaturesMatch(first, second) {
  return Boolean(first && second && first.type === second.type && first.pieceId === second.pieceId
    && first.direction === second.direction && sameCells(first.cells, second.cells));
}

function sameCells(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== second.length) return false;
  const sorted = (cells) => cells.map(cloneCell).sort((a, b) => a.y - b.y || a.x - b.x);
  return JSON.stringify(sorted(first)) === JSON.stringify(sorted(second));
}

function nextWitnessStep(witness, matchesFirst) {
  if (!matchesFirst || witness?.steps !== 2 || !witness.second) return null;
  return { first: witness.second, steps: 1 };
}

function buildRescueRow(cols, palette, gapMask, random, incomingTurn, score, baseColor, forcedColor = null) {
  const gaps = new Set(gapMask);
  const segments = [];
  for (let x = 0; x < cols;) {
    if (gaps.has(x)) { x += 1; continue; }
    const end = (() => { let next = x; while (next < cols && !gaps.has(next)) next += 1; return next; })();
    const length = Math.min(4, end - x);
    let color = forcedColor ?? baseColor;
    const chance = secondColorChance(score, incomingTurn);
    if (!forcedColor && chance && palette.length > 1 && random() < chance) {
      const alternatives = [...new Set(palette.filter((candidate) => candidate !== baseColor))];
      if (alternatives.length) color = alternatives[Math.floor(random() * alternatives.length)];
    }
    segments.push({ x, length, color });
    x += length;
  }
  return segments;
}

function rescueGapMasks(state) {
  const candidates = [];
  const columnDepths = Array(state.cols).fill(-1);
  for (const piece of state.pieces) for (const cell of piece.cells) {
    columnDepths[cell.x] = Math.max(columnDepths[cell.x], cell.y);
  }
  // Keep the mask search bounded on custom widths and leave room for a piece.
  const columns = columnDepths.map((_, x) => x)
    .sort((a, b) => columnDepths[b] - columnDepths[a] || a - b)
    .slice(0, 8).sort((a, b) => a - b);
  for (let gapCount = 2; gapCount <= Math.min(4, state.cols - 1); gapCount += 1) {
    const choose = (start, selected) => {
      if (selected.length === gapCount) {
        let priority = 0;
        for (const x of selected) {
          const deepest = columnDepths[x];
          if (deepest === state.rows - 1) priority += 3;
          else if (deepest === state.rows - 2) priority += 2;
          else if (deepest >= state.rows - 4) priority += 1;
        }
        candidates.push({ gaps: [...selected], priority });
        return;
      }
      for (let index = start; index < columns.length; index += 1) {
        choose(index + 1, [...selected, columns[index]]);
      }
    };
    choose(0, []);
  }
  candidates.sort((a, b) => b.priority - a.priority || a.gaps[0] - b.gaps[0]
    || a.gaps.length - b.gaps.length || a.gaps.join(',').localeCompare(b.gaps.join(',')));
  return candidates;
}

function makePlacementPotential(state, piece) {
  const rows = Array.from({ length: state.rows }, () => new Map());
  for (const other of state.pieces) {
    if (other.id === piece.id) continue;
    for (const cell of other.cells) rows[cell.y].set(cell.x, other.color);
  }
  return (cells) => {
    const affectedRows = new Set([...piece.cells, ...cells].map((cell) => cell.y));
    const rowScores = [];
    for (const y of affectedRows) {
      const counts = new Map();
      let wildcards = 0;
      const addCell = (color) => {
        if (color === RAINBOW_COLOR) wildcards += 1;
        else counts.set(color, (counts.get(color) ?? 0) + 1);
      };
      for (const color of rows[y].values()) addCell(color);
      for (const cell of cells) if (cell.y === y) addCell(piece.color);
      const occupied = [...counts.values()].reduce((sum, count) => sum + count, 0) + wildcards;
      const matching = wildcards > 0 ? occupied : Math.max(0, ...counts.values());
      rowScores.push(matching === state.cols ? 10000 : matching * matching);
    }
    return rowScores.reduce((sum, value) => sum + value, 0);
  };
}

function legalTrialActions(state, budget, maxActions = 48) {
  const candidates = [];
  const directions = [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const owners = new Uint32Array(state.cols * state.rows);
  for (let pieceIndex = 0; pieceIndex < state.pieces.length; pieceIndex += 1) {
    for (const cell of state.pieces[pieceIndex].cells) owners[cell.y * state.cols + cell.x] = pieceIndex + 1;
  }
  const offsetWidth = state.cols * 2 + 1;
  const offsetKey = (x, y) => (y + state.rows) * offsetWidth + x + state.cols;
  const reconstructPath = (nodes, nodeIndex) => {
    const path = [];
    for (let index = nodeIndex; index >= 0; index = nodes[index].parent) {
      path.push({ x: nodes[index].x, y: nodes[index].y });
    }
    path.reverse();
    return path;
  };

  for (let pieceIndex = 0; pieceIndex < state.pieces.length; pieceIndex += 1) {
    const piece = state.pieces[pieceIndex];
    const potential = makePlacementPotential(state, piece);
    const validOffset = ({ x, y }) => piece.cells.every((cell) => {
      const targetX = cell.x + x, targetY = cell.y + y;
      return targetX >= 0 && targetX < state.cols && targetY >= 0 && targetY < state.rows
        && (owners[targetY * state.cols + targetX] === 0 || owners[targetY * state.cols + targetX] === pieceIndex + 1);
    });
    const nodes = [{ x: 0, y: 0, parent: -1 }];
    const seen = new Set([offsetKey(0, 0)]);
    for (let cursor = 0; cursor < nodes.length; cursor += 1) {
      const entry = nodes[cursor];
      for (const direction of directions) {
        const x = entry.x + direction.x;
        const y = entry.y + direction.y;
        const key = offsetKey(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        budget.searchStates += 1;
        if (budget.searchStates > budget.searchLimit) { budget.exhausted = true; break; }
        const offset = { x, y };
        if (!validOffset(offset)) continue;
        const nodeIndex = nodes.length;
        nodes.push({ x, y, parent: cursor });
        const cells = piece.cells.map((cell) => ({ x: cell.x + x, y: cell.y + y }));
        candidates.push({ type: 'move', pieceId: piece.id, nodeIndex, nodes, offset, cells, potential: potential(cells) });
      }
      if (budget.exhausted) break;
    }
    if (budget.exhausted) break;
    for (const direction of ['clockwise', 'counterclockwise']) {
      budget.searchStates += 1;
      if (budget.searchStates > budget.searchLimit) { budget.exhausted = true; break; }
      const preview = previewRotation(state, piece.id, direction);
      if (!preview.valid) continue;
      candidates.push({
        type: 'rotate', pieceId: piece.id, direction, preview,
        potential: potential(preview.cells),
      });
    }
    if (budget.exhausted) break;
  }

  candidates.sort((a, b) => b.potential - a.potential || a.pieceId.localeCompare(b.pieceId)
    || a.type.localeCompare(b.type) || (a.direction ?? '').localeCompare(b.direction ?? '')
    || JSON.stringify(a.cells ?? a.preview.cells).localeCompare(JSON.stringify(b.cells ?? b.preview.cells)));
  const actions = [];
  for (const candidate of candidates.slice(0, maxActions * 2)) {
    if (candidate.type === 'rotate') { actions.push(candidate); continue; }
    budget.previewChecks += 1;
    if (budget.previewChecks > budget.previewLimit) { budget.exhausted = true; break; }
    const path = reconstructPath(candidate.nodes, candidate.nodeIndex);
    const preview = previewMovePath(state, candidate.pieceId, path);
    if (!preview.valid || preview.lastValidOffset.x !== candidate.offset.x || preview.lastValidOffset.y !== candidate.offset.y) continue;
    actions.push({ ...candidate, path, preview });
    if (actions.length >= maxActions) break;
  }
  return actions;
}

function simulateTrialAction(state, action, { prepareNext = false, refreshHeldWitness = false } = {}) {
  const event = action.type === 'rotate'
    ? { type: 'rotate', pieceId: action.pieceId, direction: action.direction }
    : { type: 'move', pieceId: action.pieceId, path: action.preview.acceptedPath, lastValidOffset: action.preview.lastValidOffset };
  return finalizeMove(state, action.pieceId, action.preview, event, {
    recordEvents: false,
    prepareNext,
    refreshHeldWitness,
  });
}

function findTrialWitness(state, budget, firstActions, { deduplicateFirstStates = false, maxFirstStates = 6 } = {}) {
  const startingScore = state.score;
  const candidates = [];
  const seenFirstStates = deduplicateFirstStates ? new Set() : null;
  for (const action of firstActions) {
    if (budget.transitions >= budget.transitionLimit) { budget.exhausted = true; break; }
    budget.transitions += 1;
    const result = simulateTrialAction(state, action);
    if (result.state.status !== 'playing') continue;
    const first = actionSignature(action.type, action.pieceId, action.direction, action.preview.cells, action.preview.acceptedPath);
    if (result.state.score > startingScore) return { first, steps: 1 };
    const consumedPause = state.skipNextRise && !result.state.skipNextRise;
    if (seenFirstStates) {
      const stateKey = JSON.stringify({
        pieces: result.state.pieces.map((item) => ({
          id: item.id,
          color: item.color,
          cells: item.cells.map(cloneCell).sort((a, b) => a.y - b.y || a.x - b.x),
          frame: item.frame,
        })),
        row: result.state.nextRow,
        kind: result.state.nextRowKind,
        skipNextRise: result.state.skipNextRise,
        skipRiseUsed: result.state.skipRiseUsed,
        rng: result.state._rng,
        nextId: result.state._nextId,
        score: result.state.score,
        doubled: result.doubled ?? null,
      });
      if (seenFirstStates.has(stateKey)) continue;
      seenFirstStates.add(stateKey);
    }
    candidates.push({ first, state: result.state, keepRow: result.doubled === 'replace' || consumedPause });
    if (candidates.length >= maxFirstStates) break;
  }

  for (const candidate of candidates) {
    if (budget.exhausted) return null;
    const continuationState = { ...candidate.state, _witness: null };
    let continuationRow = null;
    let continuationRng = continuationState._rng;
    let continuationKind = candidate.state.nextRowKind ?? 'regular';
    let continuationMode = 'generated';
    if (candidate.keepRow) {
      continuationRow = copyRow(candidate.state.nextRow);
      continuationMode = 'reserved';
    } else {
      const random = createRandom(continuationState._rng);
      const rootSeed = random.state;
      const debutCount = continuationState._debutRowsReserved ?? 0;
      const { baseColor, forcedSecondColor, forcedRowColor } = trialRowColorMode(continuationState, debutCount);
      continuationRow = generateTrialRow(continuationState.cols, continuationState.palette, random, continuationState.turn + 1, continuationState.score, baseColor, forcedRowColor);
      if (continuationState.score >= COLOR_DEBUT_SCORE) {
        continuationRow = chooseCompatibleGaps(continuationState, continuationRow, random.state);
      }
      continuationRng = random.state;
      continuationRow = placeRainbow(continuationRow, planRainbow(continuationState, rootSeed));
      Object.assign(continuationState, rainbowCountersAfter(continuationState, continuationRow));
      if (forcedSecondColor) continuationState._debutRowsReserved = debutCount + 1;
      continuationState.nextRow = continuationRow;
      continuationState.nextRowKind = 'regular';
      continuationState._rng = continuationRng;
      continuationKind = 'regular';
    }

    const secondActions = legalTrialActions(continuationState, budget, 16);
    for (const action of secondActions) {
      if (budget.transitions >= budget.transitionLimit) { budget.exhausted = true; break; }
      budget.transitions += 1;
      const result = simulateTrialAction(continuationState, action);
      if (result.state.status === 'playing' && result.state.score > startingScore) {
        return {
          first: candidate.first,
          second: actionSignature(action.type, action.pieceId, action.direction, action.preview.cells, action.preview.acceptedPath),
          steps: 2,
          continuationRow: copyRow(continuationRow),
          continuationRng,
          continuationKind,
          continuationMode,
          continuationDebutRowsReserved: continuationState._debutRowsReserved ?? 0,
          continuationRowsPrepared: continuationState._rowsPrepared ?? 0,
          continuationRainbowRows: [...(continuationState._rainbowRows ?? [])],
          continuationRainbowFirstDone: continuationState._rainbowFirstDone === true,
        };
      }
    }
    if (budget.exhausted) return null;
  }
  return null;
}

function findHeldWitness(state) {
  if (!state.trial || state.status !== 'playing' || state.score >= HELD_WITNESS_SCORE_LIMIT) return null;
  const poolBudget = makeTrialSearchBudget(0, 900, 1800);
  const firstActions = legalTrialActions(state, poolBudget, 48);
  if (!firstActions.length) return null;
  const witnessBudget = makeTrialSearchBudget(220, 1400, 2800);
  const witness = findTrialWitness(state, witnessBudget, firstActions, {
    deduplicateFirstStates: true,
    maxFirstStates: 12,
  });
  return witness;
}

function makeTrialSearchBudget(transitionLimit, previewLimit, searchLimit = previewLimit * 2) {
  return { transitions: 0, transitionLimit, previewChecks: 0, previewLimit, searchStates: 0, searchLimit, exhausted: false };
}

function selectTrialPreview(state, random) {
  const incomingTurn = state.turn + 1;
  const rootSeed = random.state;
  const debutCount = state._debutRowsReserved ?? 0;
  const { baseColor, forcedSecondColor, forcedRowColor } = trialRowColorMode(state, debutCount);
  let fallbackRow = generateTrialRow(state.cols, state.palette, random, incomingTurn, state.score, baseColor, forcedRowColor);
  if (state.score >= COLOR_DEBUT_SCORE) fallbackRow = chooseCompatibleGaps(state, fallbackRow, rootSeed);
  // The strip goes onto every ordinary candidate row before any witness search, so the search
  // and the shown row share one composition. A candidate without a suitable segment stays plain.
  const rainbowPlan = planRainbow(state, rootSeed);
  fallbackRow = placeRainbow(fallbackRow, rainbowPlan);
  const attemptEasy = random() < easySelectionChance(state.score);
  const fallbackRng = random.state;
  const nearCeiling = state.rows - stackHeight(state.pieces, state.rows) <= 2;
  const droughtDue = (state._droughtTurns ?? 0) >= DROUGHT_RESCUE_TURNS && !state._droughtRescueIssued;
  const shouldSearch = attemptEasy || nearCeiling || droughtDue;
  const finish = (row, kind, skipNextRise, witness, rngState, rescued = false) => ({
    row, kind, skipNextRise, witness, rngState,
    debutRowsReserved: debutCount + (forcedSecondColor ? 1 : 0),
    droughtRescueIssued: (state._droughtRescueIssued ?? false) || (rescued && droughtDue),
    ...rainbowCountersAfter(state, row),
  });
  if (!shouldSearch) return finish(fallbackRow, 'regular', false, null, fallbackRng);

  const poolBudget = makeTrialSearchBudget(0, 3200, 7000);
  const firstActionPool = legalTrialActions(state, poolBudget, 32);
  if (!firstActionPool.length) return finish(fallbackRow, 'regular', false, null, fallbackRng);

  const regularBudget = makeTrialSearchBudget(220, 2600, 5000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row = fallbackRow;
    let candidateRng = fallbackRng;
    if (attempt > 0) {
      const candidateRandom = createRandom((rootSeed ^ Math.imul(attempt + 3, 0x9e3779b1)) >>> 0);
      row = generateTrialRow(state.cols, state.palette, candidateRandom, incomingTurn, state.score, baseColor, forcedRowColor);
      if (state.score >= COLOR_DEBUT_SCORE) row = chooseCompatibleGaps(state, row, candidateRandom.state);
      row = placeRainbow(row, rainbowPlan);
      candidateRng = candidateRandom.state;
    }
    const candidate = { ...state, nextRow: copyRow(row), nextRowKind: 'regular', skipNextRise: false, _witness: null, _rng: candidateRng, _debutRowsReserved: debutCount + (forcedSecondColor ? 1 : 0), ...rainbowCountersAfter(state, row) };
    const witness = findTrialWitness(candidate, regularBudget, firstActionPool);
    if (witness) return finish(row, 'regular', false, witness, candidateRng);
    if (regularBudget.exhausted) break;
  }

  if (nearCeiling || droughtDue || (state.score < 1000 && attemptEasy)) {
    const masks = rescueGapMasks(state);
    const rescueBudget = makeTrialSearchBudget(240, 3000, 5500);
    for (const [index, { gaps }] of masks.slice(0, 24).entries()) {
      const candidateRandom = createRandom((rootSeed ^ Math.imul(index + 101, 0x85ebca6b)) >>> 0);
      const row = buildRescueRow(state.cols, state.palette, gaps, candidateRandom, incomingTurn, state.score, baseColor, forcedRowColor);
      const candidateRng = candidateRandom.state;
      const candidate = { ...state, nextRow: copyRow(row), nextRowKind: 'rescue', skipNextRise: false, _witness: null, _rng: candidateRng, _debutRowsReserved: debutCount + (forcedSecondColor ? 1 : 0), ...rainbowCountersAfter(state, row) };
      const witness = findTrialWitness(candidate, rescueBudget, firstActionPool);
      if (witness) return finish(row, 'rescue', false, witness, candidateRng, true);
      if (rescueBudget.exhausted) break;
    }
  }

  if (attemptEasy && state.score < 1000 && !state.skipRiseUsed) {
    const candidate = { ...state, nextRow: copyRow(fallbackRow), nextRowKind: 'regular', skipNextRise: true, _witness: null, _rng: fallbackRng, ...rainbowCountersAfter(state, fallbackRow) };
    const skipBudget = makeTrialSearchBudget(180, 2400, 4500);
    const witness = findTrialWitness(candidate, skipBudget, firstActionPool);
    if (witness) return finish(fallbackRow, 'regular', true, witness, fallbackRng);
  }
  return finish(fallbackRow, 'regular', false, null, fallbackRng);
}

// The fixed A1 set: a hammer with `hammerCharges` charges and one charge of a line tool.
export function makeToolSlots(lineTool = 'arrow', hammerCharges = HAMMER_CHARGES) {
  if (lineTool !== 'arrow' && lineTool !== 'cannon') throw new RangeError('Unknown line tool');
  return [{ kind: 'hammer', charges: hammerCharges }, { kind: lineTool, charges: 1 }];
}

// Pure check of the tool slots of one game: { ok: true, tools } with fresh copies, or { ok: false, reason }.
// Reasons: tools (not an array, or more than two slots), tool-shape (a slot is not exactly { kind, charges }),
// tool-kind (unknown kind), tool-duplicate (a kind twice), tool-order (not in TOOL_ORDER), tool-charges
// (not an integer 0..TOOL_CHARGES[kind]), tool-total (more than MAX_TOOL_CARRY charges together).
export function validateToolSlots(tools) {
  if (!Array.isArray(tools) || tools.length > MAX_TOOL_KINDS) return { ok: false, reason: 'tools' };
  const slots = [];
  let total = 0;
  for (const slot of tools) {
    const keys = slot !== null && typeof slot === 'object' && !Array.isArray(slot) ? Object.keys(slot) : null;
    if (!keys || keys.length !== 2 || !keys.includes('kind') || !keys.includes('charges')) return { ok: false, reason: 'tool-shape' };
    const { kind, charges } = slot;
    if (typeof kind !== 'string' || !TOOL_ORDER.includes(kind)) return { ok: false, reason: 'tool-kind' };
    if (slots.some((item) => item.kind === kind)) return { ok: false, reason: 'tool-duplicate' };
    if (slots.length && TOOL_ORDER.indexOf(kind) < TOOL_ORDER.indexOf(slots.at(-1).kind)) return { ok: false, reason: 'tool-order' };
    if (!Number.isSafeInteger(charges) || charges < 0 || charges > TOOL_CHARGES[kind]) return { ok: false, reason: 'tool-charges' };
    total += charges;
    slots.push({ kind, charges });
  }
  if (total > MAX_TOOL_CARRY) return { ok: false, reason: 'tool-total' };
  return { ok: true, tools: slots };
}

// `tools` (trial only) is the loadout of the game: zero to two slots, see validateToolSlots. Without it the fixed A1 set
// (hammer 3, arrow 1) is used, so existing callers and tests keep their games.
export function createGame({ cols = 10, rows = 20, seed = 1, palette = DEFAULT_PALETTE, trial = false, tools } = {}) {
  if (!Number.isInteger(cols) || cols < 4 || !Number.isInteger(rows) || rows < 4) {
    throw new RangeError('cols and rows must be integers of at least 4');
  }
  if (!Array.isArray(palette) || palette.length < 2 || palette.some((color) => typeof color !== 'string')) {
    throw new TypeError('palette must contain at least two color strings');
  }
  let startTools = null;
  if (trial === true) {
    const checked = tools === undefined ? { ok: true, tools: makeToolSlots('arrow') } : validateToolSlots(tools);
    if (!checked.ok) throw new RangeError(`Invalid tools: ${checked.reason}`);
    startTools = checked.tools;
  }

  const normalizedSeed = seed >>> 0;
  const random = createRandom(normalizedSeed);
  const trialEnabled = trial === true;
  const trialColor = trialEnabled ? palette[Math.floor(random() * palette.length)] : null;
  const startPalette = trialEnabled ? [trialColor] : palette;
  let pieces = [];
  let idCounter = 1;

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const generated = generateStartPieces(cols, rows, startPalette, random);
    pieces = generated.map((piece) => ({ ...piece, id: `p${idCounter++}` }));
    const temporary = { cols, rows, pieces, status: 'playing' };
    pieces = settle(pieces, rows, []);
    if (!hasReadyRows(pieces, cols, rows) && firstAvailableMove({ ...temporary, pieces })) break;
    pieces = [];
  }

  if (!pieces.length) pieces = fallbackStart(cols, rows, startPalette);

  const initialState = {
    cols,
    rows,
    palette: [...palette],
    pieces,
    nextRow: [],
    score: 0,
    turn: 0,
    status: 'playing',
    trial: trialEnabled,
    ...(trialEnabled ? { tools: startTools } : {}),
    skipNextRise: false,
    skipRiseUsed: false,
    nextRowKind: 'regular',
    _trialColor: trialColor,
    ...(trialEnabled ? {
      _debutRowsReserved: 0,
      _droughtTurns: 0,
      _droughtRescueIssued: false,
      _rowsPrepared: 0,
      _rainbowRows: [],
      _rainbowFirstDone: false,
    } : {}),
    _rng: random.state,
    _nextId: Math.max(idCounter, pieces.length + 1),
  };
  if (!trialEnabled) {
    initialState.nextRow = generateRow(cols, palette, random);
    initialState._rng = random.state;
    return initialState;
  }
  const selection = selectTrialPreview(initialState, random);
  initialState.nextRow = selection.row;
  initialState.nextRowKind = selection.kind;
  initialState.skipNextRise = selection.skipNextRise;
  initialState._debutRowsReserved = selection.debutRowsReserved;
  initialState._droughtRescueIssued = selection.droughtRescueIssued;
  initialState._rowsPrepared = selection._rowsPrepared;
  initialState._rainbowRows = selection._rainbowRows;
  initialState._rainbowFirstDone = selection._rainbowFirstDone;
  initialState._witness = selection.witness;
  initialState._rng = selection.rngState;
  return initialState;
}

function failedMutation(state, reason) {
  return { state, events: [], changed: false, reason };
}

function finalizeMove(state, pieceId, preview, moveEvent, {
  recordEvents = true,
  prepareNext = true,
  refreshHeldWitness = true,
} = {}) {
  const original = findPiece(state, pieceId);
  const moved = {
    ...clonePiece(original),
    cells: preview.cells.map(cloneCell),
    frame: cloneFrame(preview.frame),
  };
  const events = recordEvents ? [] : null;
  const startingPieces = state.pieces.map((piece) => piece.id === pieceId ? moved : clonePiece(piece));
  addSnapshotEvent(events, moveEvent, startingPieces);
  const idFactory = makeIdFactory(state._nextId ?? 1);
  const physics = resolvePhysics(startingPieces, state, events, idFactory.next);
  const nextState = {
    ...state,
    pieces: physics.pieces,
    score: state.score + physics.score,
    turn: state.turn + 1,
    _nextId: idFactory.value(),
  };
  if (state.trial) updateDroughtCounters(nextState, state);
  const witness = prepareNext && state.trial ? state._witness : null;
  const witnessMatches = Boolean(witness?.first && signaturesMatch(
    witness.first,
    actionSignature(moveEvent.type, pieceId, moveEvent.direction, preview.cells, preview.acceptedPath),
  ));
  const followingWitness = nextWitnessStep(witness, witnessMatches);

  if (nextState.pieces.some((piece) => piece.cells.some((cell) => cell.y === 0))) {
    nextState.status = 'gameover';
    addSnapshotEvent(events, { type: 'gameover', reason: 'top-overflow' }, nextState.pieces);
    return { state: nextState, events: events ?? [], changed: true, reason: 'top-overflow' };
  }

  let doubled = null;
  const settledStack = state.trial ? stackHeight(nextState.pieces, state.rows) : null;
  if (settledStack === 1) {
    // Trial doubling replaces this turn's rise: the preview, its RNG state and the
    // pause flags stay exactly as they were.
    const doubleIds = makeIdFactory(nextState._nextId);
    doubleSingleRow(nextState, doubleIds.next, events);
    nextState._nextId = doubleIds.value();
    nextState._witness = followingWitness
      ?? (prepareNext && refreshHeldWitness ? findHeldWitness(nextState) : null);
    if (topOccupied(nextState.pieces)) {
      nextState.status = 'gameover';
      addSnapshotEvent(events, { type: 'gameover', reason: 'top-row' }, nextState.pieces);
      return { state: nextState, events: events ?? [], changed: true, reason: 'top-row', doubled: 'replace' };
    }
    return { state: nextState, events: events ?? [], changed: true, reason: null, doubled: 'replace' };
  }

  if (state.trial && physics.score > 0 && settledStack >= 2) {
    nextState._witness = followingWitness
      ?? (prepareNext && refreshHeldWitness ? findHeldWitness(nextState) : null);
    return { state: nextState, events: events ?? [], changed: true, reason: null };
  }

  if (state.trial && state.skipNextRise && settledStack !== 0) {
    nextState.skipNextRise = false;
    nextState.skipRiseUsed = true;
    nextState._witness = followingWitness
      ?? (prepareNext && refreshHeldWitness ? findHeldWitness(nextState) : null);
    if (topOccupied(nextState.pieces)) {
      nextState.status = 'gameover';
      addSnapshotEvent(events, { type: 'gameover', reason: 'top-row' }, nextState.pieces);
      return { state: nextState, events: events ?? [], changed: true, reason: 'top-row' };
    }
    return { state: nextState, events: events ?? [], changed: true, reason: null };
  }

  // One rise: shift up, insert `row`, settle, clear, then (trial) double a lone row.
  const rise = (row) => {
    nextState.pieces = nextState.pieces.map((piece) => ({
      ...piece,
      cells: translateCells(piece.cells, 0, -1),
      frame: { ...piece.frame, y: piece.frame.y - 1 },
    }));
    insertRowAtBottom(nextState, row);
    addSnapshotEvent(events, { type: 'rise', rows: 1 }, nextState.pieces);
    const postRiseIdFactory = makeIdFactory(nextState._nextId);
    const postRisePhysics = resolvePhysics(nextState.pieces, state, events, postRiseIdFactory.next);
    nextState.pieces = postRisePhysics.pieces;
    nextState.score += postRisePhysics.score;
    nextState._nextId = postRiseIdFactory.value();
    if (state.trial) updateDroughtCounters(nextState, state);
    if (state.trial && stackHeight(nextState.pieces, state.rows) === 1) {
      const doubleIds = makeIdFactory(nextState._nextId);
      doubleSingleRow(nextState, doubleIds.next, events);
      nextState._nextId = doubleIds.value();
      doubled = 'after-rise';
    }
    if (state.trial && nextState.pieces.length === 0) {
      insertRowAtBottom(nextState, row);
      addSnapshotEvent(events, { type: 'refill', rows: 1 }, nextState.pieces);
      const refillIds = makeIdFactory(nextState._nextId);
      doubleSingleRow(nextState, refillIds.next, events);
      nextState._nextId = refillIds.value();
      doubled = 'after-rise';
    }
    if (state.trial && topOccupied(nextState.pieces)) {
      nextState.status = 'gameover';
      addSnapshotEvent(events, { type: 'gameover', reason: 'top-row' }, nextState.pieces);
      return false;
    }
    return true;
  };
  const gameOver = () => ({ state: nextState, events: events ?? [], changed: true, reason: 'top-row', ...(doubled ? { doubled } : {}) });

  if (!rise(state.nextRow)) return gameOver();

  const preparePreview = (rngSeed, witness, signatureMatches) => {
    if (witness && signatureMatches && witness.continuationRow) {
      nextState.nextRow = copyRow(witness.continuationRow);
      nextState.nextRowKind = witness.continuationKind ?? 'regular';
      nextState._rng = witness.continuationRng;
      nextState._witness = nextWitnessStep(witness, true);
      if (state.trial && Number.isInteger(witness.continuationDebutRowsReserved)) {
        nextState._debutRowsReserved = witness.continuationDebutRowsReserved;
      }
      if (state.trial) {
        if (Number.isInteger(witness.continuationRowsPrepared)) {
          nextState._rowsPrepared = witness.continuationRowsPrepared;
          nextState._rainbowRows = [...(witness.continuationRainbowRows ?? [])];
          nextState._rainbowFirstDone = witness.continuationRainbowFirstDone === true;
        } else {
          Object.assign(nextState, rainbowCountersAfter(state, nextState.nextRow));
        }
      }
    } else {
      nextState._witness = null;
      const random = createRandom(rngSeed);
      if (state.trial) {
        const selection = selectTrialPreview(nextState, random);
        nextState.nextRow = selection.row;
        nextState.nextRowKind = selection.kind;
        nextState.skipNextRise = selection.skipNextRise;
        nextState._witness = selection.witness;
        nextState._rng = selection.rngState;
        nextState._debutRowsReserved = selection.debutRowsReserved;
        nextState._droughtRescueIssued = selection.droughtRescueIssued;
        nextState._rowsPrepared = selection._rowsPrepared;
        nextState._rainbowRows = selection._rainbowRows;
        nextState._rainbowFirstDone = selection._rainbowFirstDone;
      } else {
        nextState.nextRow = generateRow(state.cols, state.palette, random);
        nextState.nextRowKind = 'regular';
        nextState._rng = random.state;
      }
    }
  };

  if (prepareNext) {
    preparePreview(state._rng, witness, witnessMatches);
  }
  return { state: nextState, events: events ?? [], changed: true, reason: null, ...(doubled ? { doubled } : {}) };
}

export function movePieceAlongPath(state, pieceId, path) {
  const preview = previewMovePath(state, pieceId, path);
  if (!preview.valid) return failedMutation(state, preview.reason);
  return finalizeMove(state, pieceId, preview, {
    type: 'move',
    pieceId,
    path: preview.acceptedPath.map(cloneOffset),
    lastValidOffset: cloneOffset(preview.lastValidOffset),
  });
}

export function movePiece(state, pieceId, deltaX) {
  const preview = previewMove(state, pieceId, deltaX);
  if (!preview.valid) return failedMutation(state, preview.reason);
  return finalizeMove(state, pieceId, preview, { type: 'move', pieceId, deltaX });
}

export function rotatePiece(state, pieceId, direction = 'clockwise') {
  const preview = previewRotation(state, pieceId, direction);
  if (!preview.valid) return failedMutation(state, preview.reason);
  return finalizeMove(state, pieceId, preview, { type: 'rotate', pieceId, direction });
}

// Area of the cannon for a tapped column: the left column is shifted inside the board near the right edge. One bounds function
// serves the core and the interface preview. null for a target that is not a column of the board.
export function cannonToolBounds(state, target) {
  if (!state || !Number.isInteger(state.cols) || !Number.isInteger(state.rows) || state.cols < CANNON_WIDTH
    || !Number.isInteger(target) || target < 0 || target >= state.cols) return null;
  return { x: Math.min(target, state.cols - CANNON_WIDTH), y: 0, width: CANNON_WIDTH, height: state.rows };
}

// Area of the area hammer for a tapped cell index (y * cols + x): the top-left cell is shifted inside the board near the
// right and bottom edges.
export function areaToolBounds(state, target) {
  if (!state || !Number.isInteger(state.cols) || !Number.isInteger(state.rows) || state.cols < AREA_SIZE || state.rows < AREA_SIZE
    || !Number.isInteger(target) || target < 0 || target >= state.cols * state.rows) return null;
  const tappedX = target % state.cols;
  const tappedY = Math.floor(target / state.cols);
  return { x: Math.min(tappedX, state.cols - AREA_SIZE), y: Math.min(tappedY, state.rows - AREA_SIZE), width: AREA_SIZE, height: AREA_SIZE };
}

function cellsInBounds(state, bounds) {
  if (!bounds || !Array.isArray(state.pieces)) return [];
  const { x, y, width, height } = bounds;
  return state.pieces.flatMap((piece) => piece.cells.filter((cell) => cell.x >= x && cell.x < x + width && cell.y >= y && cell.y < y + height)).map(cloneCell);
}

export function toolTargetCells(state, kind, target) {
  if (kind === 'hammer') return findPiece(state, target)?.cells.map(cloneCell) ?? [];
  if (kind === 'areaHammer') return cellsInBounds(state, areaToolBounds(state, target));
  if (kind === 'cannon') return cellsInBounds(state, cannonToolBounds(state, target));
  if (kind !== 'arrow') return [];
  if (!Number.isInteger(target) || target < 0 || target >= state.rows) return [];
  return state.pieces.flatMap((piece) => piece.cells.filter((cell) => cell.y === target)).map(cloneCell);
}

export function useHammer(state, pieceId) {
  return useTool(state, 'hammer', pieceId);
}

export function useTool(state, kind, target) {
  if (!state?.trial) return failedMutation(state, 'not-trial');
  if (state.status !== 'playing') return failedMutation(state, 'game-over');
  const slot = state.tools?.find((item) => item.kind === kind);
  if (!slot || !Object.hasOwn(TOOL_CHARGES, kind)) return failedMutation(state, 'tool-unavailable');
  if (!Number.isInteger(slot.charges) || slot.charges < 0 || slot.charges > TOOL_CHARGES[kind]) {
    return failedMutation(state, kind === 'hammer' ? 'invalid-hammers' : 'invalid-charges');
  }
  const carried = state.tools.reduce((sum, item) => sum + (Number.isSafeInteger(item?.charges) ? item.charges : 0), 0);
  if (carried > MAX_TOOL_CARRY) return failedMutation(state, kind === 'hammer' ? 'invalid-hammers' : 'invalid-charges');
  if (slot.charges === 0) return failedMutation(state, kind === 'hammer' ? 'no-hammers' : 'no-charges');
  const cells = toolTargetCells(state, kind, target);
  if (!cells.length) return failedMutation(state, kind === 'hammer' ? 'piece-not-found' : 'empty-target');

  const events = [];
  const idFactory = makeIdFactory(state._nextId ?? 1);
  const coordinates = new Set(cells.map(({ x, y }) => `${x},${y}`));
  const pieces = removeCells(state.pieces, ({ x, y }) => coordinates.has(`${x},${y}`), idFactory.next);
  const gain = cells.length * TOOL_CELL_POINTS;
  let actionTarget = target;
  if (kind === 'areaHammer') {
    const bounds = areaToolBounds(state, target);
    actionTarget = bounds.y * state.cols + bounds.x; // the clamped top-left cell
  } else if (kind === 'cannon') actionTarget = cannonToolBounds(state, target).x; // the clamped left column
  const action = kind === 'hammer' ? { type: 'hammer', pieceId: target } : { type: 'tool', kind, target: actionTarget };
  addSnapshotEvent(events, { ...action, cells, gain }, pieces);
  const physics = resolvePhysics(pieces, state, events, idFactory.next);
  const nextState = {
    ...state,
    pieces: physics.pieces,
    score: state.score + gain + physics.score,
    tools: state.tools.map((item) => item === slot ? { ...item, charges: item.charges - 1 } : item),
    _nextId: idFactory.value(),
    _witness: null,
  };
  if (physics.score > 0) {
    nextState._droughtTurns = 0;
    nextState._droughtRescueIssued = false;
  }

  if (topOccupied(nextState.pieces)) {
    nextState.status = 'gameover';
    addSnapshotEvent(events, { type: 'gameover', reason: 'top-overflow' }, nextState.pieces);
    return { state: nextState, events, changed: true, reason: 'top-overflow' };
  }

  if (nextState.pieces.length === 0) {
    insertRowAtBottom(nextState, state.nextRow);
    addSnapshotEvent(events, { type: 'refill', rows: 1 }, nextState.pieces);
    const doubleIds = makeIdFactory(nextState._nextId);
    doubleSingleRow(nextState, doubleIds.next, events);
    nextState._nextId = doubleIds.value();
    const random = createRandom(state._rng);
    const selection = selectTrialPreview(nextState, random);
    nextState.nextRow = selection.row;
    nextState.nextRowKind = selection.kind;
    nextState.skipNextRise = selection.skipNextRise;
    nextState._debutRowsReserved = selection.debutRowsReserved;
    nextState._droughtRescueIssued = selection.droughtRescueIssued;
    nextState._rowsPrepared = selection._rowsPrepared;
    nextState._rainbowRows = selection._rainbowRows;
    nextState._rainbowFirstDone = selection._rainbowFirstDone;
    nextState._witness = selection.witness;
    nextState._rng = selection.rngState;
    return { state: nextState, events, changed: true, reason: null, doubled: 'after-rise' };
  }

  nextState._witness = findHeldWitness(nextState);
  return { state: nextState, events, changed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Trial hint ("Підказати хід", DEMO_PLAN.md section 17).
// Hint search runs the real turn simulation on temporary states, including preview
// preparation when needed. The live board and its generator remain untouched.
// The action pool and the replay budgets bound the work deterministically.
// ---------------------------------------------------------------------------
const HELD_WITNESS_SCORE_LIMIT = 1000;
const HINT_POOL_SIZE = 96;
const HINT_SIMULATION_LIMIT = 160;
const HINT_REPLAY_LIMIT = 4;

function hintFromAction(action, steps, clears) {
  const base = { pieceId: action.pieceId, steps, clears };
  if (action.type === 'rotate') {
    return { kind: 'rotate', ...base, direction: action.direction, path: null, cells: action.preview.cells.map(cloneCell) };
  }
  return {
    kind: 'move', ...base, direction: null,
    path: action.preview.acceptedPath.map(cloneOffset),
    offset: cloneOffset(action.preview.lastValidOffset),
    cells: action.preview.cells.map(cloneCell),
  };
}

// Best single action that clears now: most rows, then move over rotation, then the
// shortest path. Pure helper shared by the tiers below.
function bestImmediateClear(state, pool, simulationLimit) {
  let best = null;
  for (const action of pool.slice(0, simulationLimit)) {
    const result = simulateTrialAction(state, action);
    if (result.state.status !== 'playing' || result.state.score <= state.score) continue;
    const clears = (result.state.score - state.score) / 100;
    const length = action.type === 'move' ? action.path.length : 0;
    const better = !best || clears > best.clears
      || (clears === best.clears && ((best.action.type === 'rotate' && action.type === 'move')
        || (best.action.type === action.type && length < best.length)));
    if (better) best = { action, clears, length };
  }
  return best;
}

function bestStoredImmediateClear(state) {
  if (state._witness?.steps !== 1) return null;
  const action = actionFromSignature(state, state._witness.first);
  if (!action) return null;
  const result = simulateTrialAction(state, action);
  if (result.state.status !== 'playing' || result.state.score <= state.score) return null;
  return { action, clears: (result.state.score - state.score) / 100 };
}

function actionFromSignature(state, signature) {
  if (!signature) return null;
  if (signature.type === 'rotate') {
    const preview = previewRotation(state, signature.pieceId, signature.direction);
    if (!preview.valid || !sameCells(preview.cells, signature.cells)) return null;
    return { type: 'rotate', pieceId: signature.pieceId, direction: signature.direction, preview };
  }
  if (signature.type !== 'move' || !Array.isArray(signature.path)) return null;
  const preview = previewMovePath(state, signature.pieceId, signature.path);
  if (!preview.valid || preview.lastValidOffset.x !== signature.path.at(-1)?.x
    || preview.lastValidOffset.y !== signature.path.at(-1)?.y
    || !sameCells(preview.cells, signature.cells)) return null;
  return { type: 'move', pieceId: signature.pieceId, path: preview.acceptedPath, preview };
}

export const HINT_PULSE_STACK = 10;

// Read-only cue for the interface: true when the hint lamp should draw attention. Needs an active trial game, a stack of at
// least HINT_PULSE_STACK rows and a verified path for the shown row (the same stored witness the journal records as reg1/reg2).
// Pure: no RNG, no search, no state change.
export function shouldPulseHint(state) {
  if (!state || state.trial !== true || state.status !== 'playing' || !Array.isArray(state.pieces)) return false;
  const steps = state._witness?.steps;
  if (steps !== 1 && steps !== 2) return false;
  return stackHeight(state.pieces, state.rows) >= HINT_PULSE_STACK;
}

export function suggestAction(state) {
  if (!state || state.trial !== true || state.status !== 'playing') return null;

  const pool = legalTrialActions(state, makeTrialSearchBudget(0, 3200, 7000), HINT_POOL_SIZE);

  // (1) A single action that clears at least one row right now.
  const immediate = bestImmediateClear(state, pool, HINT_SIMULATION_LIMIT);
  if (immediate) return hintFromAction(immediate.action, 1, immediate.clears);
  const storedImmediate = bestStoredImmediateClear(state);
  if (storedImmediate) return hintFromAction(storedImmediate.action, 1, storedImmediate.clears);
  if (!pool.length) return null;

  // (2) First action of the two-action path the game itself committed to for the
  // reserved preview row (state._witness, installed together with that row).
  const witness = state._witness;
  if (witness?.steps === 2 && witness.first && witness.second && witness.continuationRow) {
    const action = actionFromSignature(state, witness.first);
    if (action) {
      const firstResult = simulateTrialAction(state, action);
      if (firstResult.state.status === 'playing') {
        const heldPreview = firstResult.doubled === 'replace'
          || (state.skipNextRise && !firstResult.state.skipNextRise);
        const rowMatches = JSON.stringify(firstResult.state.nextRow) === JSON.stringify(witness.continuationRow);
        const heldMatches = witness.continuationMode !== 'reserved'
          || (heldPreview && rowMatches && firstResult.state.nextRowKind === witness.continuationKind
            && firstResult.state._rng === witness.continuationRng);
        if (heldMatches) {
          const continuation = {
            ...firstResult.state,
            nextRow: copyRow(witness.continuationRow),
            nextRowKind: witness.continuationKind ?? 'regular',
            _rng: witness.continuationRng,
          };
          const second = actionFromSignature(continuation, witness.second);
          if (second) {
            const secondResult = simulateTrialAction(continuation, second);
            if (secondResult.state.status === 'playing' && secondResult.state.score > state.score) {
              return hintFromAction(action, 2, 0);
            }
          }
        }
      }
    }
  }

  // After a doubled row or consumed pause there may be no stored witness. Search
  // quietly against the held preview, then validate the promising first step with
  // the exact live preview transition before returning any two-step hint.
  const replayWitness = findTrialWitness(
    state,
    makeTrialSearchBudget(220, 1800, 3600),
    pool.slice(0, 40),
    { deduplicateFirstStates: true, maxFirstStates: 12 },
  );
  if (replayWitness?.first) {
    const first = actionFromSignature(state, replayWitness.first);
    if (first) {
      const committed = simulateTrialAction(state, first, { prepareNext: true }).state;
      if (committed.status === 'playing' && committed.score > state.score) return hintFromAction(first, 1, (committed.score - state.score) / 100);
      if (committed.status === 'playing' && replayWitness.steps === 2) {
        let witnessValidated = false;
        const verifiedSecond = replayWitness.second && actionFromSignature(committed, replayWitness.second);
        if (verifiedSecond) {
          const result = simulateTrialAction(committed, verifiedSecond);
          witnessValidated = result.state.status === 'playing' && result.state.score > state.score;
        }
        if (witnessValidated) {
          const followPool = legalTrialActions(committed, makeTrialSearchBudget(0, 1600, 3200), HINT_POOL_SIZE);
          const follow = bestImmediateClear(committed, followPool, HINT_SIMULATION_LIMIT)
            ?? bestStoredImmediateClear(committed);
          if (follow) return hintFromAction(first, 2, 0);
        }
      }
    }
  }

  // (2b) No usable saved witness: exactly replay a small top-ranked subset through
  // the live preview selector and accept only a first step whose actual next state clears.
  for (const action of pool.slice(0, HINT_REPLAY_LIMIT)) {
    const after = simulateTrialAction(state, action, { prepareNext: true }).state;
    if (after.status !== 'playing') continue;
    const followUp = legalTrialActions(after, makeTrialSearchBudget(0, 3200, 7000), 48);
    if (bestImmediateClear(after, followUp, 64)) return hintFromAction(action, 2, 0);
  }
  return null;
}
