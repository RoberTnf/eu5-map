import { CAP_HEIGHT, tierAt, type Placement } from "./labels";
import type { Camera } from "./renderer";

/** A placed name with its text. */
export type Name = Placement & { text: string };

/**
 * How a name fills its blob (`COUNTRY_NAMES_SCALE`, `_SCALE_CAP_HEIGHT`, `_MAX_STRETCH_FACTOR`):
 * it spans this share of the room along it, as tall as this share of the blob's thickness at
 * most; letters spread apart up to this much to fill it when the height caps them.
 */
const SCALE = 0.8;
const MAX_STRETCH = 1.6;
/** Font sizes in CSS pixels: smaller names aren't drawn, larger ones stop growing. */
const MIN_SIZE = 11;
const MAX_SIZE = 64;
/** Locations' names grow from the smallest size with the zoom up to this one. */
const LOCATION_SIZE = 16;
/** How far past its location's width a location's name may run. */
const LOCATION_OVERRUN = 1.4;
/** How much smaller each size tried for a name that would overlap another is. */
const SHRINK = 0.8;
/** Names drawn and tried at most per frame; locations zoomed out are many. */
const MAX_NAMES = 400;
const MAX_TRIES = 4000;
/** The most opaque a name gets (`NMapName` `MAX_OPACITY`). */
const OPACITY = 0.85;

/** A name's letters and the width of each at 1px, kerned as the whole name sets them. */
type Glyphs = { chars: string[]; widths: number[]; width: number };
/** Size steps per doubling of the font size: a letter is scaled down by at most 16%. */
const STEPS_PER_OCTAVE = 4;
/** The atlas of letters is a square this many pixels wide, or the most the device allows. */
const ATLAS = 2048;
/** A letter's rectangle on screen: its centre, half its width and height, and its turn's cosine and sine. */
type Rect = { x: number; y: number; hw: number; hh: number; c: number; s: number };
/** A letter in the atlas: its top left, width and height in atlas pixels. */
type Cell = { u: number; v: number; w: number; h: number };
/** Floats per letter drawn: its centre in device pixels, its turn's cosine and sine times its scale, and its cell. */
const STRIDE = 8;

// A letter is its cell, centred on its place, scaled and turned. The atlas holds coverage only:
// names are black, a little see-through and without a halo, as the game letters its map
// (`mapname.shader`).
const VERTEX = `#version 300 es
in vec2 corner;
in vec4 place;
in vec4 cell;
uniform vec2 viewport;
uniform vec2 atlas;
out vec2 uv;
void main() {
  vec2 o = corner * cell.zw;
  vec2 s = place.xy + vec2(o.x * place.z - o.y * place.w, o.x * place.w + o.y * place.z);
  gl_Position = vec4(s.x / viewport.x * 2.0 - 1.0, 1.0 - s.y / viewport.y * 2.0, 0.0, 1.0);
  uv = (cell.xy + (corner + 0.5) * cell.zw) / atlas;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D letters;
uniform float opacity;
in vec2 uv;
out vec4 color;
void main() { color = vec4(0.0, 0.0, 0.0, texture(letters, uv).r * opacity); }`;

/** The texture unit of the atlas; the map's own textures take those below. */
const UNIT = 5;

/**
 * Names drawn over the map with its WebGL context: those of the tier the zoom shows, only where
 * they are on screen, the largest first, leaving out any that would overlap one already drawn.
 * Letters are drawn once into an atlas and then scaled and turned on the GPU, all in one draw
 * call; drawing them with a 2D canvas over the map cost a call per letter every frame.
 */
export class LabelLayer {
  /** Names close up, in between and far out. */
  private tiers: Name[][] = [[], [], []];
  /** Text widths at 1px, by font and text. */
  private glyphs = new Map<string, Glyphs>();
  /** The same by name, which spares building its font and key each frame. */
  private named = new WeakMap<Name, Glyphs>();
  /** Where the world wraps, a name may show a turn to the left or right. */
  private turns: number[];
  private family = "serif";
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private instances: WebGLBuffer;
  private quad: WebGLBuffer;
  private texture: WebGLTexture;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  /** Each new letter is drawn here, then copied into its cell of the atlas texture. */
  private scratch: CanvasRenderingContext2D;
  /** The atlas's cells, filled in shelves left to right and top to bottom. */
  private atlas: { size: number; cells: Map<string, Cell>; x: number; y: number; row: number };
  /** The letters last laid out and what for; laid out again when the camera or names change. */
  private data = new Float32Array(STRIDE * 1024);
  private count = 0;
  private shown = "";
  /** Asks for another frame: the atlas filled up during this one. */
  request: () => void = () => {};

