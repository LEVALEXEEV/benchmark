import { readdir, readFile } from 'node:fs/promises';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ROOT } from './servers.js';

export interface BundleSizeReport {
  readonly impl: 'threejs' | 'r3f';
  readonly files: readonly { path: string; bytes: number; gzipBytes: number; brotliBytes: number }[];
  readonly total_bytes: number;
  readonly total_gzip_bytes: number;
  readonly total_brotli_bytes: number;
}

/** доставляемые клиенту ассеты; source map в размер не входят */
const COUNTED = /\.(m?js|css|html)$/;

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/**
 * Размер production-сборки: raw, gzip (уровень 9) и brotli (качество 11) —
 * так сжимают статику типичные CDN. Считается по той же сборке, что
 * раздаётся в прогонах.
 */
export async function measureBundles(): Promise<BundleSizeReport[]> {
  const out: BundleSizeReport[] = [];
  for (const impl of ['threejs', 'r3f'] as const) {
    const dist = join(ROOT, 'packages', impl === 'threejs' ? 'impl-threejs' : 'impl-r3f', 'dist');
    const all: string[] = [];
    await walk(dist, all);
    const files: BundleSizeReport['files'][number][] = [];
    for (const f of all.filter((p) => COUNTED.test(p))) {
      const buf = await readFile(f);
      files.push({
        path: f.slice(dist.length + 1),
        bytes: buf.length,
        gzipBytes: gzipSync(buf, { level: 9 }).length,
        brotliBytes: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
      });
    }
    files.sort((a, b) => b.bytes - a.bytes);
    const sum = (k: 'bytes' | 'gzipBytes' | 'brotliBytes') => files.reduce((s, f) => s + f[k], 0);
    const r = { impl, files, total_bytes: sum('bytes'), total_gzip_bytes: sum('gzipBytes'), total_brotli_bytes: sum('brotliBytes') };
    const kb = (n: number) => (n / 1024).toFixed(1);
    console.log(`[bundle] ${impl}: ${kb(r.total_bytes)} КБ raw, ${kb(r.total_gzip_bytes)} КБ gzip, ${kb(r.total_brotli_bytes)} КБ brotli`);
    out.push(r);
  }
  return out;
}
