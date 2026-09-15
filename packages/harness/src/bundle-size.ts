import { execSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

export interface BundleSizeReport {
  readonly impl: 'threejs' | 'r3f';
  readonly distDir: string;
  readonly files: readonly { path: string; bytes: number; gzipBytes: number }[];
  readonly total_bytes: number;
  readonly total_gz_bytes: number;
}

const ROOT = new URL('../../../', import.meta.url).pathname;

const IMPL_PATHS: Record<'threejs' | 'r3f', { workspace: string; dist: string }> = {
  threejs: {
    workspace: '@bench/impl-threejs',
    dist: join(ROOT, 'packages/impl-threejs/dist'),
  },
  r3f: {
    workspace: '@bench/impl-r3f',
    dist: join(ROOT, 'packages/impl-r3f/dist'),
  },
};

/** Учитываем только реально доставляемые на клиент ассеты. */
const COUNTED_EXTS = new Set(['.js', '.mjs', '.cjs', '.css', '.html']);

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

async function measureDist(distDir: string): Promise<{
  files: { path: string; bytes: number; gzipBytes: number }[];
  total_bytes: number;
  total_gz_bytes: number;
}> {
  const all: string[] = [];
  await walk(distDir, all);
  const files: { path: string; bytes: number; gzipBytes: number }[] = [];
  let total = 0;
  let totalGz = 0;
  for (const f of all) {
    const dot = f.lastIndexOf('.');
    const ext = dot === -1 ? '' : f.slice(dot).toLowerCase();
    if (!COUNTED_EXTS.has(ext)) continue;
    const st = await stat(f);
    const buf = await readFile(f);
    const gz = gzipSync(buf).length;
    files.push({
      path: f.slice(distDir.length + 1),
      bytes: st.size,
      gzipBytes: gz,
    });
    total += st.size;
    totalGz += gz;
  }
  files.sort((a, b) => b.gzipBytes - a.gzipBytes);
  return { files, total_bytes: total, total_gz_bytes: totalGz };
}

export async function measureBundleSize(
  impl: 'threejs' | 'r3f',
  options: { build: boolean }
): Promise<BundleSizeReport> {
  const { workspace, dist } = IMPL_PATHS[impl];
  if (options.build) {
    console.log(`[bundle] building ${workspace}...`);
    execSync(`npm run build -w ${workspace}`, { cwd: ROOT, stdio: 'inherit' });
  }
  const measured = await measureDist(dist);
  return {
    impl,
    distDir: dist,
    files: measured.files,
    total_bytes: measured.total_bytes,
    total_gz_bytes: measured.total_gz_bytes,
  };
}

/**
 * Запускается отдельно (`npm run bench:s3-bundle`) либо вызывается
 * раннером перед прогонами TTFR/TTI, чтобы зафиксировать размер
 * скачиваемого с сервера приложения. Из gzipped-размера потом
 * считается H3-метрика "bundle size".
 */
export async function runBundleSizeReport(options: {
  build: boolean;
}): Promise<readonly BundleSizeReport[]> {
  const out: BundleSizeReport[] = [];
  for (const impl of ['threejs', 'r3f'] as const) {
    const r = await measureBundleSize(impl, options);
    out.push(r);
    const kb = (n: number) => (n / 1024).toFixed(1);
    console.log(
      `[bundle] ${impl}: ${kb(r.total_bytes)} KB raw, ${kb(r.total_gz_bytes)} KB gz, ${r.files.length} files`
    );
  }
  return out;
}
