import { useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import {
  applyAnimation,
  cameraPositionAt,
  type CameraSpec,
  type GeometrySpec,
  type LightSpec,
  type MaterialSpec,
  type ObjectSpec,
  type SceneSpec,
  type Vec3,
} from '@bench/scene-spec';
import { useFrameClock } from './FrameDriver.js';

// R3F-пропсы position/rotation — mutable-кортежи, спецификация — readonly.
export const v3 = (v: Vec3): [number, number, number] => [v[0], v[1], v[2]];

export function GeometryNode({ spec }: { spec: GeometrySpec }) {
  switch (spec.type) {
    case 'torusKnot':
      return (
        <torusKnotGeometry
          args={[spec.radius, spec.tube, spec.tubularSegments, spec.radialSegments, spec.p, spec.q]}
        />
      );
    case 'box':
      return <boxGeometry args={[spec.width, spec.height, spec.depth]} />;
  }
}

export function MaterialNode({ spec, emissive }: { spec: MaterialSpec; emissive?: number }) {
  switch (spec.type) {
    case 'standard':
      return (
        <meshStandardMaterial
          color={spec.color}
          metalness={spec.metalness}
          roughness={spec.roughness}
          {...(emissive === undefined ? {} : { emissive })}
        />
      );
    case 'basic':
      return <meshBasicMaterial color={spec.color} />;
  }
}

/** параметры теней задаются всегда — так же, как в three.js scene-builder */
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

/** общие для всех вариантов пропсы меша — начальная поза из спецификации */
function meshProps(spec: ObjectSpec) {
  return {
    position: v3(spec.position),
    rotation: v3(spec.rotation),
    scale: spec.scale,
    castShadow: spec.castShadow,
    receiveShadow: spec.receiveShadow,
    userData: { id: spec.id },
  };
}

export function StaticObject({ spec }: { spec: ObjectSpec }) {
  return (
    <mesh {...meshProps(spec)}>
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

/**
 * mode=ref — рекомендуемый в документации R3F путь: у каждого компонента
 * свой useFrame, мутации через ref минуя реконсиляцию.
 */
function AnimatedRefObject({ spec }: { spec: ObjectSpec }) {
  const clock = useFrameClock();
  const ref = useRef<THREE.Mesh>(null);
  const pos = useRef<[number, number, number]>([0, 0, 0]).current;
  const rot = useRef<[number, number, number]>([0, 0, 0]).current;
  useFrame(() => {
    const mesh = ref.current!;
    applyAnimation(clock.t, spec, spec.animation!, pos, rot);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.rotation.set(rot[0], rot[1], rot[2]);
  });
  return (
    <mesh ref={ref} {...meshProps(spec)}>
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

/**
 * mode=ref-central — один useFrame на все объекты, мутации через массив ref.
 * Отделяет стоимость «N подписок useFrame» от стоимости самой абстракции R3F:
 * цикл обновления здесь тот же, что в three.js.
 */
function CentralAnimatedObjects({ objects }: { objects: readonly ObjectSpec[] }) {
  const clock = useFrameClock();
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const pos = useRef<[number, number, number]>([0, 0, 0]).current;
  const rot = useRef<[number, number, number]>([0, 0, 0]).current;
  useFrame(() => {
    const t = clock.t;
    const meshes = refs.current;
    for (let i = 0; i < objects.length; i++) {
      const o = objects[i]!;
      const mesh = meshes[i]!;
      applyAnimation(t, o, o.animation!, pos, rot);
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.set(rot[0], rot[1], rot[2]);
    }
  });
  return (
    <>
      {objects.map((o, i) => (
        <mesh
          key={o.id}
          ref={(m) => {
            refs.current[i] = m;
          }}
          {...meshProps(o)}
        >
          <GeometryNode spec={o.geometry} />
          <MaterialNode spec={o.material} />
        </mesh>
      ))}
    </>
  );
}

/**
 * mode=state — наивный антипаттерн: поза в React state, setState каждый кадр
 * у каждого объекта → реконсиляция всех анимированных узлов на каждом кадре.
 */
function AnimatedStateObject({ spec }: { spec: ObjectSpec }) {
  const clock = useFrameClock();
  const [pose, setPose] = useState(() => ({ position: v3(spec.position), rotation: v3(spec.rotation) }));
  useFrame(() => {
    const position: [number, number, number] = [0, 0, 0];
    const rotation: [number, number, number] = [0, 0, 0];
    applyAnimation(clock.t, spec, spec.animation!, position, rotation);
    setPose({ position, rotation });
  });
  return (
    <mesh {...meshProps(spec)} position={pose.position} rotation={pose.rotation}>
      <GeometryNode spec={spec.geometry} />
      <MaterialNode spec={spec.material} />
    </mesh>
  );
}

export function Objects({ objects, mode }: { objects: readonly ObjectSpec[]; mode: string }) {
  const statics = objects.filter((o) => !o.animation);
  const animated = objects.filter((o) => o.animation);
  return (
    <>
      {statics.map((o) => (
        <StaticObject key={o.id} spec={o} />
      ))}
      {mode === 'ref-central' ? (
        <CentralAnimatedObjects objects={animated} />
      ) : (
        animated.map((o) =>
          mode === 'state' ? (
            <AnimatedStateObject key={o.id} spec={o} />
          ) : (
            <AnimatedRefObject key={o.id} spec={o} />
          )
        )
      )}
    </>
  );
}

function CameraOrbit({ cam }: { cam: CameraSpec }) {
  const clock = useFrameClock();
  const buf = useRef<[number, number, number]>([0, 0, 0]).current;
  useFrame((state) => {
    cameraPositionAt(cam, clock.t, buf);
    state.camera.position.set(buf[0], buf[1], buf[2]);
    state.camera.lookAt(cam.lookAt[0], cam.lookAt[1], cam.lookAt[2]);
  });
  return null;
}

/** окружение сцены: фон, свет, пол, орбита камеры — всё из спецификации */
export function SceneEnvironment({ spec }: { spec: SceneSpec }) {
  return (
    <>
      <color attach="background" args={[spec.renderer.clearColor]} />
      {spec.lights.map((l, i) => (
        <Light key={i} spec={l} />
      ))}
      {spec.floor && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={spec.floor.receiveShadow}>
          <planeGeometry args={[spec.floor.size, spec.floor.size]} />
          <meshStandardMaterial color={spec.floor.color} roughness={0.9} metalness={0.0} />
        </mesh>
      )}
      {spec.camera.autoRotateSpeed !== 0 && <CameraOrbit cam={spec.camera} />}
    </>
  );
}
