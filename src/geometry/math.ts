/** Minimal vector/matrix math. Right-handed. Body frame: x fwd, y right, z down (aero convention). */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n < 1e-12 ? [0, 0, 0] : [a[0] / n, a[1] / n, a[2] / n];
};

/** 3x3 symmetric matrix as [xx, yy, zz, xy, xz, yz]. */
export type Sym3 = readonly [number, number, number, number, number, number];

export const symZero: Sym3 = [0, 0, 0, 0, 0, 0];
export const symAdd = (a: Sym3, b: Sym3): Sym3 =>
  [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3], a[4] + b[4], a[5] + b[5]] as const;
export const symScale = (a: Sym3, s: number): Sym3 =>
  [a[0] * s, a[1] * s, a[2] * s, a[3] * s, a[4] * s, a[5] * s] as const;

/** Rigid body transform: a rotation (row-major 3x3) followed by a translation. */
export interface Rigid {
  readonly r: readonly number[];
  readonly t: Vec3;
}

export const rigidIdentity: Rigid = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export function applyRigid(m: Rigid, v: Vec3): Vec3 {
  const r = m.r;
  return [
    r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2] + m.t[0],
    r[3]! * v[0] + r[4]! * v[1] + r[5]! * v[2] + m.t[1],
    r[6]! * v[0] + r[7]! * v[1] + r[8]! * v[2] + m.t[2],
  ];
}

/** Rotate a direction, ignoring translation. */
export function rotateRigid(m: Rigid, v: Vec3): Vec3 {
  const r = m.r;
  return [
    r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2],
    r[3]! * v[0] + r[4]! * v[1] + r[5]! * v[2],
    r[6]! * v[0] + r[7]! * v[1] + r[8]! * v[2],
  ];
}

/** Compose so that the result applies `b` first, then `a`. */
export function composeRigid(a: Rigid, b: Rigid): Rigid {
  const out: number[] = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += a.r[i * 3 + k]! * b.r[k * 3 + j]!;
      out[i * 3 + j] = sum;
    }
  }
  return { r: out, t: add(rotateRigid(a, b.t), a.t) };
}

/** Rotation of `angle` radians about the line through `point` along `axis`. */
export function rotationAbout(point: Vec3, axis: Vec3, angle: number): Rigid {
  const u = unit(axis);
  if (norm(u) < 0.5) return rigidIdentity;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  const [x, y, z] = u;
  // Rodrigues' rotation formula, written out.
  const r = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  const rot: Rigid = { r, t: [0, 0, 0] };
  return { r, t: sub(point, rotateRigid(rot, point)) };
}

/** Inverse of a rigid transform: the rotation transposes, the shift undoes. */
export function invertRigid(m: Rigid): Rigid {
  const r = m.r;
  const rt = [r[0]!, r[3]!, r[6]!, r[1]!, r[4]!, r[7]!, r[2]!, r[5]!, r[8]!];
  const inv: Rigid = { r: rt, t: [0, 0, 0] };
  return { r: rt, t: scale(rotateRigid(inv, m.t), -1) };
}

/**
 * Principal axes of a symmetric 3x3, by cyclic Jacobi rotation.
 *
 * For a body made of paper the three axes are the roll, pitch and yaw axes:
 * a flat sheet obeys the perpendicular-axis theorem, so the largest moment is
 * always about the axis square to the sheet, and the smallest is about its
 * longest dimension. That is enough to recover an aircraft's body frame from
 * the shape alone, without being told which way it was folded.
 */
export function eigenSym3(m: Sym3): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[3], m[4]],
    [m[3], m[1], m[5]],
    [m[4], m[5], m[2]],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) off += a[p]![q]! * a[p]![q]!;
    }
    if (off < 1e-24) break;

    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = [0, 1, 2].sort((x, y) => a[x]![x]! - a[y]![y]!);
  const pick = (i: number): Vec3 => [v[0]![i]!, v[1]![i]!, v[2]![i]!];
  return {
    values: [a[order[0]!]![order[0]!]!, a[order[1]!]![order[1]!]!, a[order[2]!]![order[2]!]!],
    vectors: [pick(order[0]!), pick(order[1]!), pick(order[2]!)],
  };
}
