// Makes the map's data files from an eu5db build of one game version.
//
//   node scripts/snapshot.mjs <source> <out>
//
// <source> is the version's map folder, a local path or a URL
// (https://eu5db.com/data/<version>/map). It writes to <out>:
//   map.json          locations by bitmap index, see `MapInfo` in src/data.ts
//   locations.bin.gz  the location bitmap, copied
//   rivers.json       copied
//   owners.json       location → owner at the game's start date, for the demo
// Copy the result to your own hosting: the source's files and their format change between builds.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [source, out] = process.argv.slice(2);
if (!source || !out) {
  console.error("usage: node scripts/snapshot.mjs <source> <out>");
  process.exit(1);
}
const remote = /^https?:\/\//.test(source);

async function read(name) {
  if (!remote) return readFile(join(source, name));
  const response = await fetch(`${source.replace(/\/$/, "")}/${name}`);
  if (!response.ok) throw new Error(`${name}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
const readJson = async (name) => JSON.parse((await read(name)).toString("utf8"));

const geography = await readJson("geography.json");
const columns = geography.locations;
const water = new Set(geography.waterTopographies);
const kind = columns.kind.map((k, i) => (k === "impassable_mountains" && water.has(columns.topography[i]) ? "impassable_sea" : k));
const info = {
  width: geography.width,
  height: geography.height,
  wrapX: geography.wrapX,
  keys: columns.keys,
  province: columns.province,
  kind,
  center: columns.center.map((c) => c ?? null),
  pixels: columns.pixels,
  countryColors: geography.colors.country ?? {},
};

await mkdir(out, { recursive: true });
await writeFile(join(out, "map.json"), JSON.stringify(info));
await writeFile(join(out, "locations.bin.gz"), await read("locations.bin.gz"));
await writeFile(join(out, "rivers.json"), await read("rivers.json"));

// The start scenario's file is named by its date: START=<date> picks another.
const start = process.env.START ?? "1337.4.1";
const scenario = await readJson(`${start}.json`);
const owners = Object.fromEntries(Object.entries(scenario.locations).flatMap(([key, l]) => (l.owner ? [[key, l.owner]] : [])));
await writeFile(join(out, "owners.json"), JSON.stringify(owners));
console.log(`${info.keys.length} locations, ${Object.keys(owners).length} owned at ${start} → ${out}`);
