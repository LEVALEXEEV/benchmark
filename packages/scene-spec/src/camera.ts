import type { CameraSpec } from './types.js';

/**
 * Позиция камеры в момент t при авто-вращении вокруг lookAt в плоскости XZ.
 *
 * Формула вынесена в спецификацию, чтобы обе реализации не держали свои копии:
 * в НИР2 она была продублирована, и любая правка в одной копии незаметно
 * ломала бы идентичность кадра. При autoRotateSpeed = 0 возвращается
 * исходная позиция.
 */
export function cameraPositionAt(
  cam: CameraSpec,
  t: number,
  out: [number, number, number]
): void {
  if (cam.autoRotateSpeed === 0) {
    out[0] = cam.position[0];
    out[1] = cam.position[1];
    out[2] = cam.position[2];
    return;
  }
  const dx = cam.position[0] - cam.lookAt[0];
  const dz = cam.position[2] - cam.lookAt[2];
  const radius = Math.hypot(dx, dz);
  const angle = Math.atan2(dz, dx) + cam.autoRotateSpeed * t;
  out[0] = cam.lookAt[0] + Math.cos(angle) * radius;
  out[1] = cam.position[1];
  out[2] = cam.lookAt[2] + Math.sin(angle) * radius;
}
