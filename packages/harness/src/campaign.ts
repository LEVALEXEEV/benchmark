import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { SCENARIO_DEFAULTS, type BrowserName, type ScenarioId } from './config.js';
import { codeGitState, deviceSlug } from './host-env.js';
import { ROOT } from './servers.js';

/**
 * Кампания замеров «от и до» по матрице пула (nir3-spec.md, раздел 5):
 * проверки перед стартом → сборка → пауза без нагрузки → серии по очереди →
 * журнал. Подготовку ОС (сеть, индексация, сон) делают обёртки
 * scripts/macos и scripts/windows.
 *
 * Кампанию можно прервать и запустить снова: завершённые серии (manifest
 * finished, чистый код) пропускаются, прерванные снимаются заново целиком.
 *
 *   npm run campaign -- list    --session pilot|r3
 *   npm run campaign -- prepare --session pilot|r3  (git, браузеры, typecheck, сборка)
 *   npm run campaign -- run     --session pilot|r3 [--filter firefox]
 */

type DeviceId = 'D1' | 'D2';
type Session = 'pilot' | 'r3';

interface Series {
  readonly browser: BrowserName;
  readonly scenario: ScenarioId;
  /** повторов на ячейку; null — по умолчанию из config.ts */
  readonly repeats: number | null;
}

const ALL: readonly ScenarioId[] = ['s1', 's2', 's3', 's4', 's5'];

function series(browser: BrowserName, scenarios: readonly ScenarioId[], repeats: Partial<Record<ScenarioId, number>> = {}): Series[] {
  return scenarios.map((scenario) => ({ browser, scenario, repeats: repeats[scenario] ?? null }));
}

/**
 * Пилот: оценка разброса между прогонами, по ней выбирается число повторов
 * r3 (nir3-spec.md, раздел 5). По одному браузеру на машину, разные движки:
 * Mac · Chromium и Windows · Firefox — по r2 это самые шумные платформы.
 * 5 повторов мало для точной оценки разброса, поэтому n считается по его
 * верхней доверительной границе. S3 дёшев и шумнее — повторов больше.
 */
const PILOT_REPEATS: Record<ScenarioId, number> = { s1: 5, s2: 5, s3: 10, s4: 5, s5: 5 };

/**
 * Матрица пула. Порядок — порядок выполнения: основная серия (Chromium,
 * Firefox), затем дополнительная — WebKit на Mac (S1 и S5 в нём не
 * снимаются, см. config.ts, SCENARIOS_BY_BROWSER).
 */
const PLAN: Record<Session, Record<DeviceId, Series[]>> = {
  pilot: {
    D1: series('chromium', ALL, PILOT_REPEATS),
    D2: series('firefox', ALL, PILOT_REPEATS),
  },
  r3: {
    D1: [...series('chromium', ALL), ...series('firefox', ALL), ...series('webkit', ['s2', 's3', 's4'])],
    D2: [...series('chromium', ALL), ...series('firefox', ALL)],
  },
};

/**
 * Оценка длительности серии, мин, при повторах по умолчанию: число прогонов
 * (с прогревом) × (окно записи + прогрев 5 с + открытие окна + пауза 3 с).
 * Уточняется после пилота.
 */
const MINUTES: Record<ScenarioId, number> = { s1: 45, s2: 105, s3: 8, s4: 43, s5: 30 };

function minutes(s: Series): number {
  const def = SCENARIO_DEFAULTS[s.scenario].repeats;
  return (MINUTES[s.scenario] * ((s.repeats ?? def) + 1)) / (def + 1);
}

const seriesId = (s: Series) => `${s.browser}/${s.scenario}`;

interface Args {
  command: 'list' | 'prepare' | 'run';
  session: Session;
  device: DeviceId;
  filter: string | null;
  idleMin: number;
  pauseSec: number;
  yes: boolean;
  /** каталог результатов; по умолчанию results/ — другой только для проверки самой кампании */
  results: string;
}

function parse(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'prepare' && command !== 'run') {
    throw new Error('Команда: list | prepare | run. Пример: npm run campaign -- run --session r3');
  }
  const v = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!.replace(/^--/, '');
    if (k === 'yes') flags.add(k);
    else v.set(k, rest[++i] ?? '');
  }
  const session = (v.get('session') ?? '') as Session;
  if (!(session in PLAN)) throw new Error(`--session ${Object.keys(PLAN).join(' | ')}`);
  const device = (v.get('device') ?? (process.platform === 'darwin' ? 'D1' : process.platform === 'win32' ? 'D2' : '')) as DeviceId;
  if (device !== 'D1' && device !== 'D2') throw new Error('--device D1 | D2 (по умолчанию: macOS → D1, Windows → D2)');
  return {
    command,
    session,
    device,
    filter: v.get('filter') ?? null,
    // протокол: не менее 10 минут без нагрузки после сборки
    idleMin: Number(v.get('idle') ?? 10),
    pauseSec: Number(v.get('pause') ?? 120),
    yes: flags.has('yes'),
    results: v.get('results') ?? join(ROOT, 'results'),
  };
}

function selected(a: Args): Series[] {
  return PLAN[a.session][a.device].filter((s) => a.filter === null || seriesId(s).includes(a.filter));
}

interface Found {
  readonly folder: string;
  readonly complete: boolean;
  readonly commit: string | null;
}

/** серии этой кампании на диске, в том числе прерванные */
function findSeries(a: Args, s: Series): Found[] {
  const dir = join(a.results, deviceSlug(null), s.browser, s.scenario);
  if (!existsSync(dir)) return [];
  const out: Found[] = [];
  for (const folder of readdirSync(dir)) {
    if (!folder.startsWith(`${a.session} `)) continue;
    const path = join(dir, folder, 'manifest.json');
    if (!existsSync(path)) continue;
    const m = JSON.parse(readFileSync(path, 'utf8'));
    out.push({ folder: join(dir, folder), complete: m.finished != null && m.code?.clean === true, commit: m.code?.commit ?? null });
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
    if (!done) left += minutes(s);
    console.log(`  ${done ? '✓' : partial ? '…' : '·'} ${seriesId(s).padEnd(18)}${partial ? ' прервана, будет снята заново' : ''}`);
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
    console.log('\nЧек-лист перед кампанией (docs/MEASURE.md):');
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
  const args = ['run', 'bench', '--', '--scenario', s.scenario, '--browser', s.browser, '--campaign', a.session, '--no-build'];
  if (s.repeats !== null) args.push('--repeats', String(s.repeats));
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
