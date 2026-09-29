/**
 * Vortex lattice solver.
 *
 * Each panel carries a horseshoe vortex: a bound segment on the quarter chord
 * and two legs trailing downstream. Enforcing zero flow through every
 * collocation point fixes the circulations, and Kutta-Joukowski turns those
 * into forces. Solved once per geometry; the flight simulation then runs on the
 * derivatives it produces rather than re-solving the lattice every step.
 */

import { add, cross, dot, norm, scale, sub } from '../geometry/math.js';
import type { Vec3 } from '../geometry/math.js';

/**
 * One panel of the lattice: a bound vortex, where to test the flow, and which
 * way the surface faces.
 *
 * It lives here rather than in a mesher of its own. There was one - it cut a
 * planform into strips - but nothing called it once the airframe began
 * building its own stations straight from the folded paper, and a mesher
 * nobody meshes with is not a mesher.
 */
export interface LatticePanel {
  /** Bound vortex endpoints, inboard then outboard. */
  readonly a: Vec3;
  readonly b: Vec3;
  /** Collocation point at three-quarter chord. */
  readonly control: Vec3;
  readonly normal: Vec3;
  /** Panel area, m^2. */
  readonly area: number;
  readonly chord: number;
  readonly isFin: boolean;
}

/** Air density at sea level, kg/m^3. */
export const RHO = 1.225;

const FOUR_PI = 4 * Math.PI;
/*
 * How close to a filament a point may come before it counts as on it, as a
 * share of the filament's length. It was a fixed 1e-7 on |r1 x r2|^2, which
 * goes as length to the fourth: harmless on the metre-sized wing the solver
 * was tested on, but on a paper aeroplane, panels two or three centimetres
 * across, it switched off neighbouring panels altogether, and a wing split
 * chordwise came out with twice its lift acting at half its chord.
 */
const CORE = 1e-5;

/** Biot-Savart contribution of a straight filament of unit circulation. */
function segmentVelocity(p: Vec3, p1: Vec3, p2: Vec3): Vec3 {
  const r1 = sub(p, p1);
  const r2 = sub(p, p2);
  const c = cross(r1, r2);
  const cSq = dot(c, c);
  const n1 = norm(r1);
  const n2 = norm(r2);
  const r0 = sub(p2, p1);
  const lSq = dot(r0, r0);
  if (cSq < CORE * CORE * lSq * lSq || n1 < 1e-9 || n2 < 1e-9) return [0, 0, 0];
  const k = (dot(r0, r1) / n1 - dot(r0, r2) / n2) / (FOUR_PI * cSq);
  return scale(c, k);
}

/**
 * Velocity induced at `p` by a unit horseshoe on panel `q`.
 * `includeBound` is turned off when evaluating a panel on its own bound segment.
 */
function horseshoeVelocity(
  p: Vec3,
  q: LatticePanel,
  wake: Vec3,
  wakeLength: number,
  includeBound: boolean,
): Vec3 {
  const far = scale(wake, wakeLength);
  const aFar = add(q.a, far);
  const bFar = add(q.b, far);
  // Filament runs from downstream infinity in to A, across to B, then out again.
  let v = segmentVelocity(p, aFar, q.a);
  if (includeBound) v = add(v, segmentVelocity(p, q.a, q.b));
  return add(v, segmentVelocity(p, q.b, bFar));
}

function solveLinear(a: Float64Array, b: Float64Array, n: number): Float64Array {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(m[col * n + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r * n + col]!);
      if (v > best) { best = v; pivot = r; }
    }
    if (best < 1e-14) continue;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = m[col * n + c]!;
        m[col * n + c] = m[pivot * n + c]!;
        m[pivot * n + c] = t;
      }
      const t = x[col]!;
      x[col] = x[pivot]!;
      x[pivot] = t;
    }
    const d = m[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = m[r * n + col]! / d;
      if (f === 0) continue;
      for (let c = col; c < n; c++) m[r * n + c] = m[r * n + c]! - f * m[col * n + c]!;
      x[r] = x[r]! - f * x[col]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let c = r + 1; c < n; c++) s -= m[r * n + c]! * x[c]!;
    const d = m[r * n + r]!;
    x[r] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
  return x;
}

