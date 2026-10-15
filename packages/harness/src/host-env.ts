import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ROOT } from './servers.js';

function sh(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

function pkgVersion(name: string): string | null {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Пути, от которых зависят замеры. results/, analysis/ и docs/ лежат в том
 * же репозитории, но на данные не влияют: иначе каждая новая серия делала бы
 * рабочую копию «грязной» для следующей.
 */
export const CODE_PATHS = ['packages', 'package.json', 'package-lock.json', 'tsconfig.base.json'];

export function codeGitState(): { commit: string | null; dirty: boolean | null; dirtyFiles: string[] } {
  const status = sh(`git status --porcelain -- ${CODE_PATHS.join(' ')}`);
  const dirtyFiles = status ? status.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  return { commit: sh('git rev-parse HEAD'), dirty: status === null ? null : dirtyFiles.length > 0, dirtyFiles };
}

/** метка устройства для пути результатов: из --device или модели CPU */
export function deviceSlug(explicit: string | null): string {
  const raw = explicit ?? os.cpus()[0]?.model ?? 'unknown-device';
  return raw
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|cpu|@.*$| with .*$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** паспорт машины для manifest (gpu добавляется со страницы — WebGL renderer) */
export function deviceInfo(explicit: string | null) {
  const cpus = os.cpus();
  return {
    id: deviceSlug(explicit),
    cpu: cpus[0]?.model.trim() ?? null,
    cores: cpus.length,
    memory_gb: Math.round(os.totalmem() / 1024 ** 3),
    os: process.platform === 'darwin' ? `macOS ${sh('sw_vers -productVersion')}` : os.version(),
  };
}

export function libVersions(): Record<string, string | null> {
  return {
    ...Object.fromEntries(['three', 'react', '@react-three/fiber', 'vite', 'playwright'].map((n) => [n, pkgVersion(n)])),
    node: process.version.replace(/^v/, ''),
  };
}
