import { chromium, type Browser, type Page } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BenchResult,
  BenchInitResult,
  BenchInputResult,
  BenchScaleResult,
} from '@bench/metrics';
import { parseArgs, type BenchConfig, type ImplTarget } from './config.js';
import { runBundleSizeReport, type BundleSizeReport } from './bundle-size.js';

type AnyResult = BenchResult | BenchInitResult | BenchInputResult | BenchScaleResult;

interface IterationOutcome {
  readonly label: string;
  readonly iteration: number;
  readonly result: AnyResult;
}

function buildUrl(target: ImplTarget, cfg: BenchConfig): string {
  const params = new URLSearchParams({
    scenario: cfg.scenarioId,
    warmup: String(cfg.warmupMs),
    record: String(cfg.recordMs),
    quiet: String(cfg.quietWindowMs),
    ttiTimeout: String(cfg.ttiTimeoutMs),
    clickInterval: String(cfg.clickIntervalMs),
    seed: String(cfg.seed),
    fpsFloor: String(cfg.fpsFloor),
    levels: cfg.levels.join(','),
  });
  if (target.mode) params.set('mode', target.mode);
  return `${target.baseUrl}/?${params.toString()}`;
}

async function runIteration(
  browser: Browser,
  target: ImplTarget,
  cfg: BenchConfig,
  iteration: number
): Promise<IterationOutcome> {
  // Свежий context на каждый прогон → у S3 это даёт "холодный" HTTP-кэш,
  // что и есть смысл cold-start измерения.
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });

  const page: Page = await context.newPage();

  // Для S3 дополнительно отключаем HTTP-кэш на уровне CDP, чтобы между
  // итерациями не подхватывались артефакты предыдущей загрузки.
  if (cfg.scenarioId === 's3') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  }

  await page.goto(buildUrl(target, cfg), { waitUntil: 'load' });

  const timeoutMs =
    cfg.scenarioId === 's3'
      ? cfg.ttiTimeoutMs + 15_000
      : cfg.scenarioId === 's5'
        ? cfg.levels.length * (cfg.warmupMs + cfg.recordMs) + 30_000
        : cfg.warmupMs + cfg.recordMs + 15_000;

  const result: AnyResult = await page
    .waitForFunction(
      () => {
        const bench = (
          window as unknown as { __BENCH__?: { status: string; result: AnyResult | null } }
        ).__BENCH__;
        return bench?.status === 'done' && bench.result ? bench.result : null;
      },
      null,
      { timeout: timeoutMs, polling: 250 }
    )
    .then((handle) => handle.jsonValue() as Promise<AnyResult>);

  await context.close();
  return { label: target.label, iteration, result };
}

function isFrame(r: AnyResult): r is BenchResult {
  return r.kind === 'frame';
}

function isInit(r: AnyResult): r is BenchInitResult {
  return r.kind === 'init';
}

function isInput(r: AnyResult): r is BenchInputResult {
  return r.kind === 'input';
}

