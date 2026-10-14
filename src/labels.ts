import type { MapData } from "./data";
import { locationAt, type Rows } from "./rows";

/**
 * Names on the map, as the game places them. Each map mode names one kind of place close up,
 * another in between and another far out (`small_map_names`, `medium_map_names` and
 * `large_map_names` in the game's `gfx/map/map_modes/map_modes.txt`). A name labels a blob:
 * a patch of touching locations with the same value, so each enclave and exclave is named on its
 * own and water splits them. The name follows a curve through the blob and fills it, within the
 * game's limits (`COUNTRY_NAMES_*` and `NMapName` in `common/defines/graphic/00_graphics.txt`).
 */

/** Each location's size, shape and neighbours, measured once from the bitmap. */
export type Shapes = {
  /** Pixels. */
  area: Float64Array;
  /** Mean position. x may lie past the edge for a location across a wrapped one. */
  x: Float64Array;
  y: Float64Array;
  /** Variances and covariance of its pixels about the mean. */
  xx: Float64Array;
  xy: Float64Array;
  yy: Float64Array;
  /** Location `i` touches `neighbors[start[i]]` up to `neighbors[start[i + 1]]`. */
  start: Uint32Array;
  neighbors: Uint16Array;
};

/** `d` brought within half a turn of a world `width` wide. */
const wrapped = (d: number, width: number) => d - Math.round(d / width) * width;

/** One pass over the bitmap's runs of pixels: the moments of every location and which touch. */
export function measureShapes(rows: Rows, count: number, wrap: boolean): Shapes {
  const { width, height, start, x: runX, id: runId } = rows;
  const n = new Float64Array(count);
  const sx = new Float64Array(count);
  const sy = new Float64Array(count);
  const sxx = new Float64Array(count);
  const sxy = new Float64Array(count);
  const syy = new Float64Array(count);
  // Sums are taken from each location's first pixel, which keeps them small and lets x run on
  // across a wrapped edge.
  const refX = new Float64Array(count).fill(NaN);
  const refY = new Float64Array(count);
  const pairs = new Set<number>();
  let last = -1;
  const link = (a: number, b: number) => {
    if (a === b || a >= count || b >= count) return;
    const pair = a < b ? a * 65536 + b : b * 65536 + a;
    if (pair !== last) pairs.add(pair);
    last = pair;
  };
  const endOf = (r: number, rowEnd: number) => (r + 1 < rowEnd ? runX[r + 1] : width);
  for (let y = 0; y < height; y++) {
    const first = start[y], rowEnd = start[y + 1];
    for (let r = first; r < rowEnd; r++) {
      const id = runId[r];
      const x = runX[r];
      const end = endOf(r, rowEnd);
      if (id < count) {
        if (Number.isNaN(refX[id])) {
          refX[id] = x;
          refY[id] = y;
        }
        const d = wrap ? wrapped(x - refX[id], width) : x - refX[id];
        const len = end - x;
        // Σ (d + k) and Σ (d + k)² for k below len.
        const s1 = len * d + (len * (len - 1)) / 2;
        const s2 = len * d * d + d * len * (len - 1) + ((len - 1) * len * (2 * len - 1)) / 6;
        const dy = y - refY[id];
        n[id] += len;
        sx[id] += s1;
        sy[id] += len * dy;
        sxx[id] += s2;
        sxy[id] += s1 * dy;
        syy[id] += len * dy * dy;
      }
      if (r + 1 < rowEnd) link(id, runId[r + 1]);
      else if (wrap) link(id, runId[first]);
    }
    if (y + 1 < height) {
      // Where this row's runs and the next one's overlap.
      const belowEnd = start[y + 2];
      let a = first, b = rowEnd;
      while (a < rowEnd && b < belowEnd) {
        if (runId[a] !== runId[b]) link(runId[a], runId[b]);
        const ea = endOf(a, rowEnd), eb = endOf(b, belowEnd);
        if (ea <= eb) a++;
        if (eb <= ea) b++;
      }
    }
  }
  const shapes: Shapes = {
    area: n,
    x: new Float64Array(count),
    y: new Float64Array(count),
    xx: new Float64Array(count),
    xy: new Float64Array(count),
    yy: new Float64Array(count),
    start: new Uint32Array(count + 1),
    neighbors: new Uint16Array(pairs.size * 2),
  };
  for (let i = 0; i < count; i++) {
    if (!n[i]) continue;
    const mx = sx[i] / n[i];
    const my = sy[i] / n[i];
    shapes.x[i] = refX[i] + mx;
    shapes.y[i] = refY[i] + my;
    shapes.xx[i] = sxx[i] / n[i] - mx * mx;
    shapes.xy[i] = sxy[i] / n[i] - mx * my;
    shapes.yy[i] = syy[i] / n[i] - my * my;
  }
  const degree = new Uint32Array(count);
  for (const pair of pairs) {
    degree[Math.floor(pair / 65536)]++;
    degree[pair % 65536]++;
  }
  for (let i = 0; i < count; i++) shapes.start[i + 1] = shapes.start[i] + degree[i];
  const at = shapes.start.slice(0, count);
  for (const pair of pairs) {
    const a = Math.floor(pair / 65536);
    const b = pair % 65536;
    shapes.neighbors[at[a]++] = b;
    shapes.neighbors[at[b]++] = a;
  }
  return shapes;
}

