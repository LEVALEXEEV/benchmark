import { ScaleCollector } from '@bench/metrics';
import { applyAnimation, makeS5Scene } from '@bench/scene-spec';
import { buildScene, type BuiltScene } from './scene-builder.js';

export interface ScaleRunnerConfig {
  readonly scenarioId: string;
  readonly host: HTMLElement;
  readonly levels: readonly number[];
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly fpsFloor: number;
  readonly onPhaseChange?: (phase: string, value: number | null) => void;
}

/**
 * Scale-раннер для S5 на чистом three.js.
 *
 * ScaleCollector управляет прогрессией уровней; на каждый новый уровень мы
 * пересобираем сцену целиком из makeS5Scene(count). Прежний уровень полностью
 * освобождается, включая принудительную потерю WebGL-контекста, чтобы за
 * время свипа не упереться в лимит живых контекстов браузера.
 */
export function runScaleScenario(cfg: ScaleRunnerConfig): () => void {
  const collector = new ScaleCollector({
    scenarioId: cfg.scenarioId,
    implementation: 'threejs',
    mode: null,
    levels: cfg.levels,
    warmupMs: cfg.warmupMs,
    recordMs: cfg.recordMs,
    fpsFloor: cfg.fpsFloor,
    publishToWindow: true,
  });

  const posBuf: [number, number, number] = [0, 0, 0];
  const rotBuf: [number, number, number] = [0, 0, 0];
  let current: BuiltScene | null = null;

  const disposeCurrent = (): void => {
    if (!current) return;
    current.renderer.forceContextLoss();
    for (const d of current.disposables) d.dispose();
    cfg.host.innerHTML = '';
    current = null;
  };

  collector.onAdvanceLevel((count) => {
    disposeCurrent();
    current = buildScene(makeS5Scene(count), cfg.host);
  });

  let rafId = 0;
  let stopped = false;
  let frozen = false;
  const startTs = performance.now();
  let lastReportTs = startTs;

  collector.onDone((r) => {
    // свип завершён: результат опубликован, дальше крутить rAF на тяжёлой сцене
    // при снятом лимите кадров бессмысленно и грузит CPU/GPU до закрытия страницы
    frozen = true;
    // освобождаем WebGL-контекст тяжёлой сцены сразу: иначе он доживает до
    // закрытия страницы и подвешивает browser.close() на её разрушении
    disposeCurrent();
    cfg.onPhaseChange?.('done', r.degradation_count);
  });

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const t = (now - startTs) / 1000;

    if (current) {
      const animated = current.animated;
      for (let i = 0; i < animated.length; i++) {
        const a = animated[i]!;
        applyAnimation(t, a.spec, a.spec.animation!, posBuf, rotBuf);
        a.mesh.position.set(posBuf[0], posBuf[1], posBuf[2]);
        a.mesh.rotation.set(rotBuf[0], rotBuf[1], rotBuf[2]);
      }
      current.renderer.render(current.scene, current.camera);
    }

    collector.tick();

    if (now - lastReportTs > 500) {
      lastReportTs = now;
      cfg.onPhaseChange?.(window.__BENCH__?.status ?? 'idle', collector.currentCount);
    }

    if (frozen) return; // прекращаем цикл после завершения свипа (кадр уже отрисован)
    rafId = requestAnimationFrame(tick);
  };

  collector.start(); // строит уровень 0 через onAdvanceLevel
  cfg.onPhaseChange?.('warmup', collector.currentCount);
  rafId = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    disposeCurrent();
  };
}
