import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { FrameClock, type RunParams } from '@bench/metrics';
import { makeScenarioSpec, S5_LEVELS, type SceneSpec } from '@bench/scene-spec';
import { FrameClockContext, FrameDriver } from './FrameDriver.js';
import { FrameRun } from './runs/FrameRun.js';
import { InitRun } from './runs/InitRun.js';
import { InputRun } from './runs/InputRun.js';
import { ScaleRun } from './runs/ScaleRun.js';

function initialSpec(params: RunParams): SceneSpec {
  const levels = params.levels ?? S5_LEVELS;
  return makeScenarioSpec(params.scenario, {
    objects: params.objects,
    shadowMapSize: params.shadowMapSize,
    detailScale: params.detailScale,
    count: params.parity ? (params.parityCount ?? levels[0]!) : levels[0]!,
  });
}

/**
 * Камера создаётся экземпляром, а не объектом пропсов: из пропсов R3F делает
 * lookAt(0,0,0), и в НИР2 камера в S2/S3 смотрела не туда, куда задано в
 * спецификации. Экземпляр R3F не трогает (кроме aspect по размеру canvas).
 */
function createCamera(spec: SceneSpec): THREE.PerspectiveCamera {
  const c = spec.camera;
  const camera = new THREE.PerspectiveCamera(c.fov, spec.renderer.width / spec.renderer.height, c.near, c.far);
  camera.position.set(...c.position);
  camera.lookAt(...c.lookAt);
  camera.updateProjectionMatrix();
  return camera;
}

const PARENT_STATE_INTERVAL_MS = 500;

export function App({ params, mode }: { params: RunParams; mode: string | null }) {
  const spec = useMemo(() => initialSpec(params), [params]);
  const camera = useMemo(() => createCamera(spec), [spec]);
  const clock = useMemo(() => new FrameClock(params.freezeTime), [params]);

  // Антипаттерн, воспроизводящий дефект НИР2: state в родителе <Canvas>
  // меняется 2 раза в секунду. Canvas перерисовывает корень R3F на каждом
  // своём рендере (layout-эффект без зависимостей), и немемоизированная сцена
  // целиком проходит реконсиляцию. Включается только явно (?parentState=1).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!params.parentState) return;
    const id = setInterval(() => setTick((n) => n + 1), PARENT_STATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [params.parentState]);

  const r = spec.renderer;
  return (
    <Canvas
      // flat → NoToneMapping; linear=false → sRGB — как у three.js
      flat
      dpr={r.pixelRatio * params.renderScale}
      gl={{ antialias: r.antialias, alpha: r.alpha, powerPreference: 'high-performance' }}
      // объект, а не boolean: при shadows={false} R3F всё равно выставляет
      // PCFSoftShadowMap, и конфигурация рендерера расходится с three.js
      shadows={{ enabled: r.shadowMap, type: THREE.PCFShadowMap }}
      camera={camera}
      style={{ width: r.width, height: r.height }}
    >
      <FrameClockContext.Provider value={clock}>
        <FrameDriver clock={clock} gpuTimer={params.gpuTimer} />
        {params.scenario === 's3' ? (
          <InitRun params={params} spec={spec} />
        ) : params.scenario === 's4' ? (
          <InputRun params={params} mode={mode!} spec={spec} />
        ) : params.scenario === 's5' ? (
          <ScaleRun params={params} mode={mode!} initialSpec={spec} />
        ) : (
          <FrameRun params={params} mode={mode!} spec={spec} />
        )}
      </FrameClockContext.Provider>
    </Canvas>
  );
}