/** A patch of touching locations with one value, and each one's centre as seen from the first. */
export type Blob = { key: string; members: number[]; x: number[]; y: number[] };

/** The blobs of `values` (one per location; undefined ones belong to none). */
export function findBlobs(shapes: Shapes, values: (string | undefined)[], width: number, wrap: boolean): Blob[] {
  const seen = new Uint8Array(values.length);
  const blobs: Blob[] = [];
  for (let first = 0; first < values.length; first++) {
    const key = values[first];
    if (key === undefined || seen[first] || !shapes.area[first]) continue;
    const blob: Blob = { key, members: [first], x: [shapes.x[first]], y: [shapes.y[first]] };
    seen[first] = 1;
    // Each member is placed from the one it was reached by, so a blob across the wrapped edge
    // stays in one piece.
    for (let k = 0; k < blob.members.length; k++) {
      const i = blob.members[k];
      for (let e = shapes.start[i]; e < shapes.start[i + 1]; e++) {
        const j = shapes.neighbors[e];
        if (seen[j] || values[j] !== key || !shapes.area[j]) continue;
        seen[j] = 1;
        const dx = shapes.x[j] - shapes.x[i];
        blob.members.push(j);
        blob.x.push(blob.x[k] + (wrap ? wrapped(dx, width) : dx));
        blob.y.push(shapes.y[j]);
      }
    }
    blobs.push(blob);
  }
  return blobs;
}

/**
 * Where a name goes: a quadratic Bézier curve (`p0`, control `p1`, `p2`, read from p0 to p2)
 * through a blob, how long the room along it is and how thick the blob is around it, in bitmap
 * pixels. x may lie past the bitmap's edge where the world wraps.
 */
export type Placement = {
  key: string;
  /** The blob's pixels: larger names go first. */
  area: number;
  p0: [number, number];
  p1: [number, number];
  p2: [number, number];
  length: number;
  thickness: number;
  water: boolean;
  /** A location's name, which is one size everywhere rather than filling it. */
  location?: boolean;
};

/** Steps along a blob's axis at which its thickness and middle are measured. */
const BINS = 16;
/** Parts of a blob thinner than this share of its thickest are not room for its name. */
const THIN = 0.35;
/**
 * A blob that thins out in between gets a name in each of up to two parts, each at least this
 * share of it (`MAX_SPLIT_OF_PROBLEMATIC_NAMES`, `MIN_SPLIT_SIZE`).
 */
const MAX_SPLITS = 2;
const MIN_SPLIT = 0.2;
/**
 * The most a name bends: the cosine at the curve's control point between its two ends
 * (`COUNTRY_NAMES_MAX_COSINE`).
 */
