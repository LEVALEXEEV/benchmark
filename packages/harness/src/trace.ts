import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dirname } from 'node:path';
import type { CDPSession, Page } from 'playwright';

/**
 * Трассировка GC через CDP (только Chromium). Трасса сама добавляет накладные
 * расходы, поэтому прогоны с --trace — отдельная серия для объяснения
 * механизмов (GC-паузы), а не источник основных метрик.
 */
const CATEGORIES = ['devtools.timeline', 'v8', 'blink.user_timing', 'disabled-by-default-v8.gc'].join(',');

interface TraceEvent {
  readonly name: string;
  readonly cat: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid?: number;
  readonly tid?: number;
}

/** окно замера в трассе: пара меток bench:<name>-start / bench:<name>-end */
export interface GcWindowStats {
  readonly window: string;
  readonly duration_ms: number;
  readonly gc: Record<string, { count: number; total_ms: number; max_ms: number }>;
}

/**
 * Только паузы основного потока верхнего уровня. Подфазы V8.GC_* вложены в
 * них (и частично выполняются в фоновых потоках) — их суммирование дважды
 * учитывало бы одно и то же время.
 */
const GC_NAME = /^(MinorGC|MajorGC|BlinkGC\.AtomicPhase)$/;

export class Tracer {
  private readonly cdp: CDPSession;
  private readonly events: TraceEvent[] = [];
  private done: Promise<void> | null = null;

  private constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }

  static async start(page: Page): Promise<Tracer> {
    const cdp = await page.context().newCDPSession(page);
    const t = new Tracer(cdp);
    cdp.on('Tracing.dataCollected', (e) => {
      for (const ev of e.value) t.events.push(ev as unknown as TraceEvent);
    });
    await cdp.send('Tracing.start', { categories: CATEGORIES, transferMode: 'ReportEvents' });
    return t;
  }

  async stop(savePath: string | null): Promise<GcWindowStats[]> {
    this.done = new Promise((resolve) => this.cdp.once('Tracing.tracingComplete', () => resolve()));
    await this.cdp.send('Tracing.end');
    await this.done;
    if (savePath) {
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, gzipSync(JSON.stringify({ traceEvents: this.events })));
    }
    return this.analyze();
  }

  private analyze(): GcWindowStats[] {
    const marks = new Map<string, number>();
    for (const e of this.events) {
      if (e.cat.includes('blink.user_timing') && e.name.startsWith('bench:')) marks.set(e.name, e.ts);
    }
    const windows: { name: string; start: number; end: number }[] = [];
    for (const [name, ts] of marks) {
      if (!name.endsWith('-start')) continue;
      const base = name.slice('bench:'.length, -'-start'.length);
      const end = marks.get(`bench:${base}-end`);
      if (end !== undefined) windows.push({ name: base, start: ts, end });
    }

    // длительности: X-события несут dur, пары B/E сопоставляются по потоку и имени
    const spans: { name: string; start: number; dur: number }[] = [];
    const open = new Map<string, number[]>();
    for (const e of this.events) {
      if (!GC_NAME.test(e.name)) continue;
      if (e.ph === 'X' && e.dur !== undefined) spans.push({ name: e.name, start: e.ts, dur: e.dur });
      else if (e.ph === 'B') {
        const k = `${e.pid}:${e.tid}:${e.name}`;
        (open.get(k) ?? open.set(k, []).get(k)!).push(e.ts);
      } else if (e.ph === 'E') {
        const k = `${e.pid}:${e.tid}:${e.name}`;
        const s = open.get(k)?.pop();
        if (s !== undefined) spans.push({ name: e.name, start: s, dur: e.ts - s });
      }
    }

    return windows.map((w) => {
      const gc: GcWindowStats['gc'] = {};
      for (const s of spans) {
        if (s.start < w.start || s.start >= w.end) continue;
        const g = (gc[s.name] ??= { count: 0, total_ms: 0, max_ms: 0 });
        g.count++;
        g.total_ms += s.dur / 1000;
        g.max_ms = Math.max(g.max_ms, s.dur / 1000);
      }
      return { window: w.name, duration_ms: (w.end - w.start) / 1000, gc };
    });
  }
}
