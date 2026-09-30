/**
 * Where a fold is closed, the paper goes round.
 *
 * Each face is drawn where it lies, raised off the one beneath by its own
 * thickness, and the two sides of a fold were left as two cut edges with
 * daylight between them: a model that looked sliced rather than folded.
 * Real paper is one sheet, and at a closed fold it turns half a turn round
 * whatever is inside, so the two edges of every closed fold are joined by
 * a half round band out beyond the crease; a fold held open at an angle is
 * joined straight across. The faces are found by the crease they share on
 * the sheet, which no renumbering changes. Drawn only.
 *
 * Shared by every picture of the model - the folding screen, the simulator
 * and the tuning previews - so the paper looks one sheet in all of them.
 */

import type { Vec2, Vec3 } from '../geometry/math.js';
import type { RenderFace } from '../origami/space.js';

const SEGMENTS = 8;

/** The bands as triangles, three points each, in the plies' own space. */
export function foldBands(plies: readonly RenderFace[], skip?: (ply: RenderFace) => boolean): Vec3[] {
  const key = (p: Vec2) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
  const edges = new Map<string, { ply: RenderFace; i: number; j: number; first: string }[]>();
  for (const ply of plies) {
    const n = ply.outline.length;
    if (n < 3 || ply.points.length !== n) continue;
    if (skip?.(ply)) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ka = key(ply.outline[i]!);
      const kb = key(ply.outline[j]!);
      const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = edges.get(k) ?? [];
      list.push({ ply, i, j, first: ka });
      edges.set(k, list);
    }
  }
  const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
  const along = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
  const tris: Vec3[] = [];
  for (const list of edges.values()) {
    if (list.length !== 2) continue;
    const [A, B] = list as [typeof list[number], typeof list[number]];
    const aU = A.ply.points[A.i]!;
    const aV = A.ply.points[A.j]!;
    const sameStart = key(B.ply.outline[B.i]!) === A.first;
    const bU = B.ply.points[sameStart ? B.i : B.j]!;
    const bV = B.ply.points[sameStart ? B.j : B.i]!;
    if (len3(sub3(bU, aU)) < 2e-5 && len3(sub3(bV, aV)) < 2e-5) continue;
    const closed = dot3(A.ply.normal, B.ply.normal) < -0.5;
    // Out beyond the crease: away from the paper on either side of it.
    const run = sub3(aV, aU);
    const runLen = len3(run) || 1;
    const e: Vec3 = [run[0] / runLen, run[1] / runLen, run[2] / runLen];
    const middleOf = (pts: readonly Vec3[]): Vec3 => {
      const k = pts.length || 1;
      return [pts.reduce((a, p) => a + p[0], 0) / k, pts.reduce((a, p) => a + p[1], 0) / k, pts.reduce((a, p) => a + p[2], 0) / k];
    };
    const mid: Vec3 = [(aU[0] + aV[0]) / 2, (aU[1] + aV[1]) / 2, (aU[2] + aV[2]) / 2];
    let inward = sub3(middleOf(A.ply.points), mid);
    inward = along(inward, e, -dot3(inward, e));
    const ring = (pa: Vec3, pb: Vec3): Vec3[] => {
      const c: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const r = len3(sub3(pa, c));
      if (!closed || r < 1e-6) return Array.from({ length: SEGMENTS + 1 }, (_, k) => along(pa, sub3(pb, pa), k / SEGMENTS));
      const e1: Vec3 = [(pa[0] - c[0]) / r, (pa[1] - c[1]) / r, (pa[2] - c[2]) / r];
      let o = along(inward, e1, -dot3(inward, e1));
      const ol = len3(o);
      if (ol < 1e-9) return [pa, pb];
      o = [-o[0] / ol, -o[1] / ol, -o[2] / ol];
      return Array.from({ length: SEGMENTS + 1 }, (_, k) => {
        const t = (Math.PI * k) / SEGMENTS;
        return [c[0] + r * (Math.cos(t) * e1[0] + Math.sin(t) * o[0]),
          c[1] + r * (Math.cos(t) * e1[1] + Math.sin(t) * o[1]),
          c[2] + r * (Math.cos(t) * e1[2] + Math.sin(t) * o[2])] as Vec3;
      });
    };
    const ru = ring(aU, bU);
    const rv = ring(aV, bV);
    for (let k = 0; k + 1 < Math.min(ru.length, rv.length); k++) {
      tris.push(ru[k]!, ru[k + 1]!, rv[k + 1]!, ru[k]!, rv[k + 1]!, rv[k]!);
    }
  }
  return tris;
}
