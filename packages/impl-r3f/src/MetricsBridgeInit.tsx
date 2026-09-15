import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { InitCollector, type BenchInitResult } from '@bench/metrics';

interface Props {
  readonly scenarioId: string;
  readonly quietWindowMs: number;
  readonly ttiTimeoutMs: number;
  readonly onPhaseChange?: (phase: string, ttfr: number | null) => void;
}

/**
 * Подключает InitCollector к R3F-циклу для измерения холодного старта.
 *
 * Двухтактовая фиксация TTFR:
 *   - первый вызов useFrame — это уже точка, в которой R3F готов
 *     запускать render-loop, поэтому фиксируем frameStart;
 *   - на втором useFrame считаем, что первый кадр уже committed к canvas
 *     (R3F рендерит ПОСЛЕ user-колбэков), и фиксируем frameEnd → TTFR.
 *
 * После TTFR коллектор сам ждёт тихое окно longtask для определения TTI.
 */
export function MetricsBridgeInit({
  scenarioId,
  quietWindowMs,
  ttiTimeoutMs,
  onPhaseChange,
}: Props) {
  const collector = useMemo(
    () =>
      new InitCollector({
        scenarioId,
        implementation: 'r3f',
        mode: null,
        quietWindowMs,
        ttiTimeoutMs,
        publishToWindow: true,
      }),
    [scenarioId, quietWindowMs, ttiTimeoutMs]
  );

  const firstFrameStart = useRef<number | null>(null);
  const marked = useRef(false);

  useEffect(() => {
    onPhaseChange?.('warmup', null);
    collector.onDone((r: BenchInitResult) =>
      onPhaseChange?.('done', r.ttfr_ms)
    );
  }, [collector, onPhaseChange]);

  useFrame(() => {
    if (firstFrameStart.current === null) {
      firstFrameStart.current = performance.now();
      return;
    }
    if (!marked.current) {
      marked.current = true;
      const end = performance.now();
      collector.markFirstFrame(firstFrameStart.current, end);
      onPhaseChange?.('recording', end);
    }
  });

  return null;
}
