import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DEV_PORTS, PREVIEW_PORTS, type BenchConfig } from './config.js';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VITE_BIN = join(ROOT, 'node_modules/vite/bin/vite.js');
const PKG_DIR = {
  threejs: join(ROOT, 'packages/impl-threejs'),
  r3f: join(ROOT, 'packages/impl-r3f'),
} as const;

export function buildImpls(): void {
  for (const ws of ['@bench/impl-threejs', '@bench/impl-r3f']) {
    console.log(`[build] ${ws}`);
    execSync(`npm run build -w ${ws}`, { cwd: ROOT, stdio: 'inherit' });
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Сервер ${url} не поднялся за ${timeoutMs} мс: ${String(lastErr)}`);
}

export interface Servers {
  readonly info: Record<string, { url: string; coop: string | null; coep: string | null }>;
  stop(): void;
}

/**
 * Поднимает серверы обеих реализаций. По умолчанию — `vite preview` поверх
 * production-сборки: в НИР2 замеры шли на dev-сервере (development-сборка
 * React, сотни несжатых ESM-модулей), что искажало и S3, и все state-режимы.
 */
export async function startServers(cfg: BenchConfig): Promise<Servers> {
  const children: ChildProcess[] = [];
  const info: Servers['info'] = {};
  const stop = (): void => {
    for (const c of children) if (!c.killed) c.kill('SIGTERM');
  };
  process.once('exit', stop);

  try {
    for (const impl of ['threejs', 'r3f'] as const) {
      const port = cfg.serve === 'preview' ? PREVIEW_PORTS[impl] : DEV_PORTS[impl];
      const args = cfg.serve === 'preview' ? ['preview', '--port', String(port), '--strictPort'] : ['--port', String(port), '--strictPort'];
      const child = spawn(process.execPath, [VITE_BIN, ...args], {
        cwd: PKG_DIR[impl],
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
      });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += String(d)));
      child.on('exit', (code) => {
        if (code !== null && code !== 0) console.error(`[server] ${impl} завершился с кодом ${code}\n${stderr}`);
      });
      const url = `http://localhost:${port}/`;
      const res = await waitForServer(url, 30_000);
      const coop = res.headers.get('cross-origin-opener-policy');
      const coep = res.headers.get('cross-origin-embedder-policy');
      if (coop !== 'same-origin' || coep !== 'require-corp') {
        throw new Error(`${url}: нет заголовков COOP/COEP (получено ${coop}/${coep}) — таймер будет огрублён`);
      }
      info[impl] = { url, coop, coep };
      console.log(`[server] ${impl}: ${url} (${cfg.serve})`);
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { info, stop };
}
