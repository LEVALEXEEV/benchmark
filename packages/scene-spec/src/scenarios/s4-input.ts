import type { LightSpec, ObjectSpec, SceneSpec } from '../types.js';
import { mulberry32, randRange } from '../prng.js';

const OBJECT_COUNT = 2000;
const SPREAD_XY = 26;
const SPREAD_Z = 18;
const SEED = 4242;

const PALETTE = [0x4a6fa5, 0x5a8f7b, 0xa56a4a, 0x8a5a8f, 0x6a8f4a, 0x4a8f8f];

function buildObjects(): ObjectSpec[] {
  const rng = mulberry32(SEED);
  const objects: ObjectSpec[] = [];

  for (let i = 0; i < OBJECT_COUNT; i++) {
    const colorIndex = Math.floor(rng() * PALETTE.length);
    objects.push({
      id: `obj_${i}`,
      geometry: { type: 'box', width: 1, height: 1, depth: 1 },
      // standard-материал — у него есть emissive, через который реализации
      // дают визуальный отклик на клик (подсветка). Цвет приглушённый,
      // чтобы подсветка emissive была заметна.
      material: {
        type: 'standard',
        color: PALETTE[colorIndex]!,
        metalness: 0.1,
        roughness: 0.8,
      },
      position: [
        randRange(rng, -SPREAD_XY, SPREAD_XY),
        randRange(rng, -SPREAD_XY * 0.55, SPREAD_XY * 0.55),
        randRange(rng, -SPREAD_Z, SPREAD_Z),
      ],
      rotation: [
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
        randRange(rng, 0, Math.PI * 2),
      ],
      scale: randRange(rng, 0.6, 1.1),
      castShadow: false,
      receiveShadow: false,
    });
  }

  return objects;
}

const LIGHTS: LightSpec[] = [
  { type: 'ambient', color: 0xffffff, intensity: 0.6 },
  {
    type: 'directional',
    color: 0xffffff,
    intensity: 0.9,
    position: [20, 30, 40],
    castShadow: false,
    shadowMapSize: 1024,
  },
];

/**
 * S4 — Input latency сцена.
 *
 * Цель: измерить задержку «pointerdown → визуальный отклик» при raycast-
 * подсветке объекта. Сценарий проверяет, во сколько обходится доставка
 * реакции на ввод в R3F (setState → реконсиляция) против императивного
 * three.js и против «правильного» R3F через ref.
 *
 * Принципы дизайна сцены:
 *   - 2000 статичных объектов плотным облаком в кадре → почти любой клик
 *     попадает в объект (raycast hit), а число интерактивных узлов велико
 *     ровно настолько, чтобы реконсиляция R3F при наивном setState стоила
 *     заметного времени;
 *   - простая геометрия (Box) и отсутствие теней/анимации → ни GPU, ни
 *     per-frame CPU не являются узким местом; измеряется именно путь
 *     доставки отклика;
 *   - камера статична → отклик целиком определяется обработкой ввода.
 *
 * Raycasting выполняется ИДЕНТИЧНО в обеих реализациях (three.Raycaster по
 * координатам события), поэтому стоимость самого пересечения лучей в зачёт
 * разницы не идёт — сравнивается стоимость доставки подсветки до объекта:
 *   threejs          — императивно: material.emissive прямо на меше;
 *   r3f (?mode=ref)   — императивно через ref (минуя React);
 *   r3f (?mode=state) — через setState → реконсиляция дерева (наивный путь).
 *
 * Метрики — см. InputCollector / BenchInputResult.
 */
export const S4_INPUT: SceneSpec = {
  id: 's4-input',
  description: 'Input-latency scene: 2000 pickable static objects, raycast highlight',
  renderer: {
    width: 1280,
    height: 720,
    pixelRatio: 1,
    antialias: false,
    alpha: false,
    toneMapping: 'none',
    outputColorSpace: 'srgb',
    shadowMap: false,
    shadowType: 'pcf',
    clearColor: 0x0d1117,
  },
  camera: {
    fov: 55,
    near: 0.1,
    far: 300,
    position: [0, 0, 60],
    lookAt: [0, 0, 0],
    autoRotateSpeed: 0,
  },
  lights: LIGHTS,
  floor: null,
  objects: buildObjects(),
};
