import { FrameRecorder } from './frame-recorder.js';
import { bench, type FrameProbe } from './runtime.js';
import { mean, median, percentile, sortedFinite } from './stats.js';
import type { FrameRaw, FrameSummary, InputRunResult, InputSample } from './types.js';

export interface InputCollectorConfig {
  readonly warmupMs: number;
  readonly recordMs: number;
  /** клик без отклика дольше этого считается timeout */
  readonly timeoutMs: number;
}

interface Pending {
  readonly seq: number;
  readonly recorded: boolean;
  readonly eventTs: number;
  readonly captureTs: number;
  dispatchEndTs: number;
  hit: boolean;
  hitTs: number;
  isApplied: (() => boolean) | null;
  appliedTs: number;
  appliedInferred: boolean;
  feedbackRenderStart: number;
  feedbackRenderEnd: number;
  /** начатых кадров с момента события */
  frames: number;
  /** номер кадра (1 — первый после события), в котором отрисован отклик */
  feedbackFrame: number;
}

type InputMeasures = Omit<InputRunResult, 'kind' | 'meta'>;

/**
 * S4: задержка «ввод → отрисованный отклик».
 *
 * Как устроено (и чем отличается от НИР2):
 *   - клики подаёт harness через CDP / Playwright (Input.dispatchMouseEvent):
 *     событие проходит настоящий конвейер ввода браузера и приходит в
 *     СЛУЧАЙНОЙ фазе относительно кадра. В НИР2 коллектор сам диспатчил
 *     синтетическое событие изнутри своего кадрового хука, причём в three.js
 *     после render(), а в R3F — до него; разница 0,35 против 4,85 мс была
 *     артефактом этого порядка;
 *   - начало отсчёта — event.timeStamp (момент создания события браузером);
 *   - отклик считается применённым по фактическому состоянию сцены
 *     (реализация передаёт проверку цвета материала), а не по токену,
 *     который реализация сама выставляет;
 *   - конец отсчёта — конец renderer.render() кадра, в начале которого
 *     отклик уже был в сцене.
 *
 * Слушатели: capture на canvas (срабатывает раньше обработчиков реализации
 * и R3F) и bubble на window (срабатывает после всех синхронных обработчиков).
 */
export class InputCollector implements FrameProbe {
  private readonly cfg: InputCollectorConfig;
  private phase: 'idle' | 'warmup' | 'recording' | 'draining' | 'done' = 'idle';
  private warmStart = NaN;
  private recordStart = NaN;
  private recorder: FrameRecorder | null = null;
  private pending: Pending | null = null;
  private seqCounter = 0;
  private readonly samples: InputSample[] = [];
  private onDoneCb: ((m: InputMeasures) => void) | null = null;
  private detach: (() => void) | null = null;

  constructor(cfg: InputCollectorConfig) {
    this.cfg = cfg;
  }

  onDone(cb: (m: InputMeasures) => void): void {
    this.onDoneCb = cb;
  }

  /** порядковый номер клика, обрабатываемого прямо сейчас (читать в обработчике) */
  get clickSeq(): number {
    return this.pending?.seq ?? 0;
  }

  attach(canvas: HTMLElement): void {
    const onCapture = (e: PointerEvent): void => this.onPointerDownCapture(e);
    const onBubble = (): void => this.onPointerDownBubble();
    canvas.addEventListener('pointerdown', onCapture, { capture: true });
    window.addEventListener('pointerdown', onBubble);
    this.detach = () => {
      canvas.removeEventListener('pointerdown', onCapture, { capture: true });
      window.removeEventListener('pointerdown', onBubble);
    };
  }

  /**
   * Реализация сообщает о попадании raycast'а. isApplied должна возвращать
   * true, когда объект УЖЕ имеет цвет отклика этого клика.
   */
  reportHit(isApplied: () => boolean): void {
    const p = this.pending;
    if (!p || p.hit) return;
    p.hit = true;
    p.hitTs = performance.now();
    p.isApplied = isApplied;
    if (isApplied()) p.appliedTs = p.hitTs;
  }

  /**
   * Необязательный точный сигнал «отклик закоммичен» (useLayoutEffect в R3F).
   * Без него момент применения определяется в начале следующего рендера.
   */
  noteApplied(seq: number): void {
    const p = this.pending;
    if (!p || p.seq !== seq || !Number.isNaN(p.appliedTs)) return;
    if (p.isApplied?.()) p.appliedTs = performance.now();
  }

  beginFrame(now: number): void {
    if (this.phase === 'done') return;
    if (this.phase === 'idle') {
      this.phase = 'warmup';
      this.warmStart = now;
      bench.setStatus('warmup');
    }
    if (this.phase === 'warmup' && now - this.warmStart >= this.cfg.warmupMs) {
      this.phase = 'recording';
      this.recordStart = now;
      this.recorder = new FrameRecorder(now);
      bench.mark('record-start');
      bench.setStatus('recording');
    }

    const p = this.pending;
    if (p) {
      p.frames++;
      if (!Number.isNaN(p.feedbackRenderEnd)) {
        this.finalize(p, 'ok', now);
      } else if (now - p.captureTs > this.cfg.timeoutMs) {
        this.finalize(p, 'timeout', now);
      }
    }

    if (this.phase === 'recording' && now - this.recordStart >= this.cfg.recordMs) {
      this.recorder!.finish(now);
      bench.mark('record-end');
      this.phase = 'draining';
    }
    if (this.phase === 'draining' && this.pending === null) {
      this.complete();
      return;
    }
    if (this.phase === 'recording') this.recorder!.beginFrame(now);
  }

