import type { LightSpec, ObjectSpec, SceneSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

const OBJECT_COUNT = 3000;
const SPREAD = 60;
const SEED = 1337;

const PALETTE = [0xff5c7c, 0x6ec1e4, 0xf5d76e, 0x9b59b6, 0x2ecc71, 0xe67e22, 0x3498db, 0xe74c3c];
const AXES: readonly ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];

function buildObjects(): ObjectSpec[] {
  const rng = mulberry32(SEED);
  const objects: ObjectSpec[] = [];

  for (let i = 0; i < OBJECT_COUNT; i++) {
    const colorIndex = Math.floor(rng() * PALETTE.length);
    const axis = AXES[Math.floor(rng() * AXES.length)]!;

    objects.push({
      id: `obj_${i}`,
      geometry: { type: 'box', width: 0.6, height: 0.6, depth: 0.6 },
      material: { type: 'basic', color: PALETTE[colorIndex]! },
      position: [
        randRange(rng, -SPREAD, SPREAD),
        randRange(rng, 0.5, 30),
        randRange(rng, -SPREAD, SPREAD),
      ],
      rotation: [0, 0, 0],
      scale: 1,
      castShadow: false,
      receiveShadow: false,
      animation: {
        orbit: {
          radius: randRange(rng, 0.3, 1.5),
          frequency: randRange(rng, 0.15, 0.6),
          phase: randRange(rng, 0, Math.PI * 2),
        },
        spin: {
          axis,
          speed: randRange(rng, 0.5, 2.5),
        },
      },
    });
  }

  return objects;
}

const LIGHTS: LightSpec[] = [
  { type: 'ambient', color: 0xffffff, intensity: 1.0 },
];

/**
 * S2 — CPU-bound сцена.
 *
 * Цель: проверить гипотезу H2 — при высокой частоте мелких обновлений
 * состояния R3F (через ref) показывает сравнимую с three.js производительность,
 * а R3F через setState заметно деградирует из-за реконсиляции.
 *
 * Принципы дизайна сцены:
 *   - МНОГО объектов (3000) → нагрузка на CPU из-за per-frame transform updates;
 *   - простая геометрия (Box) и MeshBasicMaterial → GPU почти простаивает;
 *   - без теней, одно ambient-освещение → исключаем GPU-bottleneck;
 *   - камера статична → анимация идёт ТОЛЬКО от per-object updates,
 *     что и есть предмет измерения.
 *
 * Анимация каждого объекта (см. applyAnimation):
 *   - орбитальное движение в XZ-плоскости вокруг базовой позиции;
 *   - постоянное вращение вокруг случайной оси.
 *
 * Запускается в трёх вариантах:
 *   threejs        — императивный mesh.position.set() в rAF;
 *   r3f (?mode=ref)   — useFrame + ref.current.position.set();
 *   r3f (?mode=state) — useFrame + setState (триггерит React reconciliation).
 */
export const S2_CPU_BOUND: SceneSpec = {
  id: 's2-cpu-bound',
  description: 'CPU-bound scene with 3000 animated objects, no GPU pressure',
  renderer: {
    width: 1280,
    height: 720,
    pixelRatio: 1,
    antialias: false,
    shadowMap: false,
    clearColor: 0x0d1117,
  },
  camera: {
    fov: 60,
    near: 0.1,
    far: 500,
    position: [0, 30, 90],
    lookAt: [0, 10, 0],
    autoRotateSpeed: 0,
  },
  lights: LIGHTS,
  floor: null,
  objects: buildObjects(),
};
