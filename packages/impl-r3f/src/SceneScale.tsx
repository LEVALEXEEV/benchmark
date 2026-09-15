import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { makeS5Scene } from '@bench/scene-spec';
import { ScaleCollector, type BenchScaleResult } from '@bench/metrics';
import { AnimatedRefObject, AnimatedStateObject, type AnimationMode } from './Scene.js';

export interface ScaleSceneProps {
  readonly scenarioId: string;
  readonly mode: AnimationMode;
  readonly levels: readonly number[];
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly fpsFloor: number;
  readonly onPhaseChange?: (phase: string, value: number | null) => void;
}

/**
 * S5 на R3F. ScaleCollector ведёт прогрессию уровней, а перестроение сцены
 * под новый уровень сводится к смене React-state `count`: дерево перерисуется
 * с нужным числом анимированных мешей.
 *
 * Камера на каждом уровне подгоняется под облако по той же формуле, что и в
 * three.js (makeS5Scene(count).camera), чтобы кадрирование совпадало.
 *
 * mode=ref/state — те же два пути обновления, что в S2: ref минует
 * реконсиляцию, state гоняет её каждый кадр (и деградирует раньше).
 */
export function ScaleScene({
  scenarioId,
  mode,
  levels,
  warmupMs,
  recordMs,
  fpsFloor,
  onPhaseChange,
}: ScaleSceneProps) {
  const { camera } = useThree();
  const startTs = useRef(performance.now()).current;
  const [count, setCount] = useState<number | null>(null);
  const [finished, setFinished] = useState(false);

  const collector = useMemo(
    () =>
      new ScaleCollector({
        scenarioId,
        implementation: 'r3f',
        mode,
        levels,
        warmupMs,
        recordMs,
        fpsFloor,
        publishToWindow: true,
      }),
    [scenarioId, mode, levels, warmupMs, recordMs, fpsFloor]
  );

  useEffect(() => {
    collector.onAdvanceLevel((c) => setCount(c));
    collector.onDone((r: BenchScaleResult) => {
      // свип завершён: демонтируем тяжёлую сцену, чтобы per-object useFrame
      // (особенно setState-шторм в mode=state) не грузил CPU до закрытия страницы
      setFinished(true);
      onPhaseChange?.('done', r.degradation_count);
    });
    collector.start();
    onPhaseChange?.('warmup', collector.currentCount);
  }, [collector, onPhaseChange]);

  // подгон камеры под текущий уровень — формула общая с three.js-реализацией
  useEffect(() => {
    if (count === null) return;
    const cam = makeS5Scene(count).camera;
    camera.position.set(...cam.position);
    const persp = camera as THREE.PerspectiveCamera;
    persp.far = cam.far;
    persp.updateProjectionMatrix();
    camera.lookAt(...cam.lookAt);
  }, [count, camera]);

  const lastReportTs = useRef(0);
  useFrame(() => {
    collector.tick();
    const now = performance.now();
    if (now - lastReportTs.current > 500) {
      lastReportTs.current = now;
      onPhaseChange?.(window.__BENCH__?.status ?? 'idle', collector.currentCount);
    }
  });

  // объекты уровня строим только при смене count, не на каждый кадр;
  // после завершения свипа сцену демонтируем
  const spec = useMemo(
    () => (count === null || finished ? null : makeS5Scene(count)),
    [count, finished]
  );

  return (
    <>
      <color attach="background" args={[0x0d1117]} />
      <ambientLight intensity={1.0} />
      {spec?.objects.map((o) =>
        mode === 'ref' ? (
          <AnimatedRefObject key={o.id} spec={o} startTs={startTs} />
        ) : (
          <AnimatedStateObject key={o.id} spec={o} startTs={startTs} />
        )
      )}
    </>
  );
}
