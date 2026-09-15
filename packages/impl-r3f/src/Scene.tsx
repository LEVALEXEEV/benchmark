import { useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type {
  CameraSpec,
  GeometrySpec,
  LightSpec,
  MaterialSpec,
  ObjectSpec,
  SceneSpec,
  Vec3,
} from '@bench/scene-spec';
import { applyAnimation } from '@bench/scene-spec';
import * as THREE from 'three';

export type AnimationMode = 'ref' | 'state';

// R3F prop-типы (position, rotation, ...) объявлены как mutable-кортежи.
// SceneSpec намеренно readonly — копируем в mutable на границе.
export const v3 = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]];

export function GeometryNode({ spec }: { spec: GeometrySpec }) {
  switch (spec.type) {
    case 'torusKnot':
      return (
        <torusKnotGeometry
          args={[
            spec.radius,
            spec.tube,
            spec.tubularSegments,
            spec.radialSegments,
            spec.p,
            spec.q,
          ]}
        />
      );
    case 'box':
      return <boxGeometry args={[spec.width, spec.height, spec.depth]} />;
  }
}

function MaterialNode({ spec }: { spec: MaterialSpec }) {
  switch (spec.type) {
    case 'standard':
      return (
        <meshStandardMaterial
          color={spec.color}
          metalness={spec.metalness}
          roughness={spec.roughness}
        />
      );
    case 'basic':
      return <meshBasicMaterial color={spec.color} />;
  }
}

export function Light({ spec }: { spec: LightSpec }) {
  switch (spec.type) {
    case 'ambient':
      return <ambientLight color={spec.color} intensity={spec.intensity} />;
    case 'directional':
      return (
        <directionalLight
          color={spec.color}
          intensity={spec.intensity}
          position={v3(spec.position)}
          castShadow={spec.castShadow}
          shadow-mapSize-width={spec.shadowMapSize}
          shadow-mapSize-height={spec.shadowMapSize}
          shadow-camera-near={0.5}
          shadow-camera-far={200}
          shadow-camera-left={-60}
          shadow-camera-right={60}
          shadow-camera-top={60}
          shadow-camera-bottom={-60}
        />
      );
    case 'point':
      return (
        <pointLight
          color={spec.color}
          intensity={spec.intensity}
          position={v3(spec.position)}
          distance={spec.distance}
        />
      );
  }
}

/** Статический объект — не анимируется, рендерится один раз. */
function StaticObject({ spec }: { spec: ObjectSpec }) {
  return (
    <mesh
      position={v3(spec.position)}
      rotation={v3(spec.rotation)}
      scale={spec.scale}
      castShadow={spec.castShadow}
      receiveShadow={spec.receiveShadow}
    >
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

/**
 * S2a — рекомендованный R3F-подход: мутации идут через ref на три.js-объект
 * напрямую. React-реконсиляция НЕ запускается на каждый кадр.
 *
 * Это то, о чём говорится в документации R3F: "Components render outside of React".
 * Сравнивается с императивным three.js на ту же логику обновления.
 */
export function AnimatedRefObject({ spec, startTs }: { spec: ObjectSpec; startTs: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const posBuf = useRef<[number, number, number]>([0, 0, 0]);
  const rotBuf = useRef<[number, number, number]>([0, 0, 0]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh || !spec.animation) return;
    const t = (performance.now() - startTs) / 1000;
    applyAnimation(t, spec, spec.animation, posBuf.current, rotBuf.current);
    mesh.position.set(posBuf.current[0], posBuf.current[1], posBuf.current[2]);
    mesh.rotation.set(rotBuf.current[0], rotBuf.current[1], rotBuf.current[2]);
  });

  return (
    <mesh
      ref={ref}
      position={v3(spec.position)}
      rotation={v3(spec.rotation)}
      scale={spec.scale}
    >
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

/**
 * S2b — наивный анти-паттерн: трансформ хранится в React state,
 * useFrame вызывает setState каждый кадр.
 *
 * Это запускает полный React-рендер компонента и реконсиляцию для всех
 * 3000 узлов на КАЖДОМ кадре. Худший случай R3F.
 */
export function AnimatedStateObject({ spec, startTs }: { spec: ObjectSpec; startTs: number }) {
  const [pose, setPose] = useState<{
    position: [number, number, number];
    rotation: [number, number, number];
  }>(() => ({
    position: v3(spec.position),
    rotation: v3(spec.rotation),
  }));

  useFrame(() => {
    if (!spec.animation) return;
    const t = (performance.now() - startTs) / 1000;
    const nextPos: [number, number, number] = [0, 0, 0];
    const nextRot: [number, number, number] = [0, 0, 0];
    applyAnimation(t, spec, spec.animation, nextPos, nextRot);
    setPose({ position: nextPos, rotation: nextRot });
  });

  return (
    <mesh position={pose.position} rotation={pose.rotation} scale={spec.scale}>
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

function CameraOrbit({ cameraSpec }: { cameraSpec: CameraSpec }) {
  const { camera } = useThree();
  const lookAt = useRef(new THREE.Vector3(...cameraSpec.lookAt));
  const startTs = useRef(performance.now());
  const radius = useRef(
    new THREE.Vector3(...cameraSpec.position).sub(lookAt.current).length()
  );
  const startAngle = useRef(
    Math.atan2(
      cameraSpec.position[2] - cameraSpec.lookAt[2],
      cameraSpec.position[0] - cameraSpec.lookAt[0]
    )
  );

  useFrame(() => {
    const t = (performance.now() - startTs.current) / 1000;
    const angle = startAngle.current + cameraSpec.autoRotateSpeed * t;
    camera.position.x = lookAt.current.x + Math.cos(angle) * radius.current;
    camera.position.z = lookAt.current.z + Math.sin(angle) * radius.current;
    camera.position.y = cameraSpec.position[1];
    camera.lookAt(lookAt.current);
  });

  return null;
}

export function Scene({
  spec,
  mode,
}: {
  spec: SceneSpec;
  mode: AnimationMode;
}) {
  const startTs = useRef(performance.now()).current;

  return (
    <>
      <color attach="background" args={[spec.renderer.clearColor]} />
      {spec.lights.map((l, i) => (
        <Light key={i} spec={l} />
      ))}
      {spec.floor && (
        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          receiveShadow={spec.floor.receiveShadow}
        >
          <planeGeometry args={[spec.floor.size, spec.floor.size]} />
          <meshStandardMaterial
            color={spec.floor.color}
            roughness={0.9}
            metalness={0.0}
          />
        </mesh>
      )}
      {spec.objects.map((o) => {
        if (!o.animation) return <StaticObject key={o.id} spec={o} />;
        return mode === 'ref' ? (
          <AnimatedRefObject key={o.id} spec={o} startTs={startTs} />
        ) : (
          <AnimatedStateObject key={o.id} spec={o} startTs={startTs} />
        );
      })}
      {spec.camera.autoRotateSpeed !== 0 && <CameraOrbit cameraSpec={spec.camera} />}
    </>
  );
}
