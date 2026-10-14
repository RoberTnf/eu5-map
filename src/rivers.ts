/** A river in `rivers.json`. */
export type River = {
  /** From 0, the narrowest, to `WIDTHS - 1`. */
  width: number;
  /**
   * Pixel coordinates in the game's bitmap, `[x0, y0, x1, y1, …]`, from upstream to downstream.
   * A tributary ends on the river it flows into; a branch starts on the one it leaves.
   */
  points: number[];
};

/** Width classes in `rivers.json`: from 0 to 12. */
const WIDTHS = 13;
/** Game pixels between arrows at the finest level; each level doubles it. */
export const ARROW_STEP = 12;
/** Below this map zoom even the widest river is fully transparent. */
export const RIVER_MIN_ZOOM = 0.15;
const MAX_LEVEL = 8;
const TILE = 1024;
const VIEW_MARGIN = 64;

/**
 * Instance data for drawing: one line piece per pair of points (`ax ay bx by width`) and
 * arrows along each river pointing downstream (`x y dx dy width level`). Coordinates are
 * pixel centres in the game's bitmap. An arrow's level says how zoomed in the map must be to
 * show it: arrow k of a river has the level of the power of two dividing k + 1, so each level
 * halves the spacing.
 */
export type RiverGeometry = { pieces: Float32Array; arrows: Float32Array };

export function riverGeometry(rivers: River[]): RiverGeometry {
  const pieces: number[] = [];
  const arrows: number[] = [];
  for (const river of rivers) {
    const width = river.width / (WIDTHS - 1);
    const points = river.points;
    // Distance along the river to the next arrow.
    let next = ARROW_STEP / 2;
    let k = 0;
    let travelled = 0;
    for (let i = 2; i + 1 < points.length; i += 2) {
      const ax = points[i - 2] + 0.5;
      const ay = points[i - 1] + 0.5;
      const bx = points[i] + 0.5;
      const by = points[i + 1] + 0.5;
      pieces.push(ax, ay, bx, by, width);
      const length = Math.hypot(bx - ax, by - ay);
      if (!length) continue;
      const dx = (bx - ax) / length;
      const dy = (by - ay) / length;
      while (next <= travelled + length) {
        const t = next - travelled;
        arrows.push(ax + dx * t, ay + dy * t, dx, dy, width, level(k + 1));
        k++;
        next += ARROW_STEP;
      }
      travelled += length;
    }
  }
  return { pieces: new Float32Array(pieces), arrows: new Float32Array(arrows) };
}

function level(n: number): number {
  let l = 0;
  while (n % 2 === 0 && l < MAX_LEVEL) {
    n /= 2;
    l++;
  }
  return l;
}

/** The coarsest arrow level to show at `scale` device pixels per game pixel: arrows about `spacing` pixels apart. */
export function arrowLevel(scale: number, spacing: number): number {
  const needed = Math.ceil(Math.log2(spacing / (ARROW_STEP * scale)));
  return Math.max(0, Math.min(MAX_LEVEL, needed));
}

// Both programs place things in device pixels around the camera centre. `width` is 0 for the
// narrowest river and 1 for the widest; the game draws them 1 to 2.2 game pixels wide.
const COMMON = `#version 300 es
uniform vec2 center;
uniform float scale;
uniform float ratio;
uniform vec2 viewport;
uniform float shift;
float halfWidth(float width) { return 0.5 * max(mix(1.0, 2.2, width) * scale, ratio * mix(0.9, 2.6, width)); }
vec2 screen(vec2 p) { return (p + vec2(shift, 0.0) - center) * scale; }
vec4 clip(vec2 s) { return vec4(s.x / viewport.x * 2.0, -s.y / viewport.y * 2.0, 0.0, 1.0); }
`;

const LINE_VERTEX = `${COMMON}
in vec2 corner;
in vec4 piece;
in float width;
out float alpha;
uniform vec2 fade;
void main() {
  vec2 a = screen(piece.xy);
  vec2 b = screen(piece.zw);
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  float h = halfWidth(width);
  // Each piece runs half a width past its ends, covering the joints.
  vec2 s = mix(a, b, corner.x) + dir * (corner.x * 2.0 - 1.0) * h + normal * corner.y * h;
  gl_Position = clip(s);
  // Wide rivers appear first as the map is zoomed in.
  alpha = clamp((scale - fade.x + width * fade.y) / fade.y, 0.0, 1.0);
}`;

