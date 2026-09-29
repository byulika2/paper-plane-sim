/**
 * Is this stacking order paper, or does it pass through itself?
 *
 * A fold order is not free. Two conditions rule out everything a real sheet
 * cannot do, and both are local to a crease:
 *
 *  - a crease that closes flat makes a pocket - a taco - out of the two faces
 *    it joins, and the pocket is shut at the crease. Another taco cannot be
 *    half in and half out of it, and a plain face cannot lie inside it and
 *    still run out past the closed end.
 *
 * Everything else is a consequence of those two plus transitivity, which the
 * total order gives for free. So this module does not search for an order: it
 * audits the one the fold script produced, and says exactly which faces are in
 * an impossible position. That is what turns "the paper looks cut" into a
 * named defect with a test around it.
 */

import type { Vec2 } from '../geometry/math.js';
import { faceOutline } from './folding.js';
import type { FoldedState } from './folding.js';
import { faceAdjacency } from './graph.js';

const EPS = 1e-9;

const signedArea = (poly: readonly Vec2[]): number => {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice / 2;
};

export const area = (poly: readonly Vec2[]): number => Math.abs(signedArea(poly));

/**
 * The part of a face that lies past a pocket's closed end - beyond the crease
 * and within its length.
 *
 * The closed end is a length of crease, not a line across the whole model.
 * Paper that goes out beyond the crease line off to one side of it has gone
 * round the end of the fold, not through it: the Sky King's lock is a point
 * folded over the two flaps, closed along the seven centimetres between where
 * its edges cross them, and the flaps run on past that line outside those
 * ends. Read as a whole line, the audit called that impossible and the search
 * settled for a pile with half the lock folded the other way.
 *
 * `keep` is the side of the crease the pocket is on.
 */
export function pastClosedEnd(poly: readonly Vec2[], a: Vec2, b: Vec2, keep: boolean): Vec2[] {
  const along: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const square = (at: Vec2): Vec2 => [at[0] - along[1], at[1] + along[0]];
  const beyond = halfPlane(poly, a, b, !keep);
  const fromA = halfPlane(beyond, a, square(a), side(a, square(a), b) >= 0);
  return halfPlane(fromA, b, square(b), side(b, square(b), a) >= 0);
}

/**
 * How high each ply sits, counted only through the paper actually under it.
 *
 * The pile's order is one list for the whole model, so two plies side by side
 * - an aeroplane's two ears, folded in the same way one after the other - get
 * different places in it though neither is on the other. Stacking by place in
 * the list floated the second ear a layer above the first, and a fold made the
 * same on both sides looked as though it had gone the other way on one. A ply
 * goes one above the highest ply beneath it that it actually overlaps.
 *
 * `outlines` are listed bottom first, in the pile's order.
 */
export function stackLevels(outlines: readonly (readonly Vec2[])[]): number[] {
  const level: number[] = [];
  outlines.forEach((poly, i) => {
    let at = 0;
    for (let j = 0; j < i; j++) {
      if (level[j]! + 1 <= at) continue;
      if (area(clipTo(poly, outlines[j]!)) > 1e-10) at = level[j]! + 1;
    }
    level.push(at);
  });
  return level;
}

/**
 * Clip one polygon to the inside of another convex one.
 *
 * Every face here is a rectangle divided by a succession of straight creases -
 * the paper is never cut, only folded, and the pieces stay joined along their
 * creases - so each is convex, and Sutherland-Hodgman is exact.
 */
export function clipTo(subject: readonly Vec2[], clip: readonly Vec2[]): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const hand = signedArea(clip) >= 0 ? 1 : -1;
  let out: Vec2[] = subject.map((p) => [p[0], p[1]]);

  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    const side = (p: Vec2) =>
      hand * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const next: Vec2[] = [];
    for (let j = 0; j < out.length; j++) {
      const p = out[j]!;
      const q = out[(j + 1) % out.length]!;
      const dp = side(p);
      const dq = side(q);
      if (dp >= -EPS) next.push(p);
      if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
        const t = dp / (dp - dq);
        next.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    out = next;
  }
  return out;
}

/** The part of a polygon on one side of a line, as a polygon. */
export function halfPlane(
  poly: readonly Vec2[], a: Vec2, b: Vec2, keepPositive: boolean,
): Vec2[] {
  const sign = keepPositive ? 1 : -1;
  const side = (p: Vec2) =>
    sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const dp = side(p);
    const dq = side(q);
    if (dp >= -EPS) out.push(p);
    if ((dp > EPS && dq < -EPS) || (dp < -EPS && dq > EPS)) {
      const t = dp / (dp - dq);
      out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
    }
  }
  return out;
}

/** A crease that closes far enough to make a pocket, with the two faces in it. */
export interface Taco {
  readonly edge: number;
  readonly faces: readonly [number, number];
  /** The crease where it lands in the folded view. */
  readonly a: Vec2;
  readonly b: Vec2;
}

/** Which faces meet along each edge. */
function edgeFaces(state: FoldedState): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const adjacency = faceAdjacency(state.graph);
  for (const [face, links] of adjacency) {
    for (const { edge } of links) {
      const list = out.get(edge);
      if (list) { if (!list.includes(face)) list.push(face); }
      else out.set(edge, [face]);
    }
  }
  return out;
}

