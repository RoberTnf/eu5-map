import type { Bitmap } from "./data";

/**
 * The location bitmap as runs of one location along each row: row y's runs are `x[start[y]]` up
 * to `x[start[y + 1]]`, each running on to the next one's x or the row's end. A few megabytes
 * where the pixels take tens, so a worker can hold its own copy.
 */
export type Rows = { width: number; height: number; start: Uint32Array; x: Uint32Array; id: Uint16Array };

/** The runs of `bitmap`'s rows. */
export function rowsOf(bitmap: Bitmap): Rows {
  const { width, height, pixels } = bitmap;
  const start = new Uint32Array(height + 1);
  const x: number[] = [];
  const id: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let px = 0; px < width; px++) {
      if (px === 0 || pixels[row + px] !== pixels[row + px - 1]) {
        x.push(px);
        id.push(pixels[row + px]);
      }
    }
    start[y + 1] = x.length;
  }
  return { width, height, start, x: Uint32Array.from(x), id: Uint16Array.from(id) };
}

/**
 * The runs of `locations.bin` once ungzipped (`decodeBitmap` in data.ts), without unpacking every pixel. Its runs go on across rows.
 */
export function rowsFromRuns(buffer: ArrayBuffer): Rows {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const runs = view.getUint32(8, true);
  const values = 12;
  const lengths = values + runs * 2;
  // Each run splits at most once per row it crosses.
  const x = new Uint32Array(runs + height);
  const id = new Uint16Array(runs + height);
  const start = new Uint32Array(height + 1);
  let count = 0, px = 0, y = 0;
  for (let i = 0; i < runs; i++) {
    const value = view.getUint16(values + i * 2, true);
    let left = view.getUint16(lengths + i * 2, true);
    while (left > 0) {
      // A run that goes on from the previous one with the same value, across no row's start, adds nothing.
      if (px === 0 || id[count - 1] !== value) {
        x[count] = px;
        id[count++] = value;
      }
      const step = Math.min(left, width - px);
      px += step;
      left -= step;
      if (px === width) {
        start[++y] = count;
        px = 0;
      }
    }
  }
  if (y !== height) throw new Error(`location bitmap has ${y} of ${height} rows`);
  return { width, height, start, x: x.slice(0, count), id: id.slice(0, count) };
}

/** The location at a bitmap point, or -1 above or below the map; x wraps around. */
export function locationAt(rows: Rows, x: number, y: number): number {
  const py = Math.floor(y);
  if (py < 0 || py >= rows.height) return -1;
  const px = ((Math.floor(x) % rows.width) + rows.width) % rows.width;
  // The last run starting at or before px.
  let lo = rows.start[py], hi = rows.start[py + 1] - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rows.x[mid] <= px) lo = mid;
    else hi = mid - 1;
  }
  return rows.id[lo];
}
