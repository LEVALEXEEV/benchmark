import type { BenchResult } from '@bench/metrics';

/**
 * CSV прогона — формат docs/DATA.md. Время в мс с 3 знаками после запятой
 * (таймер страницы — 5 мкс); пустая ячейка — значения нет.
 */

const ms = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : '');

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

export function toCsv(r: BenchResult): string {
  switch (r.kind) {
    case 'frame': {
      const f = r.frames;
      return table(
        ['frame', 'frame_ms', 'update_ms', 'render_ms', 'gpu_ms'],
        f.frame_ms.map((x, i) => [String(i + 1), ms(x), ms(f.update_ms[i]!), ms(f.render_ms[i]!), ms(f.gpu_ms[i]!)])
      );
    }
    case 'init':
      return table(
        ['code_ready_ms', 'render_start_ms', 'render_end_ms'],
        [[ms(r.code_ready_ms), ms(r.render_start_ms), ms(r.render_end_ms)]]
      );
    case 'input':
      return table(
        ['click', 'outcome', 'event_ms', 'handler_start_ms', 'handler_end_ms', 'applied_ms', 'render_start_ms', 'render_end_ms'],
        r.clicks.map((c) => [
          String(c.click),
          c.outcome,
          ms(c.event_ms),
          ms(c.handler_start_ms),
          ms(c.handler_end_ms),
          ms(c.applied_ms),
          ms(c.render_start_ms),
          ms(c.render_end_ms),
        ])
      );
    case 'scale':
      return table(
        ['objects', 'frame', 'frame_ms'],
        r.levels.flatMap((l) => l.frame_ms.map((x, i) => [String(l.objects), String(i + 1), ms(x)]))
      );
  }
}
