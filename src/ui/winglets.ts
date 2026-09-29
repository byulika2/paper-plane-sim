/**
 * Both winglets in one press: a width, and the tips turn up.
 *
 * By hand a winglet is marked a centimetre in from the wing's tip at the front
 * and at the back, folded on the line through the two marks, and then the
 * model is turned over for the other one. What makes it hard to write down is
 * the flat drawing the folds are worked in. There the wing lies folded onto
 * the body, and if it was folded on a slant - Birdman's is 1.5cm deep at the
 * nose and 0.8cm at the tail - its tip lies on a slant too, so a line drawn
 * parallel to the body met the tip only part way and made a triangle of the
 * winglet. Both wings also lie in the same place in that drawing.
 *
 * So the line is found where the pupil sees it: on the aeroplane in space.
 * Each wing's tip is its outermost edge, the winglet line runs parallel to it
 * the given width inboard, in the wing's own plane, and it is carried into the
 * flat drawing through the paper it lies on. Which wing folds is named by a
 * point of the sheet, not by a place in the drawing, so the two wings lying
 * on top of each other there cannot be confused; and which way is "up" is
 * read off the aeroplane - away from the keel - so both come up together.
 */

import { buildAirframe } from '../aero/airframe.js';
import { affineApply, pointInPolygon } from '../geometry/fold.js';
import { applyRigid, cross, dot, norm, rotateRigid, sub } from '../geometry/math.js';
import type { Vec2, Vec3 } from '../geometry/math.js';
import { renderFaces, turnedFromViewerAt } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';
import { replay, wingFaces } from './foldSession.js';
import type { FoldStep, Step } from './foldSession.js';

const unit3 = (v: Vec3): Vec3 => {
  const n = norm(v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};
const add3 = (a: Vec3, b: Vec3, s = 1): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];

/** Why nothing could be folded, in words for the pupil. */
export type WingletProblem = 'no-wings' | 'too-wide';

export function wingletSteps(
  width: number,
  height: number,
  before: readonly Step[],
  widthMm: number,
  paper: PaperProps,
  group: number,
): Step[] | WingletProblem {
  const cm = Math.round(widthMm) / 10;
  return tipFold(width, height, before, widthMm, paper, group, 90, [`윙렛 접기 (${cm}cm)`, '반대쪽 윙렛도']);
}

/**
 * Both wings bent up along a line parallel to the tip, `fromTipMm` in from
 * it, by `angleDeg`: a winglet at ninety degrees, a polyhedral break at ten or
 * fifteen. The same line, found the same way, only the angle differs.
 */
