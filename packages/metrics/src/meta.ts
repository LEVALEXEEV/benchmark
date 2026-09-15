import type { WebGLRenderer } from 'three';
import { collectPageEnv } from './env.js';
import type { RunParams } from './params.js';
import { RESULT_SCHEMA_VERSION, type BenchMeta, type ImplName } from './types.js';

export interface MetaInput {
  readonly params: RunParams;
  readonly impl: ImplName;
  readonly mode: string | null;
  readonly specId: string;
  readonly renderer: WebGLRenderer;
  /** import.meta.env.MODE реализации */
  readonly buildMode: string;
  readonly libs: Record<string, string>;
}

export function buildMeta(m: MetaInput): BenchMeta {
  return {
    schema: RESULT_SCHEMA_VERSION,
    scenario: m.params.scenario,
    specId: m.specId,
    impl: m.impl,
    mode: m.mode,
    parentState: m.params.parentState,
    params: { ...m.params },
    env: collectPageEnv(m.renderer, m.buildMode, m.libs),
  };
}
