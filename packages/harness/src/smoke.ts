import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S1_LOADS, SCENARIOS_BY_BROWSER, TARGETS, type BrowserName, type ScenarioId } from './config.js';
import { codeGitState } from './host-env.js';
import { CSV_HEADER } from './output.js';
import { ROOT } from './servers.js';

/**
 * Смоук-тест стенда: работает ли он на этой машине так, как в кампании.
 *
 * Для каждой пары «браузер × сценарий» этой машины — настоящая серия через
 * runner (паритет, сборка страницы, браузер из пула), но по одному прогону
 * на ячейку и с короткими окнами, во временную папку. Затем проверяется
 * результат: серия завершена, условия страницы соблюдены, CSV в формате
 * docs/DATA.md и с данными. Замеры смоук-теста для анализа не годятся.
 *
 *   npm run smoke [-- --browser chromium,firefox] [-- --scenario s2,s4] [-- --keep]
 *
 * Сборку и typecheck делают обёртки scripts/macos/smoke.sh и
 * scripts/windows/smoke.ps1; здесь — только прогоны и проверки.
 */

const KIND: Record<ScenarioId, keyof typeof CSV_HEADER> = { s1: 'frame', s2: 'frame', s3: 'init', s4: 'input', s5: 'scale' };

/** браузеры кампании на этой ОС (как в campaign.ts) */
const BROWSERS_BY_OS: Record<string, readonly BrowserName[]> = {
  darwin: ['chromium', 'firefox', 'webkit'],
  win32: ['chromium', 'firefox'],
};

/**
 * Окна смоук-прогона: достаточно, чтобы страница прошла прогрев и записала
 * данные (в S4 — несколько кликов), но не для статистики. В S5 окна — на
 * уровень, и уровень всё равно продлевается до 60 кадров.
 */
const WINDOWS: Record<ScenarioId, { warmup: number; record: number }> = {
  s1: { warmup: 1000, record: 3000 },
  s2: { warmup: 1000, record: 3000 },
  s3: { warmup: 0, record: 0 },
  s4: { warmup: 1000, record: 4000 },
  s5: { warmup: 300, record: 500 },
};

interface Args {
  browsers: BrowserName[];
  scenarios: ScenarioId[] | null;
  keep: boolean;
}

function parse(argv: string[]): Args {
  const v = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!.replace(/^--/, '');
    if (k === 'keep') flags.add(k);
    else v.set(k, argv[++i] ?? '');
  }
  const own = BROWSERS_BY_OS[process.platform] ?? ['chromium', 'firefox'];
  const browsers = (v.get('browser')?.split(',') ?? own) as BrowserName[];
  for (const b of browsers) if (!own.includes(b)) throw new Error(`--browser: ${b} не снимается на этой ОС; есть ${own.join(', ')}`);
  const scenarios = (v.get('scenario')?.split(',') ?? null) as ScenarioId[] | null;
  for (const s of scenarios ?? []) if (!(s in KIND)) throw new Error(`--scenario: неизвестный сценарий ${s}`);
  return { browsers, scenarios, keep: flags.has('keep') };
}

/** серия через runner — тот же код, что в кампании; вывод — в лог */
function runSeries(out: string, browser: BrowserName, scenario: ScenarioId, log: string): Promise<number> {
  const w = WINDOWS[scenario];
  const args = [
    join(ROOT, 'node_modules/tsx/dist/cli.mjs'), join(ROOT, 'packages/harness/src/runner.ts'),
    '--scenario', scenario, '--browser', browser, '--repeats', '1', '--warmupRuns', '0',
    '--warmup', String(w.warmup), '--record', String(w.record), '--pause', '500',
    '--no-build', '--allow-dirty', '--out', out,
  ];
  return new Promise((resolve) => {
    const stream = createWriteStream(log);
    const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(stream);
    p.stderr.pipe(stream);
    p.on('exit', (code) => stream.end(() => resolve(code ?? 1)));
  });
}

const isNum = (s: string): boolean => s !== '' && Number.isFinite(Number(s));

