import { previewMovePath } from './core/game.mjs';

const copyPieces = (pieces) => pieces.map((piece) => ({ ...piece, frame: { ...piece.frame }, cells: piece.cells.map((cell) => ({ ...cell })) }));
const clamp = (value) => Math.max(0, Math.min(1, value));
const easeOut = (t) => 1 - (1 - t) ** 3;

export function buildPlayback(initialPieces, events) {
  const phases = [];
  let previous = initialPieces;
  for (const event of events) {
    if (!Array.isArray(event.pieces)) throw new TypeError('Animation event requires a piece snapshot');
    const last = phases.at(-1);
    if (event.type === 'fall' && last?.type === 'fall') {
      last.to = event.pieces;
    } else {
      const phase = { type: event.type, from: previous, to: event.pieces, rows: event.rows ?? [] };
      if (event.type === 'rotate') {
        phase.pieceId = event.pieceId;
        phase.direction = event.direction;
      }
      phases.push(phase);
    }
    previous = event.pieces;
  }
  for (const phase of phases) {
    if (phase.type === 'fall') {
      const old = new Map(phase.from.map((piece) => [piece.id, piece]));
      const distance = Math.max(1, ...phase.to.map((piece) => Math.abs(piece.cells[0].y - (old.get(piece.id)?.cells[0].y ?? piece.cells[0].y))));
      phase.duration = Math.min(280, 120 + Math.sqrt(distance) * 35);
    } else phase.duration = { move: 90, clear: 170, rise: 220, rotate: 150, gameover: 0 }[phase.type] ?? 0;
  }
  return phases;
}

export function samplePieces(phase, progress) {
  const t = clamp(progress);
  if (t === 1) return copyPieces(phase.to);
  if (phase.type === 'clear') {
    return phase.from.map((piece) => ({ ...piece, cells: piece.cells.map((cell) => ({
      ...cell,
      opacity: phase.rows.includes(cell.y) ? 1 - easeOut(t) : 1,
      scale: phase.rows.includes(cell.y) ? 1 - .3 * t : 1,
    })) }));
  }
  const old = new Map(phase.from.map((piece) => [piece.id, piece]));
  const amount = phase.type === 'fall' ? t * t : phase.type === 'rise' ? (1 - Math.cos(Math.PI * t)) / 2 : easeOut(t);
  return phase.to.map((piece) => {
    const before = old.get(piece.id);
    return { ...piece, cells: piece.cells.map((cell, index) => {
      const start = before?.cells[index] ?? { x: cell.x, y: cell.y + (phase.type === 'rise' ? 1 : 0) };
      return { x: start.x + (cell.x - start.x) * amount, y: start.y + (cell.y - start.y) * amount,
        opacity: before ? 1 : .35 + .65 * amount };
    }) };
  });
}

export function simplifyPath(path) {
  const result = [], indexes = new Map();
  for (const point of path) {
    const key = `${point.x},${point.y}`;
    if (indexes.has(key)) {
      const keep = indexes.get(key);
      for (let index = result.length - 1; index > keep; index--) indexes.delete(`${result[index].x},${result[index].y}`);
      result.length = keep + 1;
    } else { indexes.set(key, result.length); result.push({ x: point.x, y: point.y }); }
  }
  return result;
}

// Floating positions that are mathematically integers can be off by a few ulps;
// treat contact within this tolerance as touching, not overlapping.
const EPSILON = 1e-9;
// At an isolated flush corner the smaller component is treated as finger noise
// (and dropped) when it is at most this fraction of the larger one.
const CORNER_SLIDE_RATIO = .5;
// ...and a corner touch holds still until the larger remaining component exceeds this
// (in cells), so wobble around a lane entrance cannot pull the piece off its lane.
const CORNER_DEAD_ZONE = .2;

function crossingTimes(start, velocity, obstacle) {
  if (Math.abs(velocity) <= EPSILON) {
    return start + 1 <= obstacle + EPSILON || start >= obstacle + 1 - EPSILON ? null : [-Infinity, Infinity];
  }
  const a = (obstacle - start - 1) / velocity, b = (obstacle + 1 - start) / velocity;
  return [Math.min(a, b), Math.max(a, b)];
}

