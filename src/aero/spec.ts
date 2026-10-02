/**
 * The folded aeroplane, measured: everything the flight needs to know about
 * it, read once off the folded paper and handed on as tables.
 *
 * The flight is not worked out on the folded paper itself. Folded, a model is
 * a pile of cut pieces - a hundred and more faces lying loose on each other,
 * stood off by their own thickness - and reading the air's shape off that pile
 * afresh inside every sum let a face moved a fraction of a millimetre turn a
 * twelve-second flight into four. What the air meets is the outside of the
 * paper, and what flies is its weight and where it lies; so those are measured
 * here, as finely as the paper allows, and the flight is worked out on an
 * aeroplane built from the measurements alone:
 *
 * - a map seen from above, a millimetre a cell: how many plies lie there, how
 *   high the top and bottom of the stack are, what the paper there weighs and
 *   how stiff the stack is along the span;
 * - a map of the keel seen from the side, the same way;
 * - the wing's sections every two millimetres across the span: leading and
 *   trailing edges, upper and lower surfaces, thickness, the radius of the
 *   leading edge;
 * - the wing's panels, where it breaks and at what angle;
 * - the folds, from the record: where each closed fold lies on the finished
 *   aeroplane, how many plies it wraps, how round it is;
 * - the weight, its centre and its inertia, from the paper itself.
 *
 * The equivalent aeroplane (`af`) carries the planform, the V and the mass of
 * these tables; the nose's camber, the section's thickness and the wing's
 * stiffness are read from them where the flight needs them.
 */

import { buildAirframe } from './airframe.js';
import type { Airframe, Station } from './airframe.js';
import type { RenderFace } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';
import type { Vec3 } from '../geometry/math.js';

/** One cell of the map, and the section sampling, in metres. */
export const CELL = 0.001;
const SECTION_EVERY = 2;

export interface TopMap {
  /** Body x of the first column's centre and body y of the first row's, m; x runs nose-ward. */
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  /** Per cell, row-major (y then x): plies lying there. */
  readonly plies: Uint16Array;
  /** Highest and lowest ply there, body z (up is negative); NaN where there is no paper. */
  readonly top: Float32Array;
  readonly bottom: Float32Array;
  /** Paper there, kg. */
  readonly mass: Float32Array;
  /** Stiffness along the span, in single plies' worth: bundles joined along a spanwise fold count as their plies cubed. */
  readonly stiffness: Float32Array;
}

export interface SideMap {
  /** Body x of the first column, body z of the first row, m. */
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly plies: Uint16Array;
  readonly mass: Float32Array;
}

export interface Section {
  /** Across the span, body y, m. */
  readonly y: number;
  readonly leading: number;
  readonly trailing: number;
  readonly chord: number;
  /** Samples along the chord, a cell apart, leading edge first. */
  readonly x: Float32Array;
  readonly plies: Uint16Array;
  readonly top: Float32Array;
  readonly bottom: Float32Array;
  /** Stiffness along the span at each sample, in single plies' worth (see `TopMap`). */
  readonly stiffness: Float32Array;
  /** Thickest the stack is here, m, and where, as a share of the chord from the leading edge. */
  readonly thickness: number;
  readonly thickestAt: number;
  /** Radius of the rounded leading edge: half the stack wrapped there, m. */
  readonly noseRadius: number;
}

export interface WingPanel {
  /** Across one half span, |y| from and to, m. */
  readonly from: number;
  readonly to: number;
  /** How far it is tilted up from flat, degrees. */
  readonly angleDeg: number;
  readonly area: number;
}

/** A closed fold, where it lies on the finished aeroplane. */
export interface FoldEdge {
  readonly step: number;
  readonly angleDeg: number;
  /** Plies it carried over, on average, and the depth of that paper back from the crease, m. */
  readonly plies: number;
  readonly depth: number;
  /** Middle of its crease, body x, m, and whether it runs across the aeroplane. */
  readonly x: number;
  readonly across: boolean;
  /** Radius the paper turns round it: half the plies it wraps, m. */
  readonly radius: number;
  /** A roll of the nose: across the aeroplane, closed flat, in the front of it. */
  readonly roll: boolean;
}

