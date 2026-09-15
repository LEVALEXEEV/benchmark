import * as THREE from 'three';
import {
  bench,
  buildMeta,
  countMeshes,
  enableParityMode,
  FrameClock,
  FrameCollector,
  InitCollector,
  InputCollector,
  readRunParams,
  resolveMode,
  ScaleCollector,
  type BenchResult,
  type RunParams,
} from '@bench/metrics';
import {
  applyAnimation,
  cameraPositionAt,
  expectedMeshCount,
  FEEDBACK_EMISSIVE_OFF,
  feedbackColorFor,
  getScenario,
  makeS5Scene,
  S5_LEVELS,
  withDetailScale,
  type SceneSpec,
} from '@bench/scene-spec';
import { startLoop } from './loop.js';
import { applyCameraSpec, buildContent, createCamera, createRenderer, type BuiltContent } from './scene-builder.js';

// Модули бандла уже исполнены: отсюда начинается код приложения (метка S3).
const jsReady = performance.now();

const host = document.getElementById('canvas-host')!;
const LIBS = { three: THREE.REVISION };

function meta(params: RunParams, spec: SceneSpec, renderer: THREE.WebGLRenderer) {
  return buildMeta({
    params,
    impl: 'threejs',
    mode: null,
    specId: spec.id,
    renderer,
    buildMode: import.meta.env.MODE,
    libs: LIBS,
  });
}

/** S1, S2: статичная сцена с орбитой камеры либо per-object анимация */
function runFrameScenario(params: RunParams, spec: SceneSpec): void {
  const renderer = createRenderer(spec, params.renderScale, host);
  const camera = createCamera(spec);
  const content = buildContent(spec);
  const clock = new FrameClock(params.freezeTime);
  const pos: [number, number, number] = [0, 0, 0];
  const rot: [number, number, number] = [0, 0, 0];
  const camPos: [number, number, number] = [0, 0, 0];
  const lookAt = new THREE.Vector3(...spec.camera.lookAt);

  const loop = startLoop(
    (now) => {
      clock.tick(now);
      const t = clock.t;
      if (spec.camera.autoRotateSpeed !== 0) {
        cameraPositionAt(spec.camera, t, camPos);
        camera.position.set(camPos[0], camPos[1], camPos[2]);
        camera.lookAt(lookAt);
      }
      const animated = content.animated;
      for (let i = 0; i < animated.length; i++) {
        const a = animated[i]!;
        applyAnimation(t, a.spec, a.spec.animation!, pos, rot);
        a.mesh.position.set(pos[0], pos[1], pos[2]);
        a.mesh.rotation.set(rot[0], rot[1], rot[2]);
      }
    },
    () => renderer.render(content.scene, camera)
  );

  if (params.parity) {
    enableParityMode(
      bench,
      () => ({ renderer, scene: content.scene, camera }),
      () => countMeshes(content.scene) === expectedMeshCount(spec)
    );
    return;
  }

  const collector = new FrameCollector({ warmupMs: params.warmupMs, recordMs: params.recordMs });
  collector.onDone((summary, raw) => {
    loop.stop();
    const result: BenchResult = { kind: 'frame', meta: meta(params, spec, renderer), summary, raw };
    bench.complete(result);
  });
  bench.addProbe(collector);
}

/** S3: холодный старт — сцена строится сразу, первый рендер в первом rAF */
function runInitScenario(params: RunParams, spec: SceneSpec): void {
  let scene: THREE.Scene | null = null;
  const collector = new InitCollector({
    settleMs: params.settleMs,
    isSceneComplete: () => scene !== null && countMeshes(scene) === expectedMeshCount(spec),
  });
  collector.markJsReady(jsReady);
  bench.addProbe(collector);

  const renderer = createRenderer(spec, params.renderScale, host);
  const camera = createCamera(spec);
  const content = buildContent(spec);
  scene = content.scene;
  const loop = startLoop(
    () => {},
    () => renderer.render(content.scene, camera)
  );

  if (params.parity) {
    enableParityMode(
      bench,
      () => ({ renderer, scene: content.scene, camera }),
      () => countMeshes(content.scene) === expectedMeshCount(spec)
    );
    return;
  }

  collector.onDone((m) => {
    loop.stop();
    bench.complete({ kind: 'init', meta: meta(params, spec, renderer), ...m } satisfies BenchResult);
  });
}

