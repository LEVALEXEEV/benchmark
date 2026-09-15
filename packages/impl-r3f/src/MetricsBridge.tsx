import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { MetricsCollector, type BenchResult } from '@bench/metrics';

interface Props {
  readonly scenarioId: string;
  readonly mode: 'ref' | 'state';
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly onPhaseChange?: (phase: string, fps: number | null) => void;
}

/**
 * Подключает MetricsCollector к R3F-циклу через useFrame.
 *
 * useFrame в R3F — это аналог requestAnimationFrame: он вызывается
 * каждый кадр ВНУТРИ render-loop R3F (который, согласно документации,
 * работает вне React-реконсиляции). Это то место, где нужно тикать
 * коллектор, чтобы измерять реальное время кадра.
 */
export function MetricsBridge({
  scenarioId,
  mode,
  warmupMs,
  recordMs,
  onPhaseChange,
}: Props) {
  const collector = useMemo(
    () =>
      new MetricsCollector({
        scenarioId,
        implementation: 'r3f',
        mode,
        warmupMs,
        recordMs,
        publishToWindow: true,
      }),
    [scenarioId, mode, warmupMs, recordMs]
  );

  const lastReportTs = useRef(0);
  const framesSinceReport = useRef(0);
  const lastReportFrames = useRef(0);

  useEffect(() => {
    collector.start();
    onPhaseChange?.('warmup', null);
    collector.onDone((_r: BenchResult) => onPhaseChange?.('done', null));
    lastReportTs.current = performance.now();
  }, [collector, onPhaseChange]);

  useFrame(() => {
    collector.tick();

    framesSinceReport.current++;
    const now = performance.now();
    if (now - lastReportTs.current > 500) {
      const fps =
        (framesSinceReport.current - lastReportFrames.current) /
        ((now - lastReportTs.current) / 1000);
      lastReportFrames.current = framesSinceReport.current;
      lastReportTs.current = now;
      onPhaseChange?.(window.__BENCH__?.status ?? 'idle', fps);
    }
  });

  return null;
}
