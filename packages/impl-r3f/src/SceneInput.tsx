import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { ObjectSpec, SceneSpec } from '@bench/scene-spec';
import { InputCollector, type BenchInputResult } from '@bench/metrics';
import { GeometryNode, Light, v3 } from './Scene.js';

export type AnimationMode = 'ref' | 'state';

/** цвет emissive-подсветки выбранного объекта (одинаков в обеих реализациях) */
const HIGHLIGHT_EMISSIVE = 0xffae00;

type RegisterFn = (id: string, mesh: THREE.Mesh | null) => void;

/**
 * Один интерактивный объект сцены S4.
 *
 * В state-режиме подсветка приходит через prop `highlighted`: смена highlightId
 * в родителе ре-рендерит ВСЕ такие узлы (наивный путь, ср. S2b). В ref-режиме
 * `highlighted` всегда false — подсветка ставится императивно через
 * зарегистрированный ref, минуя React.
 */
function InputMesh({
  spec,
  highlighted,
  register,
}: {
  spec: ObjectSpec;
  highlighted: boolean;
  register: RegisterFn;
}) {
  const ref = useCallback(
    (mesh: THREE.Mesh | null) => {
      if (mesh) mesh.userData.id = spec.id;
      register(spec.id, mesh);
    },
    [spec.id, register]
  );

  return (
    <mesh
      ref={ref}
      position={v3(spec.position)}
      rotation={v3(spec.rotation)}
      scale={spec.scale}
    >
      <GeometryNode spec={spec.geometry} />
      {spec.material.type === 'standard' ? (
        <meshStandardMaterial
          color={spec.material.color}
          metalness={spec.material.metalness}
          roughness={spec.material.roughness}
          emissive={highlighted ? HIGHLIGHT_EMISSIVE : 0x000000}
        />
      ) : (
        <meshBasicMaterial color={spec.material.color} />
      )}
    </mesh>
  );
}

export interface InputSceneProps {
  readonly spec: SceneSpec;
  readonly mode: AnimationMode;
  readonly warmupMs: number;
  readonly recordMs: number;
  readonly clickIntervalMs: number;
  readonly seed: number;
  readonly onPhaseChange?: (phase: string, latency: number | null) => void;
}

/**
 * S4 на R3F. Сам рендерит сцену, ведёт подсветку и подключает InputCollector.
 *
 * Raycasting выполняется вручную (three.Raycaster) — идентично three.js-
 * реализации, чтобы в зачёт шла только стоимость доставки отклика:
 *   mode=ref   — императивно через ref (минуя реконсиляцию);
 *   mode=state — через setState → React-реконсиляция всех узлов.
 *
 * Фиксация «отрисованного» токена:
 *   - ref-режим: токен ставится прямо в обработчике (отклик применён сразу);
 *   - state-режим: токен фиксируется в useLayoutEffect, т.е. после commit'а
 *     React — ближайший кадр R3F уже отрисует обновлённое дерево.
 */
export function InputScene({
  spec,
  mode,
  warmupMs,
  recordMs,
  clickIntervalMs,
  seed,
  onPhaseChange,
}: InputSceneProps) {
  const { gl, camera } = useThree();
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const meshMap = useRef<Map<string, THREE.Mesh>>(new Map());

  // храним токен прямо в state: даже при двух кликах подряд по одному и тому
  // же объекту state меняется → ре-рендер и useLayoutEffect гарантированы.
  const [highlight, setHighlight] = useState<{ id: string; token: number } | null>(null);
  const renderedTokenRef = useRef(0);
  const prevImperative = useRef<THREE.Mesh | null>(null);

  const collector = useMemo(
    () =>
      new InputCollector({
        scenarioId: spec.id,
        implementation: 'r3f',
        mode,
        warmupMs,
        recordMs,
        clickIntervalMs,
        seed,
        publishToWindow: true,
      }),
    [spec.id, mode, warmupMs, recordMs, clickIntervalMs, seed]
  );

  const register = useCallback<RegisterFn>((id, mesh) => {
    if (mesh) meshMap.current.set(id, mesh);
    else meshMap.current.delete(id);
  }, []);

  useEffect(() => {
    const canvas = gl.domElement;

    const handler = (e: PointerEvent): void => {
      const t0 = performance.now();
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects([...meshMap.current.values()], false);
      const hit = hits.length > 0 ? (hits[0]!.object as THREE.Mesh) : null;

      collector.onPointerDown(t0, hit !== null);
      if (!hit) return;

      const id = hit.userData.id as string;
      const token = collector.currentToken;

      if (mode === 'ref') {
        if (prevImperative.current && prevImperative.current !== hit) {
          (prevImperative.current.material as THREE.MeshStandardMaterial).emissive.setHex(
            0x000000
          );
        }
        (hit.material as THREE.MeshStandardMaterial).emissive.setHex(HIGHLIGHT_EMISSIVE);
        prevImperative.current = hit;
        renderedTokenRef.current = token;
      } else {
        setHighlight({ id, token });
      }
    };

    canvas.addEventListener('pointerdown', handler);
    collector.onDone((r: BenchInputResult) =>
      onPhaseChange?.('done', r.input_latency_ms_avg)
    );
    collector.start(canvas);
    onPhaseChange?.('warmup', null);

    return () => canvas.removeEventListener('pointerdown', handler);
  }, [collector, gl, camera, raycaster, ndc, mode, onPhaseChange]);

  // state-режим: момент, когда подсветка фактически закоммичена React'ом
  useLayoutEffect(() => {
    if (mode === 'state' && highlight) renderedTokenRef.current = highlight.token;
  }, [highlight, mode]);

  const lastReportTs = useRef(0);
  useFrame(() => {
    const now = performance.now();
    collector.frame(now, renderedTokenRef.current);
    if (now - lastReportTs.current > 500) {
      lastReportTs.current = now;
      onPhaseChange?.(window.__BENCH__?.status ?? 'idle', null);
    }
  });

  return (
    <>
      <color attach="background" args={[spec.renderer.clearColor]} />
      {spec.lights.map((l, i) => (
        <Light key={i} spec={l} />
      ))}
      {spec.objects.map((o) => (
        <InputMesh
          key={o.id}
          spec={o}
          highlighted={mode === 'state' && highlight?.id === o.id}
          register={register}
        />
      ))}
    </>
  );
}