/** S4: raycast по pointerdown и императивная подсветка */
function runInputScenario(params: RunParams, spec: SceneSpec): void {
  const renderer = createRenderer(spec, params.renderScale, host);
  const camera = createCamera(spec);
  const content = buildContent(spec);
  const canvas = renderer.domElement;

  // в режиме паритета запись не нужна, но нумерация кликов должна совпадать
  const collector = new InputCollector({
    warmupMs: params.parity ? Infinity : params.warmupMs,
    recordMs: params.recordMs,
    timeoutMs: 2000,
  });
  collector.attach(canvas);
  bench.addProbe(collector);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const meshes = [...content.meshes];
  let highlighted: THREE.Mesh | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return;
    const hit = hits[0]!.object as THREE.Mesh;
    const color = feedbackColorFor(collector.clickSeq);
    if (highlighted && highlighted !== hit) {
      (highlighted.material as THREE.MeshStandardMaterial).emissive.setHex(FEEDBACK_EMISSIVE_OFF);
    }
    const mat = hit.material as THREE.MeshStandardMaterial;
    mat.emissive.setHex(color);
    highlighted = hit;
    collector.reportHit(() => mat.emissive.getHex() === color);
  });

  const loop = startLoop(
    () => {},
    () => renderer.render(content.scene, camera)
  );

  if (params.parity) {
    enableParityMode(
      bench,
      () => ({ renderer, scene: content.scene, camera }),
      () => countMeshes(content.scene) === expectedMeshCount(spec)
    );
    return;
  }

  collector.onDone((m) => {
    loop.stop();
    bench.complete({ kind: 'input', meta: meta(params, spec, renderer), ...m } satisfies BenchResult);
  });
}

/**
 * S5: свип по числу объектов. Рендерер и WebGL-контекст одни на весь свип —
 * меняется только содержимое сцены (в НИР2 контекст пересоздавался на каждом
 * уровне, а в R3F — нет).
 */
function runScaleScenario(params: RunParams): void {
  const levels = params.levels ?? S5_LEVELS;
  const firstSpec = makeS5Scene(params.parity ? (params.parityCount ?? levels[0]!) : levels[0]!);
  const renderer = createRenderer(firstSpec, params.renderScale, host);
  const camera = createCamera(firstSpec);
  const clock = new FrameClock(params.freezeTime);
  const pos: [number, number, number] = [0, 0, 0];
  const rot: [number, number, number] = [0, 0, 0];
  let spec = firstSpec;
  let content: BuiltContent | null = null;

  const setLevel = (count: number): void => {
    content?.dispose();
    spec = makeS5Scene(count);
    content = buildContent(spec);
    applyCameraSpec(camera, spec.camera);
  };

  const loop = startLoop(
    (now) => {
      clock.tick(now);
      if (!content) return;
      const t = clock.t;
      const animated = content.animated;
      for (let i = 0; i < animated.length; i++) {
        const a = animated[i]!;
        applyAnimation(t, a.spec, a.spec.animation!, pos, rot);
        a.mesh.position.set(pos[0], pos[1], pos[2]);
        a.mesh.rotation.set(rot[0], rot[1], rot[2]);
      }
    },
    () => {
      if (content) renderer.render(content.scene, camera);
    }
  );

  if (params.parity) {
    setLevel(firstSpec.objects.length);
    enableParityMode(
      bench,
      () => (content ? { renderer, scene: content.scene, camera } : null),
      () => content !== null && countMeshes(content.scene) === expectedMeshCount(spec)
    );
    return;
  }

  const collector = new ScaleCollector({
    levels,
    warmupMs: params.warmupMs,
    recordMs: params.recordMs,
    fpsFloor: params.fpsFloor,
    levelsBeyondFloor: params.levelsBeyondFloor,
    minLevelFrames: params.minLevelFrames,
  });
  collector.onAdvanceLevel((count) => {
    setLevel(count);
    // построение синхронное — объекты уже в графе сцены
    collector.levelReady();
  });
  collector.onDone((m) => {
    loop.stop();
    const result: BenchResult = { kind: 'scale', meta: meta(params, spec, renderer), ...m };
    content?.dispose();
    bench.complete(result);
  });
  bench.addProbe(collector);
  collector.start();
}

function main(): void {
  const params = readRunParams();
  resolveMode(params, 'threejs');
  if (params.parentState) throw new Error('parentState применим только к R3F');
  bench.configureHud(params.hud, 'three.js');

  switch (params.scenario) {
    case 's1':
    case 's2':
      return runFrameScenario(params, withDetailScale(getScenario(params.scenario), params.detailScale));
    case 's3':
      return runInitScenario(params, withDetailScale(getScenario('s3'), params.detailScale));
    case 's4':
      return runInputScenario(params, getScenario('s4'));
    case 's5':
      return runScaleScenario(params);
    default:
      throw new Error(`Неизвестный сценарий ${params.scenario}`);
  }
}

try {
  main();
} catch (e) {
  bench.fail(e);
}