  constructor(
    private gl: WebGL2RenderingContext,
    compile: (type: number, source: string) => WebGLShader,
    /** The bitmap's size, and whether the world wraps around in x. */
    map: { width: number; height: number; wrap: boolean },
  ) {
    this.turns = map.wrap ? [0, -map.width, map.width] : [0];
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "name shader failed to link");
    this.program = program;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, "corner");
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    this.instances = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    for (const [name, offset] of [["place", 0], ["cell", 4]] as const) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, STRIDE * 4, offset * 4);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);

    const size = Math.min(ATLAS, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    // Letters are read back to fill the texture, so the canvas stays in memory rather than on the GPU.
    this.scratch = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    this.atlas = { size, cells: new Map(), x: 0, y: 0, row: 0 };
    this.texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, param, gl.LINEAR);
    for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, size, size);
  }

  setNames(tiers: Name[][]) {
    this.tiers = tiers;
    this.named = new WeakMap();
    this.shown = "";
  }

  setFont(family: string) {
    this.family = family;
    this.glyphs.clear();
    this.named = new WeakMap();
    this.clearAtlas();
    this.shown = "";
  }

  /** Draw the names for `camera` over the map, `viewport` device pixels at `ratio` per CSS pixel. */
  draw(camera: Camera, ratio: number, viewport: [number, number]) {
    const key = `${camera.x},${camera.y},${camera.scale},${ratio},${viewport}`;
    if (key !== this.shown) {
      // Letters that didn't fit in the atlas wait for a frame with an emptied one.
      const fresh = this.atlas.cells.size === 0;
      const complete = this.layout(camera, ratio, { width: viewport[0] / ratio, height: viewport[1] / ratio });
      this.shown = key;
      if (!complete && !fresh) {
        this.clearAtlas();
        this.shown = "";
        this.request();
      }
    }
    if (!this.count) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.uniform("letters"), UNIT);
    gl.uniform1f(this.uniform("opacity"), OPACITY);
    gl.uniform2f(this.uniform("viewport"), viewport[0], viewport[1]);
    gl.uniform2f(this.uniform("atlas"), this.atlas.size, this.atlas.size);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteBuffer(this.quad);
    gl.deleteBuffer(this.instances);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
  }

  /** Choose and place the names to show, into the instance buffer. False when the atlas ran out of room. */
  private layout(camera: Camera, ratio: number, view: { width: number; height: number }): boolean {
    this.count = 0;
    let complete = true;
    const { scale } = camera;
    const left = camera.x - view.width / 2 / scale;
    const right = camera.x + view.width / 2 / scale;
    const top = camera.y - view.height / 2 / scale;
    const bottom = camera.y + view.height / 2 / scale;
    const taken = new Occupied();
    let drawn = 0, tried = 0;
    for (const name of this.tiers[tierAt(scale)] ?? []) {
      if (drawn >= MAX_NAMES || tried >= MAX_TRIES) break;
      const pad = name.thickness / 2;
      const y0 = Math.min(name.p0[1], name.p1[1], name.p2[1]) - pad;
      const y1 = Math.max(name.p0[1], name.p1[1], name.p2[1]) + pad;
      if (y1 < top || y0 > bottom) continue;
      const x0 = Math.min(name.p0[0], name.p1[0], name.p2[0]) - pad;
      const x1 = Math.max(name.p0[0], name.p1[0], name.p2[0]) + pad;
      for (const turn of this.turns) {
        if (x1 + turn < left || x0 + turn > right) continue;
        tried++;
        const room = name.length * scale;
        const tall = CAP_HEIGHT * name.thickness * scale;
        // Too thin for even the smallest name to sit mostly inside.
        if (tall * 2.5 < MIN_SIZE || room < MIN_SIZE) continue;
        let glyphs = this.named.get(name);
        if (!glyphs) this.named.set(name, (glyphs = this.measure(this.style(name), name.text)));
        const unit = glyphs.width / 100;
        let size: number;
        if (name.location) {
          size = Math.min(LOCATION_SIZE, MIN_SIZE + Math.max(0, scale - 3));
          if (unit * size > room * LOCATION_OVERRUN) continue;
        } else {
          size = Math.min((SCALE * room) / unit, tall, MAX_SIZE);
          // Too small to read: a short name may still run a little over its blob's edges.
          if (size < MIN_SIZE) {
            if (unit * MIN_SIZE > room * 1.15) continue;
            size = MIN_SIZE;
          }
        }
        const toScreen = (p: [number, number]): [number, number] => [(p[0] + turn - camera.x) * scale + view.width / 2, (p[1] - camera.y) * scale + view.height / 2];
        if (name.location) {
          // Straight and set as the font sets it: one rectangle for the whole name.
          const [x, y] = toScreen(name.p1);
          const width = unit * size;
          const rect = glyphRect({ char: "", x, y, angle: 0, width }, size);
          if (taken.hits(rect)) continue;
          taken.add(rect);
          const placed: Placed[] = [];
          let at = x - width / 2;
          for (let c = 0; c < glyphs.chars.length; c++) {
            const w = (glyphs.widths[c] * size) / 100;
            placed.push({ char: glyphs.chars[c], x: at + w / 2, y, angle: 0, width: w });
            at += w;
          }
          complete = this.paint(name, size, ratio, placed) && complete;
          drawn++;
          continue;
        }
        // A name that would overlap one already drawn tries smaller sizes before giving up.
        for (let fit = size; fit >= MIN_SIZE; fit = fit > MIN_SIZE && fit * SHRINK < MIN_SIZE ? MIN_SIZE : fit * SHRINK) {
          const natural = unit * fit;
          const spread = Math.min(MAX_STRETCH * natural, Math.max(natural, SCALE * room));
          const placed = layout(glyphs, fit / 100, spread, toScreen(name.p0), toScreen(name.p1), toScreen(name.p2));
          if (!placed) break;
          const rects = placed.map((g) => glyphRect(g, fit));
          if (rects.some((r) => taken.hits(r))) continue;
          for (const r of rects) taken.add(r);
          complete = this.paint(name, fit, ratio, placed) && complete;
          drawn++;
          break;
        }
      }
    }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, this.count * STRIDE), gl.DYNAMIC_DRAW);
    return complete;
  }

  /** Add a name's letters to the instance buffer. False when the atlas had no room for one. */
  private paint(name: Name, size: number, ratio: number, placed: Placed[]): boolean {
    // Letters are drawn at the size step at or above this size and scaled down to it.
    const step = 2 ** (Math.ceil(Math.log2(size * ratio) * STEPS_PER_OCTAVE) / STEPS_PER_OCTAVE);
    const k = (size * ratio) / step;
    for (const g of placed) {
      if (!g.char.trim()) continue;
      const cell = this.cell(name, step, g.char);
      if (!cell) return false;
      if ((this.count + 1) * STRIDE > this.data.length) {
        const grown = new Float32Array(this.data.length * 2);
        grown.set(this.data);
        this.data = grown;
      }
      const o = this.count++ * STRIDE;
      this.data[o] = g.x * ratio;
      this.data[o + 1] = g.y * ratio;
      this.data[o + 2] = Math.cos(g.angle) * k;
      this.data[o + 3] = Math.sin(g.angle) * k;
      this.data[o + 4] = cell.u;
      this.data[o + 5] = cell.v;
      this.data[o + 6] = cell.w;
      this.data[o + 7] = cell.h;
    }
    return true;
  }

  private style(name: Name, px = 100): string {
    return `${name.water ? "italic " : ""}${name.location ? 400 : 500} ${px}px ${this.family}`;
  }

  /** `char` in `name`'s style, `px` device pixels tall, in the atlas; null when it is full. */
  private cell(name: Name, px: number, char: string): Cell | null {
    const font = this.style(name, px);
    const id = `${font}|${char}`;
    const atlas = this.atlas;
    const known = atlas.cells.get(id);
    if (known) return known;
    let ctx = this.scratch;
    ctx.font = font;
    const pad = Math.ceil(px * 0.1) + 1;
    const w = Math.ceil(ctx.measureText(char).width) + pad * 2;
    const h = Math.ceil(px * 1.3) + pad * 2;
    if (atlas.x + w > atlas.size) {
      atlas.y += atlas.row;
      atlas.x = 0;
      atlas.row = 0;
    }
    if (w > atlas.size || atlas.y + h > atlas.size) return null;
    const cell = { u: atlas.x, v: atlas.y, w, h };
    atlas.x += w;
    atlas.row = Math.max(atlas.row, h);
    atlas.cells.set(id, cell);
    // The whole cell is drawn, its blank margin too, so nothing left of an earlier atlas shows.
    const canvas = ctx.canvas;
    if (canvas.width < w || canvas.height < h) {
      canvas.width = Math.max(canvas.width, w);
      canvas.height = Math.max(canvas.height, h);
      ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    } else ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000";
    ctx.fillText(char, w / 2, h / 2);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let k = 0; k < alpha.length; k++) alpha[k] = rgba[k * 4 + 3];
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, cell.u, cell.v, w, h, gl.RED, gl.UNSIGNED_BYTE, alpha);
    return cell;
  }

  private clearAtlas() {
    const atlas = this.atlas;
    atlas.cells.clear();
    atlas.x = atlas.y = atlas.row = 0;
  }

  private measure(font: string, text: string): Glyphs {
    const id = `${font}|${text}`;
    let glyphs = this.glyphs.get(id);
    if (!glyphs) {
      const ctx = this.scratch;
      ctx.font = font;
      const chars = Array.from(text);
      // Each letter's width is how much it adds to the text before it, which keeps the font's kerning.
      const widths: number[] = [];
      let before = 0, prefix = "";
      for (const c of chars) {
        prefix += c;
        const width = ctx.measureText(prefix).width;
        widths.push(width - before);
        before = width;
      }
      glyphs = { chars, widths, width: before };
      this.glyphs.set(id, glyphs);
    }
    return glyphs;
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }
}

