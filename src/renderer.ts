import { NO_LOCATION, type Bitmap } from "./data";
import { LabelLayer } from "./labelLayer";
import { GROUP_EMPTY, GROUP_IMPASSABLE, GROUP_WATER, OVERLAY_GROUP, type Painting } from "./paint";
import { RiverLayer, type RiverGeometry } from "./rivers";

/** What part of the map is on screen: the bitmap pixel at the centre and screen pixels per bitmap pixel. */
export type Camera = { x: number; y: number; scale: number };

/** Per-location textures are rows of this many locations. */
const ROW = 256;

const VERTEX = `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;

// Every screen pixel weighs the 4×4 bitmap pixels around it with a cubic filter and takes the
// location with the most weight, so edges follow smooth curves instead of the bitmap's stairs.
// Where two locations' weights are equal is the edge between them; the weights' gradient gives a
// pixel's distance to it, which antialiases the fill and draws borders as lines of a set width.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;

uniform usampler2D ids;
uniform sampler2D palette;
// A second mode's colour, drawn as stripes where its alpha is set.
uniform sampler2D overlay;
uniform usampler2D groups;
uniform usampler2D chosen;
uniform ivec2 size;
uniform vec2 center;
uniform float scale;
uniform float pixel;
uniform vec2 viewport;
uniform int hovered;
// 0: nothing selected, 1: a location, 2: a division. Either dims the rest.
uniform int selection;
// A selected location's centre (texture pixels) and its radius, for the ring around it.
uniform vec2 marker;
uniform float markerRadius;
// A legend entry: a border group, or an overlay one plus OVERLAY.
uniform int highlight;
uniform float provinceBorders;
uniform float locationBorders;
uniform vec3 outside;
out vec4 color;

const int NONE = ${NO_LOCATION};
const uint WATER = ${GROUP_WATER}u;
const uint IMPASSABLE = ${GROUP_IMPASSABLE}u;
const uint EMPTY = ${GROUP_EMPTY}u;
const int OVERLAY = ${OVERLAY_GROUP};

// How much of this pixel is an overlay stripe; main sets it.
float stripe = 0.0;

int idAt(vec2 p) {
  ivec2 t = ivec2(floor(p));
  if (t.y < 0 || t.y >= size.y) return -1;
  t.x = ((t.x % size.x) + size.x) % size.x;
  return int(texelFetch(ids, t, 0).r);
}

ivec2 row(int id) { return ivec2(id % ${ROW}, id / ${ROW}); }

// .r: border group, .g: province, .b: overlay group.
uvec3 groupOf(int id) { return id < 0 || id == NONE ? uvec3(WATER, 0u, WATER) : texelFetch(groups, row(id), 0).rgb; }

bool lit(uvec3 g) { return highlight >= OVERLAY ? int(g.b) == highlight - OVERLAY : int(g.r) == highlight; }

bool isChosen(int id) { return id >= 0 && id != NONE && texelFetch(chosen, row(id), 0).r > 0u; }

bool isLit(int id) { return id >= 0 && lit(groupOf(id)); }

float border(int id, uvec3 g, int other) {
  if (other == id || other < 0) return 0.0;
  uvec3 h = groupOf(other);
  // Water and wasteland have no inner borders.
  if (g.r == h.r && (g.r == WATER || g.r == IMPASSABLE)) return 0.0;
  if (g.r != h.r && !(g.r == EMPTY && h.r == EMPTY)) return 0.75;
  if (g.r == WATER || h.r == WATER) return 0.0;
  if (g.g != h.g) return provinceBorders;
  return locationBorders;
}

// Weights of the four samples around t, and their derivatives. Catmull-Rom passes through every
// sample, so even a one-pixel location keeps its place; zoomed out it blends into a B-spline,
// which smooths over the several bitmap pixels under each screen pixel.
void weights(float t, float soft, out vec4 w, out vec4 d) {
  float t2 = t * t, t3 = t2 * t, u = 1.0 - t;
  vec4 cr = 0.5 * vec4(-t3 + 2.0 * t2 - t, 3.0 * t3 - 5.0 * t2 + 2.0, -3.0 * t3 + 4.0 * t2 + t, t3 - t2);
  vec4 crd = 0.5 * vec4(-3.0 * t2 + 4.0 * t - 1.0, 9.0 * t2 - 10.0 * t, -9.0 * t2 + 8.0 * t + 1.0, 3.0 * t2 - 2.0 * t);
  vec4 bs = vec4(u * u * u, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
  vec4 bsd = vec4(-0.5 * u * u, 1.5 * t2 - 2.0 * t, -1.5 * t2 + t + 0.5, 0.5 * t2);
  w = mix(cr, bs, soft);
  d = mix(crd, bsd, soft);
}

vec3 fill(int id) {
  if (id < 0) return outside;
  vec3 c = id == NONE ? vec3(0.36, 0.5, 0.65) : texelFetch(palette, row(id), 0).rgb;
  if (id != NONE) {
    vec4 o = texelFetch(overlay, row(id), 0);
    c = mix(c, o.rgb, o.a * stripe);
  }
  uvec3 g = groupOf(id);
  float grey = dot(c, vec3(0.3, 0.59, 0.11));
  // A legend entry picked out: the rest turns a flat grey, so dark and grey categories show too.
  if (highlight >= 0 && !lit(g) && g.r != WATER) c = vec3(mix(grey, 0.55, 0.7)) * 0.7;
  // Everything but the selection fades to grey, water less so.
  if (selection > 0 && !isChosen(id)) c = g.r == WATER ? c * 0.8 : mix(c, vec3(grey), 0.7) * 0.7;
  if (id == hovered) c = mix(c, vec3(1.0), 0.35);
  return c;
}

// A white line inside where a field crosses one half and a dark one outside, each two pixels wide.
// d is the signed distance to that crossing in device pixels, positive inside.
vec3 outline(vec3 c, float d) {
  float w = pixel * 2.0;
  c = mix(c, vec3(0.08, 0.06, 0.05), clamp(0.5 - d, 0.0, 1.0) * clamp(w + 0.5 + d, 0.0, 1.0));
  return mix(c, vec3(1.0), clamp(0.5 + d, 0.0, 1.0) * clamp(w + 0.5 - d, 0.0, 1.0));
}

void main() {
  vec2 frag = vec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y);
  vec2 p = center + (frag - viewport * 0.5) / scale;
  // Overlay stripes run diagonally with the map, a set width on screen: 40% of every 9 CSS pixels.
  float u = (p.x - p.y) * scale / (pixel * 9.0);
  float du = fwidth(u);
  stripe = 1.0 - smoothstep(0.2 - du, 0.2 + du, abs(fract(u) - 0.5));
  if (p.y < 0.0 || p.y >= float(size.y)) { color = vec4(outside, 1.0); return; }

  // Zoomed out, the samples spread to cover the bitmap pixels under this one.
  float stride = max(1.0, 1.0 / scale);
  float soft = clamp(2.0 - 2.0 * scale, 0.0, 1.0);
  vec2 q = p / stride - 0.5;
  vec2 base = floor(q);
  vec4 wx, dx, wy, dy;
  weights(q.x - base.x, soft, wx, dx);
  weights(q.y - base.y, soft, wy, dy);
  // A weight's change per device pixel, from its change per sample.
  float perPixel = 1.0 / (stride * scale);
  int s[16];
  for (int n = 0; n < 16; n++) s[n] = idAt((base + vec2(n % 4, n / 4) - 0.5) * stride);

  // The two heaviest of the four nearest locations, and each one's weight and gradient.
  int a = -2, b = -2;
  float wa = -1e9, wb = -1e9;
  vec2 ga = vec2(0.0), gb = vec2(0.0);
  for (int k = 0; k < 4; k++) {
    int id = s[(1 + k / 2) * 4 + 1 + k % 2];
    if (id == a || id == b) continue;
    float w = 0.0;
    vec2 g = vec2(0.0);
    for (int n = 0; n < 16; n++) {
      if (s[n] != id) continue;
      int i = n % 4, j = n / 4;
      w += wx[i] * wy[j];
      g += vec2(dx[i] * wy[j], wx[i] * dy[j]);
    }
    if (w > wa) { b = a; wb = wa; gb = ga; a = id; wa = w; ga = g; }
    else if (w > wb) { b = id; wb = w; gb = g; }
  }

  vec3 c = fill(a);
  if (b != -2) {
    // Device pixels from the edge between a and b.
    float d = (wa - wb) / max(length(ga - gb) * perPixel, 1e-6);
    c = mix(fill(b), c, clamp(0.5 + d, 0.0, 1.0));
    // Borders are lines centred on the edge: a pixel and a half between countries, one within.
    float edge = border(a, groupOf(a), b);
    float half_ = pixel * (edge >= 0.75 ? 0.75 : 0.5);
    c = mix(c, vec3(0.1, 0.08, 0.06), edge * clamp(half_ + 0.5 - d, 0.0, 1.0));
  }

  if (selection > 0 || highlight >= 0) {
    float wc = 0.0, wl = 0.0;
    vec2 gc = vec2(0.0), gl = vec2(0.0);
    for (int n = 0; n < 16; n++) {
      int i = n % 4, j = n / 4;
      float w = wx[i] * wy[j];
      vec2 g = vec2(dx[i] * wy[j], wx[i] * dy[j]);
      if (selection > 0 && isChosen(s[n])) { wc += w; gc += g; }
      if (highlight >= 0 && isLit(s[n])) { wl += w; gl += g; }
    }
    if (selection > 0) c = outline(c, (wc - 0.5) / max(length(gc) * perPixel, 1e-6));
    // A legend entry is outlined like a selection, on the edges of its category.
    if (highlight >= 0) c = outline(c, (wl - 0.5) / max(length(gl) * perPixel, 1e-6));
  }

  // A ring around a selected location, so a small one stands out at any zoom. It fades away
  // once the location itself is large on screen.
  if (selection == 1) {
    vec2 d = p - marker;
    d.x = mod(d.x + float(size.x) * 0.5, float(size.x)) - float(size.x) * 0.5;
    float r = length(d) * scale / pixel;
    float own = markerRadius * scale / pixel;
    float ring = max(own + 8.0, 16.0);
    float fade = 1.0 - smoothstep(40.0, 90.0, own);
    float band = abs(r - ring);
    if (band < 1.5) c = mix(c, vec3(1.0), fade);
    else if (band < 3.0) c = mix(c, vec3(0.08, 0.06, 0.05), fade);
  }
  color = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || `shader failed to compile${gl.isContextLost() ? " (context lost)" : ""}`);
  return shader;
}

/** Every other pixel, for devices whose textures can't hold the whole bitmap. */
function halve(bitmap: Bitmap): Bitmap {
  const width = bitmap.width >> 1;
  const height = bitmap.height >> 1;
  const pixels = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = bitmap.pixels[2 * y * bitmap.width + 2 * x];
  return { width, height, pixels };
}

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private textures: WebGLTexture[] = [];
  private palette: WebGLTexture;
  private overlay: WebGLTexture;
  private groups: WebGLTexture;
  private chosen: WebGLTexture;
  /** Bitmap pixels per texture pixel: 2 when the texture had to be halved. */
  private shrink = 1;
  private rows: number;
  private frame = 0;
  private state = { camera: { x: 0, y: 0, scale: 1 }, hovered: -1, highlight: -1, rivers: false };
  /** 0: nothing, 1: a location, 2: a division; see the shader. */
  private selection = 0;
  /** Centre and radius of a selected location, in bitmap pixels. */
  private marker = { x: 0, y: 0, radius: 0 };
  private rivers: { layer: RiverLayer; perGame: number; wrap: number } | null = null;
  /** Names over the map and rivers. */
  readonly labels: LabelLayer;
  outside: [number, number, number] = [0.9, 0.87, 0.8];

  static supported(): boolean {
    try {
      return !!document.createElement("canvas").getContext("webgl2");
    } catch {
      return false;
    }
  }

  constructor(
    private canvas: HTMLCanvasElement,
    bitmap: Bitmap,
    locations: number,
    wrap: boolean,
  ) {
    const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("WebGL 2 is not available");
    this.gl = gl;
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "shader failed to link");
    this.program = program;
    gl.useProgram(program);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    let ids = bitmap;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    while (ids.width > max) {
      ids = halve(ids);
      this.shrink *= 2;
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.texture(0, "ids", gl.R16UI, ids.width, ids.height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ids.pixels);
    this.rows = Math.ceil(locations / ROW);
    this.palette = this.texture(1, "palette", gl.RGBA8, ROW, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(ROW * this.rows * 4));
    this.groups = this.texture(2, "groups", gl.RGBA16UI, ROW, this.rows, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(ROW * this.rows * 4));
    this.chosen = this.texture(3, "chosen", gl.R8UI, ROW, this.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(ROW * this.rows));
    this.overlay = this.texture(4, "overlay", gl.RGBA8, ROW, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(ROW * this.rows * 4));
    gl.uniform2i(this.uniform("size"), ids.width, ids.height);
    this.labels = new LabelLayer(gl, (type, source) => compile(gl, type, source), { width: bitmap.width, height: bitmap.height, wrap });
    this.labels.request = () => this.request();
  }

  private uniform(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    return this.uniforms.get(name)!;
  }

  private texture(unit: number, name: string, internal: number, width: number, height: number, format: number, type: number, data: ArrayBufferView): WebGLTexture {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    this.textures.push(texture);
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    for (const param of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, param, gl.NEAREST);
    for (const param of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, param, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    gl.uniform1i(this.uniform(name), unit);
    return texture;
  }

  /** Colours and border groups per location, from `paint`. */
  setPainting(painting: Painting, provinces: Uint16Array) {
    const gl = this.gl;
    const colors = new Uint8Array(ROW * this.rows * 4);
    colors.set(painting.colors);
    const overlay = new Uint8Array(ROW * this.rows * 4);
    if (painting.overlay) overlay.set(painting.overlay.colors);
    const groups = new Uint16Array(ROW * this.rows * 4);
    for (let i = 0; i < painting.groups.length; i++) {
      groups[i * 4] = painting.groups[i];
      groups[i * 4 + 1] = provinces[i];
      groups[i * 4 + 2] = painting.overlay?.groups[i] ?? GROUP_WATER;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, colors);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.groups);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW, this.rows, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, groups);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.overlay);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, overlay);
    this.request();
  }

  /**
   * Outline these locations and dim the rest: one location, ringed by `marker` (its centre and
   * radius in bitmap pixels), or every location of a division.
   */
  setSelection(indices: number[], marker: { x: number; y: number; radius: number } | null) {
    const gl = this.gl;
    const chosen = new Uint8Array(ROW * this.rows);
    for (const i of indices) chosen[i] = 1;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.chosen);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ROW, this.rows, gl.RED_INTEGER, gl.UNSIGNED_BYTE, chosen);
    this.selection = indices.length === 0 ? 0 : marker ? 1 : 2;
    if (marker) this.marker = marker;
    this.request();
  }

  /**
   * Rivers to draw over the map. `perGame` is bitmap pixels per game pixel, the rivers' unit;
   * `wrap` the width of the world in game pixels when it wraps around, else 0.
   */
  setRivers(geometry: RiverGeometry, perGame: number, wrap: number) {
    this.rivers?.layer.destroy();
    this.rivers = { layer: new RiverLayer(this.gl, geometry, (type, source) => compile(this.gl, type, source)), perGame, wrap };
    this.request();
  }

  update(state: Partial<MapRenderer["state"]>) {
    this.state = { ...this.state, ...state };
    this.request();
  }

  request() {
    if (!this.frame) this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    this.frame = 0;
    const { gl, canvas } = this;
    // The map shader runs once per backing-store pixel. Capping DPR on narrow screens keeps
    // high-density phones from multiplying that work across several million pixels per frame.
    const deviceRatio = window.devicePixelRatio || 1;
    const ratio = Math.min(deviceRatio, canvas.clientWidth <= 820 ? 1.25 : 2);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    const { camera, hovered, highlight } = this.state;
    // The camera is in bitmap pixels and CSS pixels; the shader works in texture and device pixels.
    const scale = camera.scale * ratio * this.shrink;
    gl.uniform2f(this.uniform("center"), camera.x / this.shrink, camera.y / this.shrink);
    gl.uniform1f(this.uniform("scale"), scale);
    gl.uniform1f(this.uniform("pixel"), ratio);
    gl.uniform2f(this.uniform("viewport"), width, height);
    gl.uniform1i(this.uniform("hovered"), hovered);
    gl.uniform1i(this.uniform("selection"), this.selection);
    gl.uniform2f(this.uniform("marker"), this.marker.x / this.shrink, this.marker.y / this.shrink);
    gl.uniform1f(this.uniform("markerRadius"), this.marker.radius / this.shrink);
    gl.uniform1i(this.uniform("highlight"), highlight);
    // Finer borders appear as the map is zoomed in.
    gl.uniform1f(this.uniform("provinceBorders"), fade(camera.scale, 0.35, 0.9) * 0.45);
    gl.uniform1f(this.uniform("locationBorders"), fade(camera.scale, 1.2, 3) * 0.22);
    gl.uniform3f(this.uniform("outside"), ...this.outside);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (this.rivers && this.state.rivers) {
      const { layer, perGame, wrap } = this.rivers;
      layer.draw({
        center: [camera.x / perGame, camera.y / perGame],
        scale: camera.scale * ratio * perGame,
        ratio,
        viewport: [width, height],
        wrap,
        zoom: camera.scale,
      });
    }
    this.labels.draw(camera, ratio, [width, height]);
  }

  /** Frees the GPU memory. The context stays usable: the canvas may get a new renderer. */
  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    const gl = this.gl;
    this.rivers?.layer.destroy();
    this.rivers = null;
    this.labels.destroy();
    for (const texture of this.textures) gl.deleteTexture(texture);
    gl.deleteProgram(this.program);
  }
}

/** 0 below `from`, 1 above `to`, smooth between. */
function fade(value: number, from: number, to: number): number {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}
