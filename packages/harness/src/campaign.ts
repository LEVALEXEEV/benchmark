import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { BrowserName, ScenarioId } from './config.js';
import { codeGitState, deviceSlug } from './host-env.js';
import { ROOT } from './servers.js';

/**
 * Кампания замеров «от и до» по матрице пула (nir3-plan.md, «Протокол
 * измерений и пул платформ»): проверки перед стартом → сборка → пауза без
 * нагрузки → серии по очереди → журнал. Подготовку ОС (сеть, индексация,
 * сон) делают обёртки scripts/macos и scripts/windows.
 *
 * Кампанию можно прервать и запустить снова: завершённые серии (все
 * прогоны расписания, protocol.usable) пропускаются. Незавершённые остаются
 * на диске, загрузчик анализа их не берёт.
 *
 *   npm run campaign -- list    --session r2
 *   npm run campaign -- prepare --session r2        (git, браузеры, typecheck, сборка)
 *   npm run campaign -- run     --session r2 [--filter chromium/base] [--optional]
 */

type DeviceId = 'D1' | 'D2';
type Session = 'r2' | 'r2b';

interface Condition {
  readonly id: string;
  readonly args: readonly string[];
  /** как условие выглядит в config манифеста — для поиска готовых серий */
  readonly match: { cpuThrottle: number; network: string; vsync: boolean; trace: boolean };
}

const BASE = { cpuThrottle: 1, network: 'none', vsync: false, trace: false };
const COND: Record<string, Condition> = {
  base: { id: 'base', args: [], match: BASE },
  // GC — отдельной серией: трасса сама добавляет накладные расходы
  trace: { id: 'trace', args: ['--trace'], match: { ...BASE, trace: true } },
  cpu4: { id: 'cpu4', args: ['--cpuThrottle', '4'], match: { ...BASE, cpuThrottle: 4 } },
  slow4g: { id: 'slow4g', args: ['--network', 'slow4g'], match: { ...BASE, network: 'slow4g' } },
  vsync: { id: 'vsync', args: ['--vsync'], match: { ...BASE, vsync: true } },
};

interface Series {
  readonly browser: BrowserName;
  readonly condition: Condition;
  readonly scenario: ScenarioId;
  readonly optional: boolean;
}

const ALL: readonly ScenarioId[] = ['s1', 's2', 's3', 's4', 's5'];

function series(browser: BrowserName, cond: string, scenarios: readonly ScenarioId[], optional = false): Series[] {
  return scenarios.map((scenario) => ({ browser, condition: COND[cond]!, scenario, optional }));
}

/**
 * Матрица пула. Порядок — порядок выполнения: сначала основная платформа
 * целиком (после неё — быстрый разбор), затем остальные условия.
 */
const PLAN: Record<Session, Record<DeviceId, Series[]>> = {
  r2: {
    D1: [
      ...series('chromium', 'base', ALL),
      ...series('chromium', 'trace', ['s2']),
      // S5 в WebKit не снимается: от ≈ 6400 объектов (у каждого своя геометрия
      // и материал) WebKit теряет контекст WebGL — ёмкость не определена
      ...series('webkit', 'base', ['s2', 's3', 's4']),
      ...series('chromium', 'cpu4', ['s2', 's3', 's4']),
      ...series('chromium', 'slow4g', ['s3']),
      ...series('webkit', 'base', ['s1'], true),
      ...series('chromium', 'vsync', ['s2'], true),
      // связь с первой серией: Chrome for Testing ≈ системный Chrome
      ...series('chrome', 'base', ['s2'], true),
    ],
    D2: [
      ...series('chromium', 'base', ALL),
      ...series('chromium', 'trace', ['s2']),
      ...series('firefox', 'base', ALL),
    ],
  },
  // вторая сессия в другой день — разброс между сессиями
  r2b: {
    D1: series('chromium', 'base', ALL),
    D2: series('chromium', 'base', ['s2', 's5']),
  },
};

/**
 * Оценка длительности серии, мин: длительности прогонов первой серии на M4
 * + прогрев, контрольные прогоны, пауза и открытие окна. Запись фиксирована
 * по времени, поэтому от устройства и условия почти не зависит.
 */
const MINUTES: Record<ScenarioId, number> = { s1: 60, s2: 105, s3: 8, s4: 57, s5: 58 };

const seriesId = (s: Series) => `${s.browser}/${s.condition.id}/${s.scenario}`;

