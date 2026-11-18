import { COLOR_DEBUT_SCORE, HAMMER_CHARGES, RAINBOW_COLOR, createGame, movePieceAlongPath, previewRotation, rotatePiece, suggestAction, useHammer } from './core/game.mjs?v=rainbow-d6dc18844b';
import { buildPlayback, samplePieces, advanceDrag } from './motion.mjs?v=rainbow-d6dc18844b';
import { BUILD_ID, createJournal, exportJournal, finishGameLog, formatAll, formatReport, importJournal, latestGame, parseDevice, recordHammer, recordTurn, startGameLog, summarizeGame } from './journal.mjs?v=rainbow-d6dc18844b';
import { isNewRecord, nextBest, parseBest, parseGame, serializeBest, serializeGame } from './core/persistence.mjs?v=rainbow-d6dc18844b';
import { HAMMER_STORAGE_KEYS as STORAGE_KEYS, STORAGE_KEYS as LEGACY_STORAGE_KEYS, STORAGE_LIMITS, createStorage } from './storage.mjs?v=rainbow-d6dc18844b';

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
let previewTween = null, previewFrame = 0;
let hintDirection = 'clockwise';
let suggestion = null, suggestionFrame = 0, hintVisible = true;
const hintButton = $('hintButton');
const hammerButton = $('hammerButton'), hammerCount = $('hammerCount');
const HAMMER_PROMPT = 'Торкнись фігури, яку хочеш прибрати.';
const HAMMER_TAP_DISTANCE = 8;
let hammerArmed = false, hammerTarget = null;
let successfulActions = 0, rotated = false, selectHintShown = false;
const ROTATE_IDLE_HINT = 'Торкнись фігури: зі світлою рамкою її можна й повернути.';
const ROTATE_SELECT_HINT = 'Фігури зі світлою рамкою можна повернути кнопками Вліво / Вправо.';
const rotationPreviews = new Map();
// --- Journal (DEMO_PLAN 18): UI-owned records with separate browser persistence.
const journal = createJournal();
let journalReadyAt = 0, journalHints = 0, journalLastHint = null;
const historyDetails = $('gameHistory'), historyEmpty = $('historyEmpty'), historyList = $('historyList');
const historyCopyArea = $('copyHistoryText'), historyCopyStatus = $('copyHistoryStatus');
function journalSafe(action) { try { return action(); } catch { return null; } }
function journalTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function journalRecord(before, result) {
  const first = result.events[0];
  if (first.type === 'hammer') {
    recordHammer(journal, { before, after: result.state, result });
  } else {
    const hint = journalLastHint, rotateAction = first.type === 'rotate';
    const followed = Boolean(hint) && hint.pieceId === first.pieceId && (rotateAction
      ? hint.kind === 'rotate' && hint.direction === first.direction
      : hint.kind === 'move' && hint.offset.x === first.lastValidOffset?.x && hint.offset.y === first.lastValidOffset?.y);
    recordTurn(journal, {
      before, after: result.state, result, kind: rotateAction ? 'rotate' : 'move',
      pathLength: first.path?.length ?? 0, pieceLength: before.pieces.find((item) => item.id === first.pieceId)?.cells.length ?? 0,
      direction: first.direction ?? null, ms: performance.now() - journalReadyAt, hintsPressed: journalHints, followedHint: followed,
    });
    journalHints = 0;
  }
  journalLastHint = null;
  if (result.state.status === 'gameover') finishGameLog(journal, result.state, { endedAt: Date.now() });
}

