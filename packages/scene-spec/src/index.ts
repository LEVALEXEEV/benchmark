export * from './types.js';
export * from './prng.js';
export * from './animation.js';
export { S1_GPU_BOUND } from './scenarios/s1-gpu-bound.js';
export { S2_CPU_BOUND } from './scenarios/s2-cpu-bound.js';
export { S3_INIT } from './scenarios/s3-init.js';
export { S4_INPUT } from './scenarios/s4-input.js';
export { S5_SCALE, S5_LEVELS, makeS5Scene } from './scenarios/s5-scale.js';

import type { SceneSpec } from './types.js';
import { S1_GPU_BOUND } from './scenarios/s1-gpu-bound.js';
import { S2_CPU_BOUND } from './scenarios/s2-cpu-bound.js';
import { S3_INIT } from './scenarios/s3-init.js';
import { S4_INPUT } from './scenarios/s4-input.js';
import { S5_SCALE } from './scenarios/s5-scale.js';

export const SCENARIOS: Record<string, SceneSpec> = {
  s1: S1_GPU_BOUND,
  s2: S2_CPU_BOUND,
  s3: S3_INIT,
  s4: S4_INPUT,
  s5: S5_SCALE,
};

export function getScenario(id: string): SceneSpec {
  const spec = SCENARIOS[id];
  if (!spec) {
    throw new Error(
      `Unknown scenario "${id}". Available: ${Object.keys(SCENARIOS).join(', ')}`
    );
  }
  return spec;
}
