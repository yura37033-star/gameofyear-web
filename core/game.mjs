import { createRandom, generateRow, generateStartPieces } from './generator.mjs';

const DEFAULT_PALETTE = ['#5D8FE8', '#F3C969'];

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
      const own = new Set(piece.cells.map((cell) => `${cell.x},${cell.y}`));
      const canFall = piece.cells.every((cell) => {
        const below = `${cell.x},${cell.y + 1}`;
        return cell.y + 1 < rows && (!occupied.has(below) || own.has(below));
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
    if (cells.size !== cols || new Set(cells.values()).size !== 1) return [];
    return [y];
  });
}

function clearRows(pieces, clearRows, nextId) {
  const removedRows = new Set(clearRows);
  const nextPieces = [];
  for (const piece of pieces) {
    const remaining = piece.cells.filter((cell) => !removedRows.has(cell.y));
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
    current = clearRows(current, rows, idFactory);
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

export function createGame({ cols = 10, rows = 16, seed = 1, palette = DEFAULT_PALETTE } = {}) {
  if (!Number.isInteger(cols) || cols < 4 || !Number.isInteger(rows) || rows < 4) {
    throw new RangeError('cols and rows must be integers of at least 4');
  }
  if (!Array.isArray(palette) || palette.length < 2 || palette.some((color) => typeof color !== 'string')) {
    throw new TypeError('palette must contain at least two color strings');
  }

  const normalizedSeed = seed >>> 0;
  const random = createRandom(normalizedSeed);
  let pieces = [];
  let idCounter = 1;

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const generated = generateStartPieces(cols, rows, palette, random);
    pieces = generated.map((piece) => ({ ...piece, id: `p${idCounter++}` }));
    const temporary = { cols, rows, pieces, status: 'playing' };
    pieces = settle(pieces, rows, []);
    if (!hasReadyRows(pieces, cols, rows) && firstAvailableMove({ ...temporary, pieces })) break;
    pieces = [];
  }

  if (!pieces.length) pieces = fallbackStart(cols, rows, palette);

  const nextRow = generateRow(cols, palette, random);
  return {
    cols,
    rows,
    palette: [...palette],
    pieces,
    nextRow,
    score: 0,
    turn: 0,
    status: 'playing',
    _rng: random.state,
    _nextId: Math.max(idCounter, pieces.length + 1),
  };
}

function failedMutation(state, reason) {
  return { state, events: [], changed: false, reason };
}

function finalizeMove(state, pieceId, preview, moveEvent) {
  const original = findPiece(state, pieceId);
  const moved = {
    ...clonePiece(original),
    cells: preview.cells.map(cloneCell),
    frame: cloneFrame(preview.frame),
  };
  const events = [];
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

  if (nextState.pieces.some((piece) => piece.cells.some((cell) => cell.y === 0))) {
    nextState.status = 'gameover';
    addSnapshotEvent(events, { type: 'gameover', reason: 'top-overflow' }, nextState.pieces);
    return { state: nextState, events, changed: true, reason: 'top-overflow' };
  }

  nextState.pieces = nextState.pieces.map((piece) => ({
    ...piece,
    cells: translateCells(piece.cells, 0, -1),
    frame: { ...piece.frame, y: piece.frame.y - 1 },
  }));
  for (const segment of state.nextRow) {
    const cells = Array.from({ length: segment.length }, (_, index) => ({ x: segment.x + index, y: state.rows - 1 }));
    nextState.pieces.push({
      id: `p${nextState._nextId++}`,
      color: segment.color,
      cells,
      frame: makeFrame(cells),
    });
  }
  addSnapshotEvent(events, { type: 'rise', rows: 1 }, nextState.pieces);
  const postRiseIdFactory = makeIdFactory(nextState._nextId);
  const postRisePhysics = resolvePhysics(nextState.pieces, state, events, postRiseIdFactory.next);
  nextState.pieces = postRisePhysics.pieces;
  nextState.score += postRisePhysics.score;
  nextState._nextId = postRiseIdFactory.value();
  const random = createRandom(state._rng);
  nextState.nextRow = generateRow(state.cols, state.palette, random);
  nextState._rng = random.state;
  return { state: nextState, events, changed: true, reason: null };
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
