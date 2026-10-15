import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit, type Browser, type BrowserContext } from 'playwright';
import type { BrowserName } from './config.js';

/**
 * Chromium:
 *   --disable-gpu-vsync, --disable-frame-rate-limit — снять привязку к частоте
 *     монитора, иначе время кадра упирается в 16,7 мс и различия не видны;
 *   --disable-renderer-backgrounding и др. — окно без фокуса не должно
 *     троттлиться (headed-окно может оказаться перекрыто);
 *   --no-proxy-server — см. directEnv.
 */
const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-frame-rate-limit',
  '--disable-gpu-vsync',
  '--no-proxy-server',
];

/**
 * Firefox: layout.frame_rate=0 — без vsync; privacy.reduceTimerPrecision=false
 * — точный performance.now(). WebKit (Playwright-сборка) не позволяет снять
 * vsync: кадр там не короче 16,7 мс, сравниваются фазы кадра.
 */
const FIREFOX_PREFS = {
  'layout.frame_rate': 0,
  // без прокси — см. directEnv
  'network.proxy.type': 0,
  'privacy.reduceTimerPrecision': false,
  'webgl.force-enabled': true,
  'dom.timeout.enable_budget_timer_throttling': false,
};

export interface LaunchedBrowser {
  readonly browser: Browser;
  readonly name: BrowserName;
  readonly version: string;
  /** флаги запуска для manifest: аргументы Chromium или настройки Firefox */
  readonly flags: readonly string[];
}

/**
 * Окружение браузера без переменных прокси. Если в системе задан прокси
 * (VPN, HTTP_PROXY), Firefox пускает через него даже запросы к localhost, и
 * стенд отвечает 502; да и сеть между страницей и сервером замеров должна
 * быть одинаково прямой во всех браузерах.
 */
function directEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(https?|all|no)_proxy$/i.test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

export async function launchBrowser(name: BrowserName): Promise<LaunchedBrowser> {
  let browser: Browser;
  let flags: string[] = [];
  switch (name) {
    case 'chromium':
      browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS, env: directEnv() });
      flags = CHROMIUM_ARGS;
      break;
    case 'firefox':
      browser = await firefox.launch({
        headless: false,
        firefoxUserPrefs: FIREFOX_PREFS,
        // macOS 27 закрывает ~/Library/Application Support/Firefox, где сборка
        // Playwright ищет свои данные, и браузер не стартует
        // (microsoft/playwright#42768, исправлено в Firefox 158). Отдельная
        // пустая «домашняя папка» обходит это; песочница Firefox не трогается.
        env: directEnv(process.platform === 'darwin' ? { CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), 'bench-ff-')) } : {}),
      });
      flags = Object.entries(FIREFOX_PREFS).map(([k, v]) => `${k}=${v}`);
      break;
    case 'webkit':
      browser = await webkit.launch({ headless: false, env: directEnv() });
      break;
  }
  return { browser, name, version: browser.version(), flags };
}

export async function newBenchContext(b: LaunchedBrowser): Promise<BrowserContext> {
  return b.browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
}
