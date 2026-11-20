/// <reference lib="es2022" />
import occtimportjs, { type OcctModule } from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import { MESH_PARAMS } from '../core/mesh-params';
import { processOcctResult } from '../core/pipeline';
import { parseStepStructure, type StepStructure } from '../core/step-structure';
import type { OcctResult } from '../core/types';
import type { WorkerRequest, WorkerResponse } from './protocol';

const scope = self as unknown as Worker;
const post = (msg: WorkerResponse, transfer: Transferable[] = []) => scope.postMessage(msg, transfer);

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

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  if (req.type !== 'import') return;
  try {
    post({ type: 'stage', stage: 'init' });
    const occt = await occtimportjs({ locateFile: () => wasmUrl });
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

    post({ type: 'stage', stage: 'parse' });
    const t0 = performance.now();
    const raw = read(occt, req.format, bytes);
    const parseMs = performance.now() - t0;
    if (!raw.success) throw new Error('无法解析该文件：可能不是有效的模型文件，或文件已损坏。');
    if (!raw.meshes?.length) throw new Error('文件中没有可显示的实体或曲面。');

    post({ type: 'stage', stage: 'edges' });
    const { result, transfer } = processOcctResult(raw, { format: req.format, structure, parseMs });
    post({ type: 'result', result }, transfer);
  } catch (err) {
    post({ type: 'error', message: describeError(err) });
  }
};
