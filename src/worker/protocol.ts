import type { ImportResult, MeshData, ModelFormat } from '../core/types';

export type Stage = 'init' | 'structure' | 'parse' | 'edges';

/** Progress inside a stage (only reported when a large STEP file is read part by part). */
export interface StageInfo {
  /** 0..1 */
  progress?: number;
  /** e.g. "37 / 220" */
  detail?: string;
}

export interface ImportRequest {
  type: 'import';
  format: ModelFormat;
  buffer: ArrayBuffer;
  /** read a STEP file part by part: true = always, false = never, undefined = decided by file size */
  split?: boolean;
}

export type WorkerRequest = ImportRequest;

export type WorkerResponse =
  | ({ type: 'stage'; stage: Stage } & StageInfo)
  | { type: 'result'; result: ImportResult }
  | { type: 'error'; message: string };

/** occt.worker → mesh.worker: mesh one part file (large assemblies are meshed in parallel). */
export interface MeshJob {
  id: number;
  file: Uint8Array;
  params: object;
}

export interface MeshReply {
  id: number;
  meshes: MeshData[];
  error?: string;
}