// --- Persistence (P1, PERSISTENCE_PLAN.md): the best score, the last game and the journal live in localStorage.
// Two tabs share one store: the last write wins (no cross-tab merging). Every call is wrapped so storage can never break the game.
const STORAGE_NOTICE = 'Прогрес цього запуску не збережеться.';
let best = 0, bestAtStart = 0, recordBase = 0, storageNoticePending = false, storageNoticeShown = false;
const storage = createStorage({ onUnavailable: () => { if (!storageNoticeShown) { storageNoticeShown = true; storageNoticePending = true; } } });
function persistSafe(action) { try { return action(); } catch { return null; } }
function persistGame() {
  if (state) persistSafe(() => storage.save(STORAGE_KEYS.game, serializeGame(state, { bestAtStart, savedAt: Date.now() })));
}
function persistBest() {
  if (!state || nextBest(best, state.score) === best) return;
  best = nextBest(best, state.score);
  // Another tab may have stored a higher record: re-read it and never lower it.
  persistSafe(() => storage.load(STORAGE_KEYS.best).then((read) => {
    const parsed = read.ok ? parseBest(read.value) : null;
    if (parsed?.ok && parsed.score > best) best = parsed.score;
    storage.save(STORAGE_KEYS.best, serializeBest(best));
  }).catch(() => {}));
}
function persistJournal() {
  persistSafe(() => {
    // Fall back to fewer stored games when the whole journal would not fit the size limit.
    for (const maxGames of [5, 3, 2, 1]) {
      const record = exportJournal(journal, { maxGames });
      if (JSON.stringify(record).length <= STORAGE_LIMITS[STORAGE_KEYS.journal] || maxGames === 1) {
        storage.save(STORAGE_KEYS.journal, record);
        return;
      }
    }
  });
}
function persistAll() { persistBest(); persistGame(); persistJournal(); }

