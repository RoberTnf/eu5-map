/// <reference lib="webworker" />
import { measureShapes, placeNames, type NameRequest, type Placement, type Shapes } from "./labels";
import { rowsFromRuns, rowsOf, type Rows } from "./rows";
import type { Bitmap } from "./data";

/**
 * Places the map's names off the main thread: measuring every location's shape takes a pass over
 * the whole bitmap, and placing a mode's names a search through every blob, which together froze
 * phones for a second.
 */
export type NameMessage =
  | { type: "map"; runs: ArrayBuffer | null; bitmap: Bitmap | null; count: number; wrap: boolean }
  | { type: "place"; id: number; request: NameRequest };
export type NameReply = { id: number; placements: Placement[] };

let map: { rows: Rows; shapes: Shapes; wrap: boolean } | null = null;

self.onmessage = (event: MessageEvent<NameMessage>) => {
  const message = event.data;
  if (message.type === "map") {
    const rows = message.runs ? rowsFromRuns(message.runs) : rowsOf(message.bitmap!);
    map = { rows, shapes: measureShapes(rows, message.count, message.wrap), wrap: message.wrap };
    return;
  }
  const placements = map ? placeNames(map.rows, map.shapes, map.wrap, message.request) : [];
  self.postMessage({ id: message.id, placements } satisfies NameReply);
};
