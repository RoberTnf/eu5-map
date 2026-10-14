import { riverGeometry, type River, type RiverGeometry } from "./rivers";

/** Pixel value of places that are no location. */
export const NO_LOCATION = 0xffff;

/**
 * The location bitmap: each pixel is a location index, row by row from the top left. `runs` is
 * the ungzipped `locations.bin` it was decoded from, which is far smaller to hand to a worker.
 */
export type Bitmap = { width: number; height: number; pixels: Uint16Array; runs?: ArrayBuffer };

/**
 * How a location is drawn when nothing paints it. `impassable_sea` is impassable terrain on open
 * water, drawn as deep sea.
 */
export type LocationKind = "land" | "non_ownable" | "sea_zone" | "lake" | "impassable_mountains" | "impassable_sea";

/** `map.json`; see `scripts/snapshot.mjs`. Per-location arrays are indexed by bitmap value. */
export type MapInfo = {
  /** The game's bitmap size. Rivers and `center` are in its pixels; the bitmap may be smaller. */
  width: number;
  height: number;
  /** The map wraps around horizontally: the left and right edges touch. */
  wrapX: boolean;
  keys: string[];
  province: string[];
  kind: LocationKind[];
  /** Mean position of a location's pixels, in game pixels; null for none. */
  center: ([number, number] | null)[];
  /** Size in game pixels. */
  pixels: number[];
  /** Country tag → `rrggbb`, the game's map colours. */
  countryColors: Record<string, string>;
};

export type MapData = {
  info: MapInfo;
  bitmap: Bitmap;
  byKey: Map<string, number>;
  /** Province index per location, for the province borders. */
  provinces: Uint16Array;
  /** Bitmap pixels per game pixel. */
  shrink: number;
};

/** Run-length decoding of `locations.bin.gz`: width, height and run count (u32), values, then lengths (u16). */
export function decodeBitmap(buffer: ArrayBuffer): Bitmap {
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const runs = view.getUint32(8, true);
  const pixels = new Uint16Array(width * height);
  const values = 12;
  const lengths = values + runs * 2;
  let at = 0;
  for (let i = 0; i < runs; i++) {
    const length = view.getUint16(lengths + i * 2, true);
    pixels.fill(view.getUint16(values + i * 2, true), at, at + length);
    at += length;
  }
  if (at !== pixels.length) throw new Error(`location bitmap has ${at} of ${pixels.length} pixels`);
  return { width, height, pixels, runs: buffer };
}

async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  // Some servers decode it on the way (Content-Encoding); then it is no longer gzip.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response;
}

/** `map.json` and `locations.bin.gz` from the folder at `base`. */
export async function loadMap(base: string): Promise<MapData> {
  const [info, buffer] = await Promise.all([
    fetchOk(`${base}/map.json`).then((r) => r.json() as Promise<MapInfo>),
    fetchOk(`${base}/locations.bin.gz`).then((r) => r.arrayBuffer()),
  ]);
  const bitmap = decodeBitmap(await gunzip(buffer));
  const byKey = new Map(info.keys.map((key, i) => [key, i]));
  const ids = new Map<string, number>();
  const provinces = Uint16Array.from(info.province, (p) => {
    if (!ids.has(p)) ids.set(p, ids.size);
    return ids.get(p)!;
  });
  return { info, bitmap, byKey, provinces, shrink: bitmap.width / info.width };
}

/** `rivers.json` from the folder at `base`, ready to draw. */
export async function loadRivers(base: string): Promise<RiverGeometry> {
  return riverGeometry((await (await fetchOk(`${base}/rivers.json`)).json()) as River[]);
}