interface Args {
  command: 'list' | 'prepare' | 'run';
  session: Session;
  device: DeviceId;
  filter: string | null;
  optional: boolean;
  idleMin: number;
  pauseSec: number;
  yes: boolean;
  /** каталог результатов; по умолчанию results/ — другой только для проверки самой кампании */
  results: string;
}

function parse(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'prepare' && command !== 'run') {
    throw new Error('Команда: list | prepare | run. Пример: npm run campaign -- run --session r2');
  }
  const v = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!.replace(/^--/, '');
    if (['optional', 'yes'].includes(k)) flags.add(k);
    else v.set(k, rest[++i] ?? '');
  }
  const session = (v.get('session') ?? '') as Session;
  if (!(session in PLAN)) throw new Error('--session r2 | r2b');
  const device = (v.get('device') ?? (process.platform === 'darwin' ? 'D1' : process.platform === 'win32' ? 'D2' : '')) as DeviceId;
  if (device !== 'D1' && device !== 'D2') throw new Error('--device D1 | D2 (по умолчанию: macOS → D1, Windows → D2)');
  return {
    command,
    session,
    device,
    filter: v.get('filter') ?? null,
    optional: flags.has('optional'),
    // протокол: не менее 10 минут без нагрузки после сборки
    idleMin: Number(v.get('idle') ?? 10),
    pauseSec: Number(v.get('pause') ?? 120),
    yes: flags.has('yes'),
    results: v.get('results') ?? join(ROOT, 'results'),
  };
}

function selected(a: Args): Series[] {
  return PLAN[a.session][a.device].filter(
    (s) => (a.optional || !s.optional) && (a.filter === null || seriesId(s).includes(a.filter))
  );
}

interface Found {
  readonly folder: string;
  readonly complete: boolean;
  readonly commit: string | null;
}

/** серии этой кампании на диске, в том числе прерванные */
function findSeries(a: Args, s: Series): Found[] {
  const session = a.session;
  const dir = join(a.results, deviceSlug(null), s.browser, s.scenario);
  if (!existsSync(dir)) return [];
  const out: Found[] = [];
  for (const folder of readdirSync(dir)) {
    if (!folder.startsWith(`${session} `)) continue;
    const path = join(dir, folder, 'manifest.json');
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8'));
    const c = m.config ?? {};
    const same =
      (c.cpuThrottle ?? 1) === s.condition.match.cpuThrottle &&
      (c.network ?? 'none') === s.condition.match.network &&
      !!c.vsync === s.condition.match.vsync &&
      !!c.trace === s.condition.match.trace;
    if (!same) continue;
    const complete =
      m.protocol?.usable === true && Array.isArray(m.schedule) && m.schedule.length > 0 && m.runs.length === m.schedule.length;
    out.push({ folder: join(dir, folder), complete, commit: m.host?.git?.commit ?? null });
  }
  return out;
}

function journalPath(a: Args): string {
  const dir = join(a.results, deviceSlug(null));
  mkdirSync(dir, { recursive: true });
  return join(dir, `journal-${a.session}.md`);
}

function journal(a: Args, line: string): void {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  appendFileSync(journalPath(a), `- ${stamp} — ${line}\n`);
  console.log(`[campaign] ${line}`);
}

function list(a: Args): void {
  let left = 0;
  console.log(`\nКампания ${a.session}, устройство ${a.device} (${deviceSlug(null)})\n`);
  for (const s of selected(a)) {
    const found = findSeries(a, s);
    const done = found.some((f) => f.complete);
    const partial = !done && found.length > 0;
    if (!done) left += MINUTES[s.scenario] * (s.condition.id === 'cpu4' ? 1.1 : 1);
    console.log(`  ${done ? '✓' : partial ? '…' : '·'} ${seriesId(s).padEnd(26)}${s.optional ? ' (необязательно)' : ''}${partial ? ' прервана, будет снята заново' : ''}`);
  }
  console.log(`\nОсталось ≈ ${Math.round(left / 6) / 10} ч машинного времени.`);
}