export interface Fin {
  /** Side area, m^2, and where its middle is, body coordinates. */
  readonly area: number;
  readonly centre: Vec3;
  readonly mass: number;
  /** How tall it stands, m: its reach up or down off the wing. */
  readonly height: number;
}

export interface PlaneSpec {
  readonly caliper: number;
  readonly top: TopMap;
  readonly keel: SideMap;
  readonly fins: readonly Fin[];
  readonly sections: readonly Section[];
  readonly panels: readonly WingPanel[];
  readonly folds: readonly FoldEdge[];
  /** The aeroplane the flight is worked out on. */
  readonly af: Airframe;
  /** The same, as a pupil would read it off the model. */
  readonly summary: {
    readonly length: number;
    readonly span: number;
    readonly wingArea: number;
    readonly mass: number;
    readonly cgFromNose: number;
    readonly noseThickness: number;
    readonly keelDepth: number;
    readonly veeDeg: number;
  };
  /** Paper counted by the maps, kg, against the sheet's own: a check that nothing was lost. */
  readonly mapMass: number;
}

const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};

function inside(poly: readonly Vec3[], a: number, b: number, i0: 0 | 1 | 2, i1: 0 | 1 | 2): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[i]!;
    const q = poly[j]!;
    if ((p[i1] > b) !== (q[i1] > b) && a < p[i0] + ((b - p[i1]) / (q[i1] - p[i1])) * (q[i0] - p[i0])) hit = !hit;
  }
  return hit;
}

/** A flat polygon's height (body z) over (x, y), on the plane through its points (Newell's normal). */
function heightAt(pts: readonly Vec3[], x: number, y: number): number {
  let nx = 0; let ny = 0; let nz = 0; let cx = 0; let cy = 0; let cz = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
    cx += a[0]; cy += a[1]; cz += a[2];
  }
  const k = pts.length || 1;
  cx /= k; cy /= k; cz /= k;
  return Math.abs(nz) > 1e-12 ? cz - (nx * (x - cx) + ny * (y - cy)) / nz : cz;
}

/**
 * Measure the folded aeroplane `plies` (real paper's: thick, its nose as long
 * as its rolls leave it) on `paper`. `folds` are the record's closed folds as
 * they lie on it (see `foldEdges`).
 */
