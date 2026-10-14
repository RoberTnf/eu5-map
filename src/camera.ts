import type { Camera } from "./renderer";

export type Viewport = { width: number; height: number };
export type Size = { width: number; height: number };

/** Most screen pixels per bitmap pixel. */
export const MAX_SCALE = 24;

/** Least zoom: the map fills the viewport's height. */
export const minScale = (view: Viewport, map: Size) => Math.max(view.height / map.height, view.width / map.width / 3);

/** Keep the map covering the viewport vertically, and x within one turn of the world. */
export function clamp(camera: Camera, view: Viewport, map: Size): Camera {
  const scale = Math.min(MAX_SCALE, Math.max(minScale(view, map), camera.scale));
  const half = view.height / 2 / scale;
  const y = half * 2 >= map.height ? map.height / 2 : Math.min(map.height - half, Math.max(half, camera.y));
  const x = ((camera.x % map.width) + map.width) % map.width;
  return { x, y, scale };
}

/** The bitmap point under a screen point (relative to the viewport's top left). */
export function toMap(camera: Camera, view: Viewport, sx: number, sy: number): { x: number; y: number } {
  return { x: camera.x + (sx - view.width / 2) / camera.scale, y: camera.y + (sy - view.height / 2) / camera.scale };
}

/** Zoom by `factor` keeping the point under (sx, sy) in place. */
export function zoomAt(camera: Camera, view: Viewport, map: Size, factor: number, sx: number, sy: number): Camera {
  const point = toMap(camera, view, sx, sy);
  const scale = Math.min(MAX_SCALE, Math.max(minScale(view, map), camera.scale * factor));
  return clamp({ scale, x: point.x - (sx - view.width / 2) / scale, y: point.y - (sy - view.height / 2) / scale }, view, map);
}

/** A camera showing the box `[x0, y0]–[x1, y1]` with some margin. */
export function fit(box: { x0: number; y0: number; x1: number; y1: number }, view: Viewport, map: Size): Camera {
  const width = Math.max(1, box.x1 - box.x0) * 1.15;
  const height = Math.max(1, box.y1 - box.y0) * 1.15;
  const scale = Math.min(view.width / width, view.height / height);
  return clamp({ x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2, scale }, view, map);
}

/** The location index at a bitmap point. */
export function pick(pixels: Uint16Array, map: Size, x: number, y: number): number {
  const py = Math.floor(y);
  if (py < 0 || py >= map.height) return -1;
  const px = ((Math.floor(x) % map.width) + map.width) % map.width;
  return pixels[py * map.width + px];
}
