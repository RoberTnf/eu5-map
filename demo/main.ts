import { attachGestures, loadMap, loadRivers, MapCamera, MapRenderer, NamePlacer, nameRequest, paintOwners, type Name } from "../src";

// The files `npm run snapshot` writes into demo/public.
const DATA = "";

const canvas = document.querySelector<HTMLCanvasElement>("#map")!;
const hoverText = document.querySelector<HTMLDivElement>("#hover")!;

const [data, owners] = await Promise.all([loadMap(DATA), fetch(`${DATA}/owners.json`).then((r) => r.json() as Promise<Record<string, string>>)]);

const renderer = new MapRenderer(canvas, data.bitmap, data.info.keys.length, data.info.wrapX);
renderer.outside = [0xf4 / 255, 0xef / 255, 0xe4 / 255];
renderer.setPainting(paintOwners(data, owners), data.provinces);

const camera = new MapCamera(canvas, renderer, { width: data.bitmap.width, height: data.bitmap.height });
// Europe, in game pixels.
const s = data.shrink;
camera.fitBox({ x0: 7800 * s, y0: 1500 * s, x1: 10200 * s, y1: 3400 * s });
new ResizeObserver(() => camera.move(camera.camera)).observe(canvas);

attachGestures(canvas, data, camera, {
  onHover: (index) => {
    renderer.update({ hovered: index });
    const key = data.info.keys[index];
    hoverText.textContent = key ? `${key}${owners[key] ? ` · ${owners[key]}` : ""}` : "";
  },
  onTap: (index) => console.log("tapped", data.info.keys[index]),
});

// Rivers arrive after the map: it is usable without them.
loadRivers(DATA).then((rivers) => {
  renderer.setRivers(rivers, data.shrink, data.info.wrapX ? data.info.width : 0);
  renderer.update({ rivers: true });
});

// Names: locations close up, countries in between and far out. The text here is the tag; give
// it your countries' names.
const placer = new NamePlacer(data);
const [locations, countries] = await Promise.all([
  placer.place(nameRequest(data, (i) => data.info.keys[i], true)),
  placer.place(nameRequest(data, (i) => owners[data.info.keys[i]])),
]);
const named = (list: typeof locations): Name[] => list.map((p) => ({ ...p, text: p.key }));
renderer.labels.setNames([named(locations), named(countries), named(countries)]);
renderer.request();
