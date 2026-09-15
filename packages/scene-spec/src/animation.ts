import type { AnimationSpec, ObjectSpec } from './types.js';

/**
 * Считает позицию и поворот объекта в момент времени t.
 *
 * Пишет результат в переданные mutable-буферы — это важно: на hot path
 * (тысячи объектов × 60 fps) лишние аллокации искажают замер CPU.
 *
 * Формула одинакова для обеих реализаций (three.js и R3F), что гарантирует
 * идентичную CPU-нагрузку чисто на математику. Различия между технологиями
 * проявятся в стоимости ДОСТАВКИ этих значений до объекта сцены.
 */
export function applyAnimation(
  t: number,
  base: ObjectSpec,
  anim: AnimationSpec,
  outPos: [number, number, number],
  outRot: [number, number, number]
): void {
  const orbitAngle = anim.orbit.phase + anim.orbit.frequency * 2 * Math.PI * t;
  outPos[0] = base.position[0] + anim.orbit.radius * Math.cos(orbitAngle);
  outPos[1] = base.position[1];
  outPos[2] = base.position[2] + anim.orbit.radius * Math.sin(orbitAngle);

  const spinDelta = anim.spin.speed * t;
  outRot[0] = base.rotation[0] + (anim.spin.axis === 'x' ? spinDelta : 0);
  outRot[1] = base.rotation[1] + (anim.spin.axis === 'y' ? spinDelta : 0);
  outRot[2] = base.rotation[2] + (anim.spin.axis === 'z' ? spinDelta : 0);
}
