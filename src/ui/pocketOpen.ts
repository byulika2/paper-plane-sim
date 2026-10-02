/**
 * The first fold of a pocket, made as far as the paper lets it go.
 *
 * The plies taken are folded right over on the line drawn. Where they are
 * still joined to paper that stays - along the fold made before, running from
 * the pocket's corner - they cannot lie flat, and the paper there stands up
 * in a curve: flat against the paper it is joined to along that join, folded
 * right over along the line drawn, and bowed in between, a cone from the
 * corner. That bulge is the pocket the next step squashes.
 *
 * Shown as the flap stood up at eighty degrees, the pocket looked like a
 * loose triangle; shown as the squash half done, like a fold stopped part way.
 * It is a picture: nothing weighs it or folds by it.
 */

import type { Vec2, Vec3 } from '../geometry/math.js';
import type { RenderFace } from '../origami/space.js';

/** The farthest point of a convex outline along a ray from a point on or in it. */
function reachAlong(poly: readonly Vec2[], from: Vec2, dir: Vec2): Vec2 {
  let best = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!; const b = poly[(i + 1) % poly.length]!;
    const ex = b[0] - a[0]; const ey = b[1] - a[1];
    const den = dir[0] * ey - dir[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a[0] - from[0]) * ey - (a[1] - from[1]) * ex) / den;
    const u = ((a[0] - from[0]) * dir[1] - (a[1] - from[1]) * dir[0]) / den;
    if (t > best && u >= -1e-9 && u <= 1 + 1e-9) best = t;
  }
  return [from[0] + dir[0] * best, from[1] + dir[1] * best];
}

/** A turn by `t` about the line a-b lying in the view's plane. */
function turnAbout(a: Vec2, b: Vec2, t: number) {
  const ux = b[0] - a[0]; const uy = b[1] - a[1]; const ul = Math.hypot(ux, uy) || 1;
  const k: Vec3 = [ux / ul, uy / ul, 0];
  const c = Math.cos(t); const sn = Math.sin(t);
  return (p: readonly number[]): Vec3 => {
    const v: Vec3 = [p[0]! - a[0], p[1]! - a[1], p[2]!];
    const kv = k[0] * v[0] + k[1] * v[1];
    const x: Vec3 = [k[1] * v[2], -k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
    return [a[0] + v[0] * c + x[0] * sn + k[0] * kv * (1 - c), a[1] + v[1] * c + x[1] * sn + k[1] * kv * (1 - c), v[2] * c + x[2] * sn];
  };
}

/**
 * `taken`: each ply the first fold takes, with its fold line and a point on
 * its moving side, in the view. `corners`: where the pocket opens, in the
 * view. The plies are folded toward the viewer (-z), as a valley fold lifts
 * them.
 */
export function pocketFolded(
  plies: readonly RenderFace[], taken: ReadonlyMap<number, readonly [Vec2, Vec2, Vec2]>, corners: readonly Vec2[],
): RenderFace[] {
  const STEPS = 14;
  const out: RenderFace[] = [];
  for (const f of plies) {
    const line = taken.get(f.face);
    if (!line) continue;
    const [a, b, m] = line;
    // Whichever way round takes the moving side up toward the viewer.
    const up = turnAbout(a, b, (80 * Math.PI) / 180)([m[0], m[1], 0])[2] < 0 ? 1 : -1;
    const fold = (t: number) => turnAbout(a, b, up * t);
    const n = f.points.length;
    const at = f.points.findIndex((q) => corners.some((c) => Math.hypot(q[0] - c[0], q[1] - c[1]) < 1e-4));
    const along: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const lineLen = Math.hypot(along[0], along[1]) || 1;
    const onLine = (q: readonly number[]) => Math.abs((q[0]! - a[0]) * along[1] - (q[1]! - a[1]) * along[0]) / lineLen < 1e-4;
    // Away from the corner the paper folds right over.
    const flat = () => {
      const turn = fold(Math.PI);
      const o = turn([0, 0, 0]); const nn = turn(f.normal);
      out.push({ ...f, points: f.points.map((q) => turn(q)), normal: [nn[0] - o[0], nn[1] - o[1], nn[2] - o[2]] });
    };
    if (at < 0) { flat(); continue; }
    const corner = f.points[at]!;
    const next = f.points[(at + 1) % n]!;
    const prev = f.points[(at + n - 1) % n]!;
    // Of the two edges from the corner, the one on the line drawn is folded over; the other is the join, which stays.
    const [foldEnd, joinEnd] = onLine(next) ? [next, prev] : onLine(prev) ? [prev, next] : [null, null];
    if (!foldEnd || !joinEnd) { flat(); continue; }
    const a0 = Math.atan2(foldEnd[1] - corner[1], foldEnd[0] - corner[0]);
    let a1 = Math.atan2(joinEnd[1] - corner[1], joinEnd[0] - corner[0]);
    while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI;
    while (a0 - a1 > Math.PI) a1 += 2 * Math.PI;
    const poly: Vec2[] = f.points.map((q) => [q[0], q[1]]);
    const rays = Array.from({ length: STEPS + 1 }, (_, i) => {
      const u = i / STEPS;
      const ang = a0 + (a1 - a0) * u;
      const end = reachAlong(poly, [corner[0], corner[1]], [Math.cos(ang), Math.sin(ang)]);
      // Folded right over at the line drawn, not at all at the join.
      return fold(Math.PI * (1 - u))([end[0], end[1], corner[2]]);
    });
    const tip: Vec3 = [corner[0], corner[1], corner[2]];
    for (let i = 0; i < STEPS; i++) {
      const A = rays[i]!; const B = rays[i + 1]!;
      const e1: Vec3 = [A[0] - tip[0], A[1] - tip[1], A[2] - tip[2]];
      const e2: Vec3 = [B[0] - tip[0], B[1] - tip[1], B[2] - tip[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1]; const ny = e1[2] * e2[0] - e1[0] * e2[2]; const nz = e1[0] * e2[1] - e1[1] * e2[0];
      const nl = Math.hypot(nx, ny, nz) || 1;
      out.push({ ...f, points: [tip, A, B], outline: [f.outline[at]!, f.outline[at]!, f.outline[at]!], normal: [nx / nl, ny / nl, nz / nl] });
    }
  }
  return out;
}
