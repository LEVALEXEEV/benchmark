import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { bench, countMeshes, enableParityMode, InputCollector, type RunParams } from '@bench/metrics';
import {
  expectedMeshCount,
  FEEDBACK_EMISSIVE_OFF,
  feedbackColorFor,
  type ObjectSpec,
  type SceneSpec,
} from '@bench/scene-spec';
import { useRunFinish } from '../FrameDriver.js';
import { GeometryNode, MaterialNode, SceneEnvironment, v3 } from '../nodes.js';

interface Highlight {
  readonly id: string;
  readonly color: number;
  readonly seq: number;
}

function emissiveOf(mesh: THREE.Object3D): THREE.Color {
  return ((mesh as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive;
}

/**
 * Узел для mode=ref и mode=state. НЕ мемоизирован намеренно: в state-режиме
 * смена подсветки в родителе перерисовывает все 2000 узлов (наивный путь).
 * ref-колбэк стабилен, чтобы ре-рендер не добавлял лишних вызовов ref,
 * не относящихся к самому паттерну.
 */
function InputMesh({
  spec,
  index,
  emissive,
  onMesh,
}: {
  spec: ObjectSpec;
  index: number;
  emissive: number;
  onMesh: (index: number, m: THREE.Mesh | null) => void;
}) {
  const ref = useCallback((m: THREE.Mesh | null) => onMesh(index, m), [index, onMesh]);
  return (
    <mesh
      ref={ref}
      position={v3(spec.position)}
      rotation={v3(spec.rotation)}
      scale={spec.scale}
      castShadow={spec.castShadow}
      receiveShadow={spec.receiveShadow}
      userData={{ id: spec.id }}
    >
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} emissive={emissive} />
    </mesh>
  );
}

/** минимальный внешний стор выбранного объекта (аналог zustand с селектором) */
function createHighlightStore() {
  let state: Highlight | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Highlight) {
      state = next;
      for (const l of listeners) l();
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
type HighlightStore = ReturnType<typeof createHighlightStore>;

/**
 * mode=events — идиоматичный R3F: встроенная система событий (onPointerDown
 * на меше, raycast делает R3F), мемоизированные узлы и подписка на стор с
 * селектором — при клике перерисовываются только прежний и новый выбранные.
 */
const EventsMesh = memo(function EventsMesh({
  spec,
  store,
  collector,
}: {
  spec: ObjectSpec;
  store: HighlightStore;
  collector: InputCollector;
}) {
  const color = useSyncExternalStore(store.subscribe, () => {
    const h = store.get();
    return h !== null && h.id === spec.id ? h.color : FEEDBACK_EMISSIVE_OFF;
  });
  useLayoutEffect(() => {
    const h = store.get();
    if (h && h.id === spec.id) collector.noteApplied(h.seq);
  }, [color, spec.id, store, collector]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>): void => {
    // ближайшее пересечение обрабатывается первым; дальше событие не идёт
    e.stopPropagation();
    const seq = collector.clickSeq;
    const target = feedbackColorFor(seq);
    store.set({ id: spec.id, color: target, seq });
    const obj = e.object;
    collector.reportHit(() => emissiveOf(obj).getHex() === target);
  };

  return (
    <mesh
      onPointerDown={onPointerDown}
      position={v3(spec.position)}
      rotation={v3(spec.rotation)}
      scale={spec.scale}
      castShadow={spec.castShadow}
      receiveShadow={spec.receiveShadow}
      userData={{ id: spec.id }}
    >
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} emissive={color} />
    </mesh>
  );
});

/** S4 */
export function InputRun({ params, mode, spec }: { params: RunParams; mode: string; spec: SceneSpec }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const finish = useRunFinish(params, mode);

  const collector = useMemo(
    () =>
      new InputCollector({
        // в режиме паритета запись не нужна, но нумерация кликов должна совпадать
        warmupMs: params.parity ? Infinity : params.warmupMs,
        recordMs: params.recordMs,
        timeoutMs: 2000,
      }),
    [params]
  );
  const store = useMemo(createHighlightStore, []);
  // меши в порядке спецификации — тот же массив целей raycast, что в three.js
  const meshes = useRef<THREE.Mesh[]>(new Array(spec.objects.length)).current;
  const onMesh = useMemo(
    () => (i: number, m: THREE.Mesh | null) => {
      if (m) meshes[i] = m;
    },
    [meshes]
  );
  const [highlight, setHighlight] = useState<Highlight | null>(null);

  useLayoutEffect(() => {
    const canvas = gl.domElement;
    collector.attach(canvas);
    const offProbe = bench.addProbe(collector);

    let offListener = (): void => {};
    if (mode !== 'events') {
      const raycaster = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      let highlighted: THREE.Mesh | null = null;
      const handler = (e: PointerEvent): void => {
        const rect = canvas.getBoundingClientRect();
        ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hits = raycaster.intersectObjects(meshes, false);
        if (hits.length === 0) return;
        const hit = hits[0]!.object as THREE.Mesh;
        const seq = collector.clickSeq;
        const color = feedbackColorFor(seq);
        if (mode === 'ref') {
          if (highlighted && highlighted !== hit) emissiveOf(highlighted).setHex(FEEDBACK_EMISSIVE_OFF);
          emissiveOf(hit).setHex(color);
          highlighted = hit;
        } else {
          setHighlight({ id: hit.userData.id as string, color, seq });
        }
        collector.reportHit(() => emissiveOf(hit).getHex() === color);
      };
      canvas.addEventListener('pointerdown', handler);
      offListener = () => canvas.removeEventListener('pointerdown', handler);
    }

    if (params.parity) {
      enableParityMode(
        bench,
        () => ({ renderer: gl, scene, camera }),
        () => countMeshes(scene) === expectedMeshCount(spec)
      );
    } else {
      collector.onDone((m) => {
        finish.stopLoop();
        bench.complete({ kind: 'input', meta: finish.meta(spec.id), ...m });
      });
    }
    return () => {
      offListener();
      offProbe();
    };
  }, []);

  // state-режим: точный момент коммита подсветки
  useLayoutEffect(() => {
    if (highlight) collector.noteApplied(highlight.seq);
  }, [highlight, collector]);

  return (
    <>
      <SceneEnvironment spec={spec} />
      {mode === 'events'
        ? spec.objects.map((o) => <EventsMesh key={o.id} spec={o} store={store} collector={collector} />)
        : spec.objects.map((o, i) => (
            <InputMesh
              key={o.id}
              index={i}
              spec={o}
              onMesh={onMesh}
              emissive={mode === 'state' && highlight?.id === o.id ? highlight.color : FEEDBACK_EMISSIVE_OFF}
            />
          ))}
    </>
  );
}
