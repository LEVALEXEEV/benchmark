import { bench } from '@bench/metrics';

/**
 * Императивный цикл кадра. Порядок совпадает с циклом R3F:
 *   requestAnimationFrame(следующий) → beginFrame → update → beginRender →
 *   render → endRender.
 * Следующий rAF запрашивается в начале колбэка, как в R3F (loop в events.js),
 * чтобы исключение в кадре не меняло планирование по-разному.
 */
export function startLoop(update: (now: number) => void, render: () => void): { stop(): void } {
  let rafId = 0;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);
    const now = performance.now();
    bench.beginFrame(now);
    update(now);
    bench.beginRender(performance.now());
    render();
    bench.endRender(performance.now());
  };
  rafId = requestAnimationFrame(tick);
  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(rafId);
    },
  };
}
