import { createGame, movePieceAlongPath, previewRotation, rotatePiece } from './core/game.mjs';
import { buildPlayback, samplePieces, advanceDrag } from './motion.mjs';

const $ = (id) => document.getElementById(id);
const board = $('board'), nextCanvas = $('nextRow'), slot = $('boardSlot'), frame = $('boardFrame');
const ctx = board.getContext('2d'), nextCtx = nextCanvas.getContext('2d');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let state, scene = [], displayedRow = [], displayedScore = 0, selectedId = null, drag = null;
let cell = 28, busy = false, actionEpoch = 0, activePhase = null, rotationTween = null;
let tween = null, animationFrame = 0, renderRequest = 0;

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
function drawCell(context, x, y, color, alpha = 1, scale = 1) {
  const gap = Math.max(1, cell * .045), radius = Math.max(2, cell * .15);
  context.save(); context.globalAlpha = alpha;
  if (scale !== 1) { context.translate((x + .5) * cell, (y + .5) * cell); context.scale(scale, scale); context.translate(-(x + .5) * cell, -(y + .5) * cell); }
  const gradient = context.createLinearGradient(0, y * cell, 0, (y + 1) * cell);
  gradient.addColorStop(0, brighten(color, 20)); gradient.addColorStop(.3, color); gradient.addColorStop(1, color);
  context.fillStyle = gradient;
  context.beginPath(); context.roundRect(x * cell + gap, y * cell + gap, cell - gap * 2, cell - gap * 2, radius); context.fill();
  context.fillStyle = '#ffffff28'; context.fillRect(x * cell + gap + radius, y * cell + gap + 1, Math.max(0, cell - gap * 2 - radius * 2), Math.max(1, cell * .045));
  context.fillStyle = '#00000020'; context.fillRect(x * cell + gap + radius, (y + 1) * cell - gap - 3, Math.max(0, cell - gap * 2 - radius * 2), 2);
  context.restore();
}
function drawOutline(cells, color, width = 2, alpha = 1) {
  const occupied = new Set(cells.map((p) => `${p.x},${p.y}`));
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = width;
  for (const p of cells) {
    const x = p.x * cell, y = p.y * cell;
    if (!occupied.has(`${p.x},${p.y - 1}`)) { ctx.beginPath(); ctx.moveTo(x + 1, y + 1); ctx.lineTo(x + cell - 1, y + 1); ctx.stroke(); }
    if (!occupied.has(`${p.x},${p.y + 1}`)) { ctx.beginPath(); ctx.moveTo(x + 1, y + cell - 1); ctx.lineTo(x + cell - 1, y + cell - 1); ctx.stroke(); }
    if (!occupied.has(`${p.x - 1},${p.y}`)) { ctx.beginPath(); ctx.moveTo(x + 1, y + 1); ctx.lineTo(x + 1, y + cell - 1); ctx.stroke(); }
    if (!occupied.has(`${p.x + 1},${p.y}`)) { ctx.beginPath(); ctx.moveTo(x + cell - 1, y + 1); ctx.lineTo(x + cell - 1, y + cell - 1); ctx.stroke(); }
  }
  ctx.restore();
}
function drawPiece(item, alpha = 1, selected = item.id === selectedId) {
  for (const c of item.cells) drawCell(ctx, c.x, c.y, item.color, alpha * (c.opacity ?? 1), c.scale ?? 1);
  const outlined = item.cells.filter((c) => (c.opacity ?? 1) > .95);
  drawOutline(outlined, selected ? '#fff5da' : '#071326aa', selected ? 2.4 : 1.7, alpha);
}
function drawHint(preview) {
  ctx.save(); ctx.fillStyle = preview.valid ? '#9dfbe51c' : '#ff657420';
  ctx.strokeStyle = preview.valid ? '#a3ffe0ce' : '#ff8292d9'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
  for (const p of preview.cells || []) {
    ctx.beginPath(); ctx.roundRect(p.x * cell + 3, p.y * cell + 3, cell - 6, cell - 6, Math.max(1, cell * .12)); ctx.fill(); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const p of preview.blockedCells || []) { ctx.fillStyle = '#ff304f55'; ctx.fillRect(p.x * cell + 1, p.y * cell + 1, cell - 2, cell - 2); }
  ctx.restore();
}
function movedDrawing(item, offset) {
  return { ...item, cells: item.cells.map((c) => ({ x: c.x + offset.x, y: c.y + offset.y })) };
}
function render() {
  if (!state) return;
  ctx.clearRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#0c182a'; ctx.fillRect(0, 0, state.cols * cell, state.rows * cell);
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#14233a61' : '#17283e61';
    ctx.beginPath(); ctx.roundRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2, 3); ctx.fill();
  }
  const danger = scene.some((p) => p.cells.some((c) => c.y <= 2));
  frame.classList.toggle('danger', danger);
  if (danger) { ctx.fillStyle = '#ff657408'; ctx.fillRect(0, 0, cell * state.cols, cell * 3); }
  for (const item of scene) {
    if (rotationTween?.id === item.id) {
      const rotation = rotationTween, amount = 1 - (1 - rotation.progress) ** 3;
      const centerX = (item.frame.x + item.frame.size / 2) * cell, centerY = (item.frame.y + item.frame.size / 2) * cell;
      ctx.save(); ctx.translate((rotation.dx * amount) * cell, (rotation.dy * amount) * cell);
      ctx.translate(centerX, centerY); ctx.rotate(Math.PI / 2 * amount); ctx.translate(-centerX, -centerY);
      drawPiece(item); ctx.restore();
    } else drawPiece(item, drag?.moved && drag.id === item.id ? .12 : 1);
  }
  if (activePhase?.type === 'clear') {
    ctx.fillStyle = `rgba(129,255,215,${.16 * (1 - activePhase.progress)})`;
    for (const y of activePhase.rows) ctx.fillRect(0, y * cell, state.cols * cell, cell);
  }
  if (drag?.moved) {
    const selected = piece(drag.id);
    drawHint({ valid: !drag.blocked, cells: movedDrawing(selected, drag.offset).cells });
    drawPiece(movedDrawing(selected, drag.floating), 1, true);
  } else if (selectedId && !busy && state.status === 'playing') drawHint(previewRotation(state, selectedId));
  nextCtx.clearRect(0, 0, state.cols * cell, cell);
  for (let x = 0; x < state.cols; x++) { nextCtx.fillStyle = '#192b4380'; nextCtx.beginPath(); nextCtx.roundRect(x * cell + 1, 1, cell - 2, cell - 2, 3); nextCtx.fill(); }
  for (const p of displayedRow) for (let i = 0; i < p.length; i++) drawCell(nextCtx, p.x + i, 0, p.color, .92);
  $('score').textContent = displayedScore.toLocaleString('uk-UA'); $('turn').textContent = state.turn;
  $('rotateButton').disabled = !selectedId || !piece(selectedId) || state.status !== 'playing' || busy || !!drag;
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
  state = createGame({ cols: 10, rows: 16, seed: seed() });
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
    const complete = await animate(phase.duration, (progress) => {
      activePhase.progress = progress; scene = samplePieces(phase, progress); render();
    });
    if (!complete || actionEpoch !== epoch) return;
    scene = phase.to;
    if (phase.type === 'clear') {
      displayedScore += phase.rows.length * 100;
      $('gain').textContent = `+${phase.rows.length * 100}`; $('gain').classList.remove('show'); void $('gain').offsetWidth; $('gain').classList.add('show');
    }
    if (phase.type === 'rise') displayedRow = state.nextRow;
  }
  scene = state.pieces; displayedScore = state.score; displayedRow = state.nextRow;
  activePhase = null; busy = false; completedMessage(state.score - oldScore); render();
}
async function rotate() {
  if (busy || drag || !selectedId || state.status !== 'playing') return;
  const preview = previewRotation(state, selectedId);
  if (!preview.valid) { invalidFeedback('Для повороту бракує місця — перешкоди підсвічено.'); render(); return; }
  const id = selectedId, original = piece(id), result = rotatePiece(state, id), epoch = ++actionEpoch;
  if (!result.changed) return;
  state = result.state; busy = true;
  rotationTween = { id, progress: 0, dx: preview.frame.x - original.frame.x, dy: preview.frame.y - original.frame.y };
  const complete = await animate(150, (progress) => { rotationTween.progress = progress; render(); });
  if (!complete || epoch !== actionEpoch) return;
  rotationTween = null; scene = state.pieces; busy = false;
  message('Поворот без ходу. Тепер обери переміщення.', 'good'); render();
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
  if (event.key.toLowerCase() === 'r') { event.preventDefault(); rotate(); return; }
  const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
  if (direction) { event.preventDefault(); commit(movePieceAlongPath(state, selectedId, [{ x: direction[0], y: direction[1] }])); }
});
$('rotateButton').addEventListener('click', rotate);
$('newGameButton').addEventListener('click', startGame); $('retryButton').addEventListener('click', startGame);
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('closeHelp').addEventListener('click', () => $('helpDialog').close()); $('playButton').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (e) => { if (e.target === $('helpDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
new ResizeObserver(resize).observe(slot);
startGame();
