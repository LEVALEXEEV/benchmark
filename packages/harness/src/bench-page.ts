import type { BrowserContext, Page } from 'playwright';
// типы window.__BENCH__ / __BENCH_CTRL__ объявлены в metrics/runtime.ts
import type {} from '@bench/metrics';

type Waiter = { statuses: Set<string>; resolve: (s: string) => void; reject: (e: Error) => void };

/**
 * Страница прогона. Статусы приходят из страницы через exposeFunction
 * (window.__BENCH_NOTIFY__), поэтому во время замера harness не исполняет в
 * странице никакого кода.
 */
export class BenchPage {
  readonly page: Page;
  readonly consoleErrors: string[] = [];
  private readonly seen = new Set<string>();
  private waiters: Waiter[] = [];
  lastStatus = 'none';

  private constructor(page: Page) {
    this.page = page;
  }

  static async open(context: BrowserContext): Promise<BenchPage> {
    const page = await context.newPage();
    const bp = new BenchPage(page);
    await page.exposeFunction('__BENCH_NOTIFY__', (status: string) => bp.onStatus(status));
    page.on('console', (m) => {
      if (m.type() === 'error') bp.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => bp.consoleErrors.push(`pageerror: ${e.message}`));
    page.on('crash', () => bp.onStatus('crash'));
    return bp;
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
  }

  private onStatus(status: string): void {
    this.lastStatus = status;
    this.seen.add(status);
    const failed = status === 'error' || status === 'crash';
    for (const w of [...this.waiters]) {
      if (w.statuses.has(status)) {
        w.resolve(status);
        this.waiters = this.waiters.filter((x) => x !== w);
      } else if (failed) {
        this.errorText()
          .then((t) => w.reject(new Error(`страница: ${status}\n${t}`)))
          .catch(() => w.reject(new Error(`страница: ${status}`)));
        this.waiters = this.waiters.filter((x) => x !== w);
      }
    }
  }

  has(status: string): boolean {
    return this.seen.has(status);
  }

  waitFor(statuses: readonly string[], timeoutMs: number): Promise<string> {
    const set = new Set(statuses);
    for (const s of set) if (this.seen.has(s)) return Promise.resolve(s);
    if (this.seen.has('error') || this.seen.has('crash')) {
      return this.errorText().then((t) => Promise.reject(new Error(`страница: error\n${t}`)));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(
          new Error(
            `таймаут ${timeoutMs} мс ожидания [${statuses.join(', ')}], последний статус ${this.lastStatus}` +
              (this.consoleErrors.length ? `\nconsole: ${this.consoleErrors.join('\n')}` : '')
          )
        );
      }, timeoutMs);
      const w: Waiter = {
        statuses: set,
        resolve: (s) => {
          clearTimeout(timer);
          resolve(s);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(w);
    });
  }

  private async errorText(): Promise<string> {
    const err = await this.page.evaluate(() => window.__BENCH__?.error ?? null).catch(() => null);
    return [err, ...this.consoleErrors].filter(Boolean).join('\n');
  }

  result<T>(): Promise<T> {
    return this.page.evaluate(() => window.__BENCH__!.result) as Promise<T>;
  }
}

