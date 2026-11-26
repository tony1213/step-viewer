/**
 * Opening a model from a web address: the 「打开链接」 panel and `?model=<url>`.
 *
 * The browser downloads the file straight from that address (it still never reaches a server of
 * ours), so the other server must allow cross-origin reads (CORS). Error messages are shown to the
 * user as they are, hence Chinese. DOM-free (the page address is passed in), so it runs in Node tests.
 */

export interface DownloadProgress {
  loaded: number;
  /** expected bytes; null when unknown (no Content-Length, or it counted compressed bytes) */
  total: number | null;
}

/** http:// to these is not mixed content, even from an https:// page */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Online drives and document services, by host name. Their links lead to a web page, usually behind
 * a login, and never to a file another site may read (no CORS). They are turned down before any
 * download, with a hint instead of the generic CORS message.
 */
const CLOUD_DRIVES: [RegExp, string][] = [
  [/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com)$/, '飞书'],
  [/(^|\.)dingtalk\.com$/, '钉钉'],
  [/^drive\.weixin\.qq\.com$/, '企业微信微盘'],
  [/^docs\.qq\.com$/, '腾讯文档'],
  [/(^|\.)weiyun\.com$/, '腾讯微云'],
  [/(^|\.)kdocs\.cn$/, '金山文档'],
  [/^(pan|yun)\.baidu\.com$/, '百度网盘'],
  [/(^|\.)(aliyundrive|alipan)\.com$/, '阿里云盘'],
  [/^pan\.quark\.cn$/, '夸克网盘'],
  [/(^|\.)jianguoyun\.com$/, '坚果云'],
  [/(^|\.)lanzou[a-z]?\.com$/, '蓝奏云'],
];

/**
 * Where to download the model named by `input` (typed into the panel, or taken from ?model=),
 * resolved against the page address. `typed`: an address without a scheme gets https://.
 */
export function resolveModelUrl(input: string, page: string, typed = false): URL {
  let text = input.trim();
  if (!text) throw new Error('请输入模型文件的网址。');
  if (/^(file:|[a-z]:[\\/]|\\\\)/i.test(text)) {
    throw new Error('这是本机上的文件路径，不能当作网址打开：请点「打开文件」，或把文件拖进窗口。');
  }
  if (typed && !/^[a-z][a-z\d+.-]*:\/\//i.test(text) && !/^[./]/.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text, page);
  } catch {
    throw new Error('网址格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只能打开以 http:// 或 https:// 开头的网址。');
  const drive = CLOUD_DRIVES.find(([host]) => host.test(url.hostname))?.[1];
  if (drive) {
    throw new Error(`这是${drive}的网页链接，不是模型文件本身。${drive}不允许其他网页直接读取其中的文件：请先在${drive}里下载，再把文件拖进本页面（或点「打开文件」）。`);
  }
  if (new URL(page).protocol === 'https:' && url.protocol === 'http:' && !LOOPBACK.test(url.hostname)) {
    throw new Error('本页面是 HTTPS 网页，浏览器不允许它从 http:// 网址下载文件：请改用 https:// 网址，或在本机运行本工具后再打开。');
  }
  return url;
}

/** The name shown for a model address: its last path segment, decoded ('model' when there is none). */
export function fileNameOf(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    /* malformed %-escape: show it as it is */
  }
  return name.trim() || 'model';
}

/**
 * The page address that reopens `model` (?model=<url>), or that opens nothing when `model` is null.
 * Other parameters (?debug, ?split) are kept.
 */
export function pageAddress(page: string, model: string | null): string {
  const u = new URL(page);
  if (model === null && !u.searchParams.has('model') && !u.searchParams.has('name')) return page;
  u.searchParams.delete('model');
  u.searchParams.delete('name');
  if (model === null) return u.href;
  u.searchParams.set('model', model);
  // ':' and '/' may stay unescaped inside a query, which keeps a shared address readable
  return u.href.replace(/([?&]model=)([^&#]*)/, (_, key: string, value: string) => key + value.replace(/%3A/gi, ':').replace(/%2F/gi, '/'));
}

/** A web page (share, login or error page) instead of a model file. */
export function isHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart().toLowerCase();
  return head.startsWith('<') && /<(!doctype html|html|head|body)[\s>]/.test(head);
}

function httpError(status: number): Error {
  const why = status === 404 ? '（文件不存在）' : status === 401 || status === 403 ? '（没有访问权限，或链接已过期）' : '';
  return new Error(`下载失败：服务器返回 HTTP ${status}${why}。`);
}

/**
 * Downloads a model file. The usual failures (unreachable or CORS, HTTP errors, a web page instead
 * of a file) reject with a Chinese message; aborting `signal` rejects with its AbortError.
 */
export async function downloadModel(url: URL, signal?: AbortSignal, onProgress?: (p: DownloadProgress) => void): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    // the browser deliberately does not say which: network error, CORS refusal, blocked request …
    throw new Error('无法下载该文件：网址无法访问，或者对方服务器不允许其他网页读取它的文件（CORS）。请先在浏览器里打开这个网址，把文件下载到本机，再拖进本页面。');
  }
  if (!res.ok) throw httpError(res.status);
  const bytes = await readBody(res, signal, onProgress);
  if (!bytes.length) throw new Error('下载到的文件是空的。');
  if (isHtml(bytes)) throw new Error('该网址返回的是网页，不是模型文件：请使用文件本身的下载地址（直链），而不是网盘分享页的网址。');
  return bytes.buffer;
}

async function readBody(res: Response, signal: AbortSignal | undefined, onProgress?: (p: DownloadProgress) => void): Promise<Uint8Array<ArrayBuffer>> {
  const length = Number(res.headers.get('content-length'));
  let total = length > 0 ? length : null;
  let loaded = 0;
  const chunks: Uint8Array[] = [];
  onProgress?.({ loaded, total });
  try {
    if (!res.body) {
      const all = new Uint8Array(await res.arrayBuffer());
      onProgress?.({ loaded: all.length, total: all.length });
      return all;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      // a compressed transfer: Content-Length counted the encoded bytes
      if (total !== null && loaded > total) total = null;
      onProgress?.({ loaded, total });
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new Error('下载中断：网络连接出错，请重试。');
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
