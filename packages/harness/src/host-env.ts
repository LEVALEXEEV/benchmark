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
 * Пути, от которых зависят замеры. results/ и analysis/ лежат в том же
 * репозитории, но на данные не влияют: иначе каждая новая серия делала бы
 * рабочую копию «грязной» для следующей.
 */
export const CODE_PATHS = ['packages', 'package.json', 'package-lock.json', 'tsconfig.base.json'];

export function codeGitState(): { commit: string | null; dirty: boolean | null; dirtyFiles: string[]; diff: string | null } {
  const paths = CODE_PATHS.join(' ');
  const status = sh(`git status --porcelain -- ${paths}`);
  const dirtyFiles = status ? status.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  return {
    commit: sh('git rev-parse HEAD'),
    dirty: status === null ? null : dirtyFiles.length > 0,
    dirtyFiles,
    diff: dirtyFiles.length > 0 ? sh(`git diff HEAD -- ${paths}`) : null,
  };
}

/**
 * Паспорт машины — статичное описание для таблицы пула. Показания датчиков
 * (температура, питание, частоты) стенд не снимает: влияние среды
 * контролируется контрольными прогонами three.js и повтором уровня в S5.
 */
export function hostEnv() {
  const cpus = os.cpus();
  const git = codeGitState();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    osVersion: process.platform === 'darwin' ? sh('sw_vers -productVersion') : os.version(),
    cpuModel: cpus[0]?.model ?? null,
    cpuCount: cpus.length,
    totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    // сам diff — в отдельном файле серии, в манифесте только список файлов
    git: { commit: git.commit, dirty: git.dirty, dirtyFiles: git.dirtyFiles, scope: CODE_PATHS },
    libs: Object.fromEntries(
      ['three', 'react', 'react-dom', '@react-three/fiber', 'vite', 'playwright', 'typescript'].map((n) => [
        n,
        pkgVersion(n),
      ])
    ),
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
