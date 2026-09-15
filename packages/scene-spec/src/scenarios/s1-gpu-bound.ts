import type { SceneSpec, ObjectSpec, LightSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

const OBJECT_COUNT = 3000;
const SPREAD = 40;
const SEED = 42;

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
        radius: 0.6,
        tube: 0.22,
        tubularSegments: 128,
        radialSegments: 32,
        p: 2,
        q: 3,
      },
      material: {
        type: 'standard',
        color: PALETTE[colorIndex]!,
        metalness: randRange(rng, 0.2, 0.9),
        roughness: randRange(rng, 0.15, 0.7),
      },
      position: [
        randRange(rng, -SPREAD, SPREAD),
        randRange(rng, 0.5, 12),
        randRange(rng, -SPREAD, SPREAD),
      ],
      rotation: [
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
      ],
      scale: randRange(rng, 0.7, 1.4),
      castShadow: true,
      receiveShadow: true,
    });
  }

  return objects;
}

const LIGHTS: LightSpec[] = [
  { type: 'ambient', color: 0xffffff, intensity: 0.25 },
  {
    type: 'directional',
    color: 0xffffff,
    intensity: 1.2,
    position: [30, 40, 20],
    castShadow: true,
    shadowMapSize: 2048,
  },
  {
    type: 'point',
    color: 0xff8866,
    intensity: 80,
    position: [-20, 15, -10],
    distance: 80,
  },
];

/**
 * S1 — GPU-bound сцена.
 *
 * Цель: проверить гипотезу H1 — при насыщении GPU выбор three.js или R3F
 * не влияет на итоговый FPS.
 *
 * Нагрузка идёт через:
 *   - множество мешей с детализированной геометрией (TorusKnot 128×32);
 *   - PBR-материалы (MeshStandardMaterial);
 *   - shadow mapping от directional light (2048×2048);
 *   - shadow casting на всех объектах и приёмник на полу.
 *
 * Состояние сцены статично — анимируется ТОЛЬКО камера (медленное
 * автоповорачивание). Это изолирует GPU-нагрузку от CPU-обновлений
 * состояния (которые отдельно тестируются в S2).
 */
export const S1_GPU_BOUND: SceneSpec = {
  id: 's1-gpu-bound',
  description: 'GPU-bound static scene with shadows and PBR materials',
  renderer: {
    width: 1280,
    height: 720,
    pixelRatio: 1,
    antialias: true,
    shadowMap: true,
    clearColor: 0x1a1f2e,
  },
  camera: {
    fov: 50,
    near: 0.1,
    far: 500,
    position: [0, 18, 55],
    lookAt: [0, 6, 0],
    autoRotateSpeed: 0.15,
  },
  lights: LIGHTS,
  floor: {
    size: 200,
    color: 0x2a3142,
    receiveShadow: true,
  },
  objects: buildObjects(),
};
