import { Fragment, useLayoutEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { bench, countMeshes, enableParityMode, ScaleCollector, type RunParams } from '@bench/metrics';
import { expectedMeshCount, makeS5Scene, S5_LEVELS, type SceneSpec } from '@bench/scene-spec';
import { useRunFinish } from '../FrameDriver.js';
import { Objects, SceneEnvironment } from '../nodes.js';

/**
 * S5. Смена уровня — смена state `level`. Объекты уровня монтируются заново
 * (key по уровню), как three.js заново строит содержимое сцены: иначе React
 * переиспользовал бы узлы obj_0…obj_N и сравнивались бы разные операции.
 */
export function ScaleRun({
  params,
  mode,
  initialSpec,
}: {
  params: RunParams;
  mode: string;
  initialSpec: SceneSpec;
}) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const finish = useRunFinish(params, mode);

  const collector = useMemo(
    () =>
      new ScaleCollector({
        levels: params.levels ?? S5_LEVELS,
        warmupMs: params.warmupMs,
        recordMs: params.recordMs,
        fpsFloor: params.fpsFloor,
        levelsBeyondFloor: params.levelsBeyondFloor,
        minLevelFrames: params.minLevelFrames,
        levelControl: params.levelControl,
      }),
    [params]
  );
  // gen — номер уровня: контрольный повтор может запросить то же число
  // объектов, что и предыдущий уровень, и сцена всё равно должна собраться
  // заново (как setLevel в three.js), иначе levelReady не придёт
  const [level, setLevel] = useState<{ count: number; gen: number } | null>(
    params.parity ? { count: initialSpec.objects.length, gen: 0 } : null
  );
  const [finished, setFinished] = useState(false);
  const spec = useMemo(() => (level === null ? null : makeS5Scene(level.count)), [level]);

  useLayoutEffect(() => {
    if (params.parity) {
      enableParityMode(
        bench,
        () => ({ renderer: gl, scene, camera }),
        () => countMeshes(scene) === expectedMeshCount(initialSpec)
      );
      return;
    }
    collector.onAdvanceLevel((c) => setLevel((prev) => ({ count: c, gen: (prev?.gen ?? 0) + 1 })));
    collector.onDone((m) => {
      finish.stopLoop();
      bench.complete({ kind: 'scale', meta: finish.meta(initialSpec.id), ...m });
      // освобождаем тяжёлую сцену, как three.js делает dispose содержимого
      setFinished(true);
    });
    const off = bench.addProbe(collector);
    collector.start();
    return off;
  }, []);

  // Родительский layout-эффект срабатывает после монтирования детей в том же
  // коммите: объекты уровня уже в графе сцены. Камера — та же формула, что в three.js.
  useLayoutEffect(() => {
    if (!spec) return;
    const c = spec.camera;
    camera.near = c.near;
    camera.far = c.far;
    camera.fov = c.fov;
    camera.position.set(...c.position);
    camera.lookAt(...c.lookAt);
    camera.updateProjectionMatrix();
    if (!params.parity) collector.levelReady();
  }, [spec, camera, collector, params.parity]);

  if (!spec || finished) return null;
  return (
    <>
      <SceneEnvironment spec={spec} />
      <Fragment key={level!.gen}>
        <Objects objects={spec.objects} mode={mode} />
      </Fragment>
    </>
  );
}
