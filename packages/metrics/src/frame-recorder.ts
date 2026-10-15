import type { FrameRows } from './types.js';

/**
 * Покадровая запись с разбивкой времени кадра на фазы.
 *
 * Строка i описывает ПОЛНЫЙ цикл кадра i:
 *   frame    — start(i+1) − start(i): вся длительность цикла, включая работу
 *              между кадрами (React-коммиты вне rAF, GC, композитинг, ожидание);
 *   update   — beginRender − beginFrame: анимация/доставка значений в сцену;
 *   render   — endRender − beginRender: renderer.render() на CPU
 *              (подготовка и отправка команд; GPU работает асинхронно);
 *   gpu      — время GPU на кадр (EXT_disjoint_timer_query_webgl2), приходит
 *              с задержкой в несколько кадров и привязывается по номеру кадра.
 */
export class FrameRecorder {
  private readonly frames: number[] = [];
  private readonly updates: number[] = [];
  private readonly renders: number[] = [];
  private readonly ids: number[] = [];
  private readonly gpuById = new Map<number, number>();
  private curId = -1;

  private curStart = NaN;
  private curRenderStart = NaN;
  private curUpdate = NaN;
  private curRender = NaN;

  beginFrame(now: number, frameId: number): void {
    this.closeCurrent(now);
    this.curStart = now;
    this.curId = frameId;
    this.curUpdate = NaN;
    this.curRender = NaN;
    this.curRenderStart = NaN;
  }

  beginRender(now: number): void {
    if (Number.isNaN(this.curStart)) return;
    this.curUpdate = now - this.curStart;
    this.curRenderStart = now;
  }

  endRender(now: number): void {
    if (Number.isNaN(this.curRenderStart)) return;
    this.curRender = now - this.curRenderStart;
  }

  /** замер GPU приходит позже кадра, поэтому кладётся по номеру кадра */
  gpuSample(frameId: number, gpuMs: number): void {
    this.gpuById.set(frameId, gpuMs);
  }

  /** закрывает последний кадр моментом `now` и прекращает запись */
  finish(now: number): void {
    this.closeCurrent(now);
    this.curStart = NaN;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** длительности закрытых кадров — S5 решает по ним, идти ли дальше */
  get frameMs(): readonly number[] {
    return this.frames;
  }

  private closeCurrent(now: number): void {
    if (Number.isNaN(this.curStart)) return;
    this.ids.push(this.curId);
    this.frames.push(now - this.curStart);
    this.updates.push(this.curUpdate);
    this.renders.push(this.curRender);
  }

  rows(): FrameRows {
    return {
      frame_ms: this.frames,
      update_ms: this.updates,
      render_ms: this.renders,
      gpu_ms: this.ids.map((id) => this.gpuById.get(id) ?? NaN),
    };
  }
}
