import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import type { BrowserName } from './config.js';

/**
 * Chromium-флаги:
 *   --disable-gpu-vsync, --disable-frame-rate-limit — снять привязку к частоте
 *     монитора, иначе frame time упирается в 16,7 мс и различия не видны;
 *   --enable-precise-memory-info — без него performance.memory квантуется;
 *   --disable-renderer-backgrounding и др. — окно без фокуса не должно
 *     троттлиться (headed-окно может оказаться перекрыто).
 */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--enable-precise-memory-info',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
];

/**
 * Firefox: layout.frame_rate=0 — ASAP-режим (без vsync);
 * privacy.reduceTimerPrecision=false — точный performance.now().
 * WebKit (Playwright-сборка) не позволяет снять vsync: FPS там упирается в
 * частоту монитора, сравнивать нужно фазы кадра (update/render), а не FPS.
 */
const FIREFOX_PREFS = {
  'layout.frame_rate': 0,
  'privacy.reduceTimerPrecision': false,
  'webgl.force-enabled': true,
  'dom.timeout.enable_budget_timer_throttling': false,
};

export interface LaunchedBrowser {
  readonly browser: Browser;
  readonly name: BrowserName;
  readonly version: string;
  readonly launchArgs: readonly string[];
  readonly prefs: Record<string, unknown> | null;
  readonly vsyncUncapped: boolean;
  readonly supportsCdp: boolean;
}

export async function launchBrowser(name: BrowserName): Promise<LaunchedBrowser> {
  let browser: Browser;
  switch (name) {
    case 'chrome':
      browser = await chromium.launch({ channel: 'chrome', headless: false, args: CHROMIUM_ARGS });
      break;
    case 'chromium':
      browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
      break;
    case 'firefox':
      browser = await firefox.launch({ headless: false, firefoxUserPrefs: FIREFOX_PREFS });
      break;
    case 'webkit':
      browser = await webkit.launch({ headless: false });
      break;
  }
  const chromiumLike = name === 'chrome' || name === 'chromium';
  return {
    browser,
    name,
    version: browser.version(),
    launchArgs: chromiumLike ? CHROMIUM_ARGS : [],
    prefs: name === 'firefox' ? FIREFOX_PREFS : null,
    vsyncUncapped: name !== 'webkit',
    supportsCdp: chromiumLike,
  };
}

export async function newBenchContext(b: LaunchedBrowser): Promise<BrowserContext> {
  return b.browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
}
