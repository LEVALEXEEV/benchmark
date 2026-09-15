import { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { getScenario } from '@bench/scene-spec';
import { Scene, type AnimationMode } from './Scene.js';
import { InputScene } from './SceneInput.js';
import { ScaleScene } from './SceneScale.js';
import { MetricsBridge } from './MetricsBridge.js';
import { MetricsBridgeInit } from './MetricsBridgeInit.js';
import { S5_LEVELS } from '@bench/scene-spec';

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
const modeParam = params.get('mode');
const mode: AnimationMode = modeParam === 'state' ? 'state' : 'ref';

const isInitScenario = scenarioId === 's3';
const isInputScenario = scenarioId === 's4';
const isScaleScenario = scenarioId === 's5';

export function App() {
  const spec = getScenario(scenarioId);
  const [phase, setPhase] = useState('idle');
  const [readout, setReadout] = useState<string>('— fps');

  const onPhaseChange = useCallback((p: string, value: number | null) => {
    setPhase(p);
    if (value !== null) {
      setReadout(
        isInitScenario
          ? `ttfr ${value.toFixed(0)}ms`
          : isInputScenario
            ? `lat ${value.toFixed(1)}ms`
            : isScaleScenario
              ? `${value} obj`
              : `${value.toFixed(1)} fps`
      );
    }
  }, []);

  const hudLabel = isInputScenario || isInitScenario ? '' : ` [mode=${mode}]`;

  return (
    <div id="app">
      <div className="hud">
        react-three-fiber{hudLabel} •{' '}
        <span className={phase === 'done' ? 'done' : 'phase'}>{phase}</span> •{' '}
        <span>{readout}</span>
      </div>
      <div
        className="canvas-host"
        style={{ width: spec.renderer.width, height: spec.renderer.height }}
      >
        <Canvas
          shadows={spec.renderer.shadowMap}
          dpr={spec.renderer.pixelRatio}
          gl={{
            antialias: spec.renderer.antialias,
            powerPreference: 'high-performance',
          }}
          camera={{
            fov: spec.camera.fov,
            near: spec.camera.near,
            far: spec.camera.far,
            position: [...spec.camera.position],
          }}
          style={{ width: spec.renderer.width, height: spec.renderer.height }}
        >
          {isScaleScenario ? (
            <ScaleScene
              scenarioId={spec.id}
              mode={mode}
              levels={levels}
              warmupMs={warmupMs}
              recordMs={recordMs}
              fpsFloor={fpsFloor}
              onPhaseChange={onPhaseChange}
            />
          ) : isInputScenario ? (
            <InputScene
              spec={spec}
              mode={mode}
              warmupMs={warmupMs}
              recordMs={recordMs}
              clickIntervalMs={clickIntervalMs}
              seed={inputSeed}
              onPhaseChange={onPhaseChange}
            />
          ) : (
            <>
              <Scene spec={spec} mode={mode} />
              {isInitScenario ? (
                <MetricsBridgeInit
                  scenarioId={spec.id}
                  quietWindowMs={quietWindowMs}
                  ttiTimeoutMs={ttiTimeoutMs}
                  onPhaseChange={onPhaseChange}
                />
              ) : (
                <MetricsBridge
                  scenarioId={spec.id}
                  mode={mode}
                  warmupMs={warmupMs}
                  recordMs={recordMs}
                  onPhaseChange={onPhaseChange}
                />
              )}
            </>
          )}
        </Canvas>
      </div>
    </div>
  );
}
