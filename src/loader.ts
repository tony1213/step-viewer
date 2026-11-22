import type { ImportResult, ModelFormat } from './core/types';
import type { Stage, StageInfo, WorkerRequest, WorkerResponse } from './worker/protocol';

export class CancelledError extends Error {
  constructor() {
    super('已取消');
    this.name = 'CancelledError';
  }
}

export const ACCEPTED_EXTENSIONS = ['.step', '.stp', '.iges', '.igs', '.brep', '.brp'];

export function detectFormat(fileName: string, bytes: Uint8Array): ModelFormat {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'step' || ext === 'stp' || ext === 'p21') return 'step';
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === 'brep' || ext === 'brp') return 'brep';
  const head = new TextDecoder().decode(bytes.subarray(0, 1024));
  if (head.includes('ISO-10303-21')) return 'step';
  if (/^.{72}S\s*0*1\s*$/m.test(head)) return 'iges';
  if (head.includes('DBRep_DrawableShape') || head.includes('CASCADE Topology')) return 'brep';
  throw new Error('不支持的文件格式：请选择 STEP（.step/.stp）、IGES（.iges/.igs）或 BREP 文件。');
}

/** Runs OpenCascade in a fresh Web Worker per file (WASM memory is released afterwards). */
export class ModelLoader {
  private worker: Worker | null = null;
  private rejectCurrent: ((e: Error) => void) | null = null;

  load(fileName: string, buffer: ArrayBuffer, onStage: (stage: Stage, info: StageInfo) => void, split?: boolean): Promise<ImportResult> {
    this.cancel();
    const format = detectFormat(fileName, new Uint8Array(buffer));
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker/occt.worker.ts', import.meta.url), { type: 'module', name: 'occt' });
      this.worker = worker;
      this.rejectCurrent = reject;
      const finish = () => {
        worker.terminate();
        if (this.worker === worker) {
          this.worker = null;
          this.rejectCurrent = null;
        }
      };
      worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const msg = ev.data;
        if (msg.type === 'stage') {
          onStage(msg.stage, { progress: msg.progress, detail: msg.detail });
        } else if (msg.type === 'result') {
          finish();
          resolve(msg.result);
        } else {
          finish();
          reject(new Error(msg.message));
        }
      };
      worker.onerror = (ev) => {
        ev.preventDefault();
        finish();
        reject(new Error(ev.message ? `解析引擎出错：${ev.message}` : '解析引擎加载失败。'));
      };
      const req: WorkerRequest = { type: 'import', format, buffer, split };
      worker.postMessage(req, [buffer]);
    });
  }

  get busy(): boolean {
    return this.worker !== null;
  }

  cancel(): void {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    const reject = this.rejectCurrent;
    this.rejectCurrent = null;
    reject?.(new CancelledError());
  }
}
