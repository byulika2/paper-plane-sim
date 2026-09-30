/**
 * From folded paper to an aircraft the aerodynamics can read.
 *
 * An earlier attempt grouped plies into coplanar surfaces and meshed each one.
 * It was too fragile: a paper aeroplane has a dozen slightly different planes,
 * overlapping plies double-counted their projected area, and the span and chord
 * directions of an individual surface bear no relation to the aircraft's.
 *
 * What the aerodynamics actually needs is the shape the air sees: the planform
 * looking up from underneath, and how high that surface sits across the span -
 * which is the dihedral. So the plies are projected onto the plane of flight
 * and the silhouette is scanned station by station, exactly the way the flat
 * model's silhouette is scanned. Anything standing on edge is counted
 * separately as keel area, because it makes no lift but does resist yaw.
 *
 * Body axes follow the aerospace convention: x forward, y right, z down.
 */

import { massProperties } from '../geometry/massProps.js';
import type { MassProperties } from '../geometry/massProps.js';
import type { RenderFace } from '../origami/space.js';
import { cross, dot, eigenSym3, norm, sub, unit } from '../geometry/math.js';
import type { Vec3 } from '../geometry/math.js';
import type { PaperProps } from '../paper/stock.js';

export interface BodyFrame {
  toBody(p: Vec3): Vec3;
}

/**
 * The body frame, read off the shape itself.
 *
 * Taking the sheet's own axes does not work: fold a sheet in half to anything
 * short of flat and one half stays on the table while the other stands up, so
 * the sheet's normal is not the aircraft's. The principal axes of the mass are
 * the aircraft's, whatever attitude the paper happens to be lying in - the
 * largest moment is about the axis square to the wing, the smallest along the
 * fuselage.
 *
 * Except when the paper is still flat, where there is no aircraft to read. A
 * plane sheet has two equal principal moments, so its in-plane axes are not
 * determined at all, and the third moment that decides which way is nose and
 * which is keel comes out as rounding noise about zero. Both then flip on the
 * slightest change, which is why the paper appeared to spin on the table every
 * time a crease was pressed - and a click landed on the opposite end of the
 * sheet from the one under the pointer. A sheet with no depth gets no
 * attitude: it is placed as it lies.
 */
function principalFrame(
  inertia: Parameters<typeof eigenSym3>[0],
  centre: Vec3,
  plies: readonly RenderFace[],
): BodyFrame {
  const asItLies: BodyFrame = { toBody: (p) => sub(p, centre) };

  /* Is there any depth to stand up? Measured on the paper's own normal, which
     for a sheet that has not been folded out of its plane is the only axis
     that means anything. Below a couple of calipers there is no aeroplane. */
  let flat = true;
  outer: for (const ply of plies) {
    for (const p of ply.points) {
      if (Math.abs(p[2] - centre[2]) > 3e-4) { flat = false; break outer; }
    }
  }
  if (flat) return asItLies;

  const { vectors } = eigenSym3(inertia);
  let x = unit(vectors[0]);          // smallest moment: along the fuselage
  let z = unit(vectors[2]);          // largest: square to the wing

  /*
   * Unless the aeroplane is wider than it is long.
   *
   * A flying wing like Birdman spans 18cm on a 12cm chord, and its smallest
   * moment is about the span: nose and wingtip swapped, and every figure the
   * aerodynamics gave was for a wing flown sideways. What does not depend on
   * proportions is the mirror: an aeroplane is its own reflection across the
   * plane holding its nose and its keel. Of the two axes in the wing's plane,
   * the one it reflects across is the span.
   */
  {
    const corners = plies.flatMap((ply) => ply.points);
    const mismatch = (axis: Vec3) => {
      let total = 0;
      for (const p of corners) {
        const d = dot(sub(p, centre), axis);
        const q: Vec3 = [p[0] - 2 * d * axis[0], p[1] - 2 * d * axis[1], p[2] - 2 * d * axis[2]];
        let best = Infinity;
        for (const r of corners) {
          const e = (r[0] - q[0]) ** 2 + (r[1] - q[1]) ** 2 + (r[2] - q[2]) ** 2;
          if (e < best) best = e;
        }
        total += Math.sqrt(best);
      }
      return total / Math.max(1, corners.length);
    };
    const across = unit(vectors[1]);
    if (norm(across) > 0.5 && norm(x) > 0.5 && mismatch(x) < 0.25 * mismatch(across)) x = across;
  }
  // NaN fails every comparison, so test for the good case, not the bad one.
  if (!(norm(x) > 0.5) || !(norm(z) > 0.5)) return asItLies;
  let y = unit(cross(z, x));         // right-handed: x cross y = z
  x = unit(cross(y, z));
  if (![...x, ...y, ...z].every(Number.isFinite)) return asItLies;

  const project = (p: Vec3): Vec3 => {
    const d = sub(p, centre);
    return [dot(d, x), dot(d, y), dot(d, z)];
  };

  // Which way round the axes point still has to be settled from the shape.
  let minX = Infinity;
  let maxX = -Infinity;
  let heavyZ = 0;
  for (const ply of plies) {
    for (const p of ply.points) {
      const q = project(p);
      minX = Math.min(minX, q[0]);
      maxX = Math.max(maxX, q[0]);
      // Third moment: the keel hangs to one side and drags the mass with it.
      heavyZ += q[2] ** 3 * (ply.area / Math.max(1, ply.points.length));
    }
  }
  // The nose carries the folded-up layers, so the mass sits forward of the
  // middle of the shape; that tells us which end is the nose.
  let noseForward = (minX + maxX) / 2 < 0;
  /*
   * Unless the outline says otherwise, which it says more reliably.
   *
   * The mass rule read the dart backwards: its wide straight edge carries as
   * much paper as its point, and the aerodynamics flew it tail first - sixty
   * per cent unstable, with a pupil told to add a clip. An aeroplane is
   * narrow at the nose and widest at the tail, so where one end of the outline
   * is plainly narrower than the other, that end is the nose. A flying wing,
   * the same width at both, is left to the mass.
   */
  {
    const band = 0.15 * (maxX - minX);
    let front = 0;
    let back = 0;
    for (const ply of plies) {
      for (const p of ply.points) {
        const q = project(p);
        if (q[0] > maxX - band) front = Math.max(front, Math.abs(q[1]));
        if (q[0] < minX + band) back = Math.max(back, Math.abs(q[1]));
      }
    }
    if (front < 0.8 * back) noseForward = true;
    else if (back < 0.8 * front) noseForward = false;
  }
  const keelDown = heavyZ >= 0;
  const sx = noseForward ? 1 : -1;
  const sz = keelDown ? 1 : -1;
  // Flipping two axes keeps the frame right-handed.
  const fx = scaleVec(x, sx);
  const fz = scaleVec(z, sz);
  const fy = unit(cross(fz, fx));
  return {
    toBody: (p) => {
      const d = sub(p, centre);
      return [dot(d, fx), dot(d, fy), dot(d, fz)];
    },
  };
}

