/// <reference lib="es2022" />
import occtimportjs, { type OcctModule } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { MESH_PARAMS } from '../core/mesh-params';
import { processOcctResult, type PipelineOutput } from '../core/pipeline';
import { importSplit, inProcessMesher, planSplit, type Mesher } from '../core/step-split';
import { parseStepStructure, type StepStructure } from '../core/step-structure';
import type { MeshData, OcctResult } from '../core/types';
import type { MeshJob, MeshReply, WorkerRequest, WorkerResponse } from './protocol';

/**
 * OpenCascade gets a WebAssembly heap of at most 2 GB, enough for roughly 40–60 MB of STEP
 * (about 35 MB of heap per MB). Larger STEP files are read part by part (core/step-split.ts),
 * which is also faster (parallel, repeated parts meshed once).
 */
const SPLIT_ABOVE = 30 * 1024 * 1024;
/** Files up to this size are still read as a whole when some occurrence placement cannot be read. */
const WHOLE_MAX = 60 * 1024 * 1024;

const scope = self as unknown as Worker;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);
const createOcct = () => occtimportjs({ locateFile: () => wasmUrl });

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/memory|OOM|enlarge/i.test(msg)) return '内存不足：模型太大，浏览器无法完成解析。';
  return msg;
}

function read(occt: OcctModule, format: WorkerRequest['format'], bytes: Uint8Array): OcctResult {
  const params = { ...MESH_PARAMS };
  switch (format) {
    case 'step':
      return occt.ReadStepFile(bytes, params) as unknown as OcctResult;
    case 'iges':
      return occt.ReadIgesFile(bytes, params) as unknown as OcctResult;
    case 'brep':
      return occt.ReadBrepFile(bytes, params) as unknown as OcctResult;
  }
}

/** Parts are meshed by helper workers (one OpenCascade each); memory per helper stays well below 1 GB. */
function workerMesher(parts: number): Mesher | null {
  if (typeof Worker === 'undefined' || parts < 2) return null;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const count = Math.min(4, parts, Math.max(1, (nav.hardwareConcurrency || 2) - 1), Math.max(1, Math.floor((nav.deviceMemory ?? 8) / 2)));
  if (count < 2) return null;
  const spawn = () => new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module', name: 'occt-mesh' });
  let workers: Worker[];
  try {
    workers = Array.from({ length: count }, spawn);
  } catch {
    return null;
  }
  let seq = 0;
  return {
    concurrency: count,
    mesh(slot, file, params) {
      const id = ++seq;
      return new Promise<MeshData[]>((resolve, reject) => {
        const w = workers[slot];
        w.onmessage = (ev: MessageEvent<MeshReply>) => {
          if (ev.data.id !== id) return;
          if (ev.data.error) reject(new Error(ev.data.error));
          else resolve(ev.data.meshes);
        };
        w.onerror = (ev) => {
          ev.preventDefault();
          w.terminate();
          workers[slot] = spawn(); // keep the slot usable for the remaining parts
          reject(new Error(ev.message || '网格子进程出错'));
        };
        const job: MeshJob = { id, file, params };
        w.postMessage(job, [file.buffer as ArrayBuffer]);
      });
    },
    dispose: () => workers.forEach((w) => w.terminate()),
  };
}

/**
 * Mesh a STEP assembly part by part; null when the file cannot be split (then read it as a whole).
 * `strict`: also give up when some occurrence placement cannot be read (the whole-file read is an option).
 */
async function readBySplit(structure: StepStructure, strict: boolean, occt?: OcctModule): Promise<PipelineOutput | null> {
  let plan;
  try {
    plan = planSplit(structure);
  } catch (e) {
    console.warn('无法按零件拆分，改为整体读取', e);
    return null;
  }
  if (!plan.parts.length) return null;
  if (strict && plan.unplaced > 0) {
    console.warn(`${plan.unplaced} 个实例的位置无法读取，改为整体读取`);
    return null;
  }
  const total = plan.parts.length;
  post({ type: 'stage', stage: 'parse', progress: 0, detail: `0 / ${total}` });
  const mesher = workerMesher(total) ?? inProcessMesher(createOcct, occt);
  try {
    return await importSplit(structure, plan, mesher, {
      progress: (done, _total, fraction) => post({ type: 'stage', stage: 'parse', progress: fraction, detail: `${done} / ${total}` }),
      placing: () => post({ type: 'stage', stage: 'edges' }),
    });
  } finally {
    mesher.dispose?.();
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'import') return;
  try {
    post({ type: 'stage', stage: 'init' });
    let occt: OcctModule | null = await createOcct();
    const bytes = new Uint8Array(req.buffer);

    let structure: StepStructure | null = null;
    if (req.format === 'step') {
      post({ type: 'stage', stage: 'structure' });
      try {
        structure = parseStepStructure(bytes);
      } catch (e) {
        console.warn('无法读取 STEP 装配结构，改用简化结构', e);
      }
    }

    if (structure && (req.split ?? bytes.length > SPLIT_ABOVE)) {
      const out = await readBySplit(structure, req.split === undefined && bytes.length <= WHOLE_MAX, occt);
      if (out) {
        post({ type: 'result', result: out.result }, out.transfer);
        return;
      }
    }

    post({ type: 'stage', stage: 'parse' });
    const t0 = performance.now();
    const raw = read(occt, req.format, bytes);
    const parseMs = performance.now() - t0;
    if (!raw.success) throw new Error('无法解析该文件：可能不是有效的模型文件，或文件已损坏。');
    if (!raw.meshes?.length) throw new Error('文件中没有可显示的实体或曲面。');

    post({ type: 'stage', stage: 'edges' });
    let out: PipelineOutput | null = processOcctResult(raw, { format: req.format, structure, parseMs });
    if (out.result.stats.triangles === 0) {
      // OpenCascade's heap filled up while reading and nothing could be meshed: try part by part
      out = null;
      occt = null; // let the exhausted instance be collected
      if (structure && req.split !== false) out = await readBySplit(structure, false);
      if (!out) throw new Error('OpenCascade 没能为这个模型生成网格（多半是模型太大，浏览器内存不足）。');
    }
    post({ type: 'result', result: out.result }, out.transfer);
  } catch (err) {
    post({ type: 'error', message: describeError(err) });
  }
};
