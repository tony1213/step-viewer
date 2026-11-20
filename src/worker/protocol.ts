import type { ImportResult, ModelFormat } from '../core/types';

export type Stage = 'init' | 'structure' | 'parse' | 'edges';

export interface ImportRequest {
  type: 'import';
  format: ModelFormat;
  buffer: ArrayBuffer;
}

export type WorkerRequest = ImportRequest;

export type WorkerResponse =
  | { type: 'stage'; stage: Stage }
  | { type: 'result'; result: ImportResult }
  | { type: 'error'; message: string };
