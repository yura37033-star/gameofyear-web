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
      phases.push({ type: event.type, from: previous, to: event.pieces, rows: event.rows ?? [] });
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

function crossingTimes(start, velocity, obstacle) {
  if (velocity === 0) return start + 1 <= obstacle || start >= obstacle + 1 ? null : [-Infinity, Infinity];
  const a = (obstacle - start - 1) / velocity, b = (obstacle + 1 - start) / velocity;
  return [Math.min(a, b), Math.max(a, b)];
}

function earliestContact(piece, pieces, from, delta, cols, rows) {
  const epsilon = 1e-9;
  let earliest = null;
  const blockers = pieces.filter((other) => other.id !== piece.id).flatMap((other) => other.cells);
  const consider = (time, normals) => {
    if (!Number.isFinite(time) || time < -epsilon || time > 1 + epsilon) return;
    const t = clamp(time);
    if (!earliest || t < earliest.time - epsilon) earliest = { time: t, normals: new Set(normals) };
    else if (Math.abs(t - earliest.time) <= epsilon) for (const normal of normals) earliest.normals.add(normal);
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
      const normals = Math.abs(enterX - enterY) <= epsilon
        ? ['x', 'y']
        : enterX > enterY ? ['x'] : ['y'];
      consider(enter, normals);
    }
  }
  return earliest;
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
