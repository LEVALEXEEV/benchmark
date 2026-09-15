import { createRoot } from 'react-dom/client';
import { bench, InitCollector, readRunParams, resolveMode } from '@bench/metrics';
import { App } from './App.js';
import { initProbe } from './runs/InitRun.js';

// Модули бандла уже исполнены: отсюда начинается код приложения (метка S3).
const jsReady = performance.now();

// StrictMode не используется: двойной вызов эффектов в dev запускал бы
// коллектор дважды. Замеры идут только на production-сборке, где StrictMode
// ничего не меняет, но dev-просмотр должен вести себя так же.
try {
  const params = readRunParams();
  const mode = resolveMode(params, 'r3f');
  bench.configureHud(params.hud, mode ? `react-three-fiber [${mode}]` : 'react-three-fiber');

  if (params.scenario === 's3') {
    // Коллектор S3 регистрируется ДО создания корня, как в three.js: иначе он
    // не увидел бы кадры, отрисованные до коммита сцены.
    const collector = new InitCollector({
      settleMs: params.settleMs,
      isSceneComplete: () => initProbe.isSceneComplete(),
    });
    collector.markJsReady(jsReady);
    bench.addProbe(collector);
    initProbe.collector = collector;
  }

  createRoot(document.getElementById('canvas-host')!, {
    onUncaughtError: (error) => bench.fail(error),
    onRecoverableError: (error) => bench.fail(error),
  }).render(<App params={params} mode={mode} />);
} catch (e) {
  bench.fail(e);
}
