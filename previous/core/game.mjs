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

function generateTrialRow(cols, palette, random, incomingTurn, score, baseColor) {
  const row = generateRow(cols, palette, random);
  const chance = secondColorChance(score, incomingTurn);
  for (const segment of row) {
    segment.color = baseColor;
    if (chance && palette.length > 1 && random() < chance) {
      const alternatives = [...new Set(palette.filter((color) => color !== baseColor))];
      if (alternatives.length) segment.color = alternatives[Math.floor(random() * alternatives.length)];
    }
  }
  return row;
}

function copyRow(row) {
  return row.map((segment) => ({ ...segment }));
}

function topOccupied(pieces) {
  return pieces.some((piece) => piece.cells.some((cell) => cell.y === 0));
}

function actionSignature(type, pieceId, direction, cells) {
  return {
    type,
    pieceId,
    ...(type === 'rotate' ? { direction } : {}),
    cells: cells.map(cloneCell).sort((a, b) => a.y - b.y || a.x - b.x),
  };
}

function signaturesMatch(first, second) {
  return Boolean(first && second && first.type === second.type && first.pieceId === second.pieceId
    && first.direction === second.direction && JSON.stringify(first.cells) === JSON.stringify(second.cells));
}

function buildRescueRow(cols, palette, gapMask, random, incomingTurn, score, baseColor) {
  const gaps = new Set(gapMask);
  const segments = [];
  for (let x = 0; x < cols;) {
    if (gaps.has(x)) { x += 1; continue; }
    const end = (() => { let next = x; while (next < cols && !gaps.has(next)) next += 1; return next; })();
    const length = Math.min(4, end - x);
    let color = baseColor;
    const chance = secondColorChance(score, incomingTurn);
    if (chance && palette.length > 1 && random() < chance) {
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
      for (const color of rows[y].values()) counts.set(color, (counts.get(color) ?? 0) + 1);
      for (const cell of cells) if (cell.y === y) counts.set(piece.color, (counts.get(piece.color) ?? 0) + 1);
      const occupied = [...counts.values()].reduce((sum, count) => sum + count, 0);
      const largest = Math.max(0, ...counts.values());
      rowScores.push(occupied === state.cols && counts.size === 1 ? 10000 : largest * largest);
    }
    return rowScores.reduce((sum, value) => sum + value, 0);
  };
}

