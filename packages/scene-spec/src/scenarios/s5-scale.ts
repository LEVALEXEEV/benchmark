import type { LightSpec, ObjectSpec, SceneSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

/** уровни свипа по числу объектов; свип идёт по возрастанию до деградации */
export const S5_LEVELS: readonly number[] = [
  100, 500, 1000, 2000, 5000, 10000, 20000, 50000,
];

const SEED = 5150;
const PALETTE = [0xff5c7c, 0x6ec1e4, 0xf5d76e, 0x9b59b6, 0x2ecc71, 0xe67e22, 0x3498db, 0xe74c3c];
const AXES: readonly ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];

/**
 * Строит объекты уровня свипа. Разброс растёт как кубический корень из числа
 * объектов, чтобы плотность облака (а с ней overdraw и нагрузка на GPU)
 * оставалась примерно постоянной — тогда деградация определяется именно
 * масштабом (число объектов / draw calls / per-frame transform), а не
 * случайным ростом перекрытий.
 */
function buildLevelObjects(count: number): ObjectSpec[] {
  const rng = mulberry32(SEED);
  const spread = Math.cbrt(count) * 4;
  const objects: ObjectSpec[] = [];

  for (let i = 0; i < count; i++) {
    const colorIndex = Math.floor(rng() * PALETTE.length);
    const axis = AXES[Math.floor(rng() * AXES.length)]!;

    objects.push({
      id: `obj_${i}`,
      geometry: { type: 'box', width: 0.6, height: 0.6, depth: 0.6 },
      material: { type: 'basic', color: PALETTE[colorIndex]! },
      position: [
        randRange(rng, -spread, spread),
        randRange(rng, -spread * 0.5, spread * 0.5),
        randRange(rng, -spread, spread),
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

const LIGHTS: LightSpec[] = [{ type: 'ambient', color: 0xffffff, intensity: 1.0 }];

/** базовая конфигурация (renderer/camera/lights), общая для всех уровней */
function baseSpec(count: number): SceneSpec {
  const spread = Math.cbrt(count) * 4;
  return {
    id: 's5-scale',
    description: 'Scale sweep: animated objects, increasing count until FPS degrades',
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
      // камера отъезжает пропорционально облаку, чтобы кадрировать всю сцену
      far: spread * 8 + 200,
      position: [0, spread * 0.8, spread * 2.4 + 20],
      lookAt: [0, 0, 0],
      autoRotateSpeed: 0,
    },
    lights: LIGHTS,
    floor: null,
    objects: buildLevelObjects(count),
  };
}

/**
 * S5 — Scale сцена для заданного числа объектов.
 *
 * Цель: найти порог числа объектов, за которым FPS резко падает (< 30).
 *
 * Принципы дизайна:
 *   - та же CPU-bound анимация, что и в S2 (orbit + spin на каждый объект),
 *     но число объектов задаётся уровнем свипа;
 *   - простая геометрия (Box) и MeshBasicMaterial → узким местом по мере роста
 *     становятся per-frame transform updates и число draw calls, а не шейдеры;
 *   - камера статична и кадрирует всё облако → измеряется чистый эффект масштаба.
 *
 * Свипом и поиском точки деградации управляет ScaleCollector; здесь — только
 * параметризованное построение сцены.
 */
export function makeS5Scene(count: number): SceneSpec {
  return baseSpec(count);
}

/** спецификация для регистрации/конфигурации (renderer/camera уровня 0) */
export const S5_SCALE: SceneSpec = makeS5Scene(S5_LEVELS[0]!);