const MAX_COSINE = -0.9;
/** How much of a blob's thickness a name's height takes at most (`COUNTRY_NAMES_SCALE_CAP_HEIGHT`). */
export const CAP_HEIGHT = 0.6;
/** A typical name's length over its height, for weighing the lines a name could take. */
const NAME_ASPECT = 5;
/** How much more room an upright name needs to be chosen over a level one. */
const LEVEL_PREFERENCE = 0.5;

/**
 * The names a blob gets: one, or one per part when it thins out in between. `inside` says
 * whether a bitmap point lies in the blob, to test the lines a name could take.
 */
export function placeBlob(shapes: Shapes, blob: Blob, water: boolean, inside: (x: number, y: number) => boolean = () => true): Placement[] {
  const { members } = blob;
  let total = 0, mx = 0, my = 0;
  for (let k = 0; k < members.length; k++) {
    const a = shapes.area[members[k]];
    total += a;
    mx += a * blob.x[k];
    my += a * blob.y[k];
  }
  mx /= total;
  my /= total;
  // The blob's covariance: its members' own plus their spread about its middle.
  let cxx = 0, cxy = 0, cyy = 0;
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    const a = shapes.area[i];
    const dx = blob.x[k] - mx;
    const dy = blob.y[k] - my;
    cxx += a * (shapes.xx[i] + dx * dx);
    cxy += a * (shapes.xy[i] + dx * dy);
    cyy += a * (shapes.yy[i] + dy * dy);
  }
  // The game tries a few lines through a blob (`COUNTRY_NAMES_NUM_LINE_TESTS`): here its
  // longest axis, the horizontal and two lines between, keeping the one with room for the
  // largest name that stays inside it. Level names read best, so they are preferred.
  const longest = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let best: { placements: Placement[]; score: number } | undefined;
  for (const angle of [longest, (longest * 2) / 3, longest / 3, 0]) {
    const tried = along(angle);
    if (!best || tried.score > best.score * (1 + 1e-9)) best = tried;
  }
  return best!.placements;

  function along(angle: number): { placements: Placement[]; score: number } {
    // The name runs along `u`; `v` is across it.
    const ux = Math.cos(angle), uy = Math.sin(angle);
    const vx = -uy, vy = ux;
    // Each member spreads its pixels evenly along the axis, over a span with its own variance there.
    const spans = members.map((i, k) => {
      const dx = blob.x[k] - mx;
      const dy = blob.y[k] - my;
      const variance = ux * ux * shapes.xx[i] + 2 * ux * uy * shapes.xy[i] + uy * uy * shapes.yy[i];
      return { t: ux * dx + uy * dy, s: vx * dx + vy * dy, half: Math.max(0.5, Math.sqrt(3 * Math.max(0, variance))), area: shapes.area[i] };
    });
    let t0 = Infinity, t1 = -Infinity;
    for (const m of spans) {
      t0 = Math.min(t0, m.t - m.half);
      t1 = Math.max(t1, m.t + m.half);
    }
    const step = (t1 - t0) / BINS;
    const area = new Float64Array(BINS);
    const across = new Float64Array(BINS);
    for (const m of spans) {
      const density = m.area / (2 * m.half);
      const from = m.t - m.half, to = m.t + m.half;
      for (let b = Math.max(0, Math.floor((from - t0) / step)); b < BINS && t0 + b * step < to; b++) {
        const overlap = Math.min(to, t0 + (b + 1) * step) - Math.max(from, t0 + b * step);
        if (overlap <= 0) continue;
        area[b] += density * overlap;
        across[b] += density * overlap * m.s;
      }
    }
    const thick = Array.from(area, (a) => a / step);
    const most = Math.max(...thick);
    // Parts thick enough for a name, largest first.
    const parts: { from: number; to: number; area: number }[] = [];
    for (let b = 0; b < BINS; ) {
      if (thick[b] < most * THIN) {
        b++;
        continue;
      }
      let end = b, sum = 0;
      while (end < BINS && thick[end] >= most * THIN) sum += area[end++];
      parts.push({ from: b, to: end, area: sum });
      b = end;
    }
    parts.sort((a, b) => b.area - a.area);
    const chosen = parts.filter((p, n) => n === 0 || (n < MAX_SPLITS && p.area >= total * MIN_SPLIT));
    const placements = chosen.map((part): Placement => {
      // The middle of the part across the axis, as a parabola s(t) fitted to the middle of each step.
      const points: { t: number; s: number; w: number }[] = [];
      for (let b = part.from; b < part.to; b++) if (area[b] > 0) points.push({ t: t0 + (b + 0.5) * step, s: across[b] / area[b], w: area[b] });
      const s = fitParabola(points);
      const a = t0 + part.from * step, b = t0 + part.to * step;
      const at = (t: number): [number, number] => {
        const off = s[0] + s[1] * t + s[2] * t * t;
        return [mx + ux * t + vx * off, my + uy * t + vy * off];
      };
      // The control point of the Bézier that is this parabola: where its end tangents meet.
      const slope = s[1] + 2 * s[2] * a;
      const mid = (a + b) / 2;
      const offset = s[0] + s[1] * a + s[2] * a * a + slope * (mid - a);
      let p0 = at(a), p2 = at(b);
      const p1 = limitBend(p0, [mx + ux * mid + vx * offset, my + uy * mid + vy * offset], p2);
      // Names read left to right, so their letters never lean back past upright; names within
      // 10° of upright read upwards.
      const dx = p2[0] - p0[0], dy = p2[1] - p0[1];
      const upright = Math.abs(dx) < Math.abs(dy) * Math.tan(Math.PI / 18);
      if (upright ? dy > 0 : dx < 0) [p0, p2] = [p2, p0];
      const middle = thick.slice(part.from, part.to).sort((x, y) => x - y);
      return { key: blob.key, area: total, p0, p1, p2, length: b - a, thickness: middle[Math.floor(middle.length / 2)], water };
    });
    const first = placements[0];
    const size = Math.min(first.length / NAME_ASPECT, first.thickness);
    const within = share(first, inside);
    return { placements, score: size * within * within * (1 - LEVEL_PREFERENCE * Math.abs(Math.sin(angle))) };
  }
}

