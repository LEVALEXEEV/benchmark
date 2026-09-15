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
 * Термальное состояние и питание — источники дрейфа между прогонами
 * (в НИР2 два свипа S5 на одной машине разошлись на 43%). Снимается перед
 * каждым прогоном; на macOS через pmset, на других ОС — null.
 */
export function thermalSnapshot(): { therm: string | null; power: string | null } {
  if (process.platform !== 'darwin') return { therm: null, power: null };
  return {
    therm: sh('pmset -g therm'),
    power: sh('pmset -g batt')?.split('\n')[0] ?? null,
  };
}

export function hostEnv() {
  const cpus = os.cpus();
  const dirty = sh('git status --porcelain');
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: process.platform === 'darwin' ? sh('sw_vers -productVersion') : os.version(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    lowPowerMode: process.platform === 'darwin' ? sh('pmset -g | grep lowpowermode') : null,
    git: {
      commit: sh('git rev-parse HEAD'),
      dirty: dirty === null ? null : dirty.length > 0,
    },
    libs: Object.fromEntries(
      ['three', 'react', 'react-dom', '@react-three/fiber', 'vite', 'playwright', 'typescript'].map((n) => [
        n,
        pkgVersion(n),
      ])
    ),
    ...thermalSnapshot(),
  };
}

/** метка устройства для пути результатов: из --device или модели CPU */
export function deviceSlug(explicit: string | null): string {
  const raw = explicit ?? os.cpus()[0]?.model ?? 'unknown-device';
  return raw
    .toLowerCase()
    .replace(/\(r\)|\(tm\)|cpu|@.*$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
