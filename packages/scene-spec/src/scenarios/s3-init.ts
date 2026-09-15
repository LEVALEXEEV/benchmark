import type { LightSpec, ObjectSpec, SceneSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

const OBJECT_COUNT = 100;
const SPREAD = 18;
const SEED = 2027;

const PALETTE = [0xff5c7c, 0x6ec1e4, 0xf5d76e, 0x9b59b6, 0x2ecc71, 0xe67e22];

function buildObjects(): ObjectSpec[] {
  const rng = mulberry32(SEED);
  const objects: ObjectSpec[] = [];

  for (let i = 0; i < OBJECT_COUNT; i++) {
    const colorIndex = Math.floor(rng() * PALETTE.length);
    objects.push({
      id: `obj_${i}`,
      geometry: {
        type: 'torusKnot',
        radius: 0.5,
        tube: 0.18,
        tubularSegments: 64,
        radialSegments: 16,
        p: 2,
        q: 3,
      },
      material: {
        type: 'standard',
        color: PALETTE[colorIndex]!,
        metalness: randRange(rng, 0.2, 0.8),
        roughness: randRange(rng, 0.2, 0.7),
      },
      position: [
        randRange(rng, -SPREAD, SPREAD),
        randRange(rng, 0.5, 6),
        randRange(rng, -SPREAD, SPREAD),
      ],
      rotation: [
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
      ],
      scale: randRange(rng, 0.7, 1.2),
      castShadow: false,
      receiveShadow: false,
    });
  }

  return objects;
}

const LIGHTS: LightSpec[] = [
  { type: 'ambient', color: 0xffffff, intensity: 0.4 },
  {
    type: 'directional',
    color: 0xffffff,
    intensity: 1.0,
    position: [20, 30, 15],
    castShadow: false,
    shadowMapSize: 1024,
  },
];

/**
 * S3 — Cold start сцена.
 *
 * Цель: проверить гипотезу H3 — R3F стартует медленнее three.js и его
 * бандл больше из-за зависимостей React + reconciler + fiber wrappers.
 *
 * Принципы дизайна сцены:
 *   - небольшое и одинаковое для обеих реализаций содержимое (~100 мешей,
 *     2 источника света) — нагрузка на runtime минимальна, чтобы измерять
 *     именно стоимость инициализации, а не рендеринга;
 *   - без анимации и без авто-вращения камеры — TTFR/TTI не должны зависеть
 *     от per-frame нагрузки;
 *   - без теней и без post-processing — изолируем стоимость bootstrap.
 *
 * Измеряемые метрики (см. InitCollector):
 *   - TTFR — от performance.timeOrigin до первого отрисованного кадра;
 *   - TTI  — момент, после которого main-thread "тих" в течение
 *            quietWindowMs (нет longtask);
 *   - heap_mb_at_first_frame — usedJSHeapSize сразу после TTFR;
 *   - heap_mb_at_tti        — usedJSHeapSize в момент TTI;
 *   - bundle_size_gz_kb — собирается отдельным скриптом в harness.
 */
export const S3_INIT: SceneSpec = {
  id: 's3-init',
  description: 'Cold start scene: ~100 static torusKnots, no animation',
  renderer: {
    width: 1280,
    height: 720,
    pixelRatio: 1,
    antialias: true,
    alpha: false,
    toneMapping: 'none',
    outputColorSpace: 'srgb',
    shadowMap: false,
    shadowType: 'pcf',
    clearColor: 0x101826,
  },
  camera: {
    fov: 50,
    near: 0.1,
    far: 200,
    position: [0, 12, 36],
    lookAt: [0, 3, 0],
    autoRotateSpeed: 0,
  },
  lights: LIGHTS,
  floor: null,
  objects: buildObjects(),
};