function legalTrialActions(state, budget, maxActions = 48) {
  const candidates = [];
  const directions = [{ x: 0, y: -1 }, { x: -1, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  for (const piece of state.pieces) {
    const potential = makePlacementPotential(state, piece);
    const occupied = new Set(state.pieces.filter((other) => other.id !== piece.id)
      .flatMap((other) => other.cells.map((cell) => `${cell.x},${cell.y}`)));
    const validOffset = ({ x, y }) => piece.cells.every((cell) => {
      const targetX = cell.x + x, targetY = cell.y + y;
      return targetX >= 0 && targetX < state.cols && targetY >= 0 && targetY < state.rows
        && !occupied.has(`${targetX},${targetY}`);
    });
    const queue = [{ offset: { x: 0, y: 0 }, path: [{ x: 0, y: 0 }] }];
    const seen = new Set(['0,0']);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const entry = queue[cursor];
      for (const direction of directions) {
        const offset = { x: entry.offset.x + direction.x, y: entry.offset.y + direction.y };
        const key = `${offset.x},${offset.y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        budget.searchStates += 1;
        if (budget.searchStates > budget.searchLimit) { budget.exhausted = true; break; }
        if (!validOffset(offset)) continue;
        const path = [...entry.path, offset];
        queue.push({ offset, path });
        const cells = piece.cells.map((cell) => ({ x: cell.x + offset.x, y: cell.y + offset.y }));
        candidates.push({ type: 'move', pieceId: piece.id, path, offset, cells, potential: potential(cells) });
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
    const preview = previewMovePath(state, candidate.pieceId, candidate.path);
    if (!preview.valid || preview.lastValidOffset.x !== candidate.offset.x || preview.lastValidOffset.y !== candidate.offset.y) continue;
    actions.push({ ...candidate, preview });
    if (actions.length >= maxActions) break;
  }
  return actions;
}

function simulateTrialAction(state, action) {
  const event = action.type === 'rotate'
    ? { type: 'rotate', pieceId: action.pieceId, direction: action.direction }
    : { type: 'move', pieceId: action.pieceId, path: action.preview.acceptedPath, lastValidOffset: action.preview.lastValidOffset };
  return finalizeMove(state, action.pieceId, action.preview, event, { recordEvents: false, prepareNext: false });
}

function findTrialWitness(state, budget, firstActions) {
  const startingScore = state.score;
  const candidates = [];
  for (const action of firstActions) {
    if (budget.transitions >= budget.transitionLimit) { budget.exhausted = true; break; }
    budget.transitions += 1;
    const result = simulateTrialAction(state, action);
    if (result.state.status !== 'playing') continue;
    const first = actionSignature(action.type, action.pieceId, action.direction, action.preview.cells);
    if (result.state.score > startingScore) return { first, steps: 1 };
    candidates.push({ first, state: result.state });
    if (candidates.length >= 6) break;
  }

  for (const candidate of candidates) {
    if (budget.exhausted) return null;
    const continuationState = { ...candidate.state, _witness: null };
    let continuationRow = null;
    let continuationRng = continuationState._rng;
    if (!(state.skipNextRise && !candidate.state.skipNextRise)) {
      const random = createRandom(continuationState._rng);
      continuationRow = generateTrialRow(continuationState.cols, continuationState.palette, random, continuationState.turn + 1, continuationState.score, continuationState._trialColor ?? continuationState.palette[0]);
      continuationRng = random.state;
      continuationState.nextRow = continuationRow;
      continuationState.nextRowKind = 'regular';
      continuationState._rng = continuationRng;
    }

    const secondActions = legalTrialActions(continuationState, budget, 16);
    for (const action of secondActions) {
      if (budget.transitions >= budget.transitionLimit) { budget.exhausted = true; break; }
      budget.transitions += 1;
      const result = simulateTrialAction(continuationState, action);
      if (result.state.status === 'playing' && result.state.score > startingScore) {
        return {
          first: candidate.first,
          steps: 2,
          continuationRow: continuationRow ? copyRow(continuationRow) : null,
          continuationRng,
          continuationKind: 'regular',
        };
      }
    }
    if (budget.exhausted) return null;
  }
  return null;
}

function makeTrialSearchBudget(transitionLimit, previewLimit, searchLimit = previewLimit * 2) {
  return { transitions: 0, transitionLimit, previewChecks: 0, previewLimit, searchStates: 0, searchLimit, exhausted: false };
}

function selectTrialPreview(state, random) {
  const incomingTurn = state.turn + 1;
  const rootSeed = random.state;
  const baseColor = state._trialColor ?? state.palette[0];
  const fallbackRow = generateTrialRow(state.cols, state.palette, random, incomingTurn, state.score, baseColor);
  const attemptEasy = random() < easySelectionChance(state.score);
  const fallbackRng = random.state;
  if (!attemptEasy) return { row: fallbackRow, kind: 'regular', skipNextRise: false, witness: null, rngState: fallbackRng };

  const poolBudget = makeTrialSearchBudget(0, 3200, 7000);
  const firstActionPool = legalTrialActions(state, poolBudget, 32);
  if (!firstActionPool.length) return { row: fallbackRow, kind: 'regular', skipNextRise: false, witness: null, rngState: fallbackRng };

  const regularBudget = makeTrialSearchBudget(220, 2600, 5000);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let row = fallbackRow;
    let candidateRng = fallbackRng;
    if (attempt > 0) {
      const candidateRandom = createRandom((rootSeed ^ Math.imul(attempt + 3, 0x9e3779b1)) >>> 0);
      row = generateTrialRow(state.cols, state.palette, candidateRandom, incomingTurn, state.score, baseColor);
      candidateRng = candidateRandom.state;
    }
    const candidate = { ...state, nextRow: copyRow(row), nextRowKind: 'regular', skipNextRise: false, _witness: null, _rng: candidateRng };
    const witness = findTrialWitness(candidate, regularBudget, firstActionPool);
    if (witness) return { row, kind: 'regular', skipNextRise: false, witness: witness.steps === 2 ? witness : null, rngState: candidateRng };
    if (regularBudget.exhausted) break;
  }

  if (state.score < 1000) {
    const masks = rescueGapMasks(state);
    const rescueBudget = makeTrialSearchBudget(240, 3000, 5500);
    for (const [index, { gaps }] of masks.slice(0, 24).entries()) {
      const candidateRandom = createRandom((rootSeed ^ Math.imul(index + 101, 0x85ebca6b)) >>> 0);
      const row = buildRescueRow(state.cols, state.palette, gaps, candidateRandom, incomingTurn, state.score, baseColor);
      const candidateRng = candidateRandom.state;
      const candidate = { ...state, nextRow: copyRow(row), nextRowKind: 'rescue', skipNextRise: false, _witness: null, _rng: candidateRng };
      const witness = findTrialWitness(candidate, rescueBudget, firstActionPool);
      if (witness) return { row, kind: 'rescue', skipNextRise: false, witness: witness.steps === 2 ? witness : null, rngState: candidateRng };
      if (rescueBudget.exhausted) break;
    }
  }

  if (state.score < 1000 && !state.skipRiseUsed) {
    const candidate = { ...state, nextRow: copyRow(fallbackRow), nextRowKind: 'regular', skipNextRise: true, _witness: null, _rng: fallbackRng };
    const skipBudget = makeTrialSearchBudget(180, 2400, 4500);
    const witness = findTrialWitness(candidate, skipBudget, firstActionPool);
    if (witness) return { row: fallbackRow, kind: 'regular', skipNextRise: true, witness: null, rngState: fallbackRng };
  }
  return { row: fallbackRow, kind: 'regular', skipNextRise: false, witness: null, rngState: fallbackRng };
}

export function createGame({ cols = 10, rows = 20, seed = 1, palette = DEFAULT_PALETTE, trial = false } = {}) {
  if (!Number.isInteger(cols) || cols < 4 || !Number.isInteger(rows) || rows < 4) {
    throw new RangeError('cols and rows must be integers of at least 4');
  }
  if (!Array.isArray(palette) || palette.length < 2 || palette.some((color) => typeof color !== 'string')) {
    throw new TypeError('palette must contain at least two color strings');
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
    skipNextRise: false,
    skipRiseUsed: false,
    nextRowKind: 'regular',
    _trialColor: trialColor,
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
  initialState._witness = selection.witness;
  initialState._rng = selection.rngState;
  return initialState;
}

function failedMutation(state, reason) {
  return { state, events: [], changed: false, reason };
}

function finalizeMove(state, pieceId, preview, moveEvent, { recordEvents = true, prepareNext = true } = {}) {
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

  if (nextState.pieces.some((piece) => piece.cells.some((cell) => cell.y === 0))) {
    nextState.status = 'gameover';
    addSnapshotEvent(events, { type: 'gameover', reason: 'top-overflow' }, nextState.pieces);
    return { state: nextState, events: events ?? [], changed: true, reason: 'top-overflow' };
  }

  if (state.trial && state.skipNextRise) {
    nextState.skipNextRise = false;
    nextState.skipRiseUsed = true;
    nextState._witness = null;
    if (topOccupied(nextState.pieces)) {
      nextState.status = 'gameover';
      addSnapshotEvent(events, { type: 'gameover', reason: 'top-row' }, nextState.pieces);
      return { state: nextState, events: events ?? [], changed: true, reason: 'top-row' };
    }
    return { state: nextState, events: events ?? [], changed: true, reason: null };
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
  if (state.trial && topOccupied(nextState.pieces)) {
    nextState.status = 'gameover';
    addSnapshotEvent(events, { type: 'gameover', reason: 'top-row' }, nextState.pieces);
    return { state: nextState, events: events ?? [], changed: true, reason: 'top-row' };
  }

  if (prepareNext) {
    const witness = state.trial ? state._witness : null;
    const currentSignature = actionSignature(moveEvent.type, pieceId, moveEvent.direction, preview.cells);
    if (witness && signaturesMatch(witness.first, currentSignature) && witness.continuationRow) {
      nextState.nextRow = copyRow(witness.continuationRow);
      nextState.nextRowKind = witness.continuationKind ?? 'regular';
      nextState._rng = witness.continuationRng;
      nextState._witness = null;
    } else {
      nextState._witness = null;
      const random = createRandom(state._rng);
      if (state.trial) {
        const selection = selectTrialPreview(nextState, random);
        nextState.nextRow = selection.row;
        nextState.nextRowKind = selection.kind;
        nextState.skipNextRise = selection.skipNextRise;
        nextState._witness = selection.witness;
        nextState._rng = selection.rngState;
      } else {
        nextState.nextRow = generateRow(state.cols, state.palette, random);
        nextState.nextRowKind = 'regular';
        nextState._rng = random.state;
      }
    }
  }
  return { state: nextState, events: events ?? [], changed: true, reason: null };
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
