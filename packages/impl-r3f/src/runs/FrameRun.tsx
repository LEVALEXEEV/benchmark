import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { bench, countMeshes, enableParityMode, FrameCollector, type RunParams } from '@bench/metrics';
import { expectedMeshCount, type SceneSpec } from '@bench/scene-spec';
import { useRunFinish } from '../FrameDriver.js';
import { Objects, SceneEnvironment } from '../nodes.js';

/** S1, S2 */
export function FrameRun({ params, mode, spec }: { params: RunParams; mode: string; spec: SceneSpec }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const finish = useRunFinish(params, mode);

  // layout-эффект: коллектор подключается в коммите, до ближайшего кадра;
  // прогон одноразовый, поэтому зависимостей нет
  useLayoutEffect(() => {
    if (params.parity) {
      enableParityMode(
        bench,
        () => ({ renderer: gl, scene, camera }),
        () => countMeshes(scene) === expectedMeshCount(spec)
      );
      return;
    }
    const collector = new FrameCollector({ warmupMs: params.warmupMs, recordMs: params.recordMs });
    collector.onDone((summary, raw) => {
      finish.stopLoop();
      bench.complete({ kind: 'frame', meta: finish.meta(spec.id), summary, raw });
    });
    return bench.addProbe(collector);
  }, []);

  return (
    <>
      <SceneEnvironment spec={spec} />
      <Objects objects={spec.objects} mode={mode} />
    </>
  );
}
