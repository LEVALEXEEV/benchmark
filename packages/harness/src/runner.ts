import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32 } from '@bench/scene-spec';
import type { BenchResult, PageEnv } from '@bench/metrics';
import { BenchPage } from './bench-page.js';
import { launchBrowser, newBenchContext, type LaunchedBrowser } from './browser.js';
import { measureBundles } from './bundle-size.js';
import {
  CLICKS,
  effRenderScale,
  PINNED_BROWSER_VERSIONS,
  parseArgs,
  runUrl,
  SWEEP,
  type BenchConfig,
  type LoadPoint,
  type Target,
} from './config.js';
import { codeGitState, deviceInfo, libVersions } from './host-env.js';
import { canvasBox, startClickDriver } from './input-driver.js';
import { toCsv } from './output.js';
import { runParity } from './parity-check.js';
import { buildImpls, startServers } from './servers.js';

/**
 * Серия: проверки → сборка → паритет → прогоны в случайном порядке → CSV на
 * прогон и manifest.json (формат — docs/DATA.md). Harness ничего не считает
 * из замеров: метрики — дело анализа.
 */

interface ScheduleItem {
  readonly target: Target;
  readonly load: LoadPoint;
  /** прогревочный прогон: выполняется, но не сохраняется */
  readonly warmup: boolean;
  /** номер повтора внутри ячейки (у прогревов — номер прогрева) */
  readonly repeat: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shuffled<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Рандомизированные блоки: в каждом повторе все ячейки («вариант × точка
 * нагрузки») в случайном порядке. В НИР2 шли сначала все прогоны three.js,
 * затем все R3F, и медленный дрейф среды смешивался с различием технологий.
 */
function buildSchedule(cfg: BenchConfig): ScheduleItem[] {
  const rng = mulberry32(cfg.orderSeed);
  const cells: { target: Target; load: LoadPoint }[] = [];
  for (const load of cfg.loads) for (const target of cfg.targets) cells.push({ target, load });
  const items: ScheduleItem[] = [];
  for (let w = 1; w <= cfg.warmupRuns; w++) {
    for (const c of shuffled(cells, rng)) items.push({ ...c, warmup: true, repeat: w });
  }
  for (let i = 1; i <= cfg.repeats; i++) {
    for (const c of shuffled(cells, rng)) items.push({ ...c, warmup: false, repeat: i });
  }
  return items;
}

/** попыток на прогон: сбой браузера повторяется один раз */
const MAX_ATTEMPTS = 2;

/** пауза после открытия окна до загрузки стенда (см. runOne) */
const WINDOW_READY_MS = 1000;

function runTimeoutMs(cfg: BenchConfig): number {
  if (cfg.scenario === 's3') return 60_000;
  // построение крупных уровней S5 в R3F занимает секунды
  if (cfg.scenario === 's5') return SWEEP.levels.length * (cfg.warmupMs + cfg.recordMs * 5 + 20_000) + 60_000;
  return cfg.warmupMs + cfg.recordMs + 60_000;
}

/**
 * Нарушения условий эксперимента — факты, а не догадки: прогон с ними
 * останавливает серию.
 */
function violations(load: LoadPoint, r: BenchResult, consoleErrors: string[]): string[] {
  const out: string[] = [];
  const env = r.meta.env;
  if (env.buildMode !== 'production') out.push(`сборка ${env.buildMode}, а не production`);
  if (!env.crossOriginIsolated) out.push('страница не cross-origin isolated — таймер огрублён');
  const scale = effRenderScale(load);
  const w = Math.round(1280 * scale);
  const h = Math.round(720 * scale);
  if (env.gl.drawingBufferWidth !== w || env.gl.drawingBufferHeight !== h) {
    out.push(`буфер кадра ${env.gl.drawingBufferWidth}×${env.gl.drawingBufferHeight} ≠ ${w}×${h}`);
  }
  if (env.gl.canvasCssWidth !== 1280 || env.gl.canvasCssHeight !== 720) {
    out.push(`холст ${env.gl.canvasCssWidth}×${env.gl.canvasCssHeight} ≠ 1280×720`);
  }
  if (env.renderer.clearAlpha !== 1) out.push(`альфа очистки ${env.renderer.clearAlpha} ≠ 1`);
  if (env.renderer.toneMapping !== 0) out.push(`tone mapping ${env.renderer.toneMapping} ≠ NoToneMapping`);
  if (r.kind === 'input') {
    // event.timeStamp должен быть в шкале performance.now(), иначе отметка
    // события несопоставима с остальными (в браузерах шкала исторически
    // различалась). При чужой шкале разница отрицательна или порядка часов
    // и лет, поэтому граница в минуту не задевает реальные задержки.
    const bad = r.clicks.find((c) => !(c.handler_start_ms - c.event_ms >= 0 && c.handler_start_ms - c.event_ms < 60_000));
    if (bad) out.push(`клик ${bad.click}: event.timeStamp не в шкале performance.now()`);
  }
  if (consoleErrors.length > 0) out.push(`ошибки страницы: ${consoleErrors.slice(0, 3).join(' | ')}`);
  return out;
}

async function runOne(lb: LaunchedBrowser, cfg: BenchConfig, item: ScheduleItem): Promise<{ result: BenchResult; consoleErrors: string[] }> {
  const context = await newBenchContext(lb);
  try {
    const bp = await BenchPage.open(context);
    // Каждый прогон — новый контекст: новое окно и холодный кэш. Если страница
    // успевала исполнить скрипт раньше, чем окно готово показывать кадры,
    // первый requestAnimationFrame ждал ≈ 40 мс (на M4 — в 40% холодных
    // загрузок S3). Окно открывается заранее, как вкладка у пользователя.
    await bp.page.goto('about:blank');
    await sleep(WINDOW_READY_MS);
    await bp.goto(runUrl(cfg, item.target, item.load));

    let driver: { stop(): Promise<number> } | null = null;
    if (cfg.scenario === 's4') {
      await bp.waitFor(['warmup', 'recording'], 60_000);
      // seed по номеру повтора: все варианты повтора получают одинаковые клики
      const seed = CLICKS.seed + (item.warmup ? -item.repeat : item.repeat) * 7919;
      driver = startClickDriver(bp.page, await canvasBox(bp.page), seed, CLICKS.intervalMs, () => bp.has('done'));
    }
    try {
      await bp.waitFor(['done'], runTimeoutMs(cfg));
    } finally {
      await driver?.stop();
    }
    return { result: await bp.result<BenchResult>(), consoleErrors: bp.consoleErrors };
  } finally {
    // закрытие тяжёлого WebGL-контекста иногда зависает — не ждём дольше 15 с
    await Promise.race([context.close().catch(() => undefined), sleep(15_000)]);
  }
}

function pageInfo(env: PageEnv) {
  return {
    build: env.buildMode,
    isolated: env.crossOriginIsolated,
    timer_resolution_ms: Math.round(env.timerResolutionMs * 1000) / 1000,
    canvas: `${env.gl.canvasCssWidth}x${env.gl.canvasCssHeight}`,
    device_pixel_ratio: env.devicePixelRatio,
  };
}

function settings(cfg: BenchConfig): Record<string, unknown> {
  const s: Record<string, unknown> = {
    variants: cfg.targets.map((t) => t.label),
    repeats: cfg.repeats,
    warmup_runs: cfg.warmupRuns,
    order: 'random',
    order_seed: cfg.orderSeed,
  };
  if (cfg.scenario !== 's3') Object.assign(s, { warmup_ms: cfg.warmupMs, record_ms: cfg.recordMs });
  s.pause_ms = cfg.pauseMs;
  if (cfg.scenario === 's1') s.loads = cfg.loads;
  if (cfg.scenario === 's4') {
    Object.assign(s, { click_interval_ms: CLICKS.intervalMs, click_seed: CLICKS.seed, click_timeout_ms: CLICKS.timeoutMs });
  }
  if (cfg.scenario === 's5') {
    Object.assign(s, { levels: SWEEP.levels, fps_floor: SWEEP.fpsFloor, levels_beyond_floor: SWEEP.levelsBeyondFloor, min_level_frames: SWEEP.minLevelFrames });
    // в S5 окна — на уровень
    s.level_warmup_ms = s.warmup_ms;
    s.level_record_ms = s.record_ms;
    delete s.warmup_ms;
    delete s.record_ms;
  }
  return s;
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const created = new Date();
  const stamp = created.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  const series = cfg.campaign ? `${cfg.campaign} ${stamp}` : stamp;

  const git = codeGitState();
  if (!cfg.parityOnly && git.dirty !== false && !cfg.allowDirty) {
    const what = git.dirty === null ? 'состояние git неизвестно' : `незакоммиченный код: ${git.dirtyFiles.join(', ')}`;
    throw new Error(`${what}\nЗакоммитьте код перед серией (для отладки — --allow-dirty).`);
  }
  const device = deviceInfo(cfg.device);
  const outDir = join(cfg.resultsDir, device.id, cfg.browser, cfg.scenario, series);
  console.log(`[harness] ${cfg.scenario} • ${cfg.browser} • ${cfg.targets.map((t) => t.label).join(', ')}`);

  if (cfg.build) buildImpls();
  const bundles = cfg.scenario === 's3' ? await measureBundles() : null;
  const servers = await startServers();
  let lb: LaunchedBrowser | null = null;

  const manifest: Record<string, unknown> & { runs: unknown[]; retries: unknown[] } = {
    series,
    scenario: cfg.scenario,
    created: created.toISOString().replace(/\.\d+Z$/, 'Z'),
    // null — серия не завершена (сбой, Ctrl+C); кампания снимает её заново
    finished: null,
    device: { ...device, gpu: null as string | null },
    browser: null,
    code: { commit: git.commit, clean: git.dirty === false },
    libs: libVersions(),
    page: null,
    settings: settings(cfg),
    parity: null,
    ...(bundles ? { bundles } : {}),
    runs: [],
    retries: [],
  };
  const saveManifest = () => writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  try {
    lb = await launchBrowser(cfg.browser);
    const pinned = PINNED_BROWSER_VERSIONS[cfg.browser];
    if (lb.version !== pinned) {
      throw new Error(
        `${lb.name} ${lb.version} ≠ ${pinned} из пула (config.ts, PINNED_BROWSER_VERSIONS).\n` +
          'Установите сборки командой `npm run browsers`.'
      );
    }
    manifest.browser = { name: lb.name, version: lb.version, flags: lb.flags };
    console.log(`[harness] браузер ${lb.name} ${lb.version}`);

    // Паритет: все варианты сравниваются с three.js — сцена, камера, свет,
    // меши и сам кадр. При расхождении серия не снимается.
    const reports = [];
    for (const load of cfg.loads) reports.push(await runParity(lb, cfg, load));
    const parityOk = reports.every((r) => r.ok);
    const issues = reports.flatMap((r) => r.entries.flatMap((e) => e.issues.map((i) => `${r.load} ${e.label}: ${i}`)));
    manifest.parity = {
      ok: parityOk,
      frame_identical: reports.every((r) => r.entries.every((e) => e.image.exact)),
      ...(issues.length ? { issues } : {}),
    };
    if (cfg.parityOnly) return;
    await mkdir(join(outDir, 'runs'), { recursive: true });
    console.log(`[harness] результаты: ${outDir}`);
    if (!parityOk) {
      await saveManifest();
      throw new Error('Паритет сцен нарушен — замеры не проводятся (см. manifest.json)');
    }
    await saveManifest();

    const schedule = buildSchedule(cfg);
    let saved = 0;
    for (let idx = 0; idx < schedule.length; idx++) {
      const item = schedule[idx]!;
      const where = `${item.target.label}${item.load.id === '-' ? '' : ` [${item.load.id}]`}`;
      const tag = `${String(saved + 1).padStart(3, '0')}_${item.target.label}${item.load.id === '-' ? '' : `_${item.load.id}`}_${item.repeat}`;
      if (idx > 0) await sleep(cfg.pauseMs);
      console.log(`[harness] ${idx + 1}/${schedule.length} ${where} ${item.warmup ? `прогрев ${item.repeat}` : `повтор ${item.repeat}`}`);

      // Сбой браузера (таймаут, падение страницы) повторяется один раз: иначе
      // случайный сбой обрывал бы многочасовую серию. Нарушения условий
      // эксперимента не повторяются.
      let started = new Date();
      let out: Awaited<ReturnType<typeof runOne>>;
      for (let attempt = 1; ; attempt++) {
        try {
          out = await runOne(lb, cfg, item);
          break;
        } catch (e) {
          const error = (e instanceof Error ? e.message : String(e)).split('\n').slice(0, 3).join(' | ');
          manifest.retries.push({ run: item.warmup ? `прогрев ${where} ${item.repeat}` : tag, attempt, error });
          await saveManifest();
          if (attempt >= MAX_ATTEMPTS) throw e;
          console.warn(`           сбой прогона: ${error} — повтор`);
          await sleep(cfg.pauseMs * 3);
          started = new Date();
        }
      }
      const { result, consoleErrors } = out;
      const broken = violations(item.load, result, consoleErrors);
      if (broken.length > 0) throw new Error(`Нарушены условия эксперимента (${where}): ${broken.join('; ')}`);
      if (manifest.page === null) {
        manifest.page = pageInfo(result.meta.env);
        (manifest.device as { gpu: string | null }).gpu = result.meta.env.gl.renderer;
      }
      if (item.warmup) continue;

      saved++;
      const file = `runs/${tag}.csv`;
      await writeFile(join(outDir, file), toCsv(result));
      manifest.runs.push({
        file,
        variant: item.target.label,
        ...(item.load.id === '-' ? {} : { load: item.load.id }),
        repeat: item.repeat,
        started: started.toISOString().replace(/\.\d+Z$/, 'Z'),
      });
      await saveManifest();
    }
    manifest.finished = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    console.log(`[harness] серия завершена: ${saved} прогонов`);
  } finally {
    if (!cfg.parityOnly) await saveManifest().catch(() => undefined);
    if (lb) await Promise.race([lb.browser.close().catch(() => undefined), sleep(15_000)]);
    servers.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
