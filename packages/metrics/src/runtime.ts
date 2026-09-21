import { GpuTimer } from './gpu-timer.js';
import type { BenchStatus, BenchWindowState } from './types.js';

/**
 * Хуки фаз кадра. Обе реализации вызывают их в ОДНИХ И ТЕХ ЖЕ точках цикла:
 *
 *   beginFrame(now)   — начало кадра, до обновления сцены;
 *   beginRender(now)  — обновления закончены, сейчас будет renderer.render();
 *   endRender(now)    — renderer.render() вернул управление.
 *
 * В three.js это прямые вызовы в rAF-цикле, в R3F — useFrame с приоритетом
 * -1000 (раньше всех) и +1 (ручной рендер вместо встроенного). В НИР2 точки
 * замера в двух реализациях не совпадали, и это напрямую исказило S3 и S4.
 */
export interface FrameProbe {
  beginFrame?(now: number): void;
  beginRender?(now: number): void;
  endRender?(now: number): void;
  /** время GPU кадра `frame`; приходит с задержкой в несколько кадров */
  gpuSample?(frame: number, gpuMs: number): void;
}

export interface BenchControl {
  /** снимок паритета на ближайшем кадре (см. parity.ts) */
  snapshot?: () => Promise<unknown>;
}

declare global {
  interface Window {
    __BENCH__?: BenchWindowState;
    __BENCH_CTRL__?: BenchControl;
    /** long tasks, собранные инлайн-скриптом в <head> до загрузки бандла */
    __LT__?: [number, number][];
    __LT_SUPPORTED__?: boolean;
    /**
     * Уведомление harness о смене статуса (page.exposeFunction). Заменяет
     * опрос страницы таймером: в НИР2 waitForFunction с polling 250 мс
     * исполнял код в странице во время замеров.
     */
    __BENCH_NOTIFY__?: (status: string) => void;
  }
}

const HUD_INTERVAL_MS = 500;

class BenchRuntime {
  private probes: FrameProbe[] = [];
  private status: BenchStatus = 'idle';
  private result: unknown = null;
  private error: string | null = null;
  private hudEnabled = true;
  private hudValue = '';
  private lastHudTs = 0;
  private gpu: GpuTimer | null = null;
  private frameIdx = 0;
  private nextRenderCallbacks: ((now: number) => void)[] = [];

  constructor() {
    this.publish();
    window.addEventListener('error', (e) => this.fail(e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => this.fail(e.reason));
    // Потеря контекста останавливает кадры, и без этого прогон молча висел бы
    // до таймаута harness (WebKit теряет контекст на S5 от ≈ 6400 объектов).
    // Событие не всплывает — ловится на фазе перехвата, от любого холста.
    window.addEventListener('webglcontextlost', () => this.fail(new Error('WebGL: контекст потерян')), true);
  }

  configureHud(enabled: boolean, implLabel: string): void {
    this.hudEnabled = enabled;
    const el = document.getElementById('hud-impl');
    if (el) el.textContent = implLabel;
  }

  /**
   * Подключает GPU-таймер к контексту рендерера. Вызывается реализацией сразу
   * после создания рендерера; дальше замером управляет рантайм, поэтому точки
   * начала и конца одинаковы в three.js и R3F.
   */
  attachGpuTimer(gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.gpu = GpuTimer.create(gl);
  }

  get gpuSupported(): boolean {
    return this.gpu !== null;
  }

  get gpuDisjointDrops(): number {
    return this.gpu?.disjointDrops ?? 0;
  }

  /** номер текущего кадра — по нему привязываются отложенные замеры GPU */
  get frameIndex(): number {
    return this.frameIdx;
  }

  addProbe(p: FrameProbe): () => void {
    this.probes.push(p);
    return () => {
      this.probes = this.probes.filter((x) => x !== p);
    };
  }

  beginFrame(now: number): void {
    this.frameIdx++;
    const ps = this.probes;
    for (let i = 0; i < ps.length; i++) ps[i]!.beginFrame?.(now);
    if (this.hudEnabled && now - this.lastHudTs >= HUD_INTERVAL_MS) {
      this.lastHudTs = now;
      this.renderHud();
    }
  }

  beginRender(now: number): void {
    const ps = this.probes;
    for (let i = 0; i < ps.length; i++) ps[i]!.beginRender?.(now);
    this.gpu?.begin(this.frameIdx);
  }

  endRender(now: number): void {
    this.gpu?.end();
    const ps = this.probes;
    for (let i = 0; i < ps.length; i++) ps[i]!.endRender?.(now);
    this.gpu?.poll((frame, gpuMs) => {
      for (let i = 0; i < ps.length; i++) ps[i]!.gpuSample?.(frame, gpuMs);
    });
    if (this.nextRenderCallbacks.length > 0) {
      const cbs = this.nextRenderCallbacks;
      this.nextRenderCallbacks = [];
      for (const cb of cbs) cb(now);
    }
  }

  /** колбэк сразу после ближайшего renderer.render() — буфер кадра ещё читаем */
  afterNextRender(cb: (now: number) => void): void {
    this.nextRenderCallbacks.push(cb);
  }

  setStatus(status: BenchStatus): void {
    if (this.status === 'error' || this.status === status) return;
    this.status = status;
    this.publish();
  }

  getStatus(): BenchStatus {
    return this.status;
  }

  setHudValue(v: string): void {
    this.hudValue = v;
  }

  complete(result: unknown): void {
    this.result = result;
    this.setStatus('done');
    this.renderHud();
  }

  fail(err: unknown): void {
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    // первая ошибка — самая информативная; последующие обычно её следствия
    if (this.status === 'error') return;
    this.error = msg;
    this.status = 'error';
    this.publish();
    this.renderHud();
    console.error('[bench] ошибка прогона:', err);
  }

  setControl(ctrl: BenchControl): void {
    window.__BENCH_CTRL__ = { ...window.__BENCH_CTRL__, ...ctrl };
  }

  /** метка в Performance Timeline — по ней harness выравнивает трассу CDP */
  mark(name: string): void {
    performance.mark(`bench:${name}`);
  }

  private publish(): void {
    window.__BENCH__ = { status: this.status, result: this.result, error: this.error };
    try {
      void window.__BENCH_NOTIFY__?.(this.status);
    } catch {
      // harness не подключён (ручной просмотр) — уведомлять некого
    }
  }

  private renderHud(): void {
    if (!this.hudEnabled) return;
    const phase = document.getElementById('hud-phase');
    const value = document.getElementById('hud-value');
    if (phase) phase.textContent = this.status;
    if (value) value.textContent = this.error ? this.error.split('\n')[0]! : this.hudValue;
  }
}

/** один рантайм на страницу: одна реализация, один сценарий, один коллектор */
export const bench = new BenchRuntime();
