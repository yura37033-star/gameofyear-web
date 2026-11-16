import { HINT_SCORE_LIMIT, createGame, movePieceAlongPath, previewRotation, rotatePiece, suggestAction } from './core/game.mjs';
import { buildPlayback, samplePieces, advanceDrag } from './motion.mjs';
import { BUILD_ID, createJournal, finishGameLog, formatAll, formatReport, latestGame, parseDevice, recordTurn, startGameLog } from './journal.mjs';

const $ = (id) => document.getElementById(id);
const board = $('board'), nextCanvas = $('nextRow'), playArea = $('playArea'), frame = $('boardFrame');
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
let suggestion = null, suggestionFrame = 0, hintVisible = true;
const hintButton = $('hintButton');
let successfulActions = 0, rotated = false, selectHintShown = false;
const ROTATE_IDLE_HINT = 'Торкнись фігури: зі світлою рамкою її можна й повернути.';
const ROTATE_SELECT_HINT = 'Фігури зі світлою рамкою можна повернути кнопками Вліво / Вправо.';
const rotationPreviews = new Map();
// --- Journal (DEMO_PLAN 18): in memory only, outside the core; every call is wrapped so it cannot break the game.
const journal = createJournal();
let journalReadyAt = 0, journalHints = 0, journalLastHint = null;
function journalSafe(action) { try { return action(); } catch { return null; } }
function journalTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function journalRecord(before, result) {
  const first = result.events[0], hint = journalLastHint, rotateAction = first.type === 'rotate';
  const followed = Boolean(hint) && hint.pieceId === first.pieceId && (rotateAction
    ? hint.kind === 'rotate' && hint.direction === first.direction
    : hint.kind === 'move' && hint.offset.x === first.lastValidOffset?.x && hint.offset.y === first.lastValidOffset?.y);
  recordTurn(journal, {
    before, after: result.state, result, kind: rotateAction ? 'rotate' : 'move',
    pathLength: first.path?.length ?? 0, pieceLength: before.pieces.find((item) => item.id === first.pieceId)?.cells.length ?? 0,
    direction: first.direction ?? null, ms: performance.now() - journalReadyAt, hintsPressed: journalHints, followedHint: followed,
  });
  journalHints = 0; journalLastHint = null;
  if (result.state.status === 'gameover') finishGameLog(journal, result.state, { endedAt: Date.now() });
}

