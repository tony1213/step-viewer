import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { downloadModel, fileNameOf, isHtml, pageAddress, resolveModelUrl, type DownloadProgress } from '../src/remote';

const PAGE = 'https://tony1213.github.io/step-viewer/';
const bytes = (s: string) => new TextEncoder().encode(s);

describe('resolveModelUrl', () => {
  it('accepts absolute and page-relative addresses', () => {
    expect(resolveModelUrl(' https://example.com/a.step ', PAGE).href).toBe('https://example.com/a.step');
    expect(resolveModelUrl('samples/a.step', PAGE).href).toBe('https://tony1213.github.io/step-viewer/samples/a.step');
    expect(resolveModelUrl('/a.step', 'http://127.0.0.1:5280/?debug').href).toBe('http://127.0.0.1:5280/a.step');
  });

  it('adds https:// to a typed address without a scheme', () => {
    expect(resolveModelUrl('example.com/a.step', PAGE, true).href).toBe('https://example.com/a.step');
    expect(resolveModelUrl('example.com/a.step', PAGE).href).toBe('https://tony1213.github.io/step-viewer/example.com/a.step');
  });

  it('rejects empty input, local paths and other schemes with a hint', () => {
    expect(() => resolveModelUrl('  ', PAGE, true)).toThrow('请输入');
    expect(() => resolveModelUrl('file:///home/me/a.step', PAGE)).toThrow('本机');
    expect(() => resolveModelUrl('C:\\Users\\me\\a.step', PAGE, true)).toThrow('本机');
    expect(() => resolveModelUrl('ftp://example.com/a.step', PAGE)).toThrow('http');
  });

  it('refuses http:// from an https:// page (mixed content), except loopback', () => {
    expect(() => resolveModelUrl('http://example.com/a.step', PAGE)).toThrow('HTTPS');
    expect(resolveModelUrl('http://127.0.0.1:8000/a.step', PAGE).href).toBe('http://127.0.0.1:8000/a.step');
    expect(resolveModelUrl('http://example.com/a.step', 'http://127.0.0.1:5280/').protocol).toBe('http:');
  });
});

describe('fileNameOf', () => {
  it('decodes the last path segment', () => {
    expect(fileNameOf(new URL('https://example.com/d/%E5%8D%87%E9%99%8D-V1.STEP?x=1#y'))).toBe('升降-V1.STEP');
    expect(fileNameOf(new URL('https://example.com/files/a.step/'))).toBe('a.step');
  });

  it('copes with a malformed escape and with no path', () => {
    expect(fileNameOf(new URL('https://example.com/%E0%A4%A.step'))).toBe('%E0%A4%A.step');
    expect(fileNameOf(new URL('https://example.com/'))).toBe('model');
  });
});

describe('pageAddress', () => {
  it('puts a readable model address into the page address that reads back unchanged', () => {
    const model = new URL('https://bucket.example.com/升降.STEP?sig=a&b=c#f').href;
    const href = pageAddress(`${PAGE}?debug&name=old.step`, model);
    expect(href.startsWith(`${PAGE}?debug=&model=https://bucket.example.com/`)).toBe(true);
    const params = new URL(href).searchParams;
    expect(params.get('model')).toBe(model);
    expect(params.has('name')).toBe(false);
  });

  it('drops the model for a local file and leaves other addresses alone', () => {
    expect(pageAddress('http://127.0.0.1:5280/?model=a.step&name=b&split=1', null)).toBe('http://127.0.0.1:5280/?split=1');
    expect(pageAddress('http://127.0.0.1:5280/?debug', null)).toBe('http://127.0.0.1:5280/?debug');
  });
});

describe('isHtml', () => {
  it('recognises web pages', () => {
    expect(isHtml(bytes('\ufeff\n  <!DOCTYPE html><html><body>登录</body></html>'))).toBe(true);
    expect(isHtml(bytes('<HTML lang="zh">'))).toBe(true);
  });

  it('does not take model files or XML errors for pages', () => {
    expect(isHtml(bytes("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('<html>'),'2;1');"))).toBe(false);
    expect(isHtml(bytes('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'))).toBe(false);
  });
});

describe('downloadModel', () => {
  const step = bytes(`ISO-10303-21;\n${"#1 = CARTESIAN_POINT ( 'NONE', ( 0.0, 0.0, 0.0 ) ) ;\n".repeat(20_000)}END-ISO-10303-21;\n`);
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case '/model.step':
          res.setHeader('Content-Length', step.length);
          for (let i = 0; i < step.length; i += 65_536) res.write(step.subarray(i, i + 65_536));
          res.end();
          return;
        case '/gzip.step': {
          const gz = gzipSync(step);
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Content-Length', gz.length);
          res.end(gz);
          return;
        }
        case '/share':
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end('<!doctype html><html><body>分享页</body></html>');
          return;
        case '/stalled.step':
          res.setHeader('Content-Length', step.length);
          res.write(step.subarray(0, 1000)); // and never more
          return;
        default:
          res.statusCode = 404;
          res.end('not found');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('downloads the whole file and reports growing progress', async () => {
    const seen: DownloadProgress[] = [];
    const buffer = await downloadModel(new URL(`${base}/model.step`), undefined, (p) => seen.push({ ...p }));
    expect(Buffer.from(buffer).equals(Buffer.from(step))).toBe(true);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.at(-1)).toEqual({ loaded: step.length, total: step.length });
    expect(seen.every((p, i) => i === 0 || p.loaded >= seen[i - 1].loaded)).toBe(true);
  });

  it('forgets a Content-Length that counted compressed bytes', async () => {
    const seen: DownloadProgress[] = [];
    const buffer = await downloadModel(new URL(`${base}/gzip.step`), undefined, (p) => seen.push({ ...p }));
    expect(buffer.byteLength).toBe(step.length);
    expect(seen.at(-1)).toEqual({ loaded: step.length, total: null });
  });

  it('explains HTTP errors, web pages and unreachable servers', async () => {
    await expect(downloadModel(new URL(`${base}/missing.step`))).rejects.toThrow('HTTP 404（文件不存在）');
    await expect(downloadModel(new URL(`${base}/share`))).rejects.toThrow('返回的是网页');
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    await expect(downloadModel(new URL(`http://127.0.0.1:${port}/a.step`))).rejects.toThrow('无法下载该文件');
  });

  it('stops with an AbortError when cancelled mid-download', async () => {
    const abort = new AbortController();
    const download = downloadModel(new URL(`${base}/stalled.step`), abort.signal, (p) => {
      if (p.loaded > 0) abort.abort();
    });
    await expect(download).rejects.toMatchObject({ name: 'AbortError' });
  });
});
