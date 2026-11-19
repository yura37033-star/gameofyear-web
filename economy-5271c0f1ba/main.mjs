import { COLOR_DEBUT_SCORE, TOOL_CELL_POINTS, RAINBOW_COLOR, createGame, movePieceAlongPath, previewRotation, rotatePiece, suggestAction, toolTargetCells, useTool } from './core/game.mjs?v=economy-5271c0f1ba';
import { buildPlayback, samplePieces, advanceDrag } from './motion.mjs?v=economy-5271c0f1ba';
import { BUILD_ID, createJournal, exportJournal, finishGameLog, formatAll, formatReport, importJournal, latestGame, parseDevice, recordTool, recordTurn, startGameLog, summarizeGame } from './journal.mjs?v=economy-5271c0f1ba';
import { isNewRecord, nextBest, parseBest, parseGame, serializeBest, serializeGame } from './core/persistence.mjs?v=economy-5271c0f1ba';
import { MAX_CARRY, MAX_KINDS, PRICES, STOCK_LIMITS, TOOL_KINDS, buyCharge, coinsForScore, createStarterWallet, parseWallet, planLoadout, serializeWallet, settleGame, takeLoadout } from './economy.mjs?v=economy-5271c0f1ba';
import { HAMMER_STORAGE_KEYS, RULES_V2_STORAGE_KEYS, RULES_V3_STORAGE_KEYS, RULES_V4_STORAGE_KEYS as STORAGE_KEYS, STORAGE_KEYS as LEGACY_STORAGE_KEYS, STORAGE_LIMITS, WALLET_STORAGE_KEY, createStorage } from './storage.mjs?v=economy-5271c0f1ba';

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
let toolButtons = []; // one button per slot of state.tools (zero to two), built by buildToolButtons
const toolbar = $('toolbar'), toolActions = $('toolActions'), applyTool = $('applyTool');
const confirmBox = $('confirmNew'), loadoutBox = $('loadoutDialog');
const modalOpen = () => confirmBox.open || loadoutBox.open;
const TOOL_UI = {
  hammer: { name: 'Молоток', short: '🔨', done: 'Молоток застосовано', prompt: 'Торкнись фігури, яку хочеш прибрати.' },
  arrow: { name: 'Стріла', short: 'Стріла', done: 'Стрілу застосовано', prompt: 'Торкнись ряду, який хочеш прибрати.' },
  cannon: { name: 'Пушка', short: 'Пушка', done: 'Пушку застосовано', prompt: 'Торкнись колонки, яку хочеш прибрати.' },
};
const TOOL_TAP_DISTANCE = 8;
let activeTool = null, toolGesture = null, toolPreview = null;
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
  if (first.type === 'hammer' || first.type === 'tool') {
    recordTool(journal, { before, after: result.state, result });
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
}

