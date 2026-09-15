import type { WebGLRenderer } from 'three';
import type { PageEnv } from './types.js';

/**
 * Минимальный наблюдаемый шаг performance.now().
 *
 * Без cross-origin isolation Chrome огрубляет таймер до 100 мкс — в НИР2 это
 * дало ступенчатые FPS (1000/1250/1428) и «задержку» 0,32 мс ниже порога
 * разрешения. Значение пишется в каждый результат, harness его проверяет.
 */
export function measureTimerResolution(budgetMs = 20): number {
  let min = Infinity;
  let last = performance.now();
  const end = last + budgetMs;
  for (;;) {
    const now = performance.now();
    if (now !== last) {
      if (now - last < min) min = now - last;
      last = now;
      if (now > end) break;
    }
  }
  return min;
}

export function collectPageEnv(
  renderer: WebGLRenderer,
  buildMode: string,
  libs: Record<string, string>
): PageEnv {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const canvas = renderer.domElement;
  return {
    userAgent: navigator.userAgent,
    crossOriginIsolated: window.crossOriginIsolated === true,
    timerResolutionMs: measureTimerResolution(),
    devicePixelRatio: window.devicePixelRatio,
    buildMode,
    libs,
    gl: {
      version: String(gl.getParameter(gl.VERSION)),
      vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
      renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      contextAttributes: gl.getContextAttributes(),
      drawingBufferWidth: gl.drawingBufferWidth,
      drawingBufferHeight: gl.drawingBufferHeight,
      canvasCssWidth: canvas.clientWidth,
      canvasCssHeight: canvas.clientHeight,
    },
    renderer: {
      pixelRatio: renderer.getPixelRatio(),
      clearAlpha: renderer.getClearAlpha(),
      toneMapping: renderer.toneMapping,
      outputColorSpace: renderer.outputColorSpace,
      shadowMapEnabled: renderer.shadowMap.enabled,
      shadowMapType: renderer.shadowMap.type,
    },
  };
}
