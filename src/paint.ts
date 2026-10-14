import type { MapData } from "./data";

export type Rgb = readonly [number, number, number];

/** How a location is drawn when nothing paints it. */
export const WATER: Rgb = [0x5d, 0x80, 0xa6];
export const IMPASSABLE: Rgb = [0x84, 0x81, 0x7b];
export const DEEP_WATER: Rgb = [0x2c, 0x42, 0x66];
export const EMPTY: Rgb = [0xcf, 0xc6, 0xb4];

/** Border groups with a meaning of their own; categories count up from 0. */
export const GROUP_WATER = 0xffff;
export const GROUP_IMPASSABLE = 0xfffe;
export const GROUP_EMPTY = 0xfffd;

/** `group` is the category's border group. */
export type Category = { key: string; color: Rgb; pixels: number; locations: number; group: number };

/**
 * What the renderer draws. Locations in different groups get a thick border between them, and
 * a highlight (`MapRenderer.update({ highlight })`) outlines one group.
 */
export type Painting = {
  /** RGBA per location index. */
  colors: Uint8Array;
  /** Border group per location index: a category index or one of the `GROUP_` values. */
  groups: Uint16Array;
  /** Most pixels first. */
  categories: Category[];
  /** A second painting drawn as stripes over this one, where its alpha is set. */
  overlay?: Overlay;
};

export type Overlay = Omit<Painting, "overlay">;

/** Legend groups of the overlay are offset by this, so one number names either painting's. */
export const OVERLAY_GROUP = 0x10000;

export function hexColor(hex: string | undefined): Rgb | undefined {
  if (!hex || hex.length !== 6) return undefined;
  const n = Number.parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A stable, well-spread colour for keys with none. */
export function keyColor(key: string): Rgb {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193) >>> 0;
  const hue = (hash % 360) / 360;
  const saturation = 0.35 + ((hash >>> 9) % 30) / 100;
  const lightness = 0.52 + ((hash >>> 17) % 22) / 100;
  return hsl(hue, saturation, lightness);
}

function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Colours and border groups of every location from a value per location: `valueOf(index)` gives
 * its category key (a country tag, say) or undefined for none, and `colorOf(key)` its colour.
 * Water and impassable land are drawn as the game does, whatever their value.
 */
export function paint(data: MapData, valueOf: (index: number) => string | undefined, colorOf: (key: string) => Rgb | undefined): Painting {
  const { kind } = data.info;
  const n = kind.length;
  const colors = new Uint8Array(n * 4);
  const groups = new Uint16Array(n);
  const set = (i: number, color: Rgb, group: number) => {
    colors.set([color[0], color[1], color[2], 255], i * 4);
    groups[i] = group;
  };
  const categories: Category[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    if (kind[i] === "sea_zone" || kind[i] === "lake") set(i, WATER, GROUP_WATER);
    else if (kind[i] === "impassable_sea") set(i, DEEP_WATER, GROUP_WATER);
    else if (kind[i] === "impassable_mountains") set(i, IMPASSABLE, GROUP_IMPASSABLE);
    else {
      const key = valueOf(i);
      if (key === undefined) {
        set(i, EMPTY, GROUP_EMPTY);
        continue;
      }
      let group = byKey.get(key);
      if (group === undefined) {
        group = categories.length;
        byKey.set(key, group);
        categories.push({ key, color: colorOf(key) ?? keyColor(key), pixels: 0, locations: 0, group });
      }
      categories[group].pixels += data.info.pixels[i];
      categories[group].locations += 1;
      set(i, categories[group].color, group);
    }
  }
  categories.sort((a, b) => b.pixels - a.pixels || a.key.localeCompare(b.key));
  return { colors, groups, categories };
}

/** The political map: `owners` maps location keys to country tags, coloured by the game's colours. */
export function paintOwners(data: MapData, owners: Record<string, string | undefined>): Painting {
  const { keys, countryColors } = data.info;
  return paint(data, (i) => owners[keys[i]], (tag) => hexColor(countryColors[tag]));
}
