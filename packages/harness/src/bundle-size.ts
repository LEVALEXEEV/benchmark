import { readdir, readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { ROOT } from './servers.js';

/** доставляемые клиенту ассеты; source map в размер не входят */
const COUNTED = /\.(m?js|css|html)$/;

async function walk(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

const kb = (bytes: number): number => Math.round((bytes / 1024) * 10) / 10;

/**
 * Размер production-сборки, КБ: как лежит на диске и после gzip (уровень 9,
 * как сжимают статику типичные CDN). Считается по той же сборке, что
 * раздаётся в прогонах.
 */
export async function measureBundles(): Promise<Record<'threejs' | 'r3f', { raw_kb: number; gzip_kb: number }>> {
  const out = {} as Record<'threejs' | 'r3f', { raw_kb: number; gzip_kb: number }>;
  for (const impl of ['threejs', 'r3f'] as const) {
    const dist = join(ROOT, 'packages', impl === 'threejs' ? 'impl-threejs' : 'impl-r3f', 'dist');
    const all: string[] = [];
    await walk(dist, all);
    let raw = 0;
    let gzip = 0;
    for (const f of all.filter((p) => COUNTED.test(p))) {
      const buf = await readFile(f);
      raw += buf.length;
      gzip += gzipSync(buf, { level: 9 }).length;
    }
    out[impl] = { raw_kb: kb(raw), gzip_kb: kb(gzip) };
    console.log(`[bundle] ${impl}: ${out[impl].raw_kb} КБ, gzip ${out[impl].gzip_kb} КБ`);
  }
  return out;
}