const ARROW_VERTEX = `${COMMON}
in vec2 corner;
in vec4 arrow;
in vec2 extra;
out float alpha;
uniform float minLevel;
uniform float arrowAlpha;
void main() {
  if (extra.y < minLevel) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 dir = arrow.zw;
  vec2 normal = vec2(-dir.y, dir.x);
  float size = max(halfWidth(extra.x) * 3.0, ratio * 7.0);
  gl_Position = clip(screen(arrow.xy) + (dir * corner.x + normal * corner.y) * size);
  alpha = arrowAlpha;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
in float alpha;
uniform vec3 color;
out vec4 outColor;
void main() { outColor = vec4(color * alpha, alpha); }`;

/** A piece is a quad from its start (x = 0) to its end (x = 1), one width across. */
const QUAD = [0, -1, 1, -1, 0, 1, 0, 1, 1, -1, 1, 1];
/** A chevron pointing along +x: the tip, the two barbs and the notch between them. */
const CHEVRON = [1, 0, -0.7, 0.8, -0.25, 0, 1, 0, -0.25, 0, -0.7, -0.8];

const LINE_COLOR = [0.29, 0.47, 0.72];
const ARROW_COLOR = [0.1, 0.2, 0.38];

type TileSpan = { x: number; y: number; x0: number; y0: number; x1: number; y1: number; start: number; count: number };
type TiledInstances = { data: Float32Array; tiles: TileSpan[] };