function seed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0];
  return Date.now() >>> 0;
}
function message(text, tone = '', fit = false) {
  const status = $('status');
  status.textContent = text; status.className = `status ${tone}`; status.style.fontSize = '';
  if (fit && status.scrollWidth > status.clientWidth) {
    // Long hint text stays on one line: shrink it (down to 8px) instead of changing the layout.
    const size = Number.parseFloat(getComputedStyle(status).fontSize);
    status.style.fontSize = `${Math.max(8, Math.floor(size * status.clientWidth / status.scrollWidth * 10) / 10)}px`;
  }
}
function rotationHintActive() { return !rotated && successfulActions < 2 && state.status === 'playing' && rotationPreviews.size > 0; }
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
  const frameWidth = frame.offsetWidth - board.offsetWidth;
  const frameHeight = frame.offsetHeight - board.offsetHeight;
  const labelHeight = nextCanvas.parentElement.offsetHeight - nextCanvas.offsetHeight;
  const gap = Number.parseFloat(getComputedStyle(playArea).rowGap) || 0;
  const widthPerCell = (playArea.clientWidth - frameWidth) / state.cols;
  const heightPerCell = (playArea.clientHeight - frameHeight - labelHeight - gap) / (state.rows + 1);
  const nextCell = Math.max(8, Math.floor(Math.min(widthPerCell, heightPerCell)));
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
function drawBar(context, x, y, width, height, color, alpha = 1, scale = 1, selected = false, canRotate = false) {
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
  context.strokeStyle = selected ? '#fff5da' : canRotate ? '#d4dce8' : '#ffffff54';
  context.lineWidth = selected || canRotate ? 2 : 1;
  context.stroke();
  context.restore();
}
function drawPiece(item, alpha = 1, selected = item.id === selectedId, canRotate = false) {
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
      item.color, alpha * (first.opacity ?? 1), first.scale ?? 1, selected, canRotate);
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
function drawSuggestion() {
  if (!suggestion || suggestion.kind !== 'move') return;
  const source = piece(suggestion.pieceId);
  if (!source) return;
  const pulse = reducedMotion.matches ? 1 : .55 + .45 * Math.sin(performance.now() / 260);
  drawPiece({ ...source, cells: suggestion.cells }, .3 + .15 * pulse, false);
  const xs = suggestion.cells.map((p) => p.x), ys = suggestion.cells.map((p) => p.y);
  const left = Math.min(...xs), top = Math.min(...ys);
  const width = Math.max(...xs) - left + 1, height = Math.max(...ys) - top + 1;
  ctx.save(); ctx.fillStyle = '#d58bff26'; ctx.strokeStyle = '#d58bff'; ctx.globalAlpha = .45 + .55 * pulse;
  ctx.lineWidth = 2.5; ctx.setLineDash([6, 4]);
  ctx.beginPath(); roundRectPath(ctx, left * cell + 2, top * cell + 2, width * cell - 4, height * cell - 4, Math.max(2, cell * .16));
  ctx.fill(); ctx.stroke(); ctx.restore();
}
function movedDrawing(item, offset) {
  return { ...item, cells: item.cells.map((c) => ({ x: c.x + offset.x, y: c.y + offset.y })) };
}
function refreshRotationPreviews() {
  rotationPreviews.clear();
  if (state.status !== 'playing') return;
  for (const item of state.pieces) {
    if (item.cells.length === 1) continue;
    const hints = {};
    for (const direction of Object.keys(rotationButtons)) {
      const preview = previewRotation(state, item.id, direction);
      if (preview.valid) hints[direction] = preview.cells;
    }
    if (hints.clockwise || hints.counterclockwise) rotationPreviews.set(item.id, hints);
  }
}
function showNextRow() {
  const playing = state.status === 'playing';
  displayedRow = playing ? state.nextRow : [];
  const label = state.skipNextRise && playing ? 'Ряд після паузи'
    : state.nextRowKind === 'rescue' && playing ? 'Рятувальний ряд' : 'Наступний ряд';
  $('nextRowLabel').textContent = label;
  nextCanvas.setAttribute('aria-label', label);
}
function render() {
  if (!state) return;
  const showRotation = !busy && !drag && state.status === 'playing';
  const rotationHints = showRotation && rotationPreviews.get(selectedId);
  for (const [direction, button] of Object.entries(rotationButtons)) {
    button.disabled = !rotationHints?.[direction];
  }
  if (!busy) hintVisible = state.trial === true && state.status === 'playing' && state.score < HINT_SCORE_LIMIT;
  hintButton.classList.toggle('is-off', !hintVisible);
  hintButton.disabled = busy || Boolean(drag) || !hintVisible;
  for (const [direction, button] of Object.entries(rotationButtons)) {
    button.classList.toggle('hint-target', Boolean(suggestion) && !busy && suggestion.kind === 'rotate' && suggestion.direction === direction);
  }
  ctx.clearRect(0, 0, board.width, board.height);
  ctx.fillStyle = '#0c182a'; ctx.fillRect(0, 0, state.cols * cell, state.rows * cell);
  for (let y = 0; y < state.rows; y++) for (let x = 0; x < state.cols; x++) {
    ctx.fillStyle = (x + y) % 2 ? '#14233a61' : '#17283e61';
    ctx.beginPath(); roundRectPath(ctx, x * cell + 1, y * cell + 1, cell - 2, cell - 2, 3); ctx.fill();
  }
  const danger = scene.some((p) => p.cells.some((c) => c.y <= 1));
  frame.classList.toggle('danger', danger);
  if (danger) { ctx.fillStyle = '#ff657414'; ctx.fillRect(0, 0, cell * state.cols, cell); }
  for (const item of scene) {
    if (rotationTween?.id === item.id) {
      const rotation = rotationTween, amount = 1 - (1 - rotation.progress) ** 3;
      const centerX = (item.frame.x + item.frame.size / 2) * cell, centerY = (item.frame.y + item.frame.size / 2) * cell;
      ctx.save(); ctx.translate((rotation.dx * amount) * cell, (rotation.dy * amount) * cell);
      ctx.translate(centerX, centerY); ctx.rotate(rotation.angle * amount); ctx.translate(-centerX, -centerY);
      drawPiece(item); ctx.restore();
    } else {
      drawPiece(item, drag?.moved && drag.id === item.id ? .12 : 1,
        item.id === selectedId, showRotation && rotationPreviews.has(item.id));
    }
  }
  if (activePhase?.type === 'clear') {
    ctx.fillStyle = `rgba(129,255,215,${.16 * (1 - activePhase.progress)})`;
    for (const y of activePhase.rows) ctx.fillRect(0, y * cell, state.cols * cell, cell);
  }
  if (!busy) drawSuggestion();
  if (drag?.moved) {
    const selected = piece(drag.id);
    drawHint(movedDrawing(selected, drag.offset).cells, drag.blocked);
    drawPiece(movedDrawing(selected, drag.floating), 1, true);
  } else {
    const hint = rotationHints?.[hintDirection] ?? rotationHints?.clockwise ?? rotationHints?.counterclockwise;
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
function clearSuggestion() {
  suggestion = null; cancelAnimationFrame(suggestionFrame); suggestionFrame = 0;
}
function suggestionTick() {
  suggestionFrame = 0;
  if (!suggestion) return;
  render();
  if (!reducedMotion.matches && !document.hidden) suggestionFrame = requestAnimationFrame(suggestionTick);
}
function requestHint() {
  if (busy || drag || state.status !== 'playing' || !hintVisible) return;
  const found = suggestAction(state);
  journalHints++; journalLastHint = found && { kind: found.kind, pieceId: found.pieceId, direction: found.direction, offset: found.offset }; // journal
  clearSuggestion();
  if (!found) { message('Підказка недоступна: шлях не знайдено.', '', true); render(); return; }
  suggestion = found; selectedId = found.pieceId;
  if (found.kind === 'rotate') {
    hintDirection = found.direction;
    message(`Підказка: поверни фігуру ${found.direction === 'clockwise' ? 'вправо' : 'вліво'}.`, 'good', true);
  } else {
    message(found.steps === 2 ? 'Підказка: перемісти сюди, це готує очищення.' : 'Підказка: перемісти фігуру сюди.', 'good', true);
  }
  render(); suggestionTick();
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
function completedMessage(gained = 0, doubled = false) {
  const doubledText = doubled === 'after-rise' ? 'Додано ряд, поле подвоїлось.' : state.skipNextRise ? 'Поле подвоїлось. Наступний хід без підйому.' : 'Поле подвоїлось. Показаний ряд чекає.';
  if (state.status === 'gameover') message('Верхній ряд зайнятий.', 'bad');
  else if (gained && doubled) message(`Прибрано рядів: ${gained / 100} · +${gained}. ${doubledText}`, 'good');
  else if (gained) message(`Прибрано рядів: ${gained / 100} · +${gained} очок`, 'good');
  else if (doubled) message(doubledText, 'good');
  else if (state.skipNextRise) message('Наступний хід без підйому.', 'good');
  else if (rotationHintActive()) message(ROTATE_IDLE_HINT);
  else message('Обирай фігуру для наступного ходу.');
}
function finishPlayback() {
  actionEpoch++; cancelTween(); activePhase = null; rotationTween = null; busy = false;
  scene = state.pieces; displayedScore = state.score; journalReadyAt = performance.now();
  showNextRow(); refreshRotationPreviews();
  frame.classList.remove('resolve'); completedMessage(); render();
}
function startGame() {
  actionEpoch++; cancelTween(); cancelDrag(); clearSuggestion(); busy = false; selectedId = null; activePhase = null; rotationTween = null;
  hintDirection = 'clockwise'; successfulActions = 0; rotated = false; selectHintShown = false;
  const gameSeed = seed();
  state = createGame({ cols: 8, rows: 12, seed: gameSeed, trial: true });
  journalSafe(() => {
    const now = new Date();
    journalHints = 0; journalLastHint = null; journalReadyAt = performance.now();
    startGameLog(journal, { seed: gameSeed, mode: `trial ${state.cols}x${state.rows}`, startedAt: now.getTime(), startedLabel: journalTime(now), device: parseDevice(navigator.userAgent), build: BUILD_ID });
    resetCopyUi();
  });
  scene = state.pieces; displayedScore = state.score;
  showNextRow(); refreshRotationPreviews();
  board.classList.remove('dragging'); frame.classList.remove('resolve', 'invalid'); $('gain').classList.remove('show');
  if (state.skipNextRise) completedMessage();
  else message(rotationHintActive() ? ROTATE_IDLE_HINT : 'Торкнись фігури, щоб обрати.');
  resize();
}
async function commit(result, initialScene = scene) {
  if (!result.changed) { invalidFeedback('Шлях зайнятий. Спробуй обійти перешкоду.'); render(); return; }
  const epoch = ++actionEpoch, oldScore = state.score;
  successfulActions++; clearSuggestion();
  journalSafe(() => journalRecord(state, result)); // journal: successful actions only
  state = result.state; selectedId = null; busy = true; scene = initialScene;
  message('Фігури займають свої місця…'); render();
  const hasDouble = result.events.some((event) => event.type === 'double');
  const doubled = hasDouble && (result.events.some((event) => event.type === 'rise') ? 'after-rise' : 'replace');
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
  }
  scene = state.pieces; displayedScore = state.score; journalReadyAt = performance.now();
  showNextRow(); refreshRotationPreviews();
  activePhase = null; busy = false; completedMessage(state.score - oldScore, doubled); render();
}
function rotate(direction) {
  if (busy || drag || !selectedId || state.status !== 'playing') return;
  const result = rotatePiece(state, selectedId, direction);
  if (result.changed) { rotated = true; commit(result); }
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
  if (suggestion && suggestion.pieceId !== selectedId) clearSuggestion();
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
  } else {
    if (selectedId && !selectHintShown && rotationHintActive() && rotationPreviews.has(selectedId)) {
      selectHintShown = true; message(ROTATE_SELECT_HINT);
    }
    render();
  }
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) journalReadyAt = performance.now(); if (document.hidden) { cancelDrag(); if (busy) finishPlayback(); } });
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
hintButton.addEventListener('click', requestHint);
// --- Copy results (DEMO_PLAN 18): clipboard write inside the click handler; read-only textarea as the fallback.
const copyUis = {
  result: { button: $('copyResultButton'), status: $('copyResultStatus'), area: $('copyResultText'), label: 'Скопіювати результати', build: () => { const game = latestGame(journal); return game ? formatReport(game) : ''; } },
  all: { button: $('copyJournalButton'), status: $('copyJournalStatus'), area: $('copyJournalText'), label: 'Скопіювати журнал партій', build: () => formatAll(journal) },
};
const copyTimers = new Map();
let copyEpoch = 0;
function resetCopyUi() {
  copyEpoch++;
  for (const ui of Object.values(copyUis)) {
    clearTimeout(copyTimers.get(ui)); ui.button.textContent = ui.label; ui.status.textContent = ''; ui.area.hidden = true; ui.area.value = '';
  }
}
function copyDone(ui, ok, text) {
  if (ok) {
    ui.area.hidden = true; ui.area.value = '';
    ui.status.textContent = 'Результати скопійовано.'; ui.button.textContent = 'Скопійовано';
    clearTimeout(copyTimers.get(ui)); copyTimers.set(ui, setTimeout(() => { ui.button.textContent = ui.label; }, 2000));
  } else {
    clearTimeout(copyTimers.get(ui)); ui.button.textContent = ui.label;
    ui.status.textContent = 'Скопіюйте вручну.'; ui.area.hidden = false; ui.area.value = text;
    ui.area.focus({ preventScroll: true }); ui.area.select(); ui.area.setSelectionRange(0, text.length);
  }
}
for (const ui of Object.values(copyUis)) {
  ui.button.addEventListener('click', () => {
    const epoch = copyEpoch;
    let text = '';
    try { text = ui.build(); } catch { ui.status.textContent = 'Журнал недоступний.'; return; }
    let pending;
    try { pending = navigator.clipboard.writeText(text); } catch { copyDone(ui, false, text); return; }
    // A slow clipboard answer must not touch the UI of a game that has been restarted meanwhile.
    Promise.resolve(pending).then(() => { if (epoch === copyEpoch) copyDone(ui, true, text); }, () => { if (epoch === copyEpoch) copyDone(ui, false, text); });
  });
}
$('newGameButton').addEventListener('click', startGame); $('retryButton').addEventListener('click', startGame);
$('helpButton').addEventListener('click', () => $('helpDialog').showModal());
$('helpDialog').addEventListener('close', () => { journalReadyAt = performance.now(); }); // thinking time excludes reading the help
$('closeHelp').addEventListener('click', () => $('helpDialog').close()); $('playButton').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (e) => { if (e.target === $('helpDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
new ResizeObserver(resize).observe(playArea);
startGame();
