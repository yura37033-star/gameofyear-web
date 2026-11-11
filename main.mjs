import { createGame, movePieceAlongPath, previewRotation, rotatePiece } from './core/game.mjs';
import { buildPlayback, samplePieces, advanceDrag } from './motion.mjs';

const $ = (id) => document.getElementById(id);
const board = $('board'), nextCanvas = $('nextRow'), slot = $('boardSlot'), frame = $('boardFrame');
const ctx = board.getContext('2d'), nextCtx = nextCanvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const rotationButtons = {
  clockwise: $('rotateRightButton'),
  counterclockwise: $('rotateLeftButton'),
};
let state, scene = [], displayedRow = [], displayedScore = 0, selectedId = null, drag = null;
let cell = 28, busy = false, actionEpoch = 0, activePhase = null, rotationTween = null;
let tween = null, animationFrame = 0, renderRequest = 0;
let hintDirection = 'clockwise';

function seed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Date.now() >>> 0;
}
function message(text, tone = '') { $('status').textContent = text; $('status').className = `status ${tone}`; }
function piece(id) { return state.pieces.find((item) => item.id === id); }
function invalidFeedback(text) {
  message(text, 'bad'); frame.classList.remove('invalid'); void frame.offsetWidth; frame.classList.add('invalid');
}
function scheduleRender() {
  if (!renderRequest) renderRequest = requestAnimationFrame(() => { renderRequest = 0; render(); });
}
function setCanvas(canvas, context, width, height) {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}
function resize() {
  if (!state) return;
  const box = slot.getBoundingClientRect();
  const nextCell = Math.max(8, Math.floor(Math.min((box.width - 14) / state.cols, (box.height - 14) / state.rows, 38)));
  if (nextCell !== cell && drag) cancelDrag();
  cell = nextCell;
  setCanvas(board, ctx, cell * state.cols, cell * state.rows);
  setCanvas(nextCanvas, nextCtx, cell * state.cols, cell);
  nextCanvas.parentElement.style.width = `${cell * state.cols}px`;
  render();
}
function brighten(hex, amount = 25) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  return '#' + hex.slice(1).match(/../g).map((part) => Math.min(255, parseInt(part, 16) + amount).toString(16).padStart(2, '0')).join('');
}
function roundRectPath(context, x, y, w, h, r) {
  if (typeof context.roundRect === 'function') { context.roundRect(x, y, w, h, r); return; }
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  context.moveTo(x + radius, y);
  context.arcTo(x + w, y, x + w, y + h, radius);
  context.arcTo(x + w, y + h, x, y + h, radius);
  context.arcTo(x, y + h, x, y, radius);
  context.arcTo(x, y, x + w, y, radius);
  context.closePath();
}
function drawBar(context, x, y, width, height, color, alpha = 1, scale = 1, selected = false) {
  const gap = Math.max(1, cell * .065), radius = Math.max(2, cell * .15);
  const left = x * cell + gap, top = y * cell + gap;
  const barWidth = width * cell - gap * 2, barHeight = height * cell - gap * 2;
  context.save(); context.globalAlpha = alpha;
  if (scale !== 1) {
    const centerX = (x + width / 2) * cell, centerY = (y + height / 2) * cell;
    context.translate(centerX, centerY); context.scale(scale, scale); context.translate(-centerX, -centerY);
  }
  const gradient = context.createLinearGradient(0, top, 0, top + barHeight);
  gradient.addColorStop(0, brighten(color, 28)); gradient.addColorStop(.55, color);
  gradient.addColorStop(1, color);
  context.fillStyle = gradient;
  context.beginPath(); roundRectPath(context, left, top, barWidth, barHeight, radius); context.fill();
  context.strokeStyle = selected ? '#fff5da' : '#ffffff54';
  context.lineWidth = selected ? 2 : 1;
  context.stroke();
  context.restore();
}
function drawPiece(item, alpha = 1, selected = item.id === selectedId) {
  const vertical = item.cells.some((p) => p.y !== item.cells[0].y);
  const axis = vertical ? 'y' : 'x';
  const ordered = [...item.cells].sort((a, b) => a[axis] - b[axis]);
  // Cells that are disappearing can animate separately from the surviving bar.
  for (let start = 0; start < ordered.length;) {
    const first = ordered[start];
    let end = start + 1;
    while (end < ordered.length && Math.abs(ordered[end][axis] - first[axis] - (end - start)) < 1e-6 &&
      ordered[end].opacity === first.opacity && ordered[end].scale === first.scale) end++;
    const length = end - start;
    drawBar(ctx, first.x, first.y, vertical ? 1 : length, vertical ? length : 1,
      item.color, alpha * (first.opacity ?? 1), first.scale ?? 1, selected);
    start = end;
  }
}
function drawHint(cells, blocked = false) {
  const xs = cells.map((p) => p.x), ys = cells.map((p) => p.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  const width = Math.max(...xs) - left + 1, height = Math.max(...ys) - top + 1;
  ctx.save(); ctx.fillStyle = blocked ? '#ff657420' : '#9dfbe51c';
  ctx.strokeStyle = blocked ? '#ff8292d9' : '#a3ffe0ce'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
  ctx.beginPath(); roundRectPath(ctx, left * cell + 3, top * cell + 3, width * cell - 6, height * cell - 6, Math.max(1, cell * .12));
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
function movedDrawing(item, offset) {
  return { ...item, cells: item.cells.map((c) => ({ x: c.x + offset.x, y: c.y + offset.y })) };
}
function render() {
  if (!state) return;
  const canRotate = selectedId && !busy && !drag && state.status === 'playing';
  const rotationHints = {};
  for (const [direction, button] of Object.entries(rotationButtons)) {
    const preview = canRotate && previewRotation(state, selectedId, direction);
    button.disabled = !preview?.valid;
    if (preview?.valid) rotationHints[direction] = preview.cells;
  }
  ctx.clearRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#0c182a'; ctx.fillRect(0, 0, state.cols * cell, state.rows * cell);
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#14233a61' : '#17283e61';
    ctx.beginPath(); roundRectPath(ctx, x * cell + 1, y * cell + 1, cell - 2, cell - 2, 3); ctx.fill();
  }
  const danger = scene.some((p) => p.cells.some((c) => c.y <= 2));
  frame.classList.toggle('danger', danger);
  if (danger) { ctx.fillStyle = '#ff657408'; ctx.fillRect(0, 0, cell * state.cols, cell * 3); }
  for (const item of scene) {
    if (rotationTween?.id === item.id) {
      const rotation = rotationTween, amount = 1 - (1 - rotation.progress) ** 3;
      const centerX = (item.frame.x + item.frame.size / 2) * cell, centerY = (item.frame.y + item.frame.size / 2) * cell;
      ctx.save(); ctx.translate((rotation.dx * amount) * cell, (rotation.dy * amount) * cell);
      ctx.translate(centerX, centerY); ctx.rotate(rotation.angle * amount); ctx.translate(-centerX, -centerY);
      drawPiece(item); ctx.restore();
    } else drawPiece(item, drag?.moved && drag.id === item.id ? .12 : 1);
  }
  if (activePhase?.type === 'clear') {
    ctx.fillStyle = `rgba(129,255,215,${.16 * (1 - activePhase.progress)})`;
    for (const y of activePhase.rows) ctx.fillRect(0, y * cell, state.cols * cell, cell);
  }
  if (drag?.moved) {
    const selected = piece(drag.id);
    drawHint(movedDrawing(selected, drag.offset).cells, drag.blocked);
    drawPiece(movedDrawing(selected, drag.floating), 1, true);
  } else {
    const hint = rotationHints[hintDirection] ?? rotationHints.clockwise ?? rotationHints.counterclockwise;
    if (hint) drawHint(hint);
  }
  nextCtx.clearRect(0, 0, state.cols * cell, cell);
  for (let x = 0; x < state.cols; x++) { nextCtx.fillStyle = '#192b4380'; nextCtx.beginPath(); roundRectPath(nextCtx, x * cell + 1, 1, cell - 2, cell - 2, 3); nextCtx.fill(); }
  for (const p of displayedRow) drawBar(nextCtx, p.x, 0, p.length, 1, p.color, .92);
  $('score').textContent = displayedScore.toLocaleString('uk-UA'); $('turn').textContent = state.turn;
  $('gameOver').hidden = state.status !== 'gameover' || busy;
  $('finalScore').textContent = state.score.toLocaleString('uk-UA');
  board.setAttribute('aria-label', `Поле ${state.cols} на ${state.rows}. Очки: ${displayedScore}. Ходів: ${state.turn}. ${selectedId ? 'Фігуру обрано.' : 'Обери фігуру.'}`);
}
function cancelTween() {
  cancelAnimationFrame(animationFrame);
  const previous = tween; tween = null;
  if (previous) previous.resolve(false);
}
function animate(duration, update) {
  if (reducedMotion.matches || document.hidden || duration === 0) { update(1); return Promise.resolve(true); }
  return new Promise((resolve) => {
    const token = { resolve }; tween = token;
    let start;
    const tick = (time) => {
      if (tween !== token) return;
      start ??= time;
      const progress = Math.min(1, (time - start) / duration);
      update(progress);
      if (progress < 1) animationFrame = requestAnimationFrame(tick);
      else { tween = null; resolve(true); }
    };
    animationFrame = requestAnimationFrame(tick);
  });
}
function completedMessage(gained = 0) {
  if (state.status === 'gameover') message('Поле переповнене. Спробуємо ще?', 'bad');
  else if (gained) message(`Прибрано рядів: ${gained / 100} · +${gained} очок`, 'good');
  else message('Наступний ряд додано. Обирай новий хід.');
}
function finishPlayback() {
  actionEpoch++; cancelTween(); activePhase = null; rotationTween = null; busy = false;
  scene = state.pieces; displayedScore = state.score; displayedRow = state.nextRow;
  frame.classList.remove('resolve'); completedMessage(); render();
}
function startGame() {
  actionEpoch++; cancelTween(); cancelDrag(); busy = false; selectedId = null; activePhase = null; rotationTween = null;
  hintDirection = 'clockwise';
  state = createGame({ cols: 10, rows: 20, seed: seed() });
  scene = state.pieces; displayedRow = state.nextRow; displayedScore = state.score;
  board.classList.remove('dragging'); frame.classList.remove('resolve', 'invalid'); $('gain').classList.remove('show');
  message('Торкнись фігури, щоб обрати.'); resize();
}
async function commit(result, initialScene = scene) {
  if (!result.changed) { invalidFeedback('Шлях зайнятий. Спробуй обійти перешкоду.'); render(); return; }
  const epoch = ++actionEpoch, oldScore = state.score;
  state = result.state; selectedId = null; busy = true; scene = initialScene;
  message('Фігури займають свої місця…'); render();
  for (const phase of buildPlayback(initialScene, result.events)) {
    activePhase = { ...phase, progress: 0 };
    if (phase.type === 'rotate') {
      const original = phase.from.find((item) => item.id === phase.pieceId);
      const target = phase.to.find((item) => item.id === phase.pieceId);
      scene = phase.from;
      rotationTween = {
        id: phase.pieceId,
        angle: phase.direction === 'counterclockwise' ? -Math.PI / 2 : Math.PI / 2,
        dx: target.frame.x - original.frame.x,
        dy: target.frame.y - original.frame.y,
        progress: 0,
      };
    }
    const complete = await animate(phase.duration, (progress) => {
      activePhase.progress = progress;
      if (rotationTween) rotationTween.progress = progress;
      else scene = samplePieces(phase, progress);
      render();
    });
    if (!complete || actionEpoch !== epoch) return;
    rotationTween = null; scene = phase.to;
    if (phase.type === 'clear') {
      displayedScore += phase.rows.length * 100;
      $('gain').textContent = `+${phase.rows.length * 100}`; $('gain').classList.remove('show'); void $('gain').offsetWidth; $('gain').classList.add('show');
    }
    if (phase.type === 'rise') displayedRow = state.nextRow;
  }
  scene = state.pieces; displayedScore = state.score; displayedRow = state.nextRow;
  activePhase = null; busy = false; completedMessage(state.score - oldScore); render();
}
function rotate(direction) {
  if (busy || drag || !selectedId || state.status !== 'playing') return;
  const result = rotatePiece(state, selectedId, direction);
  if (result.changed) commit(result);
}
function processDragSample(event) {
  if (!drag) return;
  const raw = { x: (event.clientX - drag.startX) / cell, y: (event.clientY - drag.startY) / cell };
  if (Math.hypot(raw.x, raw.y) * cell > 4) drag.moved = true;
  if (!drag.moved) return;
  drag = advanceDrag(state, drag, raw);
}
board.addEventListener('pointerdown', (event) => {
  if (busy || state.status !== 'playing' || event.button > 0 || !event.isPrimary || drag) return;
  event.preventDefault(); board.focus({ preventScroll: true });
  const rect = board.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / cell), y = Math.floor((event.clientY - rect.top) / cell);
  const hit = state.pieces.find((p) => p.cells.some((c) => c.x === x && c.y === y));
  selectedId = hit?.id ?? null;
  if (hit) {
    drag = { id: hit.id, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId,
      path: [{ x: 0, y: 0 }], offset: { x: 0, y: 0 }, floating: { x: 0, y: 0 }, moved: false, blocked: false };
    board.setPointerCapture(event.pointerId); board.classList.add('dragging');
    message('Рухай у будь-який бік вільним шляхом. Відпусти — фігура впаде.');
  } else message('Торкнись кольорової фігури.');
  render();
});
board.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents?.() ?? [];
  for (const sample of samples) processDragSample(sample);
  processDragSample(event); scheduleRender();
});
board.addEventListener('pointerup', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  processDragSample(event);
  const completed = drag;
  const initialScene = state.pieces.map((item) => item.id === completed.id ? movedDrawing(item, completed.floating) : item);
  drag = null; board.classList.remove('dragging');
  if (board.hasPointerCapture(event.pointerId)) board.releasePointerCapture(event.pointerId);
  if (completed.moved && (completed.offset.x !== 0 || completed.offset.y !== 0)) {
    commit(movePieceAlongPath(state, completed.id, completed.path), initialScene);
  } else if (completed.moved && Math.hypot(completed.floating.x, completed.floating.y) > .001) {
    snapBack(initialScene);
  } else render();
});
async function snapBack(initialScene) {
  const epoch = ++actionEpoch; busy = true;
  const phase = { type: 'move', from: initialScene, to: state.pieces };
  const complete = await animate(90, (progress) => { scene = samplePieces(phase, progress); render(); });
  if (!complete || epoch !== actionEpoch) return;
  scene = state.pieces; busy = false; message('Позицію не змінено — хід не витрачено.'); render();
}
function cancelDrag() {
  if (!drag) return;
  const pointerId = drag.pointerId; drag = null; board.classList.remove('dragging');
  if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
  scheduleRender();
}
board.addEventListener('pointercancel', (event) => { if (drag?.pointerId === event.pointerId) cancelDrag(); });
board.addEventListener('lostpointercapture', (event) => { if (drag?.pointerId === event.pointerId) cancelDrag(); });
window.addEventListener('blur', cancelDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelDrag(); if (busy) finishPlayback(); } });
board.addEventListener('keydown', (event) => {
  if (!selectedId || busy || drag || state.status !== 'playing') return;
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); rotate(event.shiftKey ? 'counterclockwise' : 'clockwise'); return; }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) { event.preventDefault(); commit(movePieceAlongPath(state, selectedId, [{ x: direction[0], y: direction[1] }])); }
});
for (const [direction, button] of Object.entries(rotationButtons)) {
  const showHint = () => { hintDirection = direction; scheduleRender(); };
  button.addEventListener('pointerenter', showHint);
  button.addEventListener('focus', showHint);
  button.addEventListener('click', () => rotate(direction));
}
$('newGameButton').addEventListener('click', startGame); $('retryButton').addEventListener('click', startGame);
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close()); $('playButton').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (e) => { if (e.target === $('helpDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
new ResizeObserver(resize).observe(slot);
startGame();
