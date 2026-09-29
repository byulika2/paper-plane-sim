/**
 * Mass properties of the opened aircraft.
 *
 * Folding never adds or removes paper, so total mass is fixed by the sheet.
 * What folding does change - and what decides whether the plane flies - is
 * where that mass sits and how it resists rotation.
 */

import { cross, dot, sub, symAdd, symScale, symZero } from './math.js';
import type { Sym3, Vec3 } from './math.js';
/**
 * A piece of paper in space, weighed rather than drawn.
 *
 * It used to come from an assembly module that stood a flat model up into a
 * three-dimensional one. That module went when the folding engine started
 * placing faces in space itself, and this is all anything wanted from it.
 */
export interface Panel3 {
  readonly points: readonly Vec3[];
  /** Flat paper area of this piece, m^2. */
  readonly area: number;
  /** Which half of the sheet it came from: -1 or 1. */
  readonly side: number;
  readonly isFin: boolean;
}

export interface MassProperties {
  /** Total mass, kg. */
  readonly mass: number;
  /** Centre of gravity in the construction frame, m. */
  readonly cg: Vec3;
  /** Inertia tensor about the CG, kg*m^2, as [Ixx, Iyy, Izz, Ixy, Ixz, Iyz]. */
  readonly inertia: Sym3;
  /** Total paper area accounted for, m^2. Must match the sheet. */
  readonly areaCheck: number;
}

/** Fan-triangulate a planar polygon. */
function triangles(points: readonly Vec3[]): Array<[Vec3, Vec3, Vec3]> {
  const out: Array<[Vec3, Vec3, Vec3]> = [];
  for (let i = 1; i + 1 < points.length; i++) {
    out.push([points[0]!, points[i]!, points[i + 1]!]);
  }
  return out;
}

const triangleArea = (a: Vec3, b: Vec3, c: Vec3): number => {
  const n = cross(sub(b, a), sub(c, a));
  return 0.5 * Math.sqrt(dot(n, n));
};

/**
 * Second-moment matrix of a uniform triangular lamina about the origin, per
 * unit areal density: C = (A/12)(S S^T + sum p_i p_i^T) with S = p0 + p1 + p2.
 */
function triangleCovariance(a: Vec3, b: Vec3, c: Vec3, area: number): Sym3 {
  const s: Vec3 = [a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]];
  const k = area / 12;
  const term = (p: Vec3, q: Vec3): Sym3 =>
    [p[0] * q[0], p[1] * q[1], p[2] * q[2], p[0] * q[1], p[0] * q[2], p[1] * q[2]] as const;
  let m = term(s, s);
  for (const p of [a, b, c]) m = symAdd(m, term(p, p));
  return symScale(m, k);
}

export function massProperties(panels: readonly Panel3[], arealDensity: number): MassProperties {
  let area = 0;
  let flatArea = 0;
  let moment: Vec3 = [0, 0, 0];
  let cov: Sym3 = symZero;

  for (const panel of panels) {
    flatArea += panel.area;
    for (const [a, b, c] of triangles(panel.points)) {
      const at = triangleArea(a, b, c);
      if (at < 1e-14) continue;
      area += at;
      const centroid: Vec3 = [
        (a[0] + b[0] + c[0]) / 3,
        (a[1] + b[1] + c[1]) / 3,
        (a[2] + b[2] + c[2]) / 3,
      ];
      moment = [
        moment[0] + centroid[0] * at,
        moment[1] + centroid[1] * at,
        moment[2] + centroid[2] * at,
      ];
      cov = symAdd(cov, triangleCovariance(a, b, c, at));
    }
  }

  const mass = area * arealDensity;
  const cg: Vec3 = area > 1e-12
    ? [moment[0] / area, moment[1] / area, moment[2] / area]
    : [0, 0, 0];

  // Shift the second-moment matrix from the origin to the CG, then convert it
  // into an inertia tensor: I = trace(C) * Id - C.
  const shift: Sym3 = [
    cg[0] * cg[0], cg[1] * cg[1], cg[2] * cg[2],
    cg[0] * cg[1], cg[0] * cg[2], cg[1] * cg[2],
  ];
  const c = symAdd(symScale(cov, arealDensity), symScale(shift, -mass));
  const trace = c[0] + c[1] + c[2];
  const inertia: Sym3 = [
    trace - c[0], trace - c[1], trace - c[2],
    -c[3], -c[4], -c[5],
  ];

  return { mass, cg, inertia, areaCheck: flatArea };
}
