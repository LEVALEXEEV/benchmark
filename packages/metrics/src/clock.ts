/**
 * Время анимации сцены, общее для всех объектов кадра.
 *
 * Отсчёт идёт от первого кадра, а не от момента монтирования: в three.js и
 * R3F «старт» наступает в разные моменты, а первый кадр — общая точка.
 * В НИР2 R3F-объекты вызывали performance.now() каждый сам (3000 вызовов на
 * кадр, разные t внутри одного кадра) — это отличалось от three.js, где t
 * одно на кадр.
 *
 * frozen — фиксированное t для проверки паритета кадров.
 */
export class FrameClock {
  t = 0;
  private origin = NaN;
  private readonly frozen: number | null;

  constructor(frozen: number | null) {
    this.frozen = frozen;
    if (frozen !== null) this.t = frozen;
  }

  tick(now: number): void {
    if (this.frozen !== null) return;
    if (Number.isNaN(this.origin)) this.origin = now;
    this.t = (now - this.origin) / 1000;
  }
}
