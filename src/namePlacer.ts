import type { MapData } from "./data";
import type { NameRequest, Placement } from "./labels";
import type { NameMessage, NameReply } from "./nameWorker";

/** The map's names placed by a worker (`nameWorker.ts`), which keeps its own copy of the map. */
export class NamePlacer {
  private worker = new Worker(new URL("./nameWorker.ts", import.meta.url), { type: "module" });
  private waiting = new Map<number, (placements: Placement[]) => void>();
  private next = 0;

  constructor(data: MapData) {
    const { runs, ...bitmap } = data.bitmap;
    // The run-length file is a few megabytes; the pixels, only where there is no file, tens.
    this.post({ type: "map", runs: runs ?? null, bitmap: runs ? null : bitmap, count: data.info.keys.length, wrap: data.info.wrapX });
    this.worker.onmessage = (event: MessageEvent<NameReply>) => {
      this.waiting.get(event.data.id)?.(event.data.placements);
      this.waiting.delete(event.data.id);
    };
  }

  place(request: NameRequest): Promise<Placement[]> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.post({ type: "place", id, request });
    });
  }

  destroy() {
    this.worker.terminate();
    this.waiting.clear();
  }

  private post(message: NameMessage) {
    this.worker.postMessage(message);
  }
}