/** The share of points along a name's curve, and along its edges either side, that lie in its blob. */
function share(place: Placement, inside: (x: number, y: number) => boolean): number {
  const STEPS = 12;
  const { p0, p1, p2 } = place;
  let hits = 0, count = 0;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
    const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
    // The curve's normal, from its tangent.
    const tx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
    const ty = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
    const norm = Math.hypot(tx, ty) || 1;
    const edge = (place.thickness * CAP_HEIGHT) / 2;
    for (const k of [-1, 0, 1]) {
      count++;
      if (inside(x - (ty / norm) * edge * k, y + (tx / norm) * edge * k)) hits++;
    }
  }
  return hits / count;
}

/** Weighted least squares of s = c0 + c1 t + c2 t²; fewer points fit a line or a constant. */
export function fitParabola(points: { t: number; s: number; w: number }[], degree = Math.min(2, points.length - 1)): [number, number, number] {
  if (degree < 0) return [0, 0, 0];
  // Normal equations of the polynomial's coefficients.
  const size = degree + 1;
  const m = Array.from({ length: size }, () => new Array<number>(size + 1).fill(0));
  for (const { t, s, w } of points) {
    const powers = [1, t, t * t];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) m[r][c] += w * powers[r] * powers[c];
      m[r][size] += w * powers[r] * s;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < size; c++) {
    let pivot = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r;
    [m[c], m[pivot]] = [m[pivot], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return fitParabola(points, degree - 1);
    for (let r = 0; r < size; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= size; k++) m[r][k] -= f * m[c][k];
    }
  }
  const result: [number, number, number] = [0, 0, 0];
  for (let r = 0; r < size; r++) result[r] = m[r][size] / m[r][r];
  return result;
}

