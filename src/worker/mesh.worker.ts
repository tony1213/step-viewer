/// <reference lib="es2022" />
/** Helper of occt.worker: meshes single-part STEP files cut out of a large assembly. */
import occtimportjs, { type OcctModule } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { meshPartFile } from '../core/step-split';
import type { MeshJob, MeshReply } from './protocol';

const scope = self as unknown as Worker;
let occt: Promise<OcctModule> | null = null;

self.onmessage = async (ev: MessageEvent<MeshJob>) => {
  const { id, file, params } = ev.data;
  let reply: MeshReply;
  const transfer = new Set<ArrayBuffer>();
  try {
    occt ??= occtimportjs({ locateFile: () => wasmUrl });
    const meshes = meshPartFile(await occt, file, params);
    for (const m of meshes) {
      for (const a of [m.position, m.normal, m.index, m.faceRanges, m.faceColors, m.edges]) if (a) transfer.add(a.buffer as ArrayBuffer);
    }
    reply = { id, meshes };
  } catch (e) {
    occt = null; // unusable after an abort (e.g. out of memory): the next part gets a fresh instance
    reply = { id, meshes: [], error: e instanceof Error ? e.message : String(e) };
  }
  scope.postMessage(reply, [...transfer]);
};