function isScale(r: AnyResult): r is BenchScaleResult {
  return r.kind === 'scale';
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function summarizeFrame(results: BenchResult[]): Record<string, unknown> {
  const pick = (k: keyof BenchResult): number[] =>
    results.map((r) => (r[k] as number) ?? 0);
  return {
    iterations: results.length,
    fps_avg: avg(pick('fps_avg')),
    fps_p1_low: avg(pick('fps_p1_low')),
    frame_time_ms_avg: avg(pick('frame_time_ms_avg')),
    frame_time_ms_stddev: avg(pick('frame_time_ms_stddev')),
    frame_time_ms_p99: avg(pick('frame_time_ms_p99')),
    heap_mb_peak: avg(pick('heap_mb_peak')),
  };
}

function summarizeInit(results: BenchInitResult[]): Record<string, unknown> {
  const pick = (k: keyof BenchInitResult): number[] =>
    results
      .map((r) => r[k])
      .filter((x): x is number => typeof x === 'number');
  const ttfr = pick('ttfr_ms');
  const tti = pick('tti_ms');
  return {
    iterations: results.length,
    ttfr_ms_avg: avg(ttfr),
    ttfr_ms_median: median(ttfr),
    ttfr_ms_stddev: stddev(ttfr),
    ttfr_ms_min: ttfr.length ? Math.min(...ttfr) : 0,
    ttfr_ms_max: ttfr.length ? Math.max(...ttfr) : 0,
    tti_ms_avg: avg(tti),
    tti_ms_median: median(tti),
    tti_ms_stddev: stddev(tti),
    first_frame_duration_ms_avg: avg(pick('first_frame_duration_ms')),
    heap_mb_at_first_frame_avg: avg(pick('heap_mb_at_first_frame')),
    heap_mb_at_tti_avg: avg(pick('heap_mb_at_tti')),
    long_tasks_count_avg: avg(pick('long_tasks_count')),
    long_tasks_total_ms_avg: avg(pick('long_tasks_total_ms')),
  };
}

function summarizeInput(results: BenchInputResult[]): Record<string, unknown> {
  const pick = (k: keyof BenchInputResult): number[] =>
    results
      .map((r) => r[k])
      .filter((x): x is number => typeof x === 'number');
  return {
    iterations: results.length,
    recorded_samples_avg: avg(pick('recorded_samples')),
    missed_clicks_avg: avg(pick('missed_clicks')),
    input_latency_ms_avg: avg(pick('input_latency_ms_avg')),
    input_latency_ms_median_avg: avg(pick('input_latency_ms_median')),
    input_latency_ms_p95_avg: avg(pick('input_latency_ms_p95')),
    input_latency_ms_p99_avg: avg(pick('input_latency_ms_p99')),
    input_latency_ms_max_avg: avg(pick('input_latency_ms_max')),
    input_latency_ms_stddev_avg: avg(pick('input_latency_ms_stddev')),
    frames_to_feedback_avg: avg(pick('frames_to_feedback_avg')),
    heap_mb_peak_avg: avg(pick('heap_mb_peak')),
  };
}

function summarizeScale(results: BenchScaleResult[]): Record<string, unknown> {
  const degs = results
    .map((r) => r.degradation_count)
    .filter((x): x is number => typeof x === 'number');

  // median FPS по каждому уровню, усреднённый по итерациям
  const byCount = new Map<number, number[]>();
  for (const r of results) {
    for (const lvl of r.levels) {
      (byCount.get(lvl.count) ?? byCount.set(lvl.count, []).get(lvl.count)!).push(
        lvl.fps_median
      );
    }
  }
  const perLevel: Record<string, number> = {};
  for (const [count, fpsList] of [...byCount.entries()].sort((a, b) => a[0] - b[0])) {
    perLevel[String(count)] = avg(fpsList);
  }

  return {
    iterations: results.length,
    degradation_count_avg: avg(degs),
    degradation_count_min: degs.length ? Math.min(...degs) : null,
    degradation_count_max: degs.length ? Math.max(...degs) : null,
    // сколько прогонов вообще достигли деградации в пределах уровней
    degraded_iterations: degs.length,
    fps_median_by_count: perLevel,
  };
}

function summarize(outcomes: readonly IterationOutcome[]): Record<string, unknown> {
  const byLabel: Record<string, AnyResult[]> = {};
  for (const o of outcomes) {
    (byLabel[o.label] ??= []).push(o.result);
  }
  const summary: Record<string, unknown> = {};
  for (const [label, results] of Object.entries(byLabel)) {
    if (results.every(isFrame)) {
      summary[label] = summarizeFrame(results);
    } else if (results.every(isInit)) {
      summary[label] = summarizeInit(results);
    } else if (results.every(isInput)) {
      summary[label] = summarizeInput(results);
    } else if (results.every(isScale)) {
      summary[label] = summarizeScale(results);
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  console.log(
    `[harness] scenario=${cfg.scenarioId} iterations=${cfg.iterations} ` +
      `warmupRuns=${cfg.warmupRuns} (discarded)`
  );
  if (cfg.scenarioId === 's3') {
    console.log(`[harness] quietWindow=${cfg.quietWindowMs}ms ttiTimeout=${cfg.ttiTimeoutMs}ms`);
  } else if (cfg.scenarioId === 's5') {
    console.log(
      `[harness] per-level warmup=${cfg.warmupMs}ms record=${cfg.recordMs}ms ` +
        `fpsFloor=${cfg.fpsFloor} levels=[${cfg.levels.join(', ')}]`
    );
  } else {
    console.log(`[harness] warmup=${cfg.warmupMs}ms record=${cfg.recordMs}ms`);
  }
  console.log(`[harness] targets: ${cfg.targets.map((t) => t.label).join(', ')}`);

  await mkdir(cfg.resultsDir, { recursive: true });

  let bundleSize: readonly BundleSizeReport[] | null = null;
  if (cfg.scenarioId === 's3') {
    // Бандл собираем один раз перед прогонами TTFR/TTI.
    // Сборка кэшируется Vite, повторно не дёргаем.
    bundleSize = await runBundleSizeReport({ build: true });
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--use-gl=angle',
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
    ],
  });

  const outcomes: IterationOutcome[] = [];

  try {
    for (const target of cfg.targets) {
      // Прогрев браузера: первые прогоны отбрасываем — они ловят холодный
      // выброс (JIT, инициализация компилятора шейдеров, дисковый кэш).
      for (let w = 1; w <= cfg.warmupRuns; w++) {
        console.log(`[harness] ${target.label} • warm-up ${w}/${cfg.warmupRuns} (discarded)`);
        await runIteration(browser, target, cfg, 0);
      }
      for (let i = 1; i <= cfg.iterations; i++) {
        console.log(`[harness] ${target.label} • iteration ${i}/${cfg.iterations}`);
        const outcome = await runIteration(browser, target, cfg, i);
        outcomes.push(outcome);
        const r = outcome.result;
        if (isFrame(r)) {
          console.log(
            `  → fps_avg=${r.fps_avg.toFixed(1)}  p1_low=${r.fps_p1_low.toFixed(1)}  ` +
              `frame_ms_avg=${r.frame_time_ms_avg.toFixed(2)}±${r.frame_time_ms_stddev.toFixed(2)}`
          );
        } else if (isInput(r)) {
          console.log(
            `  → lat_avg=${r.input_latency_ms_avg.toFixed(2)}ms  ` +
              `median=${r.input_latency_ms_median.toFixed(2)}ms  ` +
              `p95=${r.input_latency_ms_p95.toFixed(2)}ms  ` +
              `frames=${r.frames_to_feedback_avg.toFixed(2)}  ` +
              `samples=${r.recorded_samples}/${r.dispatched_clicks}`
          );
        } else if (isScale(r)) {
          const deg = r.degradation_count === null ? 'none' : `${r.degradation_count}`;
          const sweep = r.levels
            .map((l) => `${l.count}:${l.fps_median.toFixed(0)}`)
            .join(' ');
          console.log(`  → degradation=${deg} (fps<${r.fpsFloor})  [count:fps] ${sweep}`);
        } else {
          const tti = r.tti_ms === null ? 'n/a' : `${r.tti_ms.toFixed(0)}ms`;
          console.log(
            `  → ttfr=${r.ttfr_ms.toFixed(0)}ms  tti=${tti}  ` +
              `heap_ff=${r.heap_mb_at_first_frame?.toFixed(1) ?? 'n/a'}MB  ` +
              `longtasks=${r.long_tasks_count}`
          );
        }
      }
    }
  } finally {
    // Результаты пишем ДО закрытия браузера: на тяжёлых сценах (S5)
    // browser.close() иногда зависает на освобождении WebGL-контекста, и файл
    // иначе вообще не успевает сформироваться.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = join(cfg.resultsDir, `${cfg.scenarioId}-${stamp}.json`);
    const payload = {
      config: cfg,
      bundleSize,
      outcomes,
      summary: summarize(outcomes),
    };
    await writeFile(outFile, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`[harness] wrote ${outFile}`);
    console.log('[harness] summary:');
    console.log(JSON.stringify(payload.summary, null, 2));

    // Закрываем браузер с таймаутом: если close() завис на разрушении тяжёлого
    // WebGL-контекста, не ждём его дольше 10 c. Гарантированное завершение
    // процесса даёт process.exit(0) ниже (результаты уже записаны выше).
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
