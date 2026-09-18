import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mulberry32 } from '@bench/scene-spec';
import type {
  BenchResult,
  FrameRunResult,
  InitRunResult,
  InputRunResult,
  ScaleRunResult,
} from '@bench/metrics';
import { BenchPage } from './bench-page.js';
import { launchBrowser, newBenchContext, type LaunchedBrowser } from './browser.js';
import { measureBundles } from './bundle-size.js';
import { effRenderScale, parseArgs, runUrl, type BenchConfig, type LoadPoint, type Target } from './config.js';
import { deviceSlug, hostEnv, thermalSnapshot } from './host-env.js';
import { canvasBox, startClickDriver } from './input-driver.js';
import { runParity } from './parity-check.js';
import { buildImpls, startServers } from './servers.js';
import { Tracer, type GcWindowStats } from './trace.js';

interface ScheduleItem {
  readonly target: Target;
  readonly load: LoadPoint;
  readonly warmup: boolean;
  /** номер итерации (для прогревов — номер прогрева) */
  readonly iteration: number;
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
 * Порядок прогонов. random — рандомизированные блоки: в каждой итерации все
 * варианты в случайном порядке. В НИР2 шли сначала все прогоны three.js, затем
 * все R3F, и медленный дрейф среды (нагрев, фоновые процессы) смешивался с
 * различием технологий. blocked оставлен для контроля этого эффекта.
 */
function buildSchedule(cfg: BenchConfig): ScheduleItem[] {
  const rng = mulberry32(cfg.orderSeed);
  const items: ScheduleItem[] = [];
  // ячейка плана — пара «вариант × точка нагрузки»
  const cells: { target: Target; load: LoadPoint }[] = [];
  for (const load of cfg.loads) for (const target of cfg.targets) cells.push({ target, load });

  for (let w = 1; w <= cfg.warmupRuns; w++) {
    for (const c of shuffled(cells, rng)) items.push({ ...c, warmup: true, iteration: w });
  }
  if (cfg.order === 'blocked') {
    for (const c of cells) {
      for (let i = 1; i <= cfg.iterations; i++) items.push({ ...c, warmup: false, iteration: i });
    }
  } else {
    for (let i = 1; i <= cfg.iterations; i++) {
      for (const c of shuffled(cells, rng)) items.push({ ...c, warmup: false, iteration: i });
    }
  }
  return items;
}

function runTimeoutMs(cfg: BenchConfig): number {
  switch (cfg.scenario) {
    case 's3':
      return cfg.settleMs + 60_000;
    case 's5':
      // построение крупных уровней в state-режиме занимает секунды
      return cfg.levels.length * (cfg.warmupMs + cfg.recordMs * 5 + 20_000) + 60_000;
    default:
      return cfg.warmupMs + cfg.recordMs + 60_000;
  }
}

/**
 * Проверки валидности прогона. fatal — нарушение условий эксперимента
 * (серия прерывается), остальные — предупреждения в манифесте.
 */
function validate(cfg: BenchConfig, lb: LaunchedBrowser, load: LoadPoint, r: BenchResult, consoleErrors: string[]) {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const env = r.meta.env;
  if (cfg.serve === 'preview' && env.buildMode !== 'production') fatal.push(`buildMode=${env.buildMode}`);
  if (!env.crossOriginIsolated) fatal.push('страница не cross-origin isolated');
  if (env.timerResolutionMs > 0.1) warnings.push(`грубый таймер: ${env.timerResolutionMs} мс`);
  const scale = effRenderScale(cfg, load);
  const w = Math.round(1280 * scale);
  const h = Math.round(720 * scale);
  if (env.gl.drawingBufferWidth !== w || env.gl.drawingBufferHeight !== h) {
    fatal.push(`drawing buffer ${env.gl.drawingBufferWidth}×${env.gl.drawingBufferHeight} ≠ ${w}×${h}`);
  }
  if (env.gl.canvasCssWidth !== 1280 || env.gl.canvasCssHeight !== 720) {
    fatal.push(`canvas CSS ${env.gl.canvasCssWidth}×${env.gl.canvasCssHeight} ≠ 1280×720`);
  }
  if (env.renderer.clearAlpha !== 1) fatal.push(`альфа очистки ${env.renderer.clearAlpha} ≠ 1`);
  if (env.renderer.toneMapping !== 0) fatal.push(`tone mapping ${env.renderer.toneMapping} ≠ NoToneMapping`);
  if (r.kind === 'frame' && r.summary.frames < 100) warnings.push(`мало кадров: ${r.summary.frames}`);
  if (r.kind === 'frame' && lb.vsyncUncapped && Math.abs(r.summary.fps_median - 60) < 1.5) {
    warnings.push('median FPS ≈ 60 — похоже, vsync не снят');
  }
  if (r.kind === 'input') {
    if (r.summary.ok < 30) warnings.push(`мало измеренных кликов: ${r.summary.ok}`);
    if (r.summary.timeout > 0) warnings.push(`клики без отклика: ${r.summary.timeout}`);
    // event.timeStamp должен быть в шкале performance.now(); иначе queue и
    // полная задержка бессмысленны (в разных браузерах шкала исторически различалась)
    const q = r.summary.queue_ms_median;
    if (!(q >= 0 && q < 100)) fatal.push(`queue_ms_median=${q}: event.timeStamp не в шкале performance.now()`);
  }
  if (consoleErrors.length > 0) warnings.push(`ошибки консоли: ${consoleErrors.slice(0, 3).join(' | ')}`);
  return { fatal, warnings };
}

async function runOne(
  lb: LaunchedBrowser,
  cfg: BenchConfig,
  item: ScheduleItem,
  tracePath: string | null
): Promise<{ result: BenchResult; consoleErrors: string[]; gc: GcWindowStats[] | null; clicks: number | null }> {
  const context = await newBenchContext(lb);
  try {
    const bp = await BenchPage.open(context);
    if (cfg.scenario === 's3' && lb.supportsCdp) {
      // новый контекст уже с пустым кэшем; CDP — дополнительная гарантия
      const cdp = await context.newCDPSession(bp.page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    }
    const tracer = tracePath && lb.supportsCdp ? await Tracer.start(bp.page) : null;

    await bp.goto(runUrl(cfg, item.target, item.load));

    let driver: { stop(): Promise<number> } | null = null;
    if (cfg.scenario === 's4') {
      await bp.waitFor(['warmup', 'recording'], 60_000);
      // seed по номеру итерации: все варианты итерации получают одинаковые клики
      const seed = cfg.clickSeed + (item.warmup ? -item.iteration : item.iteration) * 7919;
      driver = startClickDriver(bp.page, await canvasBox(bp.page), seed, cfg.clickIntervalMs, () =>
        bp.has('done')
      );
    }

    try {
      await bp.waitFor(['done'], runTimeoutMs(cfg));
    } finally {
      await driver?.stop();
    }
    const clicks = driver ? await driver.stop() : null;
    const result = await bp.result<BenchResult>();
    const gc = tracer ? await tracer.stop(tracePath) : null;
    return { result, consoleErrors: bp.consoleErrors, gc, clicks };
  } finally {
    // закрытие тяжёлого WebGL-контекста иногда зависает — не ждём дольше 15 с
    await Promise.race([context.close().catch(() => undefined), sleep(15_000)]);
  }
}

/** компактная сводка прогона для манифеста и консоли */
function brief(r: BenchResult): Record<string, number | null> {
  const n = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
  switch (r.kind) {
    case 'frame': {
      const s = (r as FrameRunResult).summary;
      return {
        fps_median: n(s.fps_median),
        frame_ms_median: n(s.frame_ms_median),
        frame_ms_p99: n(s.frame_ms_p99),
        fps_p1_low: n(s.fps_p1_low),
        jank_60_share: n(s.jank_60_share),
        update_ms_median: n(s.update_ms_median),
        render_ms_median: n(s.render_ms_median),
        gpu_ms_median: n(s.gpu_ms_median),
        other_ms_median: n(s.other_ms_median),
        heap_mb_peak: n(s.heap_mb_peak),
      };
    }
    case 'init': {
      const i = r as InitRunResult;
      return {
        js_ready_ms: n(i.js_ready_ms),
        ttfr_submit_ms: n(i.ttfr_submit_ms),
        ttfr_frame_ms: n(i.ttfr_frame_ms),
        init_ms: n(i.init_ms),
        first_frame_render_ms: n(i.first_frame_render_ms),
        tbt_to_ttfr_ms: n(i.tbt_to_ttfr_ms),
        heap_mb_at_ttfr: n(i.heap_mb_at_ttfr),
      };
    }
    case 'input': {
      const s = (r as InputRunResult).summary;
      return {
        ok: s.ok,
        miss: s.miss,
        latency_render_ms_median: n(s.latency_render_ms_median),
        latency_render_ms_p95: n(s.latency_render_ms_p95),
        queue_ms_median: n(s.queue_ms_median),
        dispatch_ms_median: n(s.dispatch_ms_median),
        apply_ms_median: n(s.apply_ms_median),
        commit_ms_median: n(s.commit_ms_median),
        frame_wait_ms_median: n(s.frame_wait_ms_median),
        render_ms_median: n(s.render_ms_median),
      };
    }
    case 'scale': {
      const s = r as ScaleRunResult;
      return {
        levels: s.levels.length,
        capacity_fps60: s.capacity_fps60,
        capacity_fps30: s.capacity_fps30,
        first_below_floor: s.first_below_floor,
      };
    }
  }
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function printSummary(runs: { label: string; warmup: boolean; brief: Record<string, number | null> }[]): void {
  const byLabel = new Map<string, Record<string, number | null>[]>();
  for (const r of runs) {
    if (r.warmup) continue;
    (byLabel.get(r.label) ?? byLabel.set(r.label, []).get(r.label)!).push(r.brief);
  }
  const table: Record<string, Record<string, number | null>> = {};
  for (const [label, briefs] of byLabel) {
    const row: Record<string, number | null> = { n: briefs.length };
    for (const k of Object.keys(briefs[0] ?? {})) {
      const v = median(briefs.map((b) => b[k]).filter((x): x is number => x !== null));
      row[k] = v === null ? null : Math.round(v * 1000) / 1000;
    }
    table[label] = row;
  }
  console.log('\n[harness] медианы по итерациям (предварительно; статистика — в анализе):');
  console.table(table);
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(cfg.resultsDir, deviceSlug(cfg.device), cfg.browser, cfg.scenario, stamp);
  await mkdir(join(outDir, 'runs'), { recursive: true });
  console.log(`[harness] ${cfg.scenario} • ${cfg.browser} • ${cfg.targets.map((t) => t.label).join(', ')}`);
  console.log(`[harness] результаты: ${outDir}`);
  if (cfg.serve === 'dev') console.warn('[harness] ВНИМАНИЕ: dev-сервер — данные непригодны для анализа');

  if (cfg.build && cfg.serve === 'preview') buildImpls();
  const bundles = cfg.serve === 'preview' ? await measureBundles() : null;
  const servers = await startServers(cfg);
  let lb: LaunchedBrowser | null = null;

  const manifest: Record<string, unknown> & { runs: unknown[] } = {
    schema: 2,
    createdAt: new Date().toISOString(),
    config: cfg,
    host: hostEnv(),
    browser: null,
    servers: servers.info,
    bundles,
    parity: null,
    schedule: [],
    runs: [],
  };
  const saveManifest = () => writeFile(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  try {
    lb = await launchBrowser(cfg.browser);
    manifest.browser = {
      name: lb.name,
      version: lb.version,
      launchArgs: lb.launchArgs,
      prefs: lb.prefs,
      vsyncUncapped: lb.vsyncUncapped,
    };
    console.log(`[harness] браузер ${lb.name} ${lb.version}`);
    await saveManifest();

    if (!cfg.skipParity) {
      const reports = [];
      for (const load of cfg.loads) reports.push(await runParity(lb, cfg, load));
      manifest.parity = reports;
      await writeFile(join(outDir, 'parity.json'), JSON.stringify(reports, null, 2));
      await saveManifest();
      if (reports.some((r) => !r.ok)) {
        throw new Error('Паритет сцен нарушен — замеры не проводятся (см. parity.json)');
      }
    } else {
      console.warn('[harness] ВНИМАНИЕ: проверка паритета пропущена');
    }
    if (cfg.parityOnly) return;

    const schedule = buildSchedule(cfg);
    manifest.schedule = schedule.map((s) => ({ label: s.target.label, load: s.load.id, warmup: s.warmup, iteration: s.iteration }));
    const briefs: { label: string; warmup: boolean; brief: Record<string, number | null> }[] = [];

    for (let idx = 0; idx < schedule.length; idx++) {
      const item = schedule[idx]!;
      const loadTag = item.load.id === '-' ? '' : `_${item.load.id}`;
      const tag = `${String(idx + 1).padStart(3, '0')}_${item.target.label}${loadTag}_${item.warmup ? 'w' : 'i'}${item.iteration}`;
      if (idx > 0) await sleep(cfg.cooldownMs);
      const thermal = thermalSnapshot();
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      console.log(
        `[harness] ${idx + 1}/${schedule.length} ${item.target.label}${item.load.id === '-' ? '' : ` [${item.load.id}]`} ` +
          `${item.warmup ? `прогрев ${item.iteration}` : `итерация ${item.iteration}`}`
      );
      const tracePath = cfg.trace ? join(outDir, 'traces', `${tag}.json.gz`) : null;
      const { result, consoleErrors, gc, clicks } = await runOne(lb, cfg, item, tracePath);
      const validity = validate(cfg, lb, item.load, result, consoleErrors);
      const b = brief(result);
      console.log(`           ${JSON.stringify(b)}`);
      for (const wmsg of validity.warnings) console.warn(`           ⚠ ${wmsg}`);

      const file = `runs/${tag}.json`;
      await writeFile(
        join(outDir, file),
        JSON.stringify({
          label: item.target.label,
          load: item.load.id,
          warmup: item.warmup,
          iteration: item.iteration,
          startedAt,
          durationMs: Date.now() - t0,
          thermal,
          validity,
          consoleErrors,
          clicksSent: clicks,
          gc,
          result,
        })
      );
      manifest.runs.push({
        file,
        label: item.target.label,
        load: item.load.id,
        warmup: item.warmup,
        iteration: item.iteration,
        startedAt,
        durationMs: Date.now() - t0,
        thermal: thermal.therm,
        validity,
        brief: b,
      });
      briefs.push({ label: item.target.label + (item.load.id === '-' ? '' : ` [${item.load.id}]`), warmup: item.warmup, brief: b });
      await saveManifest();
      if (validity.fatal.length > 0) {
        throw new Error(`Нарушены условия эксперимента в ${tag}: ${validity.fatal.join('; ')}`);
      }
    }
    printSummary(briefs);
  } finally {
    await saveManifest();
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