function earliestContact(piece, pieces, from, delta, cols, rows) {
  const epsilon = EPSILON;
  let earliest = null;
  const blockers = pieces.filter((other) => other.id !== piece.id).flatMap((other) => other.cells);
  const consider = (time, normals, corner = false) => {
    if (!Number.isFinite(time) || time < -epsilon || time > 1 + epsilon) return;
    const t = clamp(time);
    if (!earliest || t < earliest.time - epsilon) {
      earliest = { time: t, faceNormals: new Set(), cornerNormals: new Set() };
    }
    if (Math.abs(t - earliest.time) <= epsilon) {
      const contactNormals = corner ? earliest.cornerNormals : earliest.faceNormals;
      for (const normal of normals) contactNormals.add(normal);
    }
  };

  for (const cell of piece.cells) {
    const x = cell.x + from.x, y = cell.y + from.y;
    if (delta.x > 0 && x + delta.x > cols - 1 + epsilon) consider((cols - 1 - x) / delta.x, ['x']);
    if (delta.x < 0 && x + delta.x < -epsilon) consider(-x / delta.x, ['x']);
    if (delta.y > 0 && y + delta.y > rows - 1 + epsilon) consider((rows - 1 - y) / delta.y, ['y']);
    if (delta.y < 0 && y + delta.y < -epsilon) consider(-y / delta.y, ['y']);

    for (const obstacle of blockers) {
      const tx = crossingTimes(x, delta.x, obstacle.x), ty = crossingTimes(y, delta.y, obstacle.y);
      if (!tx || !ty) continue;
      const enterX = tx[0], enterY = ty[0];
      const enter = Math.max(enterX, enterY), leave = Math.min(tx[1], ty[1]);
      if (!(enter < leave && leave > epsilon && enter <= 1 + epsilon && enter >= -epsilon)) continue;
      const corner = Math.abs(enterX - enterY) <= epsilon;
      const normals = corner
        ? ['x', 'y']
        : enterX > enterY ? ['x'] : ['y'];
      consider(enter, normals, corner);
    }
  }
  if (!earliest) return null;
  // At one instant a real face can meet one cell while an adjacent cell only
  // touches the shared corner. Preserve the face tangent and ignore that
  // incidental corner normal; isolated corners still block both axes.
  const normals = earliest.faceNormals.size ? earliest.faceNormals : earliest.cornerNormals;
  return { time: earliest.time, normals, corner: !earliest.faceNormals.size };
}

// Sweep the continuous offset and project remaining motion along each contact surface.
export function constrainDragOffset(piece, pieces, from, requested, cols, rows) {
  let current = { x: from.x, y: from.y };
  let remaining = { x: requested.x - from.x, y: requested.y - from.y };
  const waypoints = [{ ...current }];
  let blocked = false;

  for (let contact = 0; contact < 3; contact += 1) {
    if (Math.abs(remaining.x) + Math.abs(remaining.y) < 1e-12) break;
    const hit = earliestContact(piece, pieces, current, remaining, cols, rows);
    if (!hit) {
      current = { x: current.x + remaining.x, y: current.y + remaining.y };
      waypoints.push({ ...current });
      remaining = { x: 0, y: 0 };
      break;
    }

    const fraction = hit.time;
    current = { x: current.x + remaining.x * fraction, y: current.y + remaining.y * fraction };
    if (Math.hypot(current.x - waypoints.at(-1).x, current.y - waypoints.at(-1).y) > 1e-12) waypoints.push({ ...current });
    const remainder = { x: remaining.x * (1 - fraction), y: remaining.y * (1 - fraction) };
    const next = {
      x: hit.normals.has('x') ? 0 : remainder.x,
      y: hit.normals.has('y') ? 0 : remainder.y,
    };
    if (hit.corner) {
      // A lone corner touch: a mostly axis-aligned motion slides along the face
      // it grazes; a true diagonal into the corner still stops both axes.
      const ax = Math.abs(remainder.x), ay = Math.abs(remainder.y);
      if (Math.max(ax, ay) < CORNER_DEAD_ZONE) { /* hold still */ }
      else if (ay <= ax * CORNER_SLIDE_RATIO) next.x = remainder.x;
      else if (ax <= ay * CORNER_SLIDE_RATIO) next.y = remainder.y;
    }
    blocked ||= Math.abs(next.x - remaining.x) + Math.abs(next.y - remaining.y) > 1e-12;
    remaining = next;
    if (contact === 2 && Math.abs(remaining.x) + Math.abs(remaining.y) > 1e-12) blocked = true;
  }

  return { x: current.x, y: current.y, blocked, waypoints };
}

export function advanceDrag(state, drag, requested) {
  const piece = state.pieces.find((item) => item.id === drag.id);
  if (!piece || !Number.isFinite(requested?.x) || !Number.isFinite(requested?.y)) {
    return { ...drag, blocked: true };
  }

  const floating = constrainDragOffset(piece, state.pieces, drag.floating, requested, state.cols, state.rows);
  const samples = floating.waypoints.slice(1).map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) }));
  const preview = previewMovePath(state, drag.id, [...drag.path, ...samples]);
  const gridBlocked = !preview.valid && preview.reason !== 'no-movement';
  if (gridBlocked) return { ...drag, blocked: true };
  const simplified = simplifyPath(preview.acceptedPath ?? drag.path);
  const verified = previewMovePath(state, drag.id, simplified.slice(1));
  if (!verified.valid && verified.reason !== 'no-movement') return { ...drag, blocked: true };
  const path = simplifyPath(verified.acceptedPath ?? drag.path);
  const offset = path.at(-1) ?? { x: 0, y: 0 };

  return {
    ...drag,
    path,
    offset,
    floating: { x: floating.x, y: floating.y },
    blocked: floating.blocked || gridBlocked,
  };
}