export interface FlowState {
  /** Freestream speed, m/s. */
  readonly speed: number;
  /** Angle of attack, radians. */
  readonly alpha: number;
  /** Sideslip, radians. */
  readonly beta: number;
  /** Body roll, pitch and yaw rates, rad/s. */
  readonly p?: number;
  readonly q?: number;
  readonly r?: number;
}

/**
 * Direction of the oncoming air in the body frame, which is the reverse of the
 * aircraft's own velocity. The wake trails along this vector, so getting its
 * sign wrong puts the trailing vortices ahead of the wing.
 */
export function freestream(alpha: number, beta: number): Vec3 {
  return [
    -Math.cos(alpha) * Math.cos(beta),
    -Math.sin(beta),
    -Math.sin(alpha) * Math.cos(beta),
  ];
}

/** Unit lift direction (perpendicular to the oncoming air, positive up). */
export function liftAxis(alpha: number, beta: number): Vec3 {
  return [
    Math.sin(alpha) * Math.cos(beta),
    Math.sin(alpha) * Math.sin(beta),
    -Math.cos(alpha),
  ];
}

export interface VlmResult {
  /** Force in the body frame, N. */
  readonly force: Vec3;
  /** Moment about the CG in the body frame, N*m. */
  readonly moment: Vec3;
  readonly circulations: Float64Array;
}

/** Cached influence coefficients, so repeated solves only refill the RHS. */
export interface VlmSystem {
  readonly panels: readonly LatticePanel[];
  readonly aic: Float64Array;
  readonly wake: Vec3;
  readonly wakeLength: number;
  readonly n: number;
}

export function buildSystem(panels: readonly LatticePanel[], wake: Vec3): VlmSystem {
  const n = panels.length;
  let extent = 0;
  for (const p of panels) extent = Math.max(extent, norm(p.control));
  const wakeLength = Math.max(50, 200 * extent);

  const aic = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const pi = panels[i]!;
    for (let j = 0; j < n; j++) {
      const v = horseshoeVelocity(pi.control, panels[j]!, wake, wakeLength, true);
      aic[i * n + j] = dot(v, pi.normal);
    }
  }
  return { panels, aic, wake, wakeLength, n };
}

export function solve(system: VlmSystem, flow: FlowState, cg: Vec3): VlmResult {
  const { panels, n, wake, wakeLength } = system;
  const vInf = scale(freestream(flow.alpha, flow.beta), flow.speed);
  const omega: Vec3 = [flow.p ?? 0, flow.q ?? 0, flow.r ?? 0];
  const spinning = omega[0] !== 0 || omega[1] !== 0 || omega[2] !== 0;

  // A point of a rotating body meets the air with an extra -omega x r.
  const onsetAt = (point: Vec3): Vec3 =>
    spinning ? sub(vInf, cross(omega, sub(point, cg))) : vInf;

  const rhs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pi = panels[i]!;
    rhs[i] = -dot(onsetAt(pi.control), pi.normal);
  }
  const gamma = solveLinear(system.aic, rhs, n);

  let force: Vec3 = [0, 0, 0];
  let moment: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const pi = panels[i]!;
    const mid: Vec3 = [
      (pi.a[0] + pi.b[0]) / 2,
      (pi.a[1] + pi.b[1]) / 2,
      (pi.a[2] + pi.b[2]) / 2,
    ];
    // Local velocity excludes this panel's own bound segment, which is singular
    // on itself; its trailing legs still contribute.
    let local = onsetAt(mid);
    for (let j = 0; j < n; j++) {
      const g = gamma[j]!;
      if (g === 0) continue;
      const v = horseshoeVelocity(mid, panels[j]!, wake, wakeLength, j !== i);
      local = add(local, scale(v, g));
    }
    const f = scale(cross(local, sub(pi.b, pi.a)), RHO * gamma[i]!);
    force = add(force, f);
    moment = add(moment, cross(sub(mid, cg), f));
  }
  return { force, moment, circulations: gamma };
}