async function readSavedRecord(slot) {
  const stored = await storage.load(STORAGE_KEYS[slot]);
  if (stored.ok || stored.reason !== 'missing') return stored;
  const legacy = await storage.load(LEGACY_STORAGE_KEYS[slot]);
  return legacy.ok ? { ...legacy, legacy: true } : legacy;
}
function hasProgress(game) {
  return game.turn > 0 || (game.hammersRemaining ?? HAMMER_CHARGES) < HAMMER_CHARGES;
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
  if (nextCell !== cell) { cancelDrag(); cancelHammerTarget(); }
  cell = nextCell;
  setCanvas(board, ctx, cell * state.cols, cell * state.rows);
  setCanvas(nextCanvas, nextCtx, cell * state.cols, cell);
  nextCanvas.parentElement.style.width = `${cell * state.cols}px`;
  render();
  if (previewTween) drawNextRowCanvas();
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
const RAINBOW_BANDS = ['#ff6574', '#ffc56b', '#f6ee73', '#66e5c5', '#5d8fe8', '#c58bff'];
// Rainbow strip: hard-edged diagonal bands, the same on the board and in the next-row block.
function rainbowGradient(context, left, top, width, height) {
  const band = Math.max(6, cell * .36), length = width + height;
  const count = Math.max(RAINBOW_BANDS.length, Math.round(length / band));
  const gradient = context.createLinearGradient(left, top, left + length / 2, top + length / 2);
  for (let index = 0; index < count; index += 1) {
    const color = RAINBOW_BANDS[index % RAINBOW_BANDS.length];
    gradient.addColorStop(index / count, color); gradient.addColorStop(Math.min(1, (index + 1) / count - 1e-4), color);
  }
  return gradient;
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
  const gradient = color === RAINBOW_COLOR ? rainbowGradient(context, left, top, barWidth, barHeight) : context.createLinearGradient(0, top, 0, top + barHeight);
  if (color !== RAINBOW_COLOR) {
    gradient.addColorStop(0, brighten(color, 28)); gradient.addColorStop(.55, color);
    gradient.addColorStop(1, color);
  }
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
function updateNextRowLabel(kind = state.nextRowKind, skipNextRise = state.skipNextRise) {
  const playing = state.status === 'playing';
  const label = !playing ? 'Наступний ряд'
    : skipNextRise ? 'Ряд після паузи'
      : kind === 'rescue' ? 'Рятувальний ряд' : 'Наступний ряд';
  $('nextRowLabel').textContent = label;
  nextCanvas.setAttribute('aria-label', label);
}
function drawNextRowCanvas(now = performance.now()) {
  nextCtx.clearRect(0, 0, state.cols * cell, cell);
  for (let x = 0; x < state.cols; x++) {
    nextCtx.fillStyle = '#192b4380'; nextCtx.beginPath(); roundRectPath(nextCtx, x * cell + 1, 1, cell - 2, cell - 2, 3); nextCtx.fill();
  }
  if (!previewTween) {
    for (const segment of displayedRow) drawBar(nextCtx, segment.x, 0, segment.length, 1, segment.color, .92);
    return;
  }
  const progress = Math.max(0, Math.min(1, (now - previewTween.start) / previewTween.duration));
  for (const segment of previewTween.from) drawBar(nextCtx, segment.x, 0, segment.length, 1, segment.color, .92 * (1 - progress));
  for (const segment of previewTween.to) drawBar(nextCtx, segment.x, 0, segment.length, 1, segment.color, .92 * progress);
}
function cancelPreviewTransition() {
  if (previewFrame) cancelAnimationFrame(previewFrame);
  previewFrame = 0;
  if (previewTween) displayedRow = previewTween.to;
  previewTween = null;
}
function previewTransitionTick() {
  previewFrame = 0;
  if (!previewTween) return;
  const progress = Math.max(0, Math.min(1, (performance.now() - previewTween.start) / previewTween.duration));
  drawNextRowCanvas();
  if (progress < 1) previewFrame = requestAnimationFrame(previewTransitionTick);
  else previewTween = null;
}
function transitionNextRow(row, kind, skipNextRise = false) {
  cancelPreviewTransition();
  const from = displayedRow.map((segment) => ({ ...segment }));
  const to = row.map((segment) => ({ ...segment }));
  displayedRow = to;
  updateNextRowLabel(kind, skipNextRise);
  if (reducedMotion.matches || document.hidden || JSON.stringify(from) === JSON.stringify(to)) {
    previewTween = null;
    drawNextRowCanvas();
    return;
  }
  previewTween = { from, to, start: performance.now(), duration: 130 };
  drawNextRowCanvas();
  previewFrame = requestAnimationFrame(previewTransitionTick);
}
function showNextRow() {
  cancelPreviewTransition();
  const playing = state.status === 'playing';
  displayedRow = playing ? state.nextRow.map((segment) => ({ ...segment })) : [];
  updateNextRowLabel();
  drawNextRowCanvas();
}
function render() {
  if (!state) return;
  const showRotation = !busy && !drag && !hammerArmed && state.status === 'playing';
  const remaining = state.hammersRemaining ?? 0;
  hammerCount.textContent = remaining;
  hammerButton.disabled = busy || Boolean(drag) || confirmOpen || state.status !== 'playing' || remaining === 0;
  hammerButton.setAttribute('aria-pressed', String(hammerArmed));
  hammerButton.setAttribute('aria-label', `Молоток, запас ударів ${remaining} з ${HAMMER_CHARGES}`);
  board.classList.toggle('hammer-armed', hammerArmed);
  const rotationHints = showRotation && rotationPreviews.get(selectedId);
  for (const [direction, button] of Object.entries(rotationButtons)) {
    button.disabled = !rotationHints?.[direction];
  }
  if (!busy) hintVisible = state.trial === true && state.status === 'playing';
  hintButton.classList.toggle('is-off', !hintVisible);
  hintButton.disabled = busy || Boolean(drag || hammerTarget) || !hintVisible;
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
  if (!previewTween) drawNextRowCanvas();
  $('score').textContent = displayedScore.toLocaleString('uk-UA'); $('turn').textContent = state.turn;
  $('best').textContent = `Рекорд ${Math.max(recordBase, displayedScore).toLocaleString('uk-UA')}`;
  $('newRecord').hidden = !(state.status === 'gameover' && isNewRecord(state.score, bestAtStart));
  $('gameOver').hidden = state.status !== 'gameover' || busy;
  $('finalScore').textContent = state.score.toLocaleString('uk-UA');
  const boardPrompt = hammerArmed ? HAMMER_PROMPT : selectedId ? 'Фігуру обрано.' : 'Обери фігуру.';
  board.setAttribute('aria-label', `Поле ${state.cols} на ${state.rows}. Очки: ${displayedScore}. Ходів: ${state.turn}. ${boardPrompt}`);
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
  if (!state || busy || drag || hammerTarget || confirmOpen || state.status !== 'playing' || !hintVisible) return;
  disarmHammer();
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
function completedMessage(gained = 0, doubled = false, didRise = true, hammered = false) {
  if (storageNoticePending && state.status === 'playing') { storageNoticePending = false; message(STORAGE_NOTICE, 'bad'); return; }
  const doubledText = doubled === 'after-rise' ? 'Додано ряд, поле подвоїлось.' : state.skipNextRise ? 'Поле подвоїлось. Наступний хід без підйому.' : 'Поле подвоїлось. Показаний ряд чекає.';
  if (state.status === 'gameover') message('Верхній ряд зайнятий.', 'bad');
  else if (gained && doubled) message(`Прибрано рядів: ${gained / 100} · +${gained}. ${doubledText}`, 'good');
  else if (gained) message(`Прибрано рядів: ${gained / 100} · +${gained} очок${didRise ? '' : '. Показаний ряд чекає.'}`, 'good');
  else if (doubled) message(doubledText, 'good');
  else if (hammered) message('Фігуру прибрано.', 'good');
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
function installState(next, text, restored = false) {
  actionEpoch++; cancelTween(); cancelDrag(); disarmHammer(); clearSuggestion(); busy = false; selectedId = null; activePhase = null; rotationTween = null;
  hintDirection = 'clockwise'; successfulActions = restored ? next.turn : 0; rotated = false; selectHintShown = false;
  state = next;
  journalHints = 0; journalLastHint = null; journalReadyAt = performance.now();
  scene = state.pieces; displayedScore = state.score;
  showNextRow(); refreshRotationPreviews();
  board.classList.remove('dragging'); frame.classList.remove('resolve', 'invalid'); $('gain').classList.remove('show');
  if (text) message(text);
  else if (state.skipNextRise) completedMessage();
  else message(rotationHintActive() ? ROTATE_IDLE_HINT : 'Торкнись фігури, щоб обрати.');
  resize();
}
function startGame(notice = '') {
  const gameSeed = seed();
  const next = createGame({ cols: 8, rows: 12, seed: gameSeed, trial: true });
  journalSafe(() => {
    const now = new Date();
    startGameLog(journal, { seed: gameSeed, mode: `trial ${next.cols}x${next.rows}`, startedAt: now.getTime(), startedLabel: journalTime(now), device: parseDevice(navigator.userAgent), build: BUILD_ID });
    resetCopyUi();
    refreshHistory();
  });
  bestAtStart = best; recordBase = best;
  installState(next, notice);
  if (storageNoticePending && !notice) { storageNoticePending = false; message(STORAGE_NOTICE, 'bad'); }
  persistGame(); persistJournal(); // a fresh game replaces the stored one; the best score and the journal stay
}
// Restores the stored best score, last game and journal; a damaged or foreign game record never blocks a new game.
async function initGame() {
  const [bestRead, gameRead, journalRead] = await Promise.all([
    storage.load(STORAGE_KEYS.best), readSavedRecord('game'), readSavedRecord('journal'),
  ]);
  if (bestRead.ok) { const parsed = parseBest(bestRead.value); if (parsed.ok) best = parsed.score; }
  if (journalRead.ok) {
    const imported = importJournal(journalRead.value);
    if (imported.ok) journal.games = imported.journal.games;
  }
  const record = gameRead.ok ? parseGame(gameRead.value) : null;
  if (!record?.ok) {
    const damaged = gameRead.ok || gameRead.reason !== 'missing';
    startGame(damaged ? 'Збережену партію не вдалося відновити, почато нову.' : '');
    if (!storage.available && !storageNoticeShown) { storageNoticeShown = true; storageNoticePending = false; message(STORAGE_NOTICE, 'bad'); }
    return;
  }
  const bestStored = best;
  best = Math.max(best, record.state.score, record.bestAtStart);
  if (best > bestStored) persistSafe(() => storage.save(STORAGE_KEYS.best, serializeBest(best)));
  bestAtStart = record.bestAtStart; recordBase = Math.max(best, bestAtStart);
  journalSafe(() => {
    const last = latestGame(journal);
    if (record.state.status === 'gameover') { if (last && !last.end) finishGameLog(journal, record.state, { endedAt: record.savedAt }); }
    else if (!last || last.end) {
      startGameLog(journal, { seed: 0, mode: `trial ${record.state.cols}x${record.state.rows} restored`, startedAt: record.savedAt, startedLabel: null, device: parseDevice(navigator.userAgent), build: BUILD_ID });
    }
    resetCopyUi();
    refreshHistory();
  });
  installState(record.state, hasProgress(record.state) ? 'Партію відновлено.' : '', true);
  if (gameRead.legacy) persistGame();
  persistBest(); persistJournal();
}
async function commit(result, initialScene = scene) {
  if (!result.changed) { invalidFeedback('Шлях зайнятий. Спробуй обійти перешкоду.'); render(); return; }
  cancelPreviewTransition();
  const epoch = ++actionEpoch, oldScore = state.score;
  const hammered = result.events[0]?.type === 'hammer';
  if (!hammered) successfulActions++;
  clearSuggestion();
  journalSafe(() => journalRecord(state, result)); // journal: successful actions only
  state = result.state; selectedId = null; busy = true; scene = initialScene;
  persistBest(); persistGame(); persistJournal(); // the finished turn is stored BEFORE the animation starts
  message('Фігури займають свої місця…'); render();
  const hasDouble = result.events.some((event) => event.type === 'double');
  const doubled = hasDouble && (result.events.some((event) => event.type === 'rise' || event.type === 'refill') ? 'after-rise' : 'replace');
  const hasDebutPreview = state.status === 'playing' && oldScore < COLOR_DEBUT_SCORE
    && state.score >= COLOR_DEBUT_SCORE && state.nextRow.some((segment) => segment.color !== state._trialColor && segment.color !== RAINBOW_COLOR);
  let didRise = false;
  let waitingForDebut = false;
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
    if (phase.type === 'rise' || (hammered && phase.type === 'refill')) {
      didRise = true;
      waitingForDebut = hasDebutPreview && displayedScore < COLOR_DEBUT_SCORE;
      if (waitingForDebut || state.status !== 'playing') transitionNextRow([], 'regular');
      else transitionNextRow(state.nextRow, state.nextRowKind, state.skipNextRise);
    }
    if (phase.type === 'clear') {
      displayedScore += phase.rows.length * 100;
      $('gain').textContent = `+${phase.rows.length * 100}`; $('gain').classList.remove('show'); void $('gain').offsetWidth; $('gain').classList.add('show');
      if (waitingForDebut && displayedScore >= COLOR_DEBUT_SCORE) {
        waitingForDebut = false;
        render();
        transitionNextRow(state.nextRow, state.nextRowKind, state.skipNextRise);
      }
    }
  }
  scene = state.pieces; displayedScore = state.score; journalReadyAt = performance.now();
  if (!didRise || waitingForDebut || state.status === 'gameover') showNextRow();
  refreshRotationPreviews();
  activePhase = null; busy = false; completedMessage(state.score - oldScore, doubled, didRise, hammered); render();
}
function rotate(direction) {
  if (busy || drag || hammerArmed || confirmOpen || !selectedId || state.status !== 'playing') return;
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
function pieceAt(event) {
  const rect = board.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / cell), y = Math.floor((event.clientY - rect.top) / cell);
  return state.pieces.find((item) => item.cells.some((point) => point.x === x && point.y === y));
}
function movedDuringHammerTap(event, target) {
  return Math.hypot(event.clientX - target.startX, event.clientY - target.startY) > HAMMER_TAP_DISTANCE;
}
function cancelHammerTarget() {
  if (!hammerTarget) return;
  const { pointerId } = hammerTarget;
  hammerTarget = null; selectedId = null;
  if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
  scheduleRender();
}
function disarmHammer() {
  if (!hammerArmed) return;
  hammerArmed = false; cancelHammerTarget();
}
function toggleHammer() {
  if (!state || busy || drag || confirmOpen || state.status !== 'playing' || !state.hammersRemaining) return;
  if (hammerArmed) {
    disarmHammer();
    completedMessage();
  } else {
    hammerArmed = true; selectedId = null; clearSuggestion();
    message(HAMMER_PROMPT);
  }
  render();
}
board.addEventListener('pointerdown', (event) => {
  if (!state || confirmOpen || busy || state.status !== 'playing' || event.button > 0 || !event.isPrimary || drag || hammerTarget) return;
  event.preventDefault(); board.focus({ preventScroll: true });
  const hit = pieceAt(event);
  selectedId = hit?.id ?? null;
  if (suggestion && suggestion.pieceId !== selectedId) clearSuggestion();
  if (hammerArmed) {
    if (hit) {
      hammerTarget = { id: hit.id, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId };
      board.setPointerCapture(event.pointerId);
    }
    render();
    return;
  }
  if (hit) {
    drag = { id: hit.id, startX: event.clientX, startY: event.clientY, pointerId: event.pointerId,
      path: [{ x: 0, y: 0 }], offset: { x: 0, y: 0 }, floating: { x: 0, y: 0 }, moved: false, blocked: false };
    board.setPointerCapture(event.pointerId); board.classList.add('dragging');
    message('Рухай у будь-який бік вільним шляхом. Відпусти — фігура впаде.');
  } else message('Торкнись кольорової фігури.');
  render();
});
board.addEventListener('pointermove', (event) => {
  if (hammerTarget?.pointerId === event.pointerId) {
    event.preventDefault();
    if (movedDuringHammerTap(event, hammerTarget)) cancelHammerTarget();
    return;
  }
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents?.() ?? [];
  for (const sample of samples) processDragSample(sample);
  processDragSample(event); scheduleRender();
});
board.addEventListener('pointerup', (event) => {
  if (hammerTarget?.pointerId === event.pointerId) {
    const target = hammerTarget;
    const validTap = !movedDuringHammerTap(event, target) && pieceAt(event)?.id === target.id;
    cancelHammerTarget();
    if (validTap && hammerArmed && !confirmOpen && !busy) {
      const result = useHammer(state, target.id);
      if (result.changed) { disarmHammer(); commit(result); }
    }
    return;
  }
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
function cancelPointer(event) {
  if (drag?.pointerId === event.pointerId) cancelDrag();
  if (hammerTarget?.pointerId === event.pointerId) cancelHammerTarget();
}
board.addEventListener('pointercancel', cancelPointer);
board.addEventListener('lostpointercapture', cancelPointer);
window.addEventListener('blur', () => { cancelDrag(); cancelHammerTarget(); });
window.addEventListener('pagehide', persistAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) journalReadyAt = performance.now();
  if (document.hidden) {
    persistAll();
    cancelDrag(); cancelHammerTarget();
    if (busy) finishPlayback();
    else if (previewTween) { cancelPreviewTransition(); showNextRow(); }
  }
});
board.addEventListener('keydown', (event) => {
  if (!selectedId || busy || drag || hammerArmed || confirmOpen || state.status !== 'playing') return;
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
hammerButton.addEventListener('click', toggleHammer);
// --- Copy results (DEMO_PLAN 18): clipboard write inside the click handler; read-only textarea as the fallback.
const copyGroups = {
  result: {
    button: $('copyResultButton'), status: $('copyResultStatus'), area: $('copyResultText'),
    label: 'Скопіювати результати', success: 'Результати скопійовано.', fallback: 'Скопіюйте вручну.',
    epoch: 0, timer: 0,
  },
  all: {
    button: $('copyJournalButton'), status: $('copyJournalStatus'), area: $('copyJournalText'),
    label: 'Скопіювати журнал партій', success: 'Результати скопійовано.', fallback: 'Скопіюйте вручну.',
    epoch: 0, timer: 0,
  },
  history: {
    status: historyCopyStatus, area: historyCopyArea,
    success: 'Журнал партії скопійовано.', fallback: 'Скопіюйте журнал партії вручну.',
    epoch: 0, timer: 0,
  },
};
function resetCopyGroup(group) {
  group.epoch++;
  clearTimeout(group.timer); group.timer = 0;
  if (group.button) group.button.textContent = group.label;
  if (group.status) group.status.textContent = '';
  if (group.area) { group.area.hidden = true; group.area.value = ''; }
}
function resetCopyUi() { for (const group of Object.values(copyGroups)) resetCopyGroup(group); }
function copyDone(group, ok, text, epoch) {
  if (epoch !== group.epoch) return;
  if (ok) {
    if (group.area) { group.area.hidden = true; group.area.value = ''; }
    if (group.status) group.status.textContent = group.success;
    if (group.button) {
      group.button.textContent = 'Скопійовано';
      group.timer = setTimeout(() => {
        if (epoch !== group.epoch) return;
        group.button.textContent = group.label;
        group.timer = 0;
      }, 2000);
    } else {
      group.timer = setTimeout(() => {
        if (epoch !== group.epoch) return;
        if (group.status) group.status.textContent = '';
        group.timer = 0;
      }, 4000);
    }
  } else {
    if (group.status) group.status.textContent = group.fallback;
    if (group.area) {
      group.area.hidden = false; group.area.value = text;
      group.area.focus({ preventScroll: true }); group.area.select(); group.area.setSelectionRange(0, text.length);
      if (group === copyGroups.history) group.area.scrollIntoView({ block: 'nearest' });
    }
  }
}
function requestCopy(group, build) {
  resetCopyGroup(group);
  const epoch = group.epoch;
  let text = '';
  try { text = build(); } catch {
    if (group.status) group.status.textContent = 'Журнал недоступний.';
    return;
  }
  if (!text) { if (group.status) group.status.textContent = 'Немає даних для копіювання.'; return; }
  if (group.status) group.status.textContent = 'Копіюємо…';
  let pending;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable');
    pending = navigator.clipboard.writeText(text);
  } catch { copyDone(group, false, text, epoch); return; }
  Promise.resolve(pending).then(
    () => copyDone(group, true, text, epoch),
    () => copyDone(group, false, text, epoch),
  );
}
copyGroups.result.button.addEventListener('click', () => requestCopy(copyGroups.result, () => {
  const game = latestGame(journal); return game ? formatReport(game) : '';
}));
copyGroups.all.button.addEventListener('click', () => requestCopy(copyGroups.all, () => formatAll(journal)));

function historyDate(game) {
  if (typeof game.startedAt === 'number' && Number.isFinite(game.startedAt)) {
    const date = new Date(game.startedAt);
    if (Number.isFinite(date.getTime())) {
      try {
        return new Intl.DateTimeFormat('uk-UA', {
          day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
        }).format(date);
      } catch { /* use the journal's saved label below */ }
    }
  }
  if (typeof game.startedLabel === 'string' && game.startedLabel.trim()) return game.startedLabel.trim().slice(0, 80);
  return 'Дата невідома';
}

function historyStatus(summary) {
  if (summary.reason === 'playing') return 'Триває';
  if (summary.reason === 'abandoned') return 'Перервана';
  return 'Завершена';
}

function refreshHistory() {
  resetCopyGroup(copyGroups.history);
  if (!historyList || !historyEmpty) return;
  const games = journal.games.slice().reverse();
  historyList.replaceChildren();
  historyEmpty.hidden = games.length > 0;
  for (const game of games) {
    const summary = summarizeGame(game);
    const date = historyDate(game);
    const item = document.createElement('li'); item.className = 'history-entry';
    const info = document.createElement('div'); info.className = 'history-entry-info';
    const dateText = document.createElement('span'); dateText.className = 'history-entry-date'; dateText.textContent = date;
    const meta = document.createElement('span'); meta.className = 'history-entry-meta';
    const description = `${summary.score} очок · ${historyStatus(summary)}`;
    meta.textContent = description;
    info.append(dateText, meta);
    const button = document.createElement('button');
    button.className = 'secondary-button history-copy'; button.type = 'button'; button.textContent = 'Копіювати';
    button.setAttribute('aria-label', `Скопіювати журнал партії від ${date} · ${description}`);
    button.addEventListener('click', () => requestCopy(copyGroups.history, () => formatReport(game)));
    item.append(info, button); historyList.append(item);
  }
}
// --- New game: an unfinished game is replaced only after an in-page confirmation (not window.confirm).
const confirmBox = $('confirmNew'), confirmStart = $('confirmStart'), confirmCancel = $('confirmCancel');
let confirmOpen = false;
function closeConfirm() { confirmOpen = false; confirmBox.hidden = true; $('newGameButton').focus({ preventScroll: true }); render(); }
function requestNewGame() {
  if (!state || confirmOpen) return;
  if (hammerArmed) { disarmHammer(); completedMessage(); }
  if (state.status === 'playing' && hasProgress(state)) {
    confirmOpen = true; confirmBox.hidden = false; confirmStart.focus({ preventScroll: true }); render();
    return;
  }
  startGame();
}
confirmStart.addEventListener('click', () => { closeConfirm(); startGame(); });
confirmCancel.addEventListener('click', closeConfirm);
document.addEventListener('keydown', (event) => {
  if (!confirmOpen) {
    if (event.key === 'Escape' && hammerArmed) { event.preventDefault(); disarmHammer(); completedMessage(); render(); }
    return;
  }
  if (event.key === 'Escape') { event.preventDefault(); closeConfirm(); }
  else if (event.key === 'Enter' && event.repeat) event.preventDefault(); // a held key must not confirm by itself
  else if (event.key === 'Enter' && document.activeElement !== confirmCancel) { event.preventDefault(); closeConfirm(); startGame(); }
  else if (event.key === 'Tab') { event.preventDefault(); (document.activeElement === confirmStart ? confirmCancel : confirmStart).focus({ preventScroll: true }); }
});
$('newGameButton').addEventListener('click', requestNewGame); $('retryButton').addEventListener('click', () => startGame());
$('helpButton').addEventListener('click', () => {
  if (hammerArmed) { disarmHammer(); completedMessage(); render(); }
  refreshHistory();
  $('helpDialog').showModal();
});
$('helpDialog').addEventListener('close', () => {
  resetCopyGroup(copyGroups.all);
  resetCopyGroup(copyGroups.history);
  journalReadyAt = performance.now();
}); // thinking time excludes reading the help; pending copy answers cannot update a closed/reopened dialog
historyDetails?.addEventListener('toggle', () => {
  if (historyDetails.open) refreshHistory();
  else resetCopyGroup(copyGroups.history);
});
$('closeHelp').addEventListener('click', () => $('helpDialog').close()); $('playButton').addEventListener('click', () => $('helpDialog').close());
$('helpDialog').addEventListener('click', (e) => { if (e.target === $('helpDialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
new ResizeObserver(resize).observe(playArea);
await initGame();