export function measurePlane(
  plies: readonly RenderFace[], paper: PaperProps, caliper: number, folds: readonly FoldEdge[] = [],
): PlaneSpec | null {
  if (plies.length < 2) return null;
  const drawn = buildAirframe(plies, paper);
  if (!(drawn.span > 0) || !(drawn.length > 0)) return null;
  const toBody = drawn.frame.toBody;
  const origin = toBody([0, 0, 0]);
  const faces = plies.map((p) => {
    const pts = p.points.map(toBody);
    return { pts, n: unit([toBody(p.normal)[0] - origin[0], toBody(p.normal)[1] - origin[1], toBody(p.normal)[2] - origin[2]]), area: p.area };
  });
  const density = paper.arealDensity;
  // Paper area over drawn area: one for a piece as folded, less for one drawn stretched.
  const spreadOf = (f: { pts: readonly Vec3[]; area: number }) => {
    let nx = 0; let ny = 0; let nz = 0;
    for (let i = 0; i < f.pts.length; i++) {
      const a = f.pts[i]!; const b = f.pts[(i + 1) % f.pts.length]!;
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
    }
    const drawn = Math.hypot(nx, ny, nz) / 2;
    return drawn > 1e-14 && f.area > 0 ? f.area / drawn : 1;
  };
  const lying = faces.map((f, i) => i).filter((i) => Math.abs(faces[i]!.n[2]) >= 0.35);
  const standing = faces.map((f, i) => i).filter((i) => Math.abs(faces[i]!.n[2]) < 0.35);

  /*
   * Which lying plies bend as one: joined along a spanwise edge they share,
   * seen from above (plate theory - plies merely lying on each other slide).
   */
  const parent = new Map<number, number>(lying.map((i) => [i, i]));
  const find = (x: number): number => { const p = parent.get(x)!; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const spanEdges: { ply: number; a: Vec3; b: Vec3 }[] = [];
  for (const i of lying) {
    const poly = faces[i]!.pts;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!; const b = poly[(k + 1) % poly.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len > 1e-3 && Math.abs(b[1] - a[1]) > 0.9 * len) spanEdges.push({ ply: i, a, b });
    }
  }
  const tol = 3e-4;
  const same = (p: Vec3, q: Vec3) => Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol;
  for (let i = 0; i < spanEdges.length; i++) {
    for (let j = i + 1; j < spanEdges.length; j++) {
      const e = spanEdges[i]!; const f = spanEdges[j]!;
      if (e.ply === f.ply) continue;
      if ((same(e.a, f.a) && same(e.b, f.b)) || (same(e.a, f.b) && same(e.b, f.a))) parent.set(find(e.ply), find(f.ply));
    }
  }

  // The map from above: every lying ply laid over the cells it covers.
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (const f of faces) for (const p of f.pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL));
  const ny = Math.max(1, Math.ceil((maxY - minY) / CELL));
  const x0 = minX + CELL / 2;
  const y0 = minY + CELL / 2;
  const cells = nx * ny;
  const count = new Uint16Array(cells);
  const top = new Float32Array(cells).fill(NaN);
  const bottom = new Float32Array(cells).fill(NaN);
  const mass = new Float32Array(cells);
  const members: number[][] = Array.from({ length: cells }, () => []);
  for (const i of lying) {
    const f = faces[i]!;
    let ax = Infinity; let bx = -Infinity; let ay = Infinity; let by = -Infinity;
    for (const p of f.pts) { ax = Math.min(ax, p[0]); bx = Math.max(bx, p[0]); ay = Math.min(ay, p[1]); by = Math.max(by, p[1]); }
    const c0 = Math.max(0, Math.floor((ax - minX) / CELL)); const c1 = Math.min(nx - 1, Math.floor((bx - minX) / CELL));
    const r0 = Math.max(0, Math.floor((ay - minY) / CELL)); const r1 = Math.min(ny - 1, Math.floor((by - minY) / CELL));
    // The paper this piece really holds, spread over the shape it is drawn as.
    const perCell = (density * CELL * CELL * spreadOf(f)) / Math.abs(f.n[2]);
    for (let r = r0; r <= r1; r++) {
      const y = y0 + r * CELL;
      for (let c = c0; c <= c1; c++) {
        const x = x0 + c * CELL;
        if (!inside(f.pts, x, y, 0, 1)) continue;
        const k = r * nx + c;
        const z = heightAt(f.pts, x, y);
        count[k]!++;
        top[k] = Number.isNaN(top[k]!) ? z : Math.min(top[k]!, z);
        bottom[k] = Number.isNaN(bottom[k]!) ? z : Math.max(bottom[k]!, z);
        mass[k]! += perCell;
        members[k]!.push(i);
      }
    }
  }
  const stiffness = new Float32Array(cells);
  for (let k = 0; k < cells; k++) {
    const m = members[k]!;
    if (m.length === 0) continue;
    const bundles = new Map<number, number>();
    for (const i of m) bundles.set(find(i), (bundles.get(find(i)) ?? 0) + 1);
    let s = 0;
    for (const g of bundles.values()) s += g ** 3;
    stiffness[k] = s;
  }
  const topMap: TopMap = { x0, y0, nx, ny, plies: count, top, bottom, mass, stiffness };

  // The keel from the side, and anything else standing: fins.
  const semi = (maxY - minY) / 2;
  const keelWidth = Math.max(0.01, 0.12 * semi);
  const knx = nx;
  const knz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  const kz0 = minZ + CELL / 2;
  const keelCount = new Uint16Array(knx * knz);
  const keelMass = new Float32Array(knx * knz);
  const fins: Fin[] = [];
  for (const i of standing) {
    const f = faces[i]!;
    const k = f.pts.length || 1;
    const centre: Vec3 = [f.pts.reduce((a, p) => a + p[0], 0) / k, f.pts.reduce((a, p) => a + p[1], 0) / k, f.pts.reduce((a, p) => a + p[2], 0) / k];
    const side = Math.abs(f.n[1]);
    if (Math.abs(centre[1]) > keelWidth || side < 0.5) {
      // A winglet or a panel standing away from the keel: its side area and weight.
      let a = 0;
      for (let k = 0; k < f.pts.length; k++) {
        const p = f.pts[k]!; const q = f.pts[(k + 1) % f.pts.length]!;
        a += p[0] * q[2] - q[0] * p[2];
      }
      let lo = Infinity; let hi = -Infinity;
      for (const p of f.pts) { lo = Math.min(lo, p[2]); hi = Math.max(hi, p[2]); }
      fins.push({ area: Math.abs(a) / 2, centre, mass: f.area * density, height: hi - lo });
      continue;
    }
    let ax = Infinity; let bx = -Infinity; let az = Infinity; let bz = -Infinity;
    for (const p of f.pts) { ax = Math.min(ax, p[0]); bx = Math.max(bx, p[0]); az = Math.min(az, p[2]); bz = Math.max(bz, p[2]); }
    const c0 = Math.max(0, Math.floor((ax - minX) / CELL)); const c1 = Math.min(knx - 1, Math.floor((bx - minX) / CELL));
    const r0 = Math.max(0, Math.floor((az - minZ) / CELL)); const r1 = Math.min(knz - 1, Math.floor((bz - minZ) / CELL));
    const perCell = (density * CELL * CELL * spreadOf(f)) / Math.max(0.2, side);
    for (let r = r0; r <= r1; r++) {
      const z = kz0 + r * CELL;
      for (let c = c0; c <= c1; c++) {
        const x = x0 + c * CELL;
        if (!inside(f.pts, x, z, 0, 2)) continue;
        keelCount[r * knx + c]!++;
        keelMass[r * knx + c]! += perCell;
      }
    }
  }
  const keel: SideMap = { x0, z0: kz0, nx: knx, nz: knz, plies: keelCount, mass: keelMass };

  // Sections every two millimetres across the span.
  const sections: Section[] = [];
  for (let r = 0; r < ny; r += SECTION_EVERY) {
    const xs: number[] = []; const ns: number[] = []; const ts: number[] = []; const bs: number[] = []; const ss: number[] = [];
    for (let c = nx - 1; c >= 0; c--) {
      const k = r * nx + c;
      if (count[k]! === 0) continue;
      xs.push(x0 + c * CELL); ns.push(count[k]!); ts.push(top[k]!); bs.push(bottom[k]!); ss.push(stiffness[k]!);
    }
    if (xs.length < 3) continue;
    const leading = xs[0]! + CELL / 2;
    const trailing = xs[xs.length - 1]! - CELL / 2;
    const chord = leading - trailing;
    let thick = 0; let at = 0;
    for (let k = 0; k < xs.length; k++) {
      const t = bs[k]! - ts[k]! + caliper;
      if (t > thick) { thick = t; at = (leading - xs[k]!) / chord; }
    }
    const nose = bs[0]! - ts[0]! + caliper;
    sections.push({
      y: y0 + r * CELL, leading, trailing, chord,
      x: Float32Array.from(xs), plies: Uint16Array.from(ns), top: Float32Array.from(ts), bottom: Float32Array.from(bs),
      stiffness: Float32Array.from(ss),
      thickness: thick, thickestAt: at, noseRadius: nose / 2,
    });
  }

  // The wing's panels: its lying plies grouped by how far they are tilted up.
  const panelOf = new Map<number, { from: number; to: number; area: number }>();
  for (const i of lying) {
    const f = faces[i]!;
    const cy = f.pts.reduce((a, p) => a + p[1], 0) / f.pts.length;
    if (Math.abs(cy) < keelWidth) continue;
    // Up is -z: its rise toward the tip is -dz/d|y| = side * ny / nz, to the nearest two degrees.
    const side = Math.sign(cy);
    const tilt = Math.round((Math.atan((side * f.n[1]) / f.n[2]) * 180) / Math.PI / 2) * 2;
    const ys = f.pts.map((p) => Math.abs(p[1]));
    const had = panelOf.get(tilt) ?? { from: Infinity, to: -Infinity, area: 0 };
    panelOf.set(tilt, { from: Math.min(had.from, ...ys), to: Math.max(had.to, ...ys), area: had.area + f.area });
  }
  const panels: WingPanel[] = [...panelOf].map(([angleDeg, p]) => ({ angleDeg, ...p }))
    .filter((p) => p.area > 1e-4).sort((a, b) => a.from - b.from);

  /*
   * The equivalent aeroplane: its planform and V off the map, its weight
   * and inertia off the paper. Twenty-four stations, as the lattice has
   * always been given; every cell of the map goes into its area. */
  const nose = maxX;
  const STATIONS = 24;
  const stations: Station[] = [];
  let area = 0;
  let macNum = 0;
  // Evenly spaced, as the lattice strips them: each station reads the row of cells it falls in.
  const pitchY = (maxY - minY) / STATIONS;
  for (let s = 0; s < STATIONS; s++) {
    const y = minY + (s + 0.5) * pitchY;
    const r = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / CELL)));
    let lead = -Infinity; let trail = Infinity; let zw = 0; let w = 0;
    for (let c = 0; c < nx; c++) {
      const k = r * nx + c;
      if (count[k]! === 0) continue;
      const x = x0 + c * CELL;
      lead = Math.max(lead, x + CELL / 2); trail = Math.min(trail, x - CELL / 2);
      zw += (top[k]! + bottom[k]!) / 2; w += 1;
    }
    lead = Math.min(lead, nose);
    if (!(lead > trail)) continue;
    stations.push({ y, leading: lead, trailing: trail, chord: lead - trail, z: w > 0 ? zw / w : 0 });
  }
  for (let r = 0; r < ny; r++) {
    let n = 0;
    for (let c = 0; c < nx; c++) if (count[r * nx + c]! > 0 && x0 + c * CELL <= nose) n++;
    area += n * CELL * CELL;
    macNum += (n * CELL) ** 2 * CELL;
  }
  let slopeNum = 0; let slopeDen = 0;
  for (const s of stations) {
    if (Math.abs(s.y) < 1e-6) continue;
    slopeNum += -s.z * Math.abs(s.y) * s.chord;
    slopeDen += s.y * s.y * s.chord;
  }
  let keelArea = 0;
  for (let k = 0; k < keelCount.length; k++) if (keelCount[k]! > 0) keelArea += CELL * CELL;
  const finArea = keelArea + fins.reduce((a, f) => a + f.area, 0);
  let mapMass = 0;
  for (let k = 0; k < cells; k++) mapMass += mass[k]!;
  for (let k = 0; k < keelMass.length; k++) mapMass += keelMass[k]!;
  for (const f of fins) mapMass += f.mass;
  const span = maxY - minY;
  const af: Airframe = {
    mass: drawn.mass,
    frame: drawn.frame,
    cgFromNose: nose,
    stations,
    wingArea: area,
    span,
    meanChord: area > 1e-9 ? macNum / area : 0,
    aspectRatio: area > 1e-9 ? (span * span) / area : 0,
    dihedral: slopeDen > 1e-12 ? Math.atan(slopeNum / slopeDen) : 0,
    finArea,
    length: nose - minX,
    wettedArea: drawn.wettedArea,
  };

  let noseThickness = 0;
  for (const s of sections) {
    for (let k = 0; k < s.x.length; k++) {
      if ((s.leading - s.x[k]!) > 0.3 * s.chord) break;
      noseThickness = Math.max(noseThickness, s.bottom[k]! - s.top[k]! + caliper);
    }
  }
  let keelLo = Infinity; let keelHi = -Infinity;
  for (let r = 0; r < knz; r++) for (let c = 0; c < knx; c++) {
    if (keelCount[r * knx + c]! > 0) { keelLo = Math.min(keelLo, r); keelHi = Math.max(keelHi, r); }
  }
  const keelDepth = keelHi >= keelLo ? (keelHi - keelLo + 1) * CELL : 0;
  return {
    caliper, top: topMap, keel, fins, sections, panels, folds, af, mapMass,
    summary: {
      length: af.length, span, wingArea: area, mass: af.mass.mass, cgFromNose: af.cgFromNose,
      noseThickness, keelDepth, veeDeg: (af.dihedral * 180) / Math.PI,
    },
  };
}
