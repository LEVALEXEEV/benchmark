export type Vec3 = readonly [number, number, number];

export type MaterialSpec =
  | {
      readonly type: 'standard';
      readonly color: number;
      readonly metalness: number;
      readonly roughness: number;
    }
  | {
      readonly type: 'basic';
      readonly color: number;
    };

export type GeometrySpec =
  | {
      readonly type: 'torusKnot';
      readonly radius: number;
      readonly tube: number;
      readonly tubularSegments: number;
      readonly radialSegments: number;
      readonly p: number;
      readonly q: number;
    }
  | {
      readonly type: 'box';
      readonly width: number;
      readonly height: number;
      readonly depth: number;
    };

export interface AnimationSpec {
  /** круговая орбита в плоскости XZ вокруг базовой позиции */
  readonly orbit: {
    readonly radius: number;
    readonly frequency: number;
    readonly phase: number;
  };
  /** постоянное вращение вокруг одной оси */
  readonly spin: {
    readonly axis: 'x' | 'y' | 'z';
    readonly speed: number;
  };
}

export interface ObjectSpec {
  readonly id: string;
  readonly geometry: GeometrySpec;
  readonly material: MaterialSpec;
  readonly position: Vec3;
  readonly rotation: Vec3;
  readonly scale: number;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  /** если задано — объект анимируется per-frame в обеих реализациях */
  readonly animation?: AnimationSpec;
}

export type LightSpec =
  | {
      readonly type: 'ambient';
      readonly color: number;
      readonly intensity: number;
    }
  | {
      readonly type: 'directional';
      readonly color: number;
      readonly intensity: number;
      readonly position: Vec3;
      readonly castShadow: boolean;
      readonly shadowMapSize: number;
    }
  | {
      readonly type: 'point';
      readonly color: number;
      readonly intensity: number;
      readonly position: Vec3;
      readonly distance: number;
    };

export interface CameraSpec {
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  readonly position: Vec3;
  readonly lookAt: Vec3;
  /** угловая скорость авто-вращения вокруг lookAt, рад/сек; 0 — без вращения */
  readonly autoRotateSpeed: number;
}

export interface RendererSpec {
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly antialias: boolean;
  readonly shadowMap: boolean;
  readonly clearColor: number;
}

export interface FloorSpec {
  readonly size: number;
  readonly color: number;
  readonly receiveShadow: boolean;
}

export interface SceneSpec {
  readonly id: string;
  readonly description: string;
  readonly renderer: RendererSpec;
  readonly camera: CameraSpec;
  readonly lights: readonly LightSpec[];
  readonly floor: FloorSpec | null;
  readonly objects: readonly ObjectSpec[];
}
