export const $ = <T extends HTMLElement = HTMLElement>(selector: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing element ${selector}`);
  return el;
};

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]);

export const fmt = (v: number, digits = 2) => v.toFixed(digits);
export const fmtInt = (v: number) => Math.round(v).toLocaleString('zh-CN');

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const fmtSeconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

export const ICONS = {
  caret: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5"/></svg>',
  eye: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M1.5 10S5 4.5 10 4.5 18.5 10 18.5 10 15 15.5 10 15.5 1.5 10 1.5 10z"/><circle cx="10" cy="10" r="2.5"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3l14 14M8.3 4.7A8 8 0 0 1 10 4.5c5 0 8.5 5.5 8.5 5.5a14.5 14.5 0 0 1-2.7 3.1M12.4 15.1a7.7 7.7 0 0 1-2.4.4c-5 0-8.5-5.5-8.5-5.5a14.6 14.6 0 0 1 3.4-3.7"/></svg>',
  asm: '<svg class="kind asm" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5.2 8 2.2l6 3v5.6l-6 3-6-3zM2 5.2l6 3 6-3M8 8.2v5.6"/></svg>',
  part: '<svg class="kind part" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.6 8 2.2l5 2.4v6.8L8 13.8l-5-2.4zM3 4.6 8 7l5-2.4M8 7v6.8"/></svg>',
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15"/></svg>',
};