const scaleVec = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

interface Interval { lo: number; hi: number; z: number }

/** Where a line at `y` crosses a polygon, as x-intervals with the surface height. */
function scanPolygon(poly: readonly Vec3[], y: number): Interval[] {
  const hits: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if ((a[1] <= y) === (b[1] <= y)) continue;
    const t = (y - a[1]) / (b[1] - a[1]);
    hits.push({ x: a[0] + t * (b[0] - a[0]), z: a[2] + t * (b[2] - a[2]) });
  }
  hits.sort((p, q) => p.x - q.x);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    out.push({ lo: hits[i]!.x, hi: hits[i + 1]!.x, z: (hits[i]!.z + hits[i + 1]!.z) / 2 });
  }
  return out;
}

function unionIntervals(list: Interval[]): Interval[] {
  if (list.length === 0) return [];
  const sorted = [...list].sort((a, b) => a.lo - b.lo);
  const out: Interval[] = [{ ...sorted[0]! }];
  for (const iv of sorted.slice(1)) {
    const last = out[out.length - 1]!;
    if (iv.lo <= last.hi + 1e-9) last.hi = Math.max(last.hi, iv.hi);
    else out.push({ ...iv });
  }
  return out;
}

export interface Station {
  /** Spanwise position, metres from the centreline. */
  readonly y: number;
  /** Leading and trailing edge, body x. */
  readonly leading: number;
  readonly trailing: number;
  readonly chord: number;
  /** Height of the surface here, body z (negative is up). */
  readonly z: number;
}

export interface Airframe {
  readonly mass: MassProperties;
  /** Fold coordinates to body axes, for anything that wants the flying attitude. */
  readonly frame: BodyFrame;
  /** Panels and stations are given about the centre of gravity. */
  readonly cgFromNose: number;
  readonly stations: readonly Station[];
  /** Projected planform area, m^2. */
  readonly wingArea: number;
  readonly span: number;
  readonly meanChord: number;
  readonly aspectRatio: number;
  /** Dihedral from the rise of the surface across the span, radians. */
  readonly dihedral: number;
  /** Side area of anything standing on edge, m^2. */
  readonly finArea: number;
  readonly length: number;
  /** Both faces of all paper, for skin friction. */
  readonly wettedArea: number;
}

