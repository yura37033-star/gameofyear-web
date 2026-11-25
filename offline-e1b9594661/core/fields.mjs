// Approved field presets. This module has no state, storage or randomness.
export const FIELD_SIZES = Object.freeze([
  Object.freeze({ id: '8x12', name: 'Мале', cols: 8, rows: 12, bestKey: 'kr.best' }),
  Object.freeze({ id: '10x15', name: 'Середнє', cols: 10, rows: 15, bestKey: 'kr.best.10x15' }),
  Object.freeze({ id: '12x18', name: 'Велике', cols: 12, rows: 18, bestKey: 'kr.best.12x18' }),
]);
export const DEFAULT_FIELD = FIELD_SIZES[0];
export const fieldById = (id) => FIELD_SIZES.find((field) => field.id === id) ?? null;
export const fieldForSize = (cols, rows) => FIELD_SIZES.find((field) => field.cols === cols && field.rows === rows) ?? null;
export function fieldForMode(mode) {
  const match = typeof mode === 'string' ? mode.match(/(\d+)\s*x\s*(\d+)/) : null;
  return match ? fieldForSize(Number(match[1]), Number(match[2])) : null;
}
export function bestKeyForSize(cols, rows) {
  const field = fieldForSize(cols, rows);
  if (field) return field.bestKey;
  // Historical non-trial saves use the old shared record; new games only offer the presets above.
  if (cols === 10 && rows === 20) return DEFAULT_FIELD.bestKey;
  throw new RangeError('Unsupported field size');
}