/** Pull the control point towards the chord until the curve bends no more than `MAX_COSINE` allows. */
function limitBend(p0: [number, number], p1: [number, number], p2: [number, number]): [number, number] {
  const mid: [number, number] = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2];
  let control = p1;
  for (let k = 0; k < 30 && cosineAt(p0, control, p2) > MAX_COSINE; k++) {
    control = [mid[0] + (control[0] - mid[0]) * 0.8, mid[1] + (control[1] - mid[1]) * 0.8];
  }
  return cosineAt(p0, control, p2) > MAX_COSINE ? mid : control;
}

function cosineAt(p0: [number, number], p1: [number, number], p2: [number, number]): number {
  const ax = p0[0] - p1[0], ay = p0[1] - p1[1];
  const bx = p2[0] - p1[0], by = p2[1] - p1[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return la < 1e-9 || lb < 1e-9 ? -1 : (ax * bx + ay * by) / (la * lb);
}

/** A location's name: straight across its middle, as wide and thick as the location. */
export function placeLocation(shapes: Shapes, index: number, key: string, water: boolean): Placement {
  const x = shapes.x[index], y = shapes.y[index];
  // A location's pixels spread evenly over a box this wide and tall would vary as much.
  const half = Math.sqrt(3 * Math.max(0.25, shapes.xx[index]));
  const thickness = 2 * Math.sqrt(3 * Math.max(0.25, shapes.yy[index]));
  return { key, area: shapes.area[index], p0: [x - half, y], p1: [x, y], p2: [x + half, y], length: 2 * half, thickness, water, location: true };
}

/**
 * Screen pixels per bitmap pixel from which a mode's in-between and close-up names show. The
 * game switches at camera heights 615 and 271 (zoom steps 11 and 8 of `ZOOM_STEPS`); seen
 * straight down, the flat map shows detail sooner, so the steps come earlier at the same ratio.
 */
export const MIDDLE_SCALE = 1.3;
export const CLOSE_SCALE = MIDDLE_SCALE * (615 / 271);

/** Which of a mode's tiers shows at a scale: 0 close up, 1 in between, 2 far out. */
export const tierAt = (scale: number) => (scale >= CLOSE_SCALE ? 0 : scale >= MIDDLE_SCALE ? 1 : 2);

/**
 * What `placeNames` needs of a mode's tier: the value each location is named by (null where none),
 * and which are water. Cheap, so the main thread makes it and a worker does the placing.
 */
export type NameRequest = { values: (string | null)[]; water: Uint8Array; locations: boolean };

/**
 * The request for names of blobs of touching land with the same value: `valueOf(index)` is the
 * location's key (a country tag, say) or undefined for none. With `locations`, every location
 * with a value is named on its own instead, straight across its middle.
 */
export function nameRequest(data: MapData, valueOf: (index: number) => string | undefined, locations = false): NameRequest {
  const { kind } = data.info;
  const water = Uint8Array.from(kind, (k) => Number(k === "sea_zone" || k === "lake" || k === "impassable_sea"));
  const values = kind.map((_, i) => (water[i] ? null : valueOf(i) ?? null));
  return { values, water, locations };
}

/** Where the names `request` asks for go, largest first. */
export function placeNames(rows: Rows, shapes: Shapes, wrap: boolean, request: NameRequest): Placement[] {
  const { values, water: isWater } = request;
  const placements: Placement[] = [];
  if (request.locations) {
    values.forEach((key, i) => {
      if (key !== null && shapes.area[i]) placements.push(placeLocation(shapes, i, key, !!isWater[i]));
    });
  } else {
    const { width } = rows;
    const blobs = findBlobs(shapes, values.map((v) => v ?? undefined), width, wrap);
    // Which blob each location is in, to test points against.
    const blobOf = new Int32Array(values.length).fill(-1);
    blobs.forEach((blob, b) => blob.members.forEach((i) => (blobOf[i] = b)));
    blobs.forEach((blob, b) => {
      const inside = (x: number, y: number) => {
        const location = locationAt(rows, wrap ? x : Math.max(0, Math.min(width - 1, x)), y);
        return location >= 0 && location < blobOf.length && blobOf[location] === b;
      };
      placements.push(...placeBlob(shapes, blob, !!isWater[blob.members[0]], inside));
    });
  }
  return placements.sort((a, b) => b.area - a.area || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
