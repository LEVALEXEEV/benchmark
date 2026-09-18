/**
 * Время GPU на кадр через EXT_disjoint_timer_query_webgl2.
 *
 * Зачем: время внутри renderer.render() — это CPU-время отправки команд, а не
 * работа GPU. Без прямого замера утверждение «GPU насыщен» (гипотеза H1)
 * остаётся косвенным выводом. Расширение есть в Chrome, в WebKit его нет —
 * тогда поле gpu_ms пустое, и вывод строится по остальным метрикам.
 *
 * Особенности API, которые определяют устройство класса:
 *   - запросы нельзя вкладывать: не больше одного активного на кадр;
 *   - результат готов лишь через несколько кадров, поэтому он приходит
 *     асинхронно и привязывается к номеру кадра, в котором был начат;
 *   - флаг GPU_DISJOINT_EXT означает, что таймер сбился (смена частоты GPU,
 *     вытеснение контекста) — все незавершённые замеры отбрасываются.
 */
interface TimerExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** запросов в пуле: результат отстаёт на 1–3 кадра, запас взят с избытком */
const POOL_SIZE = 8;

export class GpuTimer {
  private readonly gl: WebGL2RenderingContext;
  private readonly ext: TimerExt;
  private readonly free: WebGLQuery[] = [];
  private inflight: { q: WebGLQuery; frame: number }[] = [];
  private active: WebGLQuery | null = null;
  private activeFrame = -1;
  /** сколько замеров отброшено из-за disjoint — попадает в результат прогона */
  disjointDrops = 0;

  private constructor(gl: WebGL2RenderingContext, ext: TimerExt) {
    this.gl = gl;
    this.ext = ext;
  }

  static create(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuTimer | null {
    const gl2 = gl as WebGL2RenderingContext;
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl2 instanceof WebGL2RenderingContext)) return null;
    const ext = gl2.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
    return ext ? new GpuTimer(gl2, ext) : null;
  }

  begin(frame: number): void {
    if (this.active !== null) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
    this.activeFrame = frame;
  }

  end(): void {
    if (this.active === null) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.inflight.push({ q: this.active, frame: this.activeFrame });
    this.active = null;
  }

  /** отдаёт готовые замеры; вызывается раз в кадр после end() */
  poll(onSample: (frame: number, gpuMs: number) => void): void {
    const gl = this.gl;
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.disjointDrops += this.inflight.length;
      for (const { q } of this.inflight) this.recycle(q);
      this.inflight = [];
      return;
    }
    const pending: typeof this.inflight = [];
    for (const item of this.inflight) {
      if (!gl.getQueryParameter(item.q, gl.QUERY_RESULT_AVAILABLE)) {
        pending.push(item);
        continue;
      }
      const ns = gl.getQueryParameter(item.q, gl.QUERY_RESULT) as number;
      onSample(item.frame, ns / 1e6);
      this.recycle(item.q);
    }
    this.inflight = pending;
  }

  private recycle(q: WebGLQuery): void {
    if (this.free.length < POOL_SIZE) this.free.push(q);
    else this.gl.deleteQuery(q);
  }
}
