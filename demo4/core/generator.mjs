const MAX_ROW_ATTEMPTS = 12;

export function createRandom(seed = 1) {
  let value = seed >>> 0;
  if (value === 0) value = 0x6d2b79f5;

  const random = () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0x100000000;
  };
  Object.defineProperty(random, 'state', { get: () => value >>> 0 });
  return random;
}

function shuffledRange(count, random) {
  const values = Array.from({ length: count }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
  return values;
}

function makeRow(cols, palette, random, emptyCount) {
  const empties = new Set(shuffledRange(cols, random).slice(0, emptyCount));
  const row = [];
  let x = 0;

  while (x < cols) {
    if (empties.has(x)) {
      x += 1;
      continue;
    }

    const start = x;
    while (x < cols && !empties.has(x)) x += 1;
    let remaining = x - start;
    let cursor = start;

    while (remaining > 0) {
      const maxLength = Math.min(4, remaining);
      const length = remaining <= 4
        ? remaining
        : 1 + Math.floor(random() * maxLength);
      row.push({
        x: cursor,
        length,
        color: palette[Math.floor(random() * palette.length)],
      });
      cursor += length;
      remaining -= length;
    }
  }

  return row;
}

export function generateRow(cols, palette, random) {
  if (cols < 3) return makeRow(cols, palette, random, 1);
  const minEmpty = Math.min(2, cols - 1);
  const maxEmpty = Math.min(4, cols - 1);
  const desiredEmpty = minEmpty + Math.floor(random() * (maxEmpty - minEmpty + 1));

  for (let attempt = 0; attempt < MAX_ROW_ATTEMPTS; attempt += 1) {
    const candidate = makeRow(cols, palette, random, desiredEmpty);
    if (candidate.every((piece) => piece.length <= 4)) return candidate;
  }

  // Evenly spaced gaps guarantee that the fallback never creates a segment
  // longer than four cells, including on narrow custom fields.
  const gaps = new Set();
  const gapCount = desiredEmpty;
  for (let gap = 0; gap < gapCount; gap += 1) {
    gaps.add(Math.floor(((gap + 1) * cols) / (gapCount + 1)));
  }

  const row = [];
  let x = 0;
  while (x < cols) {
    if (gaps.has(x)) {
      x += 1;
      continue;
    }
    const start = x;
    while (x < cols && !gaps.has(x)) x += 1;
    for (let cursor = start; cursor < x;) {
      const length = Math.min(4, x - cursor);
      row.push({ x: cursor, length, color: palette[Math.floor(random() * palette.length)] });
      cursor += length;
    }
  }
  return row;
}

export function generateStartPieces(cols, rows, palette, random) {
  const pieces = [];
  const rowCount = Math.min(3, rows);

  for (let y = rows - rowCount; y < rows; y += 1) {
    const row = generateRow(cols, palette, random);
    for (const segment of row) {
      const size = segment.length;
      pieces.push({
        color: segment.color,
        frame: { x: segment.x, y: y - Math.floor((size - 1) / 2), size },
        cells: Array.from({ length: segment.length }, (_, index) => ({ x: segment.x + index, y })),
      });
    }
  }

  return pieces;
}
