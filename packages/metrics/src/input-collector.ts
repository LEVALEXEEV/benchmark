import { bench, type FrameProbe } from './runtime.js';
import type { InputClick, InputOutcome } from './types.js';

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
  feedbackRenderStart: number;
  feedbackRenderEnd: number;
}

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
 * Пишутся только отметки времени каждого клика (InputClick); фазы и
 * задержку считает анализ.
 *
 * Слушатели: capture на canvas (срабатывает раньше обработчиков реализации
 * и R3F) и bubble на window (срабатывает после всех синхронных обработчиков).
 */
export class InputCollector implements FrameProbe {
  private readonly cfg: InputCollectorConfig;
  private phase: 'idle' | 'warmup' | 'recording' | 'draining' | 'done' = 'idle';
  private warmStart = NaN;
  private recordStart = NaN;
  private pending: Pending | null = null;
  private seqCounter = 0;
  private readonly clicks: InputClick[] = [];
  private onDoneCb: ((clicks: readonly InputClick[]) => void) | null = null;
  private detach: (() => void) | null = null;

  constructor(cfg: InputCollectorConfig) {
    this.cfg = cfg;
  }

  onDone(cb: (clicks: readonly InputClick[]) => void): void {
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
      bench.setStatus('recording');
    }

    const p = this.pending;
    if (p) {
      if (!Number.isNaN(p.feedbackRenderEnd)) {
        this.finalize(p, 'ok');
      } else if (now - p.captureTs > this.cfg.timeoutMs) {
        this.finalize(p, 'timeout');
      }
    }

    if (this.phase === 'recording' && now - this.recordStart >= this.cfg.recordMs) {
      this.phase = 'draining';
    }
    if (this.phase === 'draining' && this.pending === null) {
      this.complete();
    }
  }

  beginRender(now: number): void {
    const p = this.pending;
    if (!p || !p.hit || !Number.isNaN(p.feedbackRenderStart)) return;
    // без сигнала noteApplied момент применения — начало рендера, в котором
    // цвет уже в сцене
    if (Number.isNaN(p.appliedTs) && p.isApplied?.()) p.appliedTs = now;
    if (!Number.isNaN(p.appliedTs)) p.feedbackRenderStart = now;
  }

  endRender(now: number): void {
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
      // отклик предыдущего клика уже отрисован, но следующий кадр ещё не начался
      this.finalize(prev, Number.isNaN(prev.feedbackRenderEnd) ? 'superseded' : 'ok');
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
      feedbackRenderStart: NaN,
      feedbackRenderEnd: NaN,
    };
  }

  private onPointerDownBubble(): void {
    const p = this.pending;
    if (!p || !Number.isNaN(p.dispatchEndTs)) return;
    p.dispatchEndTs = performance.now();
    if (!p.hit) this.finalize(p, 'miss');
  }

  private finalize(p: Pending, outcome: InputOutcome): void {
    if (this.pending === p) this.pending = null;
    if (!p.recorded) return;
    const t = (ts: number): number => ts - this.recordStart;
    const ok = outcome === 'ok';
    this.clicks.push({
      click: this.clicks.length + 1,
      outcome,
      event_ms: t(p.eventTs),
      handler_start_ms: t(p.captureTs),
      handler_end_ms: t(p.dispatchEndTs),
      applied_ms: t(p.appliedTs),
      render_start_ms: ok ? t(p.feedbackRenderStart) : NaN,
      render_end_ms: ok ? t(p.feedbackRenderEnd) : NaN,
    });
    if (ok) bench.setHudValue(`lat ${(p.feedbackRenderEnd - p.eventTs).toFixed(1)} ms`);
  }

  private complete(): void {
    this.phase = 'done';
    this.detach?.();
    this.onDoneCb?.(this.clicks);
  }
}