/** проверки результата серии; возвращает список проблем (пусто — всё в порядке) */
function check(dir: string, browser: BrowserName, scenario: ScenarioId): string[] {
  const problems: string[] = [];
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!m.finished) problems.push('серия не завершена');
  if (!m.parity?.ok) problems.push(`паритет не пройден: ${(m.parity?.issues ?? []).slice(0, 2).join('; ')}`);
  if (m.page?.build !== 'production') problems.push(`сборка ${m.page?.build}`);
  if (!m.page?.isolated) problems.push('страница не изолирована (таймер огрублён)');
  if (m.page?.canvas !== '1280x720') problems.push(`холст ${m.page?.canvas}`);
  if (m.retries?.length) problems.push(`сбоев браузера: ${m.retries.length}`);

  const cells = TARGETS[scenario].length * (scenario === 's1' ? S1_LOADS.length : 1);
  if (m.runs.length !== cells) problems.push(`прогонов ${m.runs.length}, ожидалось ${cells}`);

  const header = CSV_HEADER[KIND[scenario]];
  for (const r of m.runs) {
    const name = `${r.variant}${r.load ? ` [${r.load}]` : ''}`;
    const lines = readFileSync(join(dir, r.file), 'utf8').trim().split('\n');
    if (lines[0] !== header.join(',')) {
      problems.push(`${name}: заголовок CSV не по формату`);
      continue;
    }
    const rows = lines.slice(1).map((l) => l.split(','));
    if (rows.some((x) => x.length !== header.length)) problems.push(`${name}: строки разной длины`);
    const col = (c: string): string[] => rows.map((x) => x[header.indexOf(c as never)]!);
    switch (KIND[scenario]) {
      case 'frame': {
        if (rows.length < 30) problems.push(`${name}: кадров ${rows.length}`);
        if (!['frame_ms', 'update_ms', 'render_ms'].every((c) => col(c).every(isNum))) problems.push(`${name}: пустые значения фаз`);
        // GPU-таймер есть только в Chromium; там он должен работать
        const gpu = col('gpu_ms').filter(isNum).length / Math.max(1, rows.length);
        if (browser === 'chromium' && gpu < 0.5) problems.push(`${name}: время GPU есть лишь у ${Math.round(gpu * 100)}% кадров`);
        break;
      }
      case 'init': {
        const t = rows[0]?.map(Number) ?? [];
        if (rows.length !== 1 || !t.every(Number.isFinite) || !(t[0]! <= t[1]! && t[1]! <= t[2]!)) {
          problems.push(`${name}: отметки старта не по порядку`);
        }
        break;
      }
      case 'input': {
        const ok = rows.filter((x) => x[1] === 'ok').length;
        if (ok === 0) problems.push(`${name}: ни одного клика с откликом из ${rows.length}`);
        break;
      }
      case 'scale': {
        const levels = new Set(col('objects')).size;
        if (levels < 2) problems.push(`${name}: уровней ${levels}`);
        if (!col('frame_ms').every(isNum)) problems.push(`${name}: пустые длительности кадров`);
        break;
      }
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  const out = mkdtempSync(join(tmpdir(), 'bench-smoke-'));
  const git = codeGitState();
  console.log(`[smoke] временная папка: ${out}`);
  console.log(
    git.dirty === false
      ? '[smoke] код закоммичен — кампания с этим кодом запустится'
      : `[smoke] код НЕ закоммичен — кампания не запустится (${git.dirtyFiles.length} файлов); смоук идёт с --allow-dirty`
  );

  const rows: { pair: string; status: string; sec: number; note: string }[] = [];
  for (const browser of a.browsers) {
    for (const scenario of SCENARIOS_BY_BROWSER[browser]) {
      if (a.scenarios && !a.scenarios.includes(scenario)) continue;
      const pair = `${browser}/${scenario}`;
      const log = join(out, `${browser}-${scenario}.log`);
      process.stdout.write(`[smoke] ${pair} … `);
      const t0 = Date.now();
      const code = await runSeries(out, browser, scenario, log);
      const sec = Math.round((Date.now() - t0) / 1000);
      let problems: string[];
      const base = join(out, readdirSync(out).find((d) => !d.endsWith('.log')) ?? '-', browser, scenario);
      const dir = existsSync(base) ? readdirSync(base).map((d) => join(base, d))[0] : undefined;
      if (code !== 0 || !dir) {
        const tail = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').slice(-3).join(' | ') : '';
        problems = [`runner завершился с кодом ${code}: ${tail}`];
      } else {
        problems = check(dir, browser, scenario);
      }
      const status = problems.length ? 'FAIL' : 'OK';
      console.log(`${status} (${sec} с)`);
      for (const p of problems) console.log(`         ${p}`);
      rows.push({ pair, status, sec, note: problems[0] ?? '' });
    }
  }

  const failed = rows.filter((r) => r.status !== 'OK');
  console.log('\n[smoke] итог:');
  console.table(rows.map((r) => ({ серия: r.pair, результат: r.status, 'время, с': r.sec, проблема: r.note.slice(0, 80) })));
  if (failed.length === 0 && !a.keep) {
    rmSync(out, { recursive: true, force: true });
    console.log('[smoke] все проверки пройдены; временная папка удалена');
  } else {
    console.log(`[smoke] ${failed.length ? `не пройдено: ${failed.length} из ${rows.length}` : 'все проверки пройдены'}; данные и логи — ${out}`);
  }
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
