/**
 * The elevator: a short stretch of each wing's trailing edge bent up or down.
 *
 * It is not a fold. Every long-flight aeroplane is tuned this way on the day -
 * a centimetre of trailing edge beside the body, half a centimetre deep, eased
 * up or down between the fingers - and the paper takes it as a curve, not a
 * crease: it bends in an arc from where the bend starts to the edge, and at
 * the two ends of the stretch it eases back into the flat wing. So it is kept
 * as a setting beside the fold script, drawn by bending the model's faces, and
 * handed to the flight as the flap it is.
 *
 * Measured the way a pupil measures it: from the middle of the aeroplane out
 * along the trailing edge, how far out it starts and how wide it is; how deep
 * from the edge; and by what angle the edge is bent.
 */

import type { Airframe } from '../aero/airframe.js';
import type { RenderFace } from '../origami/space.js';
import { applyRigid } from '../geometry/math.js';
import type { Vec2, Vec3 } from '../geometry/math.js';

export interface ElevatorTune {
  /** From the middle of the aeroplane to where the bent stretch starts, cm. */
  readonly fromCm: number;
  /** How wide the stretch is along the trailing edge, cm. */
  readonly widthCm: number;
  /** How deep it reaches in from the trailing edge, cm. */
  readonly depthCm: number;
  /** The edge's angle: up positive, down negative, degrees. */
  readonly angleDeg: number;
  /**
   * Worked out, not set by hand: the recommendation the plane was finished
   * with. Kept for what it was, but not held to - when the flying or the
   * paper's sums change, the plane is tuned again as it would be now. A pupil
   * who moves the elevator makes it theirs, and then it stays.
   */
  readonly auto?: boolean;
}

/**
 * Where the elevator is, always: from the middle of the trailing edge, where
 * the two wings meet, 1.5 cm out along each wing and 3 mm in from the edge.
 * Only its angle is tuned.
 */
export const ELEVATOR = { fromCm: 0, widthCm: 1.5, depthCm: 0.3 } as const;

/** The angles it can be set to, degrees: flat in the middle, down (−) and up (+) either side. */
export const ELEVATOR_STEPS = [-30, -20, -10, -5, 0, 5, 10, 20, 30] as const;

/**
 * Where to start: the elevator above.
 * A nose thick on top pitches the aeroplane up when it is fast, so the edge
 * starts bent down ten degrees; thick underneath, up ten; flat, not at all.
 */
export function defaultElevator(bulgeSide: -1 | 0 | 1): ElevatorTune {
  return { ...ELEVATOR, angleDeg: bulgeSide > 0 ? -10 : bulgeSide < 0 ? 10 : 0 };
}

/** How far the trailing edge itself rises (+) or drops (-), mm. */
export function elevatorRiseMm(t: ElevatorTune): number {
  return t.depthCm * 10 * Math.tan((t.angleDeg * Math.PI) / 180);
}

/** The paper eases back into the flat wing over this much at each end, m. */
const EASE = 0.005;

type Body = { to(p: Vec3): Vec3; from(q: Vec3): Vec3 };

/** The airframe's body axes both ways: the frame is a rotation and a shift. */
function bodyAxes(af: Airframe): Body {
  const to = af.frame.toBody;
  const o = to([0, 0, 0]);
  const ax = to([1, 0, 0]);
  const ay = to([0, 1, 0]);
  const az = to([0, 0, 1]);
  // Columns of the rotation: where each fold axis goes in body axes.
  const c = [
    [ax[0] - o[0], ay[0] - o[0], az[0] - o[0]],
    [ax[1] - o[1], ay[1] - o[1], az[1] - o[1]],
    [ax[2] - o[2], ay[2] - o[2], az[2] - o[2]],
  ];
  return {
    to,
    // The inverse of a rotation is its transpose.
    from: (q) => {
      const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]];
      return [
        c[0]![0]! * d[0]! + c[1]![0]! * d[1]! + c[2]![0]! * d[2]!,
        c[0]![1]! * d[0]! + c[1]![1]! * d[1]! + c[2]![1]! * d[2]!,
        c[0]![2]! * d[0]! + c[1]![2]! * d[1]! + c[2]![2]! * d[2]!,
      ];
    },
  };
}

/** The trailing edge at a span position, from the airframe's stations. */
function trailingAt(af: Airframe, y: number): number | null {
  const side = af.stations.filter((s) => Math.sign(s.y) === Math.sign(y) || Math.abs(s.y) < 1e-9)
    .sort((a, b) => Math.abs(a.y) - Math.abs(b.y));
  if (side.length === 0) return null;
  const ay = Math.abs(y);
  let lo = side[0]!;
  let hi = side[side.length - 1]!;
  for (let i = 0; i + 1 < side.length; i++) {
    if (Math.abs(side[i]!.y) <= ay && Math.abs(side[i + 1]!.y) >= ay) { lo = side[i]!; hi = side[i + 1]!; break; }
  }
  const span = Math.abs(hi.y) - Math.abs(lo.y);
  if (span < 1e-9) return lo.trailing;
  const t = Math.min(1, Math.max(0, (ay - Math.abs(lo.y)) / span));
  return lo.trailing + t * (hi.trailing - lo.trailing);
}

