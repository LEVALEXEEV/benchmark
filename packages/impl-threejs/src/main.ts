import { getScenario, S5_LEVELS } from '@bench/scene-spec';
import { runScenario } from './runner.js';
import { runInitScenario } from './init-runner.js';
import { runInputScenario } from './input-runner.js';
import { runScaleScenario } from './scale-runner.js';

const params = new URLSearchParams(window.location.search);
const scenarioId = params.get('scenario') ?? 's1';
const warmupMs = Number(params.get('warmup') ?? 5000);
const recordMs = Number(params.get('record') ?? 30000);
const quietWindowMs = Number(params.get('quiet') ?? 2000);
const ttiTimeoutMs = Number(params.get('ttiTimeout') ?? 15000);
const clickIntervalMs = Number(params.get('clickInterval') ?? 250);
const inputSeed = Number(params.get('seed') ?? 4242);
const fpsFloor = Number(params.get('fpsFloor') ?? 30);
const levelsParam = params.get('levels');
const levels = levelsParam
  ? levelsParam.split(',').map((s) => Number(s)).filter((n) => Number.isFinite(n) && n > 0)
  : S5_LEVELS;

const spec = getScenario(scenarioId);

const host = document.getElementById('canvas-host')!;
const phaseEl = document.getElementById('phase')!;
const fpsEl = document.getElementById('fps')!;

if (scenarioId === 's3') {
  runInitScenario({
    spec,
    host,
    quietWindowMs,
    ttiTimeoutMs,
    onPhaseChange: (phase, ttfr) => {
      phaseEl.textContent = phase;
      phaseEl.className = phase === 'done' ? 'done' : 'phase';
      if (ttfr !== null) fpsEl.textContent = `ttfr ${ttfr.toFixed(0)}ms`;
    },
  });
} else if (scenarioId === 's4') {
  runInputScenario({
    spec,
    host,
    warmupMs,
    recordMs,
    clickIntervalMs,
    seed: inputSeed,
    onPhaseChange: (phase, latency) => {
      phaseEl.textContent = phase;
      phaseEl.className = phase === 'done' ? 'done' : 'phase';
      if (latency !== null) fpsEl.textContent = `lat ${latency.toFixed(1)}ms`;
    },
  });
} else if (scenarioId === 's5') {
  runScaleScenario({
    scenarioId,
    host,
    levels,
    warmupMs,
    recordMs,
    fpsFloor,
    onPhaseChange: (phase, value) => {
      phaseEl.textContent = phase;
      phaseEl.className = phase === 'done' ? 'done' : 'phase';
      if (value !== null) {
        fpsEl.textContent = phase === 'done' ? `deg ${value} obj` : `${value} obj`;
      }
    },
  });
} else {
  runScenario({
    spec,
    host,
    warmupMs,
    recordMs,
    onPhaseChange: (phase, fps) => {
      phaseEl.textContent = phase;
      phaseEl.className = phase === 'done' ? 'done' : 'phase';
      if (fps !== null) fpsEl.textContent = `${fps.toFixed(1)} fps`;
    },
  });
}
