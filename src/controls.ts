import { clamp, fit, pick, toMap, zoomAt, type Size, type Viewport } from "./camera";
import { NO_LOCATION, type MapData } from "./data";
import type { Camera, MapRenderer } from "./renderer";

/** A box in bitmap pixels. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

/** The camera over a map drawn on `canvas`: where it looks, and ways to move it that keep it on the map. */
export class MapCamera {
  camera: Camera = { x: 0, y: 0, scale: 1 };

  constructor(
    private canvas: HTMLCanvasElement,
    private renderer: MapRenderer,
    readonly size: Size,
  ) {}

  view(): Viewport {
    return { width: this.canvas.clientWidth || 1, height: this.canvas.clientHeight || 1 };
  }

  move(next: Camera) {
    this.camera = clamp(next, this.view(), this.size);
    this.renderer.update({ camera: this.camera });
  }

  /** Show `box` (in bitmap pixels). */
  fitBox(box: Box) {
    this.move(fit(box, this.view(), this.size));
  }

  /** Zoom by `factor` around the middle of the view. */
  zoom(factor: number) {
    const { width, height } = this.view();
    this.move(zoomAt(this.camera, this.view(), this.size, factor, width / 2, height / 2));
  }

  /** Move by a fraction of the view: `pan(0.25, 0)` shows what was a quarter to the right. */
  pan(dx: number, dy: number) {
    const { width, height } = this.view();
    const { x, y, scale } = this.camera;
    this.move({ x: x + (dx * width) / scale, y: y + (dy * height) / scale, scale });
  }

  /** The location index under a point of the canvas (relative to its top left), or -1. */
  locationAt(pixels: Uint16Array, x: number, y: number): number {
    const point = toMap(this.camera, this.view(), x, y);
    const index = pick(pixels, this.size, point.x, point.y);
    return index === NO_LOCATION ? -1 : index;
  }
}

export type Handlers = {
  /** The location under the pointer (-1 for none), and where the pointer is in the canvas. */
  onHover?: (index: number, x: number, y: number) => void;
  /** A location tapped or clicked (-1 for a click off the map's locations). */
  onTap?: (index: number) => void;
};

/**
 * Dragging, pinching and wheel zoom on the map's canvas, hovering over locations and tapping
 * them. Returns a function that removes the listeners.
 */
export function attachGestures(canvas: HTMLCanvasElement, data: MapData, camera: MapCamera, handlers: Handlers): () => void {
  const map = camera.size;
  const pointers = new Map<number, { x: number; y: number }>();
  let gesture: { camera: Camera; x: number; y: number; distance: number; moved: boolean } | null = null;
  // A tap selects on the click that follows it: selecting sooner would let the click land on
  // whatever the selection opens under the finger.
  let tapped = false;
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  const at = (x: number, y: number) => camera.locationAt(data.bitmap.pixels, x, y);
  const centroid = () => {
    const points = [...pointers.values()];
    const x = points.reduce((s, p) => s + p.x, 0) / points.length;
    const y = points.reduce((s, p) => s + p.y, 0) / points.length;
    const distance = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    return { x, y, distance };
  };
  const begin = () => {
    gesture = { camera: camera.camera, ...centroid(), moved: gesture?.moved ?? false };
  };
  const hover = (x: number, y: number) => handlers.onHover?.(at(x, y), x, y);
  const down = (e: PointerEvent) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    begin();
  };
  const moveTo = (e: PointerEvent) => {
    const point = local(e);
    if (!pointers.has(e.pointerId)) return hover(point.x, point.y);
    pointers.set(e.pointerId, point);
    if (!gesture) return;
    const now = centroid();
    if (Math.hypot(now.x - gesture.x, now.y - gesture.y) > 4 || pointers.size > 1) gesture.moved = true;
    if (!gesture.moved) return;
    const factor = gesture.distance && now.distance ? now.distance / gesture.distance : 1;
    const zoomed = zoomAt(gesture.camera, camera.view(), map, factor, gesture.x, gesture.y);
    camera.move({ ...zoomed, x: zoomed.x - (now.x - gesture.x) / zoomed.scale, y: zoomed.y - (now.y - gesture.y) / zoomed.scale });
    handlers.onHover?.(-1, point.x, point.y);
  };
  const up = (e: PointerEvent) => {
    tapped = e.type === "pointerup" && !!gesture && !gesture.moved && pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size) begin();
    else gesture = null;
  };
  const click = (e: MouseEvent) => {
    if (!tapped) return;
    tapped = false;
    const point = local(e);
    handlers.onTap?.(at(point.x, point.y));
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const point = local(e);
    const speed = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015;
    camera.move(zoomAt(camera.camera, camera.view(), map, Math.exp(-e.deltaY * speed), point.x, point.y));
    hover(point.x, point.y);
  };
  const leave = (e: PointerEvent) => {
    const point = local(e);
    handlers.onHover?.(-1, point.x, point.y);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", moveTo);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", leave);
  canvas.addEventListener("click", click);
  canvas.addEventListener("wheel", wheel, { passive: false });
  return () => {
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointermove", moveTo);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", up);
    canvas.removeEventListener("pointerleave", leave);
    canvas.removeEventListener("click", click);
    canvas.removeEventListener("wheel", wheel);
  };
}
