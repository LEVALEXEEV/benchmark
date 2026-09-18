import { createContext, useContext, useLayoutEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { version as reactVersion } from 'react';
import { bench, buildMeta, type FrameClock, type RunParams } from '@bench/metrics';

export const FrameClockContext = createContext<FrameClock | null>(null);

export function useFrameClock(): FrameClock {
  const clock = useContext(FrameClockContext);
  if (!clock) throw new Error('FrameClockContext не задан');
  return clock;
}

/** раньше всех подписчиков useFrame */
const PRIORITY_FRAME_START = -1000;
/**
 * Положительный приоритет отключает встроенный рендер R3F — рендерим сами тем
 * же вызовом gl.render(scene, camera), что делает R3F, но с метками фаз.
 * Стоимость рендера та же, а точки замера совпадают с three.js.
 */
const PRIORITY_RENDER = 1;

export function FrameDriver({ clock, gpuTimer }: { clock: FrameClock; gpuTimer: boolean }) {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => {
    if (gpuTimer) bench.attachGpuTimer(gl.getContext());
  }, [gl, gpuTimer]);

  useFrame(() => {
    const now = performance.now();
    bench.beginFrame(now);
    clock.tick(now);
  }, PRIORITY_FRAME_START);

  useFrame((state) => {
    bench.beginRender(performance.now());
    state.gl.render(state.scene, state.camera);
    bench.endRender(performance.now());
  }, PRIORITY_RENDER);

  return null;
}

/** фабрика meta и остановка цикла по завершении прогона */
export function useRunFinish(params: RunParams, mode: string | null) {
  const gl = useThree((s) => s.gl);
  const setFrameloop = useThree((s) => s.setFrameloop);
  return {
    stopLoop: () => setFrameloop('never'),
    meta: (specId: string) =>
      buildMeta({
        params,
        impl: 'r3f',
        mode,
        specId,
        renderer: gl,
        buildMode: import.meta.env.MODE,
        libs: { three: THREE.REVISION, react: reactVersion },
      }),
  };
}