/** Pack river segments by map tile so the GPU only draws tiles in the viewport. */
export function tileRiverInstances(instances: Float32Array, stride: number, line: boolean): TiledInstances {
  const buckets = new Map<string, { x: number; y: number; x0: number; y0: number; x1: number; y1: number; values: number[] }>();
  for (let i = 0; i < instances.length; i += stride) {
    const x = line ? (instances[i] + instances[i + 2]) / 2 : instances[i];
    const y = line ? (instances[i + 1] + instances[i + 3]) / 2 : instances[i + 1];
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const key = `${tx},${ty}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { x: tx * TILE, y: ty * TILE, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, values: [] };
      buckets.set(key, bucket);
    }
    bucket.x0 = Math.min(bucket.x0, instances[i], line ? instances[i + 2] : x);
    bucket.y0 = Math.min(bucket.y0, instances[i + 1], line ? instances[i + 3] : y);
    bucket.x1 = Math.max(bucket.x1, instances[i], line ? instances[i + 2] : x);
    bucket.y1 = Math.max(bucket.y1, instances[i + 1], line ? instances[i + 3] : y);
    for (let j = 0; j < stride; j++) bucket.values.push(instances[i + j]);
  }
  const ordered = [...buckets.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  const data = new Float32Array(instances.length);
  const tiles: TileSpan[] = [];
  let offset = 0;
  for (const bucket of ordered) {
    data.set(bucket.values, offset);
    tiles.push({ x: bucket.x, y: bucket.y, x0: bucket.x0, y0: bucket.y0, x1: bucket.x1, y1: bucket.y1, start: offset / stride, count: bucket.values.length / stride });
    offset += bucket.values.length;
  }
  return { data, tiles };
}

/** A tile can reach the viewport after wrapping the world horizontally. */
export function riverTileVisible(tile: TileSpan, view: RiverView, shift = 0): boolean {
  const halfWidth = view.viewport[0] / (2 * view.scale) + VIEW_MARGIN;
  const halfHeight = view.viewport[1] / (2 * view.scale) + VIEW_MARGIN;
  return tile.x0 + shift <= view.center[0] + halfWidth && tile.x1 + shift >= view.center[0] - halfWidth
    && tile.y0 <= view.center[1] + halfHeight && tile.y1 >= view.center[1] - halfHeight;
}

type Program = {
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  instances: WebGLBuffer;
  stride: number;
  attributes: { location: number; size: number; offset: number }[];
  tiles: TileSpan[];
  uniforms: Map<string, WebGLUniformLocation | null>;
};

export type RiverView = {
  /** Camera centre in game pixels. */
  center: [number, number];
  /** Device pixels per game pixel. */
  scale: number;
  ratio: number;
  viewport: [number, number];
  /** Width of the world in game pixels when it wraps around, else 0. */
  wrap: number;
  /** Map zoom in CSS pixels per bitmap pixel, which the map's fades use. */
  zoom: number;
};

/** Rivers drawn over the map: blue lines, and chevrons pointing downstream once zoomed in. */
export class RiverLayer {
  private lines: Program;
  private arrows: Program;
  private buffers: WebGLBuffer[] = [];

  constructor(
    private gl: WebGL2RenderingContext,
    geometry: RiverGeometry,
    compile: (type: number, source: string) => WebGLShader,
  ) {
    this.lines = this.program(compile, LINE_VERTEX, QUAD, geometry.pieces, [
      ["piece", 4],
      ["width", 1],
    ]);
    this.arrows = this.program(compile, ARROW_VERTEX, CHEVRON, geometry.arrows, [
      ["arrow", 4],
      ["extra", 2],
    ]);
  }

  private program(compile: (type: number, source: string) => WebGLShader, vertex: string, template: number[], instances: Float32Array, layout: [string, number][]): Program {
    const gl = this.gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "river shader failed to link");
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    this.buffer(new Float32Array(template));
    const corner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    const stride = layout.reduce((sum, [, size]) => sum + size, 0) * 4;
    const tiled = tileRiverInstances(instances, stride / 4, layout[0][0] === "piece");
    const instanceBuffer = this.buffer(tiled.data);
    const attributes: Program["attributes"] = [];
    let offset = 0;
    for (const [name, size] of layout) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, 1);
      attributes.push({ location, size, offset });
      offset += size * 4;
    }
    gl.bindVertexArray(null);
    return { program, vao, instances: instanceBuffer, stride, attributes, tiles: tiled.tiles, uniforms: new Map() };
  }

  private buffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer()!;
    this.buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return buffer;
  }

  private uniform(p: Program, name: string): WebGLUniformLocation | null {
    if (!p.uniforms.has(name)) p.uniforms.set(name, this.gl.getUniformLocation(p.program, name));
    return p.uniforms.get(name)!;
  }

  draw(view: RiverView) {
    if (view.zoom <= RIVER_MIN_ZOOM) return;
    const gl = this.gl;
    // Wide rivers fade in between zoom 0.15 and 0.6, narrow ones between 0.6 and 1.05; arrows
    // between 1.2 and 2.
    const arrowAlpha = Math.max(0, Math.min(1, (view.zoom - 1.2) / 0.8));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const passes: [Program, number[]][] = [[this.lines, LINE_COLOR]];
    if (arrowAlpha > 0) passes.push([this.arrows, ARROW_COLOR]);
    for (const [p, color] of passes) {
      if (!p.tiles.length) continue;
      gl.useProgram(p.program);
      gl.bindVertexArray(p.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, p.instances);
      gl.uniform2f(this.uniform(p, "center"), ...view.center);
      gl.uniform1f(this.uniform(p, "scale"), view.scale);
      gl.uniform1f(this.uniform(p, "ratio"), view.ratio);
      gl.uniform2f(this.uniform(p, "viewport"), ...view.viewport);
      gl.uniform3f(this.uniform(p, "color"), color[0], color[1], color[2]);
      // The line fade is in device pixels per game pixel: zoom × (scale / zoom).
      const perZoom = view.scale / view.zoom;
      gl.uniform2f(this.uniform(p, "fade"), 0.6 * perZoom, 0.45 * perZoom);
      gl.uniform1f(this.uniform(p, "minLevel"), arrowLevel(view.scale, 110 * view.ratio));
      gl.uniform1f(this.uniform(p, "arrowAlpha"), arrowAlpha);
      for (const shift of view.wrap ? [-view.wrap, 0, view.wrap] : [0]) {
        gl.uniform1f(this.uniform(p, "shift"), shift);
        for (const tile of p.tiles) {
          if (!riverTileVisible(tile, view, shift)) continue;
          for (const attribute of p.attributes) {
            gl.vertexAttribPointer(attribute.location, attribute.size, gl.FLOAT, false, p.stride, tile.start * p.stride + attribute.offset);
          }
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, tile.count);
        }
      }
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  destroy() {
    const gl = this.gl;
    for (const buffer of this.buffers) gl.deleteBuffer(buffer);
    for (const p of [this.lines, this.arrows]) {
      gl.deleteVertexArray(p.vao);
      gl.deleteProgram(p.program);
    }
  }
}