/**
 * The creases that have actually closed.
 *
 * A crease still standing open holds nothing captive, so only folds PAST a
 * right angle make a pocket worth checking - a right angle itself is still
 * open. Counting those too made a pocket of every wing crease on an aeroplane,
 * and the two wings, drawn flat over each other in the layout, were then read
 * as threaded through one another whichever way round their plies were put.
 */
export function tacos(state: FoldedState, minAngleDeg = 90): Taco[] {
  const out: Taco[] = [];
  for (const [edge, faces] of edgeFaces(state)) {
    if (faces.length !== 2) continue;
    const assignment = state.graph.edges_assignment[edge];
    if (assignment !== 'mountain' && assignment !== 'valley') continue;
    const angle = Math.abs(((state.graph.edges_foldAngle[edge] ?? 0) * 180) / Math.PI);
    if (angle <= minAngleDeg) continue;

    const [u, v] = state.graph.edges_vertices[edge]!;
    const loop = state.graph.faces_vertices[faces[0]!]!;
    const at = (vertex: number): Vec2 => {
      const outline = faceOutline(state, faces[0]!);
      const i = loop.indexOf(vertex);
      return i >= 0 ? outline[i]! : outline[0]!;
    };
    out.push({ edge, faces: [faces[0]!, faces[1]!], a: at(u), b: at(v) });
  }
  return out;
}

export interface OrderViolation {
  readonly kind: 'taco-taco' | 'taco-tortilla';
  readonly faces: readonly number[];
  readonly detail: string;
}

export interface AuditOptions {
  /** Overlaps smaller than this are contact, not interpenetration. m^2. */
  readonly minArea?: number;
}

/**
 * Report every place the order asks the paper to pass through itself.
 *
 * An empty list is not a proof that the model can be folded - that needs the
 * full fold-order search - but every entry in a non-empty one is a real defect.
 */
export function orderViolations(
  state: FoldedState,
  options: AuditOptions = {},
): OrderViolation[] {
  const { minArea = 1e-8 } = options;
  const position = new Map<number, number>();
  state.faces_order.forEach((face, i) => position.set(face, i));
  const outlines = state.graph.faces_vertices.map((_, f) => faceOutline(state, f));
  const pockets = tacos(state);
  const out: OrderViolation[] = [];

  const rank = (f: number) => position.get(f) ?? 0;
  const between = (c: number, a: number, b: number) => {
    const lo = Math.min(rank(a), rank(b));
    const hi = Math.max(rank(a), rank(b));
    return rank(c) > lo && rank(c) < hi;
  };

  // Two pockets over the same crease cannot be threaded through each other.
  for (let i = 0; i < pockets.length; i++) {
    for (let j = i + 1; j < pockets.length; j++) {
      const p = pockets[i]!;
      const q = pockets[j]!;
      if (!segmentsShareRun(p, q)) continue;
      const inside = [q.faces[0], q.faces[1]].filter((f) => between(f, p.faces[0], p.faces[1]));
      if (inside.length === 1) {
        out.push({
          kind: 'taco-taco',
          faces: [...p.faces, ...q.faces],
          detail: `faces ${q.faces[0]},${q.faces[1]} straddle the fold at ${p.faces[0]},${p.faces[1]}`,
        });
      }
    }
  }

  // A face lying inside a pocket cannot also run out past its closed end.
  for (const pocket of pockets) {
    const [a, b] = pocket.faces;
    const shared = clipTo(outlines[a]!, outlines[b]!);
    if (area(shared) < minArea) continue;
    // The pocket lies on one side of the crease; that is the side to be inside.
    const centre = centroid(shared);
    const keep = side(pocket.a, pocket.b, centre) >= 0;

    for (let c = 0; c < outlines.length; c++) {
      if (c === a || c === b) continue;
      if (!between(c, a, b)) continue;
      if (area(clipTo(outlines[c]!, shared)) < minArea) continue;
      const past = pastClosedEnd(outlines[c]!, pocket.a, pocket.b, keep);
      if (area(past) < minArea) continue;
      out.push({
        kind: 'taco-tortilla',
        faces: [a, b, c],
        detail: `face ${c} sits inside the fold at ${a},${b} yet runs past its closed end`,
      });
    }
  }
  return out;
}

export const side = (a: Vec2, b: Vec2, p: Vec2): number =>
  (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

export function centroid(poly: readonly Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of poly) { x += p[0]; y += p[1]; }
  return [x / poly.length, y / poly.length];
}

/** Do two creases lie along the same line and share more than a point? */
export function segmentsShareRun(p: Taco, q: Taco): boolean {
  const dx = p.b[0] - p.a[0];
  const dy = p.b[1] - p.a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return false;
  const off = (v: Vec2) => ((v[0] - p.a[0]) * -dy + (v[1] - p.a[1]) * dx) / len;
  if (Math.abs(off(q.a)) > 1e-6 || Math.abs(off(q.b)) > 1e-6) return false;

  const t = (v: Vec2) => ((v[0] - p.a[0]) * dx + (v[1] - p.a[1]) * dy) / (len * len);
  const lo = Math.max(0, Math.min(t(q.a), t(q.b)));
  const hi = Math.min(1, Math.max(t(q.a), t(q.b)));
  return hi - lo > 1e-6;
}