/** A letter, or a whole name, centred at a screen point and turned by `angle`. */
type Placed = { char: string; x: number; y: number; angle: number; width: number };

/**
 * The letters of `glyphs` at `unit` scale set along a quadratic Bézier, centred and spaced to
 * span `span` pixels. None when the curve is too short for them.
 */
function layout(glyphs: Glyphs, unit: number, span: number, p0: [number, number], p1: [number, number], p2: [number, number]): Placed[] | null {
  const STEPS = 32;
  const points: [number, number][] = [];
  const lengths = [0];
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS, u = 1 - t;
    points.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
    if (i > 0) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  const total = lengths[STEPS];
  const natural = glyphs.width * unit;
  const gap = glyphs.chars.length > 1 ? (span - natural) / (glyphs.chars.length - 1) : 0;
  // A name longer than its curve runs on along the curve's ends.
  let at = (total - span) / 2;
  const placed: Placed[] = [];
  let k = 0;
  for (let c = 0; c < glyphs.chars.length; c++) {
    const width = glyphs.widths[c] * unit;
    const middle = at + width / 2;
    while (k < STEPS - 1 && lengths[k + 1] < middle) k++;
    const seg = lengths[k + 1] - lengths[k] || 1;
    const f = (middle - lengths[k]) / seg;
    const [ax, ay] = points[k], [bx, by] = points[k + 1];
    placed.push({ char: glyphs.chars[c], x: ax + (bx - ax) * f, y: ay + (by - ay) * f, angle: Math.atan2(by - ay, bx - ax), width });
    at += width + gap;
  }
  return total > 0 ? placed : null;
}