function sh(cmd: string): void {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

/** всё, что требует сети и нагружает машину, — до подготовки ОС и паузы */
function prepare(a: Args): void {
  const git = codeGitState();
  if (git.dirty !== false) throw new Error(`Код не закоммичен: ${git.dirtyFiles.join(', ') || 'состояние git неизвестно'}`);
  // протокол: один коммит на всю кампанию
  for (const s of PLAN[a.session][a.device]) {
    for (const f of findSeries(a, s)) {
      if (f.complete && f.commit !== git.commit) {
        throw new Error(
          `Серия ${f.folder} кампании ${a.session} снята на коммите ${f.commit}, сейчас ${git.commit}.\n` +
            'Коммит меняется только между кампаниями: верните коммит или начните новую кампанию.'
        );
      }
    }
  }
  sh('npm run browsers');
  sh('npm run typecheck');
  sh('npm run build');
  journal(a, `подготовка: коммит ${git.commit?.slice(0, 7)}, браузеры и сборка готовы`);
}

const CHECKLIST: Record<DeviceId, string[]> = {
  D1: [
    'Питание от сети, режим энергосбережения выключен',
    'Вход в отдельную учётную запись для замеров, основная — завершена (не быстрое переключение)',
    'Все приложения закрыты (IDE, браузеры, мессенджеры, облачные клиенты)',
    'Встроенный дисплей, внешние мониторы отключены, крышка открыта',
    'Режим «Не беспокоить» включён',
    'Заставка выключена («Никогда»), блокировка экрана не сработает за время кампании',
  ],
  D2: [
    'Зарядное устройство подключено',
    'Режим питания «Максимальная производительность» (Параметры → Система → Питание)',
    'Выполнена «чистая загрузка» (msconfig: службы не Microsoft отключены; автозагрузка отключена)',
    'Все приложения закрыты, утилиты производителя и оверлей AMD выключены',
    'Встроенный дисплей, внешние мониторы отключены, крышка открыта',
    // SetThreadExecutionState не мешает заставке — её нужно выключить вручную
    'Заставка выключена, блокировка экрана по бездействию отключена',
  ],
};

async function confirmChecklist(a: Args): Promise<void> {
  const items = CHECKLIST[a.device];
  if (a.yes) {
    journal(a, `чек-лист подтверждён флагом --yes: ${items.join('; ')}`);
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nЧек-лист перед кампанией (nir3-plan.md, раздел 3):');
    for (const item of items) {
      const ans = (await rl.question(`  ${item}? [y/N] `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'д') throw new Error(`Не выполнено: ${item}. Кампания не начата.`);
    }
  } finally {
    rl.close();
  }
  journal(a, `чек-лист подтверждён: ${items.join('; ')}`);
}

function runSeries(a: Args, s: Series): Promise<number> {
  const args = ['run', 'bench', '--', '--scenario', s.scenario, '--browser', s.browser, '--campaign', a.session, '--no-build', ...s.condition.args];
  // только для проверки кампании: в Windows аргументы идут через cmd.exe без кавычек
  if (a.results !== join(ROOT, 'results')) args.push('--out', a.results);
  return new Promise((resolve) => {
    const p = spawn('npm', args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    p.on('exit', (code) => resolve(code ?? 1));
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(a: Args): Promise<void> {
  const todo = selected(a).filter((s) => !findSeries(a, s).some((f) => f.complete));
  if (todo.length === 0) {
    console.log('[campaign] все выбранные серии уже сняты');
    return;
  }
  const git = codeGitState();
  if (git.dirty !== false) throw new Error('Код не закоммичен — сначала `npm run campaign -- prepare`');
  await confirmChecklist(a);
  journal(a, `старт: ${todo.length} серий (${todo.map(seriesId).join(', ')})`);

  if (a.idleMin > 0) {
    journal(a, `пауза без нагрузки ${a.idleMin} мин`);
    await sleep(a.idleMin * 60_000);
  }
  const failed: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i]!;
    if (i > 0 && a.pauseSec > 0) await sleep(a.pauseSec * 1000);
    journal(a, `серия ${i + 1}/${todo.length}: ${seriesId(s)}`);
    const t0 = Date.now();
    const code = await runSeries(a, s);
    const min = Math.round((Date.now() - t0) / 6000) / 10;
    const ok = code === 0 && findSeries(a, s).some((f) => f.complete);
    journal(a, `${seriesId(s)}: ${ok ? 'готово' : `ОШИБКА (код ${code})`}, ${min} мин`);
    if (!ok) failed.push(seriesId(s));
  }
  journal(a, failed.length ? `конец: не сняты ${failed.join(', ')} — повторный запуск снимет только их` : 'конец: все серии сняты');
  if (failed.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const a = parse(process.argv.slice(2));
  if (a.command === 'list') list(a);
  else if (a.command === 'prepare') prepare(a);
  else await run(a);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
