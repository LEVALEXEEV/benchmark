import { useLayoutEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import { bench, countMeshes, enableParityMode, type InitCollector, type RunParams } from '@bench/metrics';
import { expectedMeshCount, type SceneSpec } from '@bench/scene-spec';
import { useRunFinish } from '../FrameDriver.js';
import { Objects, SceneEnvironment } from '../nodes.js';

/**
 * Связь с коллектором S3, созданным в main.tsx до монтирования React:
 * сцена R3F становится доступна только после создания корня.
 */
export const initProbe: {
  collector: InitCollector | null;
  scene: THREE.Scene | null;
  expected: number;
  isSceneComplete(): boolean;
} = {
  collector: null,
  scene: null,
  expected: 0,
  isSceneComplete() {
    return this.scene !== null && countMeshes(this.scene) === this.expected;
  },
};

/** S3 */
export function InitRun({ params, spec }: { params: RunParams; spec: SceneSpec }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const finish = useRunFinish(params, null);

  useLayoutEffect(() => {
    initProbe.scene = scene;
    initProbe.expected = expectedMeshCount(spec);
    if (params.parity) {
      enableParityMode(
        bench,
        () => ({ renderer: gl, scene, camera }),
        () => initProbe.isSceneComplete()
      );
      return;
    }
    initProbe.collector!.onDone((m) => {
      finish.stopLoop();
      bench.complete({ kind: 'init', meta: finish.meta(spec.id), ...m });
    });
  }, []);

  return (
    <>
      <SceneEnvironment spec={spec} />
      <Objects objects={spec.objects} mode="ref" />
    </>
  );
}