/** The rectangle a letter covers: its width, and its body's height without ascenders and descenders. */
function glyphRect(g: Placed, size: number): Rect {
  return { x: g.x, y: g.y, hw: g.width / 2 + size * 0.04, hh: size * 0.34, c: Math.cos(g.angle), s: Math.sin(g.angle) };
}

/** Letters already drawn, bucketed in a grid by the box around each. */
class Occupied {
  private cells = new Map<number, Rect[]>();
  private static CELL = 48;

  private *keys(r: Rect) {
    const C = Occupied.CELL;
    const ex = Math.abs(r.c) * r.hw + Math.abs(r.s) * r.hh;
    const ey = Math.abs(r.s) * r.hw + Math.abs(r.c) * r.hh;
    for (let x = Math.floor((r.x - ex) / C); x <= Math.floor((r.x + ex) / C); x++) {
      for (let y = Math.floor((r.y - ey) / C); y <= Math.floor((r.y + ey) / C); y++) yield (x + 4096) * 8192 + (y + 4096);
    }
  }

  hits(r: Rect): boolean {
    for (const key of this.keys(r)) {
      for (const o of this.cells.get(key) ?? []) if (overlap(r, o)) return true;
    }
    return false;
  }

  add(r: Rect) {
    for (const key of this.keys(r)) {
      const list = this.cells.get(key);
      if (list) list.push(r);
      else this.cells.set(key, [r]);
    }
  }
}

/** Whether two turned rectangles overlap: no axis of either separates them. */
export function overlap(a: Rect, b: Rect): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  // Tested axis by axis without building arrays: this runs for every letter tried each frame.
  return !(
    separates(a, b, dx, dy, a.c, a.s) || separates(a, b, dx, dy, -a.s, a.c) ||
    separates(a, b, dx, dy, b.c, b.s) || separates(a, b, dx, dy, -b.s, b.c)
  );
}

/** Whether the axis (`ax`, `ay`) separates `a` and `b`, which are (`dx`, `dy`) apart. */
function separates(a: Rect, b: Rect, dx: number, dy: number, ax: number, ay: number): boolean {
  const reachA = a.hw * Math.abs(a.c * ax + a.s * ay) + a.hh * Math.abs(-a.s * ax + a.c * ay);
  const reachB = b.hw * Math.abs(b.c * ax + b.s * ay) + b.hh * Math.abs(-b.s * ax + b.c * ay);
  return Math.abs(dx * ax + dy * ay) > reachA + reachB;
}