/** Split a convex polygon by the line f = 0, keeping both sides. */
function split<T extends { q: Vec3 }>(poly: T[], f: (q: Vec3) => number, mix: (a: T, b: T, t: number) => T): T[][] {
  const pos: T[] = [];
  const neg: T[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const fa = f(a.q);
    const fb = f(b.q);
    if (fa >= 0) pos.push(a); else neg.push(a);
    if ((fa > 0 && fb < 0) || (fa < 0 && fb > 0)) {
      const m = mix(a, b, fa / (fa - fb));
      pos.push(m);
      neg.push(m);
    }
  }
  return [pos, neg].filter((p) => p.length >= 3);
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The model with its trailing edges bent, both wings alike.
 *
 * Only paper lying in the wing is bent - the keel and the winglets stand on
 * edge and are left as they are. Each face near the stretch is cut into thin
 * strips across the bend and along the two eased ends, and every corner is
 * lowered or raised on a parabola - the arc a strip of paper makes when its
 * edge is pushed, tangent to the wing where the bend starts.
 */
export function bendElevator(plies: readonly RenderFace[], af: Airframe | null, tune: ElevatorTune | null): readonly RenderFace[] {
  if (!af || !tune || Math.abs(tune.angleDeg) < 0.01 || tune.depthCm <= 0 || tune.widthCm <= 0) return plies;
  const body = bodyAxes(af);
  const y0 = tune.fromCm / 100;
  const y1 = y0 + tune.widthCm / 100;
  const d = tune.depthCm / 100;
  const h = d * Math.tan((tune.angleDeg * Math.PI) / 180);
  const out: RenderFace[] = [];
  const origin = body.to([0, 0, 0]);

  for (const f of plies) {
    const nb = body.to(f.normal);
    const nz = nb[2] - origin[2];
    const pts = f.points.map((p) => body.to(p));
    // On edge: keel or winglet, not wing.
    if (Math.abs(nz) < 0.5) { out.push(f); continue; }
    let touches = false;
    for (const side of [-1, 1]) {
      const te = trailingAt(af, side * (y0 + y1) / 2);
      if (te === null) continue;
      // Overlap of ranges, not a corner inside: a big wing face has no corner
      // anywhere near a one-centimetre stretch.
      const ys = pts.map((q) => q[1] * side);
      if (Math.max(...ys) > y0 - EASE && Math.min(...ys) < y1 + EASE
        && pts.some((q) => q[0] < te + d)) touches = true;
    }
    if (!touches) { out.push(f); continue; }

    type V = { q: Vec3; s: Vec2 };
    const toSheet = (p: Vec3): Vec2 => {
      const u = applyRigid(f.inverse, p);
      return [u[0], u[1]];
    };
    let polys: V[][] = [pts.map((q, i) => ({ q, s: toSheet(f.points[i]!) }))];
    const mix = (a: V, b: V, t: number): V => ({
      q: [a.q[0] + t * (b.q[0] - a.q[0]), a.q[1] + t * (b.q[1] - a.q[1]), a.q[2] + t * (b.q[2] - a.q[2])],
      s: [a.s[0] + t * (b.s[0] - a.s[0]), a.s[1] + t * (b.s[1] - a.s[1])],
    });
    const cuts: ((q: Vec3) => number)[] = [];
    for (const side of [-1, 1]) {
      const edge = trailingAt(af, side * (y0 + y1) / 2);
      if (edge === null) continue;
      // Across the bend: six strips from the edge in to where it starts.
      for (let k = 1; k <= 6; k++) cuts.push((q) => q[0] - (edge + (d * k) / 6));
      // Along the span: the stretch and its eased ends.
      for (const y of [y0 - EASE, y0 - EASE / 2, y0, (y0 + y1) / 2, y1, y1 + EASE / 2, y1 + EASE]) {
        cuts.push((q) => q[1] * side - y);
      }
    }
    for (const cut of cuts) polys = polys.flatMap((p) => split(p, cut, mix));

    for (const poly of polys) {
      const bent = poly.map(({ q }) => {
        const side = q[1] >= 0 ? 1 : -1;
        const ay = q[1] * side;
        const edge = trailingAt(af, q[1]);
        if (edge === null) return q;
        const into = (edge + d - q[0]) / d;
        if (into <= 0) return q;
        const along = ay < y0 ? smooth((ay - (y0 - EASE)) / EASE)
          : ay > y1 ? smooth(((y1 + EASE) - ay) / EASE) : 1;
        if (along <= 0) return q;
        // Up is -z in body axes.
        const dz = -h * Math.min(1, into) ** 2 * along;
        return [q[0], q[1], q[2] + dz] as Vec3;
      });
      const world = bent.map((q) => body.from(q));
      // The piece's own facing, pointed the way the face it came from pointed.
      let n: Vec3 = [0, 0, 0];
      for (let i = 0; i < world.length; i++) {
        const a = world[i]!;
        const b = world[(i + 1) % world.length]!;
        n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])];
      }
      const len = Math.hypot(n[0], n[1], n[2]) || 1;
      n = [n[0] / len, n[1] / len, n[2] / len];
      if (n[0] * f.normal[0] + n[1] * f.normal[1] + n[2] * f.normal[2] < 0) n = [-n[0], -n[1], -n[2]];
      const outline = poly.map((v) => v.s);
      let area = 0;
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i]!;
        const b = outline[(i + 1) % outline.length]!;
        area += a[0] * b[1] - b[0] * a[1];
      }
      out.push({ ...f, points: world, outline, normal: n, area: Math.abs(area) / 2 });
    }
  }
  return out;
}
