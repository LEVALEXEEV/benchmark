import type { ParitySnapshot } from '@bench/metrics';
import { BenchPage } from './bench-page.js';
import { newBenchContext, type LaunchedBrowser } from './browser.js';
import { runUrl, type BenchConfig, type LoadPoint, type Target } from './config.js';
import { canvasBox, clickPoints } from './input-driver.js';

/** время анимации, в котором сравниваются кадры */
const PARITY_TIME = '1.5';
/** S5 сравнивается на одном уровне, достаточно большом для отсечения по frustum */
const PARITY_S5_COUNT = '2000';
const PARITY_S4_CLICKS = 4;
/**
 * Допуск на средний цвет блока 8×8 (0–255). Идентичные команды WebGL дают
 * побитово равный кадр; допуск нужен лишь на случай недетерминизма драйвера
 * при MSAA и должен оставаться на уровне единиц.
 */
const IMAGE_MAX_BLOCK_DIFF = 2;

export interface ParityEntry {
  readonly label: string;
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly image: { exact: boolean; meanAbs: number; maxAbs: number };
  readonly summary: Pick<ParitySnapshot, 'meshCount' | 'meshDigest' | 'camera'> & {
    calls: number;
    triangles: number;
    imageHash: string;
  };
}

export interface ParityReport {
  readonly scenario: string;
  readonly load: string;
  readonly reference: string;
  readonly ok: boolean;
  readonly entries: readonly ParityEntry[];
}

async function snapshot(lb: LaunchedBrowser, cfg: BenchConfig, target: Target, load: LoadPoint): Promise<ParitySnapshot> {
  const ctx = await newBenchContext(lb);
  try {
    const bp = await BenchPage.open(ctx);
    await bp.goto(runUrl(cfg, target, load, { parity: '1', freezeTime: PARITY_TIME, parityCount: PARITY_S5_COUNT }));
    await bp.waitFor(['parity-ready'], 120_000);
    if (cfg.scenario === 's4') {
      // одинаковые клики → один и тот же подсвеченный объект (паритет raycast)
      const next = clickPoints(await canvasBox(bp.page), cfg.clickSeed);
      for (let i = 0; i < PARITY_S4_CLICKS; i++) {
        const p = next();
        await bp.page.mouse.click(p.x, p.y);
        await bp.page.waitForTimeout(150);
      }
      await bp.page.waitForTimeout(500);
    }
    return (await bp.page.evaluate(() => window.__BENCH_CTRL__!.snapshot!())) as ParitySnapshot;
  } finally {
    await ctx.close();
  }
}

function decode(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function compare(ref: ParitySnapshot, s: ParitySnapshot): { issues: string[]; image: ParityEntry['image'] } {
  const issues: string[] = [];
  const eq = (name: string, a: unknown, b: unknown): void => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) issues.push(`${name}: эталон ${ja} ≠ ${jb}`);
  };
  for (const k of Object.keys(ref.renderer) as (keyof ParitySnapshot['renderer'])[]) {
    // накопительные счётчики, а не свойства сцены: зависят от того, что попадало
    // в кадр до снимка (R3F-state первый кадр рисует стартовую позу)
    if (k === 'programs' || k === 'geometries' || k === 'textures') continue;
    eq(`renderer.${k}`, ref.renderer[k], s.renderer[k]);
  }
  eq('camera', ref.camera, s.camera);
  eq('background', ref.background, s.background);
  const sortKeys = (o: Readonly<Record<string, number>>) => Object.fromEntries(Object.entries(o).sort());
  eq('typeCounts', sortKeys(ref.typeCounts), sortKeys(s.typeCounts));
  eq('lights', ref.lights, s.lights);
  eq('meshCount', ref.meshCount, s.meshCount);
  if (ref.meshDigest !== s.meshDigest) {
    const a = new Set(ref.meshes);
    const b = new Set(s.meshes);
    const onlyRef = ref.meshes.filter((m) => !b.has(m)).slice(0, 3);
    const onlyS = s.meshes.filter((m) => !a.has(m)).slice(0, 3);
    issues.push(
      `meshDigest: ${ref.meshDigest} ≠ ${s.meshDigest}\n  только в эталоне: ${onlyRef.join('\n    ')}\n  только в варианте: ${onlyS.join('\n    ')}`
    );
  }

  let image: ParityEntry['image'] = { exact: true, meanAbs: 0, maxAbs: 0 };
  if (ref.image.hash !== s.image.hash) {
    const a = decode(ref.image.blocksB64);
    const b = decode(s.image.blocksB64);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i]! - (b[i] ?? 0));
      sum += d;
      if (d > max) max = d;
    }
    image = { exact: false, meanAbs: sum / a.length, maxAbs: max };
    if (max > IMAGE_MAX_BLOCK_DIFF) {
      issues.push(`image: max Δ блока ${max} > ${IMAGE_MAX_BLOCK_DIFF} (средний Δ ${image.meanAbs.toFixed(3)})`);
    }
  }
  return { issues, image };
}

/**
 * Проверка паритета: все варианты сценария сравниваются с three.js при
 * одинаковом t. Любое расхождение — повод остановить серию: данные с
 * неидентичными сценами сравнивать нельзя.
 */
export async function runParity(lb: LaunchedBrowser, cfg: BenchConfig, load: LoadPoint): Promise<ParityReport> {
  const ref = cfg.targets.find((t) => t.impl === 'threejs');
  if (!ref) throw new Error('Для проверки паритета нужен вариант threejs в --targets');
  if (load.id !== '-') console.log(`[parity] точка нагрузки ${load.id}: ${load.note}`);
  const refSnap = await snapshot(lb, cfg, ref, load);
  const entries: ParityEntry[] = [];
  for (const t of cfg.targets) {
    const snap = t === ref ? refSnap : await snapshot(lb, cfg, t, load);
    const { issues, image } = t === ref ? { issues: [], image: { exact: true, meanAbs: 0, maxAbs: 0 } } : compare(refSnap, snap);
    entries.push({
      label: t.label,
      ok: issues.length === 0,
      issues,
      image,
      summary: {
        meshCount: snap.meshCount,
        meshDigest: snap.meshDigest,
        camera: snap.camera,
        calls: snap.renderer.calls,
        triangles: snap.renderer.triangles,
        imageHash: snap.image.hash,
      },
    });
    const mark = issues.length === 0 ? 'OK ' : 'FAIL';
    const img = image.exact ? 'кадр побитово равен' : `кадр Δmax=${image.maxAbs} Δmean=${image.meanAbs.toFixed(3)}`;
    console.log(`[parity] ${mark} ${t.label}: calls=${snap.renderer.calls} tris=${snap.renderer.triangles}, ${img}`);
    for (const i of issues) console.log(`         ${i}`);
  }
  return { scenario: cfg.scenario, load: load.id, reference: ref.label, ok: entries.every((e) => e.ok), entries };
}