// --- Persistence (P1, PERSISTENCE_PLAN.md): the best score, the last game and the journal live in localStorage.
// Two tabs share one store: the last write wins (no cross-tab merging). Every call is wrapped so storage can never break the game.
const STORAGE_NOTICE = 'Прогрес цього запуску не збережеться.';
let best = 0, bestAtStart = 0, recordBase = 0, storageNoticePending = false, storageNoticeShown = false;
// Economy (package B): the wallet is the player's, not the game's. `paidCoins` is null until the current game has been paid
// out (a loss or a replacement) and then holds the coins it paid; it is stored in the game record as coinsPaid so a reload can never pay twice.
let wallet = createStarterWallet(), paidCoins = null, startTools = null;
// The last loadout of this page session ({ kind: count }, empty when no tools were taken); null until a game was started: the first offer is then the default one.
let lastPicks = null;
let walletWriteFailed = false; // the write that stored the current game's payout did not reach storage
const WALLET_NOTICE = 'Гаманець не вдалося прочитати, видано стартовий набір.';
const storage = createStorage({ onUnavailable: () => { if (!storageNoticeShown) { storageNoticeShown = true; storageNoticePending = true; } } });
function persistSafe(action) { try { return action(); } catch { return null; } }
function persistGame() {
  if (state) persistSafe(() => storage.save(STORAGE_KEYS.game, serializeGame(state, { bestAtStart, savedAt: Date.now(), coinsPaid: paidCoins ?? undefined })));
}
// Resolves to true only when the wallet reached the browser store ({ ok: true, persisted: true }); never rejects.
function persistWallet() {
  const write = persistSafe(() => storage.save(WALLET_STORAGE_KEY, serializeWallet(wallet)));
  return Promise.resolve(write).then((result) => Boolean(result?.ok && result.persisted), () => false);
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
  const keys = [STORAGE_KEYS[slot], RULES_V3_STORAGE_KEYS[slot], RULES_V2_STORAGE_KEYS[slot], HAMMER_STORAGE_KEYS[slot], LEGACY_STORAGE_KEYS[slot]];
  for (let index = 0; index < keys.length; index += 1) {
    const stored = await storage.load(keys[index]);
    if (stored.reason === 'missing') continue;
    if (stored.ok && index > 0) return { ...stored, legacy: true };
    return stored;
  }
  return { ok: false, reason: 'missing' };
}
// A game has progress after its first turn or its first tool use. Every tool use scores 10 points per destroyed cell and
// a target is never empty, so a score above zero also covers a restored game whose starting set is unknown.
function hasProgress(game) {
  return game.turn > 0 || game.score > 0;
}
// The starting set of the restored game, read from the journal's short text ('H3A1'); null when the journal does not hold it or
// it does not fit the game (the aria-label then shows only the remaining charges).
function recoverStartTools(game) {
  const text = journalSafe(() => latestGame(journal)?.st);
  const match = typeof text === 'string' ? text.match(/^(?:H([1-6]))?(?:A([1-6]))?(?:C([1-6]))?$/) : null;
  if (!match || !Array.isArray(game.tools)) return null;
  const counts = { hammer: Number(match[1] ?? 0), arrow: Number(match[2] ?? 0), cannon: Number(match[3] ?? 0) };
  const slots = TOOL_KINDS.filter((kind) => counts[kind] > 0).map((kind) => ({ kind, charges: counts[kind] }));
  const fits = slots.length === game.tools.length && slots.every(({ kind, charges }, index) => game.tools[index].kind === kind && game.tools[index].charges <= charges);
  return fits ? slots : null;
}
function updateCoins() {
  $('coins').textContent = wallet.coins.toLocaleString('uk-UA');
  fitHud();
}
// The header row (score and record, moves, coins, field badge) never scrolls sideways: when the numbers grow it steps down through
// four type scales (data-fit 0..3, set in CSS) until the row fits. It measures only when one of the texts or the width changed.
const hud = document.querySelector('.hud');
let hudSignature = '';
function fitHud(force = false) {
  const signature = [$('score').textContent, $('turn').textContent, $('coins').textContent, $('best').textContent, hud.clientWidth].join('|');
  if (!force && signature === hudSignature) return;
  hudSignature = signature;
  for (let level = 0; level <= 3; level += 1) {
    hud.dataset.fit = String(level);
    if (hud.scrollWidth <= hud.clientWidth) break;
  }
}
// Pays the current game once: the game record (with coinsPaid) is queued BEFORE the wallet, so a break between the two writes
// loses the payout instead of paying twice. Unused charges go back to the stock inside settleGame.
// `finishJournal` is false for the replacement of a game without progress, which the journal drops on its own.
function settleCurrentGame({ finishJournal = true, endedAt = Date.now() } = {}) {
  if (!state?.trial || paidCoins !== null) return null;
  let settled;
  try { settled = settleGame(wallet, state.tools, state.score); } catch { return null; }
  paidCoins = settled.coins; wallet = settled.wallet;
  persistGame(); // record first, wallet second
  walletWriteFailed = false;
  const paidState = state;
  persistWallet().then((stored) => {
    if (stored || state !== paidState || paidCoins === null) return;
    walletWriteFailed = true; render(); // the loss screen must not present the sum as confirmed
  });
  if (finishJournal) { journalSafe(() => finishGameLog(journal, state, { endedAt, coins: paidCoins })); persistJournal(); }
  updateCoins();
  return settled;
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
  if (nextCell !== cell) { cancelDrag(); cancelToolGesture(); }
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
  const showRotation = !busy && !drag && !activeTool && state.status === 'playing';
  const toolBlocked = busy || Boolean(drag || toolGesture) || modalOpen() || state.status !== 'playing';
  for (const [index, button] of toolButtons.entries()) {
    const slot = state.tools?.[index];
    button.hidden = state.status === 'gameover'; // charges of a lost game are back in the stock: nothing to offer
    button.disabled = toolBlocked || !slot?.charges;
    button.setAttribute('aria-pressed', String(Boolean(slot && slot.kind === activeTool)));
    if (!slot) continue;
    const count = button.lastElementChild;
    if (count.textContent !== String(slot.charges)) count.textContent = slot.charges;
    const start = startTools?.find((item) => item.kind === slot.kind)?.charges;
    button.setAttribute('aria-label', `${TOOL_UI[slot.kind].name}. Заряди ${slot.charges}${start === undefined ? '' : ` з ${start}`}`);
  }
  $('coins').textContent = wallet.coins.toLocaleString('uk-UA');
  toolbar.hidden = Boolean(toolPreview);
  toolActions.hidden = !toolPreview;
  applyTool.disabled = toolBlocked || !toolPreview;
  board.classList.toggle('tool-armed', Boolean(activeTool));
  const rotationHints = showRotation && rotationPreviews.get(selectedId);
  for (const [direction, button] of Object.entries(rotationButtons)) {
    button.disabled = !rotationHints?.[direction];
  }
  if (!busy) hintVisible = state.trial === true && state.status === 'playing';
  hintButton.classList.toggle('is-off', !hintVisible);
  hintButton.disabled = busy || Boolean(drag || toolGesture) || modalOpen() || !hintVisible;
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
  if (toolPreview) drawToolPreview();
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
  fitHud();
  $('newRecord').hidden = !(state.status === 'gameover' && isNewRecord(state.score, bestAtStart));
  $('gameOver').hidden = state.status !== 'gameover' || busy;
  $('finalScore').textContent = state.score.toLocaleString('uk-UA');
  const returned = (state.tools ?? []).filter((slot) => slot.charges > 0).map((slot) => `${TOOL_UI[slot.kind].name} ×${slot.charges}`);
  $('coinsEarned').textContent = state.status === 'gameover' && paidCoins !== null
    ? `+${paidCoins} монет${walletWriteFailed ? '' : `, у гаманці ${wallet.coins.toLocaleString('uk-UA')}`}` : '';
  $('walletWarning').hidden = !(state.status === 'gameover' && paidCoins !== null && walletWriteFailed);
  $('returnedTools').textContent = state.status === 'gameover' && paidCoins !== null && returned.length ? `Повернуто в запас: ${returned.join(', ')}` : '';
  $('returnedTools').hidden = !$('returnedTools').textContent;
  const boardPrompt = toolPreview ? 'Ціль обрано. Застосуй інструмент або скасуй.'
    : activeTool ? TOOL_UI[activeTool].prompt : selectedId ? 'Фігуру обрано.' : 'Обери фігуру.';
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
  if (!state || busy || drag || toolGesture || modalOpen() || state.status !== 'playing' || !hintVisible) return;
  disarmTool();
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
function completedMessage(gained = 0, doubled = false, didRise = true, usedTool = null) {
  if (storageNoticePending && state.status === 'playing') { storageNoticePending = false; message(STORAGE_NOTICE, 'bad'); return; }
  const doubledText = doubled === 'after-rise' ? 'Додано ряд, поле подвоїлось.' : state.skipNextRise ? 'Поле подвоїлось. Наступний хід без підйому.' : 'Поле подвоїлось. Показаний ряд чекає.';
  if (state.status === 'gameover') message('Верхній ряд зайнятий.', 'bad');
  else if (usedTool) message(`${TOOL_UI[usedTool].done} · +${gained} очок.${doubled ? ` ${doubledText}` : ''}`, 'good');
  else if (gained && doubled) message(`Прибрано рядів: ${gained / 100} · +${gained}. ${doubledText}`, 'good');
  else if (gained) message(`Прибрано рядів: ${gained / 100} · +${gained} очок${didRise ? '' : '. Показаний ряд чекає.'}`, 'good');
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
function installState(next, text, restored = false) {
  actionEpoch++; cancelTween(); cancelDrag(); disarmTool(); clearSuggestion(); busy = false; selectedId = null; activePhase = null; rotationTween = null;
  hintDirection = 'clockwise'; successfulActions = restored ? next.turn : 0; rotated = false; selectHintShown = false;
  state = next;
  buildToolButtons();
  journalHints = 0; journalLastHint = null; journalReadyAt = performance.now();
  scene = state.pieces; displayedScore = state.score;
  showNextRow(); refreshRotationPreviews();
  board.classList.remove('dragging'); frame.classList.remove('resolve', 'invalid'); $('gain').classList.remove('show');
  if (text) message(text);
  else if (state.skipNextRise) completedMessage();
  else message(rotationHintActive() ? ROTATE_IDLE_HINT : 'Торкнись фігури, щоб обрати.');
  resize();
}
// Starts a game from a loadout that takeLoadout accepted. The game is built first (it is pure), then the wallet with the charges
// already taken out is stored BEFORE the new game record, so a break can lose charges but never duplicate them.
function startGame(taken) {
  const gameSeed = seed();
  const next = createGame({ cols: 8, rows: 12, seed: gameSeed, trial: true, tools: taken.tools });
  wallet = taken.wallet; persistWallet(); updateCoins();
  lastPicks = Object.fromEntries(taken.tools.map(({ kind, charges }) => [kind, charges]));
  startTools = taken.tools.map(({ kind, charges }) => ({ kind, charges }));
  paidCoins = null; walletWriteFailed = false;
  journalSafe(() => {
    const now = new Date();
    startGameLog(journal, { seed: gameSeed, mode: `trial ${next.cols}x${next.rows}`, startedAt: now.getTime(), startedLabel: journalTime(now), device: parseDevice(navigator.userAgent), build: BUILD_ID, tools: taken.tools });
    resetCopyUi();
    refreshHistory();
  });
  bestAtStart = best; recordBase = best;
  installState(next);
  if (storageNoticePending) { storageNoticePending = false; message(STORAGE_NOTICE, 'bad'); }
  persistGame(); persistJournal(); // a fresh game replaces the stored one; the best score and the journal stay
}
// Restores the stored best score, wallet, last game and journal; a damaged or foreign record never blocks a new game.
async function initGame() {
  const [bestRead, walletRead, gameRead, journalRead] = await Promise.all([
    storage.load(STORAGE_KEYS.best), storage.load(WALLET_STORAGE_KEY), readSavedRecord('game'), readSavedRecord('journal'),
  ]);
  if (bestRead.ok) { const parsed = parseBest(bestRead.value); if (parsed.ok) best = parsed.score; }
  // No wallet yet (a first launch, or a player of the previous build): the starter set is issued once and stored.
  // A wallet that cannot be read is replaced by a new starter set and the player is told.
  const storedWallet = walletRead.ok ? parseWallet(walletRead.value) : null;
  let notice = '';
  if (storedWallet?.ok) wallet = storedWallet.wallet;
  else {
    wallet = createStarterWallet(); persistWallet();
    if (walletRead.ok || walletRead.reason !== 'missing') notice = WALLET_NOTICE;
  }
  updateCoins();
  if (journalRead.ok) {
    const imported = importJournal(journalRead.value);
    if (imported.ok) journal.games = imported.journal.games;
  }
  const record = gameRead.ok ? parseGame(gameRead.value) : null;
  if (!record?.ok) {
    const damaged = gameRead.ok || gameRead.reason !== 'missing';
    openLoadout({ notice: [notice, damaged ? 'Збережену партію не вдалося відновити.' : ''].filter(Boolean).join(' ') });
    return;
  }
  const bestStored = best;
  best = Math.max(best, record.state.score, record.bestAtStart);
  if (best > bestStored) persistSafe(() => storage.save(STORAGE_KEYS.best, serializeBest(best)));
  bestAtStart = record.bestAtStart; recordBase = Math.max(best, bestAtStart);
  const gameOver = record.state.status === 'gameover';
  const settledBefore = record.coinsPaid !== undefined; // already paid: a loss, or a game replaced through "Нова гра"
  paidCoins = record.coinsPaid ?? null;
  journalSafe(() => {
    const last = latestGame(journal);
    if (settledBefore) { if (last && !last.end && (gameOver || hasProgress(record.state))) finishGameLog(journal, record.state, { endedAt: record.savedAt, coins: record.coinsPaid }); }
    else if (gameOver) { /* an unpaid loss is closed together with its payout below */ }
    else if (!last || last.end) {
      startGameLog(journal, { seed: 0, mode: `trial ${record.state.cols}x${record.state.rows} restored`, startedAt: record.savedAt, startedLabel: null, device: parseDevice(navigator.userAgent), build: BUILD_ID });
    }
    resetCopyUi();
    refreshHistory();
  });
  startTools = recoverStartTools(record.state);
  installState(record.state, hasProgress(record.state) ? 'Партію відновлено.' : '', true);
  if (gameOver && paidCoins === null) settleCurrentGame({ endedAt: record.savedAt }); // a loss saved before it was paid: pay it once
  if (notice) message(notice, 'bad');
  if (gameRead.legacy || record.migrated) persistGame();
  persistBest(); persistJournal();
  // A game replaced through "Нова гра" was paid and its charges went back to the stock: it is not played on, a new set is chosen.
  if (settledBefore && !gameOver) {
    const info = record.coinsPaid > 0 ? `Попередню партію зараховано: +${record.coinsPaid.toLocaleString('uk-UA')} монет.` : 'Попередню партію закрито.';
    openLoadout({ notice, info });
  }
}
async function commit(result, initialScene = scene) {
  if (!result.changed) { invalidFeedback('Шлях зайнятий. Спробуй обійти перешкоду.'); render(); return; }
  cancelPreviewTransition();
  const epoch = ++actionEpoch, oldScore = state.score;
  const firstEvent = result.events[0]?.type;
  const toolKind = firstEvent === 'hammer' ? 'hammer' : firstEvent === 'tool' ? result.events[0].kind : null;
  const usedTool = toolKind !== null;
  if (!usedTool) successfulActions++;
  clearSuggestion();
  journalSafe(() => journalRecord(state, result)); // journal: successful actions only
  state = result.state; selectedId = null; busy = true; scene = initialScene;
  if (state.status === 'gameover') settleCurrentGame(); // a loss pays the game once: record, then wallet, then the journal end
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
    if (phase.type === 'rise' || (usedTool && phase.type === 'refill')) {
      didRise = true;
      waitingForDebut = hasDebutPreview && displayedScore < COLOR_DEBUT_SCORE;
      if (waitingForDebut || state.status !== 'playing') transitionNextRow([], 'regular');
      else transitionNextRow(state.nextRow, state.nextRowKind, state.skipNextRise);
    }
    const gain = phase.type === 'clear' ? phase.rows.length * 100 : phase.gain ?? 0;
    if (gain) {
      displayedScore += gain;
      $('gain').textContent = `+${gain}`; $('gain').classList.remove('show'); void $('gain').offsetWidth; $('gain').classList.add('show');
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
  activePhase = null; busy = false; completedMessage(state.score - oldScore, doubled, didRise, toolKind); render();
}
function rotate(direction) {
  if (busy || drag || activeTool || modalOpen() || !selectedId || state.status !== 'playing') return;
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
function boardCell(event) {
  const rect = board.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / cell), y = Math.floor((event.clientY - rect.top) / cell);
  return x >= 0 && x < state.cols && y >= 0 && y < state.rows ? { x, y } : null;
}
function pieceAt(position) {
  return position && state.pieces.find((item) => item.cells.some((point) => point.x === position.x && point.y === position.y));
}
function targetAt(position) {
  if (!position) return null;
  if (activeTool === 'hammer') return pieceAt(position)?.id ?? null;
  return activeTool === 'arrow' ? position.y : position.x;
}
function movedDuringToolTap(event, gesture) {
  return Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > TOOL_TAP_DISTANCE;
}
function cancelToolGesture() {
  if (!toolGesture) return;
  const { pointerId } = toolGesture;
  toolGesture = null;
  if (board.hasPointerCapture(pointerId)) board.releasePointerCapture(pointerId);
  scheduleRender();
}
function disarmTool() {
  activeTool = null;
  toolPreview = null;
  cancelToolGesture();
}
// Zero to two tool buttons, one per slot of the game (any kinds); the rotation buttons stay in the same toolbar.
function buildToolButtons() {
  for (const button of toolButtons) button.remove();
  toolButtons = (state.tools ?? []).map((slot) => {
    const button = document.createElement('button');
    button.className = 'tool-button'; button.type = 'button'; button.disabled = true;
    button.dataset.kind = slot.kind; button.setAttribute('aria-pressed', 'false');
    const label = document.createElement('span'); label.setAttribute('aria-hidden', 'true'); label.textContent = TOOL_UI[slot.kind].short;
    const count = document.createElement('span'); count.className = 'tool-count'; count.setAttribute('aria-hidden', 'true'); count.textContent = slot.charges;
    button.append(label, count);
    button.addEventListener('click', () => toggleTool(slot.kind));
    toolbar.append(button);
    return button;
  });
}
function toggleTool(kind) {
  if (!state || busy || drag || toolGesture || modalOpen() || state.status !== 'playing'
    || !state.tools?.find((slot) => slot.kind === kind)?.charges) return;
  if (activeTool === kind) {
    disarmTool();
    completedMessage();
  } else {
    activeTool = kind; toolPreview = null; selectedId = null; clearSuggestion();
    message(TOOL_UI[kind].prompt);
  }
  render();
}
function drawToolPreview() {
  const { target, cells } = toolPreview;
  ctx.save();
  ctx.fillStyle = '#f3c96925';
  ctx.strokeStyle = '#ffe2a5';
  ctx.lineWidth = 2;
  if (activeTool === 'arrow') ctx.fillRect(0, target * cell, state.cols * cell, cell);
  if (activeTool === 'cannon') ctx.fillRect(target * cell, 0, cell, state.rows * cell);
  for (const { x, y } of cells) ctx.strokeRect(x * cell + 3, y * cell + 3, cell - 6, cell - 6);
  ctx.restore();
}
function previewTool(target) {
  const cells = toolTargetCells(state, activeTool, target);
  toolPreview = cells.length ? { target, cells } : null;
  message(toolPreview ? `Клітинок: ${cells.length} · +${cells.length * TOOL_CELL_POINTS} очок.` : 'Ціль порожня. Обери інше місце.');
  render();
}
function cancelToolSelection() {
  if (!activeTool) return;
  const index = state.tools.findIndex((slot) => slot.kind === activeTool);
  disarmTool();
  completedMessage();
  render();
  toolButtons[index]?.focus({ preventScroll: true });
}
$('cancelTool').addEventListener('click', cancelToolSelection);
applyTool.addEventListener('click', () => {
  if (!activeTool || !toolPreview || toolGesture || busy || modalOpen()) return;
  const result = useTool(state, activeTool, toolPreview.target);
  disarmTool();
  commit(result);
});
board.addEventListener('pointerdown', (event) => {
  if (!state || modalOpen() || busy || state.status !== 'playing' || event.button > 0 || !event.isPrimary || drag || toolGesture) return;
  event.preventDefault(); board.focus({ preventScroll: true });
  const position = boardCell(event);
  if (activeTool) {
    toolGesture = { target: targetAt(position), startX: event.clientX, startY: event.clientY, pointerId: event.pointerId };
    board.setPointerCapture(event.pointerId);
    render();
    return;
  }
  const hit = pieceAt(position);
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
  if (toolGesture?.pointerId === event.pointerId) {
    event.preventDefault();
    if (movedDuringToolTap(event, toolGesture)) cancelToolGesture();
    return;
  }
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const samples = event.getCoalescedEvents?.() ?? [];
  for (const sample of samples) processDragSample(sample);
  processDragSample(event); scheduleRender();
});
board.addEventListener('pointerup', (event) => {
  if (toolGesture?.pointerId === event.pointerId) {
    const gesture = toolGesture;
    const validTap = !movedDuringToolTap(event, gesture) && targetAt(boardCell(event)) === gesture.target;
    cancelToolGesture();
    if (validTap && activeTool && !modalOpen() && !busy) previewTool(gesture.target);
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
  if (toolGesture?.pointerId === event.pointerId) cancelToolGesture();
}
board.addEventListener('pointercancel', cancelPointer);
board.addEventListener('lostpointercapture', cancelPointer);
window.addEventListener('blur', () => { cancelDrag(); cancelToolGesture(); });
window.addEventListener('pagehide', persistAll);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) journalReadyAt = performance.now();
  if (document.hidden) {
    persistAll();
    cancelDrag(); cancelToolGesture();
    if (busy) finishPlayback();
    else if (previewTween) { cancelPreviewTransition(); showNextRow(); }
  }
});
board.addEventListener('keydown', (event) => {
  if (!selectedId || busy || drag || activeTool || modalOpen() || state.status !== 'playing') return;
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
// --- "Нова гра" and the preparation screen (DEMO_PLAN 24, package B).
// A game with progress is paid and closed first (after a confirmation); a game without progress only gives its charges back.
const confirmCancel = $('confirmCancel');
const loadoutCancel = $('loadoutCancel'), loadoutStart = $('loadoutStart'), loadoutNotice = $('loadoutNotice');
const loadoutList = $('loadoutList'), loadoutSummary = $('loadoutSummary');
let picks = {}, loadoutCancellable = false, loadoutUndo = false;
const DEFAULT_HAMMERS = 3;
const coinsText = (n) => `${n.toLocaleString('uk-UA')} монет`;
const shopRows = new Map();
for (const kind of TOOL_KINDS) {
  const row = document.createElement('li'); row.className = 'shop-row'; row.dataset.kind = kind;
  const head = document.createElement('div'); head.className = 'shop-head';
  const name = document.createElement('b'); name.className = 'shop-name'; name.textContent = TOOL_UI[kind].name;
  const price = document.createElement('span'); price.className = 'shop-price'; price.textContent = coinsText(PRICES[kind]);
  const stock = document.createElement('span'); stock.className = 'shop-stock';
  head.append(name, price, stock);
  const controls = document.createElement('div'); controls.className = 'shop-controls';
  const buy = document.createElement('button'); buy.type = 'button'; buy.className = 'secondary-button shop-buy';
  const take = document.createElement('div'); take.className = 'shop-take'; take.setAttribute('role', 'group'); take.setAttribute('aria-label', `Взяти в партію: ${TOOL_UI[kind].name.toLowerCase()}`);
  const takeLabel = document.createElement('span'); takeLabel.className = 'shop-take-label'; takeLabel.textContent = 'Взяти';
  const minus = document.createElement('button'); minus.type = 'button'; minus.className = 'step-button'; minus.textContent = '−'; minus.setAttribute('aria-label', `Взяти менше: ${TOOL_UI[kind].name.toLowerCase()}`);
  const value = document.createElement('output'); value.className = 'step-value';
  const plus = document.createElement('button'); plus.type = 'button'; plus.className = 'step-button'; plus.textContent = '+'; plus.setAttribute('aria-label', `Взяти більше: ${TOOL_UI[kind].name.toLowerCase()}`);
  take.append(takeLabel, minus, value, plus);
  controls.append(buy, take);
  const note = document.createElement('p'); note.className = 'shop-note';
  row.append(head, controls, note); loadoutList.append(row);
  shopRows.set(kind, { buy, minus, plus, value, stock, note });
  buy.addEventListener('click', () => {
    if (!loadoutBox.open) return;
    const bought = buyCharge(wallet, kind);
    if (!bought.ok) return;
    wallet = bought.wallet; persistWallet(); updateCoins(); // a purchase is stored at once
    renderLoadout();
  });
  minus.addEventListener('click', () => { if (picks[kind] > 0) { picks[kind] -= 1; renderLoadout(); } });
  plus.addEventListener('click', () => { if (!takeBlock(kind)) { picks[kind] = (picks[kind] ?? 0) + 1; renderLoadout(); } });
}
// Why one more charge of `kind` cannot be taken, as a short text, or '' when it can.
function takeBlock(kind) {
  const have = picks[kind] ?? 0;
  if (wallet.stock[kind] === 0) return 'Немає в запасі';
  if (have >= wallet.stock[kind]) return 'Весь запас взято';
  const plan = planLoadout(wallet, { ...picks, [kind]: have + 1 });
  if (plan.ok) return '';
  return { 'too-many-kinds': `Не більше ${MAX_KINDS} видів`, 'too-many-charges': `Не більше ${MAX_CARRY} зарядів`, 'invalid-count': `Не більше ${MAX_CARRY} зарядів`, 'not-in-stock': 'Немає в запасі' }[plan.reason] ?? 'Недоступно';
}
function renderLoadout() {
  $('loadoutCoins').textContent = wallet.coins.toLocaleString('uk-UA');
  let total = 0, kinds = 0;
  for (const kind of TOOL_KINDS) {
    const row = shopRows.get(kind), count = picks[kind] ?? 0;
    total += count; if (count > 0) kinds += 1;
    row.stock.textContent = `Запас ${wallet.stock[kind]} з ${STOCK_LIMITS[kind]}`;
    row.buy.textContent = `Купити +1 (${PRICES[kind]})`;
    row.buy.setAttribute('aria-label', `Купити один заряд: ${TOOL_UI[kind].name.toLowerCase()}, ${coinsText(PRICES[kind])}`);
    const bought = buyCharge(wallet, kind);
    row.buy.disabled = !bought.ok;
    const buyNote = bought.ok ? '' : bought.reason === 'at-limit' ? 'Запас заповнено' : 'Не вистачає монет';
    const blocked = takeBlock(kind);
    row.value.textContent = count;
    row.minus.disabled = count === 0;
    row.plus.disabled = Boolean(blocked);
    row.note.textContent = [buyNote, blocked].filter(Boolean).join(' · ');
  }
  loadoutSummary.textContent = `Взято ${total} з ${MAX_CARRY}, видів ${kinds} з ${MAX_KINDS}`;
}
// The last choice is offered again, cut down to what the stock and the rules allow now.
function offeredPicks() {
  const offered = {};
  if (lastPicks === null) { // no remembered choice yet: a hammer x3 (or what the stock holds) is ready, the player may lower it to nothing
    const count = Math.min(wallet.stock.hammer, DEFAULT_HAMMERS, MAX_CARRY);
    if (count > 0) offered.hammer = count;
    return offered;
  }
  let total = 0, kinds = 0;
  for (const kind of TOOL_KINDS) {
    const count = Math.min(lastPicks[kind] ?? 0, wallet.stock[kind], MAX_CARRY - total);
    if (count <= 0 || kinds >= MAX_KINDS) continue;
    offered[kind] = count; total += count; kinds += 1;
  }
  return offered;
}
// `notice` is an error text (damage), `info` a neutral one; the box is red only while it holds an error.
function openLoadout({ cancellable = false, undo = false, notice = '', info = '' } = {}) {
  if (loadoutBox.open) return;
  if (activeTool) { disarmTool(); completedMessage(); }
  cancelDrag();
  loadoutCancellable = cancellable && Boolean(state); loadoutUndo = loadoutCancellable && undo;
  picks = offeredPicks();
  loadoutNotice.replaceChildren();
  for (const [text, tone] of [[notice, 'bad'], [info, 'info']]) {
    if (!text) continue;
    if (loadoutNotice.firstChild) loadoutNotice.append(' ');
    const line = document.createElement('span'); line.className = `notice-${tone}`; line.textContent = text; loadoutNotice.append(line);
  }
  loadoutNotice.classList.toggle('has-bad', Boolean(notice));
  loadoutNotice.hidden = !(notice || info);
  loadoutCancel.hidden = !loadoutCancellable;
  renderLoadout();
  loadoutBox.showModal();
  render();
}
// Cancel is offered only while nothing is lost: over a finished game, or over a game without progress whose charges were put back
// (then they are taken again: the wallet first, so a break loses charges instead of duplicating them).
function cancelLoadout() {
  if (!loadoutBox.open || !loadoutCancellable) return;
  if (loadoutUndo && paidCoins !== null && state.status === 'playing') {
    const again = takeLoadout(wallet, Object.fromEntries(state.tools.map(({ kind, charges }) => [kind, charges])));
    if (!again.ok) return;
    wallet = again.wallet; persistWallet(); updateCoins();
    paidCoins = null; persistGame();
  }
  loadoutBox.close();
}
function requestNewGame() {
  if (!state || modalOpen()) return;
  if (activeTool) { disarmTool(); completedMessage(); }
  cancelDrag();
  if (state.status === 'gameover') { openLoadout({ cancellable: true }); return; } // already paid: back to the loss screen is possible
  if (paidCoins !== null) { openLoadout(); return; } // paid and replaced (restored): only a new game remains
  if (hasProgress(state)) {
    $('confirmText').textContent = `Партію буде зараховано як завершену: +${coinsForScore(state.score)} монет. Невикористані заряди повернуться в запас.`;
    confirmBox.showModal();
    render();
    return;
  }
  settleCurrentGame({ finishJournal: false }); // no progress: the charges return, nothing is paid; Cancel takes them again
  openLoadout({ cancellable: true, undo: true });
}
$('confirmYes').addEventListener('click', () => {
  if (!confirmBox.open) return;
  confirmBox.close();
  settleCurrentGame();
  openLoadout();
});
confirmCancel.addEventListener('click', () => { if (confirmBox.open) confirmBox.close(); });
confirmBox.addEventListener('close', render);
loadoutStart.addEventListener('click', () => {
  if (!loadoutBox.open) return;
  const taken = takeLoadout(wallet, picks);
  if (!taken.ok) { renderLoadout(); return; }
  loadoutBox.close();
  startGame(taken);
});
loadoutCancel.addEventListener('click', cancelLoadout);
loadoutBox.addEventListener('cancel', (event) => { event.preventDefault(); cancelLoadout(); }); // Escape never leaves a forced screen
loadoutBox.addEventListener('close', render);
document.addEventListener('keydown', (event) => {
  if (modalOpen() && event.key === 'Enter' && event.repeat) event.preventDefault();
  if (!modalOpen() && event.key === 'Escape' && activeTool) {
    event.preventDefault();
    cancelToolSelection();
  }
});
$('newGameButton').addEventListener('click', requestNewGame);
$('retryButton').addEventListener('click', requestNewGame);
$('helpButton').addEventListener('click', () => {
  if (activeTool) { disarmTool(); completedMessage(); render(); }
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
new ResizeObserver(() => fitHud(true)).observe(hud);
await initGame();
