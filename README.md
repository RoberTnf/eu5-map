# eu5-map

The Europa Universalis V map renderer from [eu5db.com](https://eu5db.com), on its own: a WebGL 2
shader that draws the game's location bitmap with smooth, antialiased borders, plus country and
location names placed the way the game places them, rivers, and pan/zoom/pinch controls. No
framework and no runtime dependencies.

**This is a snapshot, not a maintained library.** Copy it into your project and change it as you
like. eu5db keeps changing its own copy, and its data files, without regard to this one; there
are no releases, versions or compatibility promises.

## Try it

```sh
pnpm install
node scripts/snapshot.mjs https://eu5db.com/data/<version>/map demo/public
pnpm dev
```

`<version>` is the folder eu5db's map loads for a game version (see the network tab on
eu5db.com/map). The demo paints who owns what at the 1337 start.

## Data

`scripts/snapshot.mjs` turns one game version's map data from an eu5db build into four files.
Host them yourself: eu5db's files change name and format between builds.

- `locations.bin.gz`: the location bitmap. Each pixel is a location index, run-length encoded
  (`decodeBitmap` in `src/data.ts`). It is half the game's resolution.
- `map.json`: per location index, its key (`rome`), province, kind and size, plus the map's size
  and the game's country colours (`MapInfo` in `src/data.ts`).
- `rivers.json`: river lines in game pixels.
- `owners.json`: location key → owner at the start date, for the demo.

When the game updates, run the snapshot again over the new version's data.

## Use

```ts
import { attachGestures, loadMap, MapCamera, MapRenderer, paintOwners } from "eu5-map";

const data = await loadMap("/map-data");
const renderer = new MapRenderer(canvas, data.bitmap, data.info.keys.length, data.info.wrapX);
const camera = new MapCamera(canvas, renderer, { width: data.bitmap.width, height: data.bitmap.height });
camera.fitBox({ x0: 0, y0: 0, x1: data.bitmap.width, y1: data.bitmap.height });
attachGestures(canvas, data, camera, { onHover: (i) => renderer.update({ hovered: i }) });

// Any location key → country tag map, from a save for example.
renderer.setPainting(paintOwners(data, owners), data.provinces);
```

The renderer draws whatever `Painting` it is given: a colour and a border group per location.
Locations in different groups get a thick border between them. `paint(data, valueOf, colorOf)`
builds one from any value per location (culture, religion, a subject's overlord…), and
`painting.overlay` adds a second one as stripes. See `demo/main.ts` for names and rivers.

The canvas needs a size from CSS and `touch-action: none`. Call `camera.move(camera.camera)` when
it resizes.

## Files

- `src/renderer.ts`: the map shader and `MapRenderer`.
- `src/paint.ts`: colours and border groups per location.
- `src/labels.ts`, `labelLayer.ts`, `namePlacer.ts`, `nameWorker.ts`, `rows.ts`: names, placed
  in a worker and drawn with WebGL.
- `src/rivers.ts`: rivers.
- `src/camera.ts`, `controls.ts`: the camera and gestures.
- `src/data.ts`: loading the data files.

## License

MIT; see `LICENSE`.