export function buildAirframe(
  plies: readonly RenderFace[],
  paper: PaperProps,
  stationCount = 24,
): Airframe {
  // Mass first, in fold coordinates, because the body frame is derived from it.
  const raw = massProperties(
    plies.map((p) => ({ points: p.points, area: p.area, side: 1, isFin: false })),
    paper.arealDensity,
  );
  const frame = principalFrame(raw.inertia, raw.cg, plies);

  const mass = massProperties(
    plies.map((p) => ({
      points: p.points.map(frame.toBody), area: p.area,
      side: p.mirrored ? -1 : 1, isFin: false,
    })),
    paper.arealDensity,
  );

  const outlines = plies.map((p) => p.points.map(frame.toBody));
  // Normals are directions, so they travel without the translation.
  const origin = frame.toBody([0, 0, 0]);
  const normals = plies.map((p) => unit(sub(frame.toBody(p.normal), origin)));

  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const poly of outlines) {
    for (const p of poly) {
      minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    }
  }
  if (!(maxY > minY)) {
    return {
      mass, frame, cgFromNose: 0, stations: [], wingArea: 0, span: 0, meanChord: 0,
      aspectRatio: 0, dihedral: 0, finArea: 0, length: 0, wettedArea: 0,
    };
  }

  // A ply lying nearly on edge makes no lift; it is keel, and it is left out of
  // the planform so that it does not pretend to be wing.
  const lifting = outlines.filter((_, i) => Math.abs(normals[i]![2]) >= 0.35);
  const onEdge = outlines.filter((_, i) => Math.abs(normals[i]![2]) < 0.35);

  const stations: Station[] = [];
  const step = (maxY - minY) / stationCount;
  for (let i = 0; i < stationCount; i++) {
    const y = minY + (i + 0.5) * step;
    const merged = unionIntervals(lifting.flatMap((poly) => scanPolygon(poly, y)));
    if (merged.length === 0) continue;
    const leading = merged[merged.length - 1]!.hi;
    const trailing = merged[0]!.lo;
    // Height weighted by how much paper each run covers.
    let zw = 0;
    let w = 0;
    for (const iv of merged) { zw += iv.z * (iv.hi - iv.lo); w += iv.hi - iv.lo; }
    stations.push({ y, leading, trailing, chord: leading - trailing, z: w > 0 ? zw / w : 0 });
  }

  let wingArea = 0;
  let macNum = 0;
  for (const s of stations) { wingArea += s.chord * step; macNum += s.chord * s.chord * step; }

  // Keel: the side view of everything standing on edge.
  let finArea = 0;
  for (const poly of onEdge) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      a += p[0] * q[2] - q[0] * p[2];
    }
    finArea += Math.abs(a) / 2;
  }

  // Dihedral from how the surface rises toward the tips.
  let slopeNum = 0;
  let slopeDen = 0;
  for (const s of stations) {
    if (Math.abs(s.y) < 1e-6) continue;
    slopeNum += -s.z * Math.abs(s.y) * s.chord;
    slopeDen += s.y * s.y * s.chord;
  }

  let wetted = 0;
  for (const ply of plies) wetted += ply.area * 2;

  const span = maxY - minY;
  return {
    mass,
    frame,
    cgFromNose: maxX,
    stations,
    wingArea,
    span,
    meanChord: wingArea > 1e-9 ? macNum / wingArea : 0,
    aspectRatio: wingArea > 1e-9 ? (span * span) / wingArea : 0,
    dihedral: slopeDen > 1e-12 ? Math.atan(slopeNum / slopeDen) : 0,
    finArea,
    length: maxX - minX,
    wettedArea: wetted,
  };
}

/**
 * Real paper's rolls, as a change to points, for showing: the nose `retreat`
 * further back than the drawing puts it, and the wing between its trailing
 * edge and the back of the last roll's bundle - `band` behind the nose -
 * drawn that much shorter, evenly, so every flat ply stays flat and a line on
 * the paper stays straight. Null when there is nothing to move. (The flight
 * takes the same retreat off the measured plane, weight left where it is:
 * see `measurePlane`.)
 */
export function noseStretch(
  plies: readonly RenderFace[], paper: PaperProps, retreat: number, band: number,
): ((p: Vec3) => Vec3) | null {
  if (!(Math.abs(retreat) > 1e-6) || plies.length < 2) return null;
  const af = buildAirframe(plies, paper, 8);
  if (!(af.length > 0)) return null;
  const o = af.frame.toBody([0, 0, 0]);
  const e = (v: Vec3) => { const q = af.frame.toBody(v); return q[0] - o[0]; };
  // The aeroplane's forward axis, in the plies' own coordinates.
  const forward: Vec3 = [e([1, 0, 0]), e([0, 1, 0]), e([0, 0, 1])];
  const nose = af.cgFromNose;
  const tail = nose - af.length;
  const from = Math.max(tail + 1e-4, nose - Math.max(0, Math.min(band, af.length)));
  return (p) => {
    const x = af.frame.toBody(p)[0];
    const k = x >= from ? 1 : x <= tail ? 0 : (x - tail) / (from - tail);
    return [p[0] - forward[0] * retreat * k, p[1] - forward[1] * retreat * k, p[2] - forward[2] * retreat * k];
  };
}
