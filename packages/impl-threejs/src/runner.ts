import * as THREE from 'three';
import { MetricsCollector } from '@bench/metrics';
import type { SceneSpec } from '@bench/scene-spec';
import { applyAnimation } from '@bench/scene-spec';
import { buildScene } from './scene-builder.js';

export interface RunnerConfig {
  readonly spec: SceneSpec;
  readonly host: HTMLElement;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly onPhaseChange?: (phase: string, fps: number | null) => void;
}

/**
 * Императивный цикл рендера на чистом three.js.
 *
 * Принципиальные особенности (в противовес R3F):
 *   - render-loop пишется руками через requestAnimationFrame;
 *   - обновление состояния (вращение камеры) — прямые вызовы .position / .lookAt;
 *   - нет реконсиляции, нет виртуального дерева сцены.
 */
export function runScenario(cfg: RunnerConfig): () => void {
  const { scene, camera, renderer, animated, disposables } = buildScene(cfg.spec, cfg.host);

  // mutable-буферы переиспользуем между кадрами, чтобы не аллоцировать
  // 3000 пар массивов 60 раз в секунду.
  const posBuf: [number, number, number] = [0, 0, 0];
  const rotBuf: [number, number, number] = [0, 0, 0];

  const collector = new MetricsCollector({
    scenarioId: cfg.spec.id,
    implementation: 'threejs',
    mode: null,
    warmupMs: cfg.warmupMs,
    recordMs: cfg.recordMs,
    publishToWindow: true,
  });

  const lookAt = new THREE.Vector3(...cfg.spec.camera.lookAt);
  const radius = new THREE.Vector3(...cfg.spec.camera.position).sub(lookAt).length();
  const startAngle = Math.atan2(
    cfg.spec.camera.position[2] - cfg.spec.camera.lookAt[2],
    cfg.spec.camera.position[0] - cfg.spec.camera.lookAt[0]
  );
  const camY = cfg.spec.camera.position[1];
  const omega = cfg.spec.camera.autoRotateSpeed;

  let rafId = 0;
  let stopped = false;
  const startTs = performance.now();
  let lastReportTs = startTs;
  let framesSinceReport = 0;

  collector.onDone(() => cfg.onPhaseChange?.('done', null));

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const t = (now - startTs) / 1000;

    if (omega !== 0) {
      const angle = startAngle + omega * t;
      camera.position.x = lookAt.x + Math.cos(angle) * radius;
      camera.position.z = lookAt.z + Math.sin(angle) * radius;
      camera.position.y = camY;
      camera.lookAt(lookAt);
    }

    // Императивное обновление: прямые присваивания на three.js-объект.
    // Это baseline для сравнения с R3F (см. MetricsBridge / Scene в impl-r3f).
    for (let i = 0; i < animated.length; i++) {
      const a = animated[i]!;
      applyAnimation(t, a.spec, a.spec.animation!, posBuf, rotBuf);
      a.mesh.position.set(posBuf[0], posBuf[1], posBuf[2]);
      a.mesh.rotation.set(rotBuf[0], rotBuf[1], rotBuf[2]);
    }

    renderer.render(scene, camera);
    collector.tick();

    framesSinceReport++;
    if (now - lastReportTs > 500) {
      const fps = framesSinceReport / ((now - lastReportTs) / 1000);
      framesSinceReport = 0;
      lastReportTs = now;
      cfg.onPhaseChange?.(window.__BENCH__?.status ?? 'idle', fps);
    }

    rafId = requestAnimationFrame(tick);
  };

  collector.start();
  cfg.onPhaseChange?.('warmup', null);
  rafId = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    for (const d of disposables) d.dispose();
    cfg.host.innerHTML = '';
  };
}
