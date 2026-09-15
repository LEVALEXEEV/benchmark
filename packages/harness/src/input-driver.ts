import type { Locator, Page } from 'playwright';
import { mulberry32 } from '@bench/scene-spec';

/** доля каждой стороны canvas, отсекаемая при выборе точки: облако S4 в центре кадра */
const CLICK_REGION_INSET = 0.2;

export interface ClickPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Детерминированная последовательность точек клика в координатах страницы.
 * Координаты целые: встроенные события R3F считают луч по offsetX/offsetY,
 * ручной raycast — по clientX/clientY; на целых пикселях они совпадают.
 */
export function clickPoints(
  box: { x: number; y: number; width: number; height: number },
  seed: number
): () => ClickPoint {
  const rng = mulberry32(seed);
  const span = 1 - 2 * CLICK_REGION_INSET;
  return () => ({
    x: Math.round(box.x + box.width * (CLICK_REGION_INSET + rng() * span)),
    y: Math.round(box.y + box.height * (CLICK_REGION_INSET + rng() * span)),
  });
}

export async function canvasBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const canvas: Locator = page.locator('#canvas-host canvas');
  await canvas.waitFor({ state: 'attached' });
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas не найден или невидим');
  return box;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Подаёт клики через Playwright (CDP Input.dispatchMouseEvent в Chromium):
 * событие проходит настоящий конвейер ввода браузера и приходит в случайной
 * фазе относительно кадра. Перед нажатием курсор перемещается и выдерживается
 * пауза — pointermove не попадает в тот же кадр, что и pointerdown.
 *
 * Seed зависит только от номера итерации, поэтому в одной итерации все
 * варианты получают одну и ту же последовательность точек и интервалов
 * (парный план эксперимента).
 */
export function startClickDriver(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
  seed: number,
  intervalMs: number,
  shouldStop: () => boolean
): { stop(): Promise<number> } {
  const next = clickPoints(box, seed);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  let stopped = false;
  let clicks = 0;
  const loop = (async () => {
    while (!stopped && !shouldStop()) {
      const p = next();
      await page.mouse.move(p.x, p.y);
      await sleep(30 + rng() * 30);
      if (stopped || shouldStop()) break;
      await page.mouse.down();
      await page.mouse.up();
      clicks++;
      await sleep(intervalMs * (0.5 + rng()));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop.catch(() => undefined);
      return clicks;
    },
  };
}