export function tipFold(
  width: number,
  height: number,
  before: readonly Step[],
  widthMm: number,
  paper: PaperProps,
  group: number,
  angleDeg: number,
  labels: readonly [string, string],
): Step[] | WingletProblem {
  const state = replay(width, height, before).state;
  const plies = renderFaces(state, -1, 0);
  if (plies.length < 2) return 'no-wings';
  const af = buildAirframe(plies, paper);
  if (!(af.span > 0)) return 'no-wings';
  const origin = af.frame.toBody([0, 0, 0]);
  const toBody = af.frame.toBody;
  const dirBody = (v: Vec3): Vec3 => sub(toBody(v), origin);
  // Body up (-z) back in the model's own coordinates: toward, for the sense.
  const bx = dirBody([1, 0, 0]);
  const by = dirBody([0, 1, 0]);
  const bz = dirBody([0, 0, 1]);
  const up: Vec3 = [-bx[2], -by[2], -bz[2]];
  const forward: Vec3 = [bx[0], by[0], bz[0]];

  const d = widthMm / 1000;
  const loops = state.graph.faces_vertices.map((loop) =>
    loop.map((v) => state.graph.vertices_coords[v]!));

  const out: FoldStep[] = [];
  for (const side of [1, -1] as const) {
    // The wing on this side: paper lying flat-ish, clear of the keel.
    const wing = plies.filter((f) => {
      const n = dirBody(f.normal);
      if (Math.abs(n[2]) < 0.5) return false;
      const c = f.points.reduce<Vec3>((s, p) => add3(s, p, 1 / f.points.length), [0, 0, 0]);
      return toBody(c)[1] * side > 0.01;
    });
    if (wing.length === 0) return 'no-wings';

    // Its tip: the outermost edge running fore and aft.
    let tip: { a: Vec3; b: Vec3; face: typeof wing[number]; reach: number } | null = null;
    for (const f of wing) {
      const pts = f.points;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        const along = sub(b, a);
        const len = norm(along);
        if (len < 0.01) continue;
        if (Math.abs(dot(along, forward)) / len < 0.7) continue;
        const mid = add3(a, along, 0.5);
        const reach = toBody(mid)[1] * side;
        if (!tip || reach > tip.reach + 1e-6) tip = { a, b, face: f, reach };
      }
    }
    if (!tip) return 'no-wings';
    if (tip.reach - d < 0.012) return 'too-wide';

    // Inboard, in the wing's own plane.
    const normal = unit3(rotateRigid(tip.face.transform, [0, 0, 1]));
    let inward = unit3(cross(normal, sub(tip.b, tip.a)));
    const probe = add3(add3(tip.a, sub(tip.b, tip.a), 0.5), inward, d);
    if (toBody(probe)[1] * side > tip.reach) inward = [-inward[0], -inward[1], -inward[2]];

    /*
     * The line runs the wing's whole length, not just the tip's. A tip cut
     * short - the nose's corners folded in on a slant - is shorter than the
     * paper a centimetre inboard of it, and a crease only as long as the tip
     * left the rolled nose there uncut: the winglet came up as one ply and
     * the rest of the tip stayed flat.
     */
    const run = unit3(sub(tip.b, tip.a));
    const a = add3(add3(tip.a, inward, d), run, -af.length);
    const b = add3(add3(tip.b, inward, d), run, af.length);
    // A point on the strip that turns up: between the line and the tip.
    const grip = add3(add3(tip.a, sub(tip.b, tip.a), 0.5), inward, d * 0.4);

    // The paper under the grip, and the flat drawing through it.
    const sheetOf = (f: typeof wing[number], p: Vec3): Vec3 => applyRigid(f.inverse, p);
    const holder = wing.find((f) => {
      const q = sheetOf(f, grip);
      return Math.abs(q[2]) < 1e-4 && pointInPolygon(loops[f.face]!, [q[0], q[1]]);
    }) ?? tip.face;
    const layout = (p: Vec3): Vec2 => {
      const q = sheetOf(holder, p);
      return affineApply(state.faces_matrix[holder.face]!, [q[0], q[1]]);
    };
    const gripSheet = sheetOf(holder, grip);
    const sheet: Vec2 = [gripSheet[0], gripSheet[1]];
    const turned = turnedFromViewerAt(state, sheet, up);
    /*
     * The whole tip of that wing, every ply of it past the line - as the wing
     * itself was folded - and not the paper joined to the finger's ply. Joined
     * paper stopped short where the nose's corners were folded in on a slant:
     * the rolled nose under the tip is tied to the wing only through the
     * corner flap, which lies inboard of the line, and the winglet came up as
     * the one ply of the skin while the rest of the tip stayed flat.
     */
    const [la, lb, lg] = [layout(a), layout(b), layout(grip)];
    const upper = [true, false].find((u) => wingFaces(state, la, lb, lg, u)?.has(holder.face));
    out.push({
      kind: 'fold', a: la, b: lb, movingSide: lg,
      sense: turned ? 'mountain' : 'valley', creaseOnly: false, angleDeg,
      plies: upper === undefined ? { kind: 'piece', at: lg, sheet } : { kind: 'wing', upper },
      label: labels[out.length === 0 ? 0 : 1],
      group,
    });
  }
  return out;
}

/** One break of a polyhedral wing: how far in from the tip, and how far up. */
export interface DihedralBreak { readonly fromTipCm: number; readonly angleDeg: number }

/**
 * Two- or three-stage dihedral: each wing bent up at one or two lines
 * parallel to its tip, measured in from the tip.
 *
 * The inner break is folded first. Measured from the tip, a line is found in
 * the plane of the tip's own paper, and once the outer panel is turned up that
 * plane no longer holds the inner line - folding inside out keeps every line
 * in the flat paper it is measured on.
 */
export function dihedralSteps(
  width: number,
  height: number,
  before: readonly Step[],
  breaks: readonly DihedralBreak[],
  paper: PaperProps,
  group: number,
): Step[] | WingletProblem {
  const stage = breaks.length + 1;
  const order = [...breaks].sort((a, b) => b.fromTipCm - a.fromTipCm);
  let steps: Step[] = [...before];
  const added: Step[] = [];
  for (const [i, br] of order.entries()) {
    const made = tipFold(width, height, steps, br.fromTipCm * 10, paper, group, br.angleDeg, [
      `${stage}단 상반각 ${i + 1} (끝에서 ${br.fromTipCm}cm · ${br.angleDeg}°)`, '반대쪽도',
    ]);
    if (typeof made === 'string') return made;
    steps = [...steps, ...made];
    added.push(...made);
  }
  return added;
}
