import * as THREE from 'three';
import { InputCollector } from '@bench/metrics';
import type { SceneSpec } from '@bench/scene-spec';
import { buildScene } from './scene-builder.js';

export interface InputRunnerConfig {
  readonly spec: SceneSpec;
  readonly host: HTMLElement;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly clickIntervalMs: number;
  readonly seed: number;
  readonly onPhaseChange?: (phase: string, latency: number | null) => void;
}

/** цвет emissive-подсветки выбранного объекта (одинаков в обеих реализациях) */
const HIGHLIGHT_EMISSIVE = 0xffae00;

/**
 * Input-раннер для S4 на чистом three.js (baseline отзывчивости).
 *
 * Поток ввода синтезирует InputCollector (одинаковый для обеих реализаций):
 * он диспатчит pointerdown на canvas, обработчик ниже делает raycast и
 * ИМПЕРАТИВНО подсвечивает объект — прямое присваивание material.emissive.
 * Это нижняя граница задержки: отклик готов к ближайшему кадру без какой-либо
 * промежуточной машинерии.
 */
export function runInputScenario(cfg: InputRunnerConfig): () => void {
  const { scene, camera, renderer, pickables, disposables } = buildScene(cfg.spec, cfg.host);
  const canvas = renderer.domElement;

  const collector = new InputCollector({
    scenarioId: cfg.spec.id,
    implementation: 'threejs',
    mode: null,
    warmupMs: cfg.warmupMs,
    recordMs: cfg.recordMs,
    clickIntervalMs: cfg.clickIntervalMs,
    seed: cfg.seed,
    publishToWindow: true,
  });

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const meshes = pickables.map((p) => p.mesh);

  // токен последнего применённого (отрисованного на следующем кадре) отклика
  let renderedToken = 0;
  let highlighted: THREE.Mesh | null = null;

  const setEmissive = (mesh: THREE.Mesh, hex: number): void => {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mat.emissive) mat.emissive.setHex(hex);
  };

  const onPointerDown = (e: PointerEvent): void => {
    const t0 = performance.now();
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    const hit = hits.length > 0 ? (hits[0]!.object as THREE.Mesh) : null;

    collector.onPointerDown(t0, hit !== null);
    if (!hit) return;

    // императивная подсветка: сброс предыдущей + установка новой
    if (highlighted && highlighted !== hit) setEmissive(highlighted, 0x000000);
    setEmissive(hit, HIGHLIGHT_EMISSIVE);
    highlighted = hit;
    // отклик применён к объекту здесь же → будет отрисован ближайшим кадром
    renderedToken = collector.currentToken;
  };

  canvas.addEventListener('pointerdown', onPointerDown);

  let rafId = 0;
  let stopped = false;
  let lastReportTs = performance.now();

  collector.onDone((r) => cfg.onPhaseChange?.('done', r.input_latency_ms_avg));

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    renderer.render(scene, camera);
    collector.frame(now, renderedToken);

    if (now - lastReportTs > 500) {
      lastReportTs = now;
      cfg.onPhaseChange?.(window.__BENCH__?.status ?? 'idle', null);
    }

    rafId = requestAnimationFrame(tick);
  };

  collector.start(canvas);
  cfg.onPhaseChange?.('warmup', null);
  rafId = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(rafId);
    canvas.removeEventListener('pointerdown', onPointerDown);
    for (const d of disposables) d.dispose();
    cfg.host.innerHTML = '';
  };
}