  beginRender(now: number): void {
    if (this.phase === 'recording') this.recorder!.beginRender(now);
    const p = this.pending;
    if (!p || !p.hit || !Number.isNaN(p.feedbackRenderStart)) return;
    if (Number.isNaN(p.appliedTs) && p.isApplied?.()) {
      p.appliedTs = now;
      p.appliedInferred = true;
    }
    if (!Number.isNaN(p.appliedTs)) {
      p.feedbackRenderStart = now;
      p.feedbackFrame = p.frames;
    }
  }

  endRender(now: number): void {
    if (this.phase === 'recording') this.recorder!.endRender(now);
    const p = this.pending;
    if (p && !Number.isNaN(p.feedbackRenderStart) && Number.isNaN(p.feedbackRenderEnd)) {
      p.feedbackRenderEnd = now;
    }
  }

  private onPointerDownCapture(e: PointerEvent): void {
    // при дозаписи новые клики не принимаются: иначе непрерывный поток кликов
    // от harness не даёт «висящему» клику освободиться и завершить прогон
    if (this.phase === 'idle' || this.phase === 'done' || this.phase === 'draining') return;
    const now = performance.now();
    const prev = this.pending;
    if (prev) {
      // отклик предыдущего клика уже отрисован, но следующий кадр ещё не начался:
      // выборка валидна, только latency_frame неизвестна
      if (!Number.isNaN(prev.feedbackRenderEnd)) this.finalize(prev, 'ok', NaN);
      else this.finalize(prev, 'superseded', now);
    }
    this.pending = {
      seq: ++this.seqCounter,
      // клики, начавшиеся в прогреве или при дозаписи, в выборку не идут
      recorded: this.phase === 'recording',
      eventTs: e.timeStamp,
      captureTs: now,
      dispatchEndTs: NaN,
      hit: false,
      hitTs: NaN,
      isApplied: null,
      appliedTs: NaN,
      appliedInferred: false,
      feedbackRenderStart: NaN,
      feedbackRenderEnd: NaN,
      frames: 0,
      feedbackFrame: NaN,
    };
  }

  private onPointerDownBubble(): void {
    const p = this.pending;
    if (!p || !Number.isNaN(p.dispatchEndTs)) return;
    p.dispatchEndTs = performance.now();
    if (!p.hit) this.finalize(p, 'miss', p.dispatchEndTs);
  }

  private finalize(p: Pending, outcome: InputSample['outcome'], now: number): void {
    if (this.pending === p) this.pending = null;
    if (!p.recorded) return;
    const ok = outcome === 'ok';
    const nan = NaN;
    this.samples.push({
      seq: p.seq,
      t_ms: p.captureTs - this.recordStart,
      outcome,
      queue_ms: p.captureTs - p.eventTs,
      dispatch_ms: p.dispatchEndTs - p.captureTs,
      apply_ms: ok ? p.appliedTs - p.hitTs : nan,
      commit_ms: ok ? Math.max(0, p.appliedTs - p.dispatchEndTs) : nan,
      frame_wait_ms: ok ? p.feedbackRenderStart - Math.max(p.appliedTs, p.dispatchEndTs) : nan,
      render_ms: ok ? p.feedbackRenderEnd - p.feedbackRenderStart : nan,
      latency_render_ms: ok ? p.feedbackRenderEnd - p.eventTs : nan,
      latency_frame_ms: ok ? now - p.eventTs : nan,
      frames: ok ? p.feedbackFrame : nan,
      applied_inferred: p.appliedInferred,
    });
    if (ok) bench.setHudValue(`lat ${(p.feedbackRenderEnd - p.eventTs).toFixed(1)} ms`);
  }

  private complete(): void {
    this.phase = 'done';
    this.detach?.();
    const ok = this.samples.filter((s) => s.outcome === 'ok');
    const count = (o: InputSample['outcome']): number =>
      this.samples.filter((s) => s.outcome === o).length;
    const col = (k: keyof InputSample): number[] => ok.map((s) => s[k] as number);
    const rec = this.recorder!;
    const frames: { summary: FrameSummary; raw: FrameRaw } = { summary: rec.summary(), raw: rec.raw() };
    this.onDoneCb?.({
      summary: {
        clicks: this.samples.length,
        ok: ok.length,
        miss: count('miss'),
        timeout: count('timeout'),
        superseded: count('superseded'),
        latency_render_ms_median: median(col('latency_render_ms')),
        latency_render_ms_p95: percentile(sortedFinite(col('latency_render_ms')), 95),
        latency_render_ms_mean: mean(col('latency_render_ms')),
        latency_frame_ms_median: median(col('latency_frame_ms')),
        queue_ms_median: median(col('queue_ms')),
        dispatch_ms_median: median(col('dispatch_ms')),
        apply_ms_median: median(col('apply_ms')),
        commit_ms_median: median(col('commit_ms')),
        frame_wait_ms_median: median(col('frame_wait_ms')),
        render_ms_median: median(col('render_ms')),
      },
      samples: this.samples,
      frames,
    });
  }
}
