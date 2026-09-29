/**
 * Fold-line constructions.
 *
 * Real folding instructions almost never say "crease from here to here". They
 * say "bring this corner onto that point" or "lay this edge along that edge".
 * Those are constructions: you name what should end up on top of what, and the
 * crease follows. These are the classical origami axioms, restricted to the
 * three cases a paper aeroplane actually uses.
 */

import type { Vec2 } from './math.js';

export interface Segment {
  readonly a: Vec2;
  readonly b: Vec2;
}

const EPS = 1e-9;

const dir = (s: Segment): Vec2 => [s.b[0] - s.a[0], s.b[1] - s.a[1]];
const len2 = (v: Vec2): number => v[0] * v[0] + v[1] * v[1];

function unit2(v: Vec2): Vec2 | null {
  const n = Math.hypot(v[0], v[1]);
  return n < EPS ? null : [v[0] / n, v[1] / n];
}

export const midpoint = (p: Vec2, q: Vec2): Vec2 => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
export const distance = (p: Vec2, q: Vec2): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** The point of a segment closest to `p`, clamped to its ends. */
function nearestPointOnSegment(p: Vec2, s: Segment): Vec2 {
  const d = dir(s);
  const l2 = len2(d);
  if (l2 < EPS) return s.a;
  const t = Math.max(0, Math.min(1,
    ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / l2));
  return [s.a[0] + t * d[0], s.a[1] + t * d[1]];
}

/** The foot of the perpendicular from `p` to the line through `s`, unclamped. */
function projectOntoLine(p: Vec2, s: Segment): Vec2 {
  const d = dir(s);
  const l2 = len2(d);
  if (l2 < EPS) return s.a;
  const t = ((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1]) / l2;
  return [s.a[0] + t * d[0], s.a[1] + t * d[1]];
}

/** `p` mirrored in the line through `s`. */
function reflectAcross(p: Vec2, s: Segment): Vec2 {
  const foot = projectOntoLine(p, s);
  return [2 * foot[0] - p[0], 2 * foot[1] - p[1]];
}

export const distanceToSegment = (p: Vec2, s: Segment): number =>
  distance(p, nearestPointOnSegment(p, s));

/** Crease that brings `p` exactly onto `q`. */
function perpendicularBisector(p: Vec2, q: Vec2): Segment | null {
  const d = unit2([q[0] - p[0], q[1] - p[1]]);
  if (!d) return null;
  const m = midpoint(p, q);
  return { a: m, b: [m[0] - d[1], m[1] + d[0]] };
}

function intersectLines(s1: Segment, s2: Segment): Vec2 | null {
  const d1 = dir(s1);
  const d2 = dir(s2);
  const den = d1[0] * d2[1] - d1[1] * d2[0];
  if (Math.abs(den) < EPS) return null;
  const t = ((s2.a[0] - s1.a[0]) * d2[1] - (s2.a[1] - s1.a[1]) * d2[0]) / den;
  return [s1.a[0] + t * d1[0], s1.a[1] + t * d1[1]];
}

/**
 * Crease that lays the line of `s1` onto the line of `s2`.
 *
 * Two bisectors always satisfy that. An edge usually runs past the crossing on
 * both sides - a sheet's top edge straddles its own centre line - so which
 * bisector is wanted depends on which part of the edge the user grabbed. That
 * is what `ref` is: the point they clicked.
 */
function angleBisector(s1: Segment, s2: Segment, ref?: Vec2): Segment | null {
  const d1 = unit2(dir(s1));
  const d2 = unit2(dir(s2));
  if (!d1 || !d2) return null;

  const x = intersectLines(s1, s2);
  if (!x) {
    // Parallel edges: the crease is the midline between them.
    const foot = projectOntoLine(s1.a, s2);
    if (!foot) return null;
    const m = midpoint(s1.a, foot);
    if (distance(s1.a, foot) < EPS) return null;
    return { a: m, b: [m[0] + d1[0], m[1] + d1[1]] };
  }

  const m1 = ref ?? midpoint(s1.a, s1.b);
  let best: Segment | null = null;
  let bestScore = Infinity;
  for (const cand of [
    unit2([d1[0] + d2[0], d1[1] + d2[1]]),
    unit2([d1[0] - d2[0], d1[1] - d2[1]]),
  ]) {
    if (!cand) continue;
    const line: Segment = { a: x, b: [x[0] + cand[0], x[1] + cand[1]] };
    const moved = reflectAcross(m1, line);
    if (!moved) continue;
    const score = distanceToSegment(moved, s2);
    if (score < bestScore) { bestScore = score; best = line; }
  }
  return best;
}

/** Crease that drops `p` onto the nearest point of the line through `s`. */
function pointOntoLine(p: Vec2, s: Segment): Segment | null {
  const foot = projectOntoLine(p, s);
  if (!foot || distance(p, foot) < 1e-6) return null;
  return perpendicularBisector(p, foot);
}

export type Pick =
  | { readonly kind: 'point'; readonly p: Vec2 }
  /** `at` is where along the edge the user clicked, which disambiguates bisectors. */
  | { readonly kind: 'edge'; readonly s: Segment; readonly at: Vec2 };

export interface Construction {
  readonly line: Segment;
  readonly note: string;
}

/**
 * Pick two things and the crease follows. The pair decides the construction,
 * so one tool covers corner-to-corner, edge-to-edge and corner-to-edge.
 */
export function alignFold(first: Pick, second: Pick): Construction | null {
  if (first.kind === 'point' && second.kind === 'point') {
    const line = perpendicularBisector(first.p, second.p);
    return line && { line, note: '맞춰접기 (점→점)' };
  }
  if (first.kind === 'edge' && second.kind === 'edge') {
    const line = angleBisector(first.s, second.s, first.at);
    return line && { line, note: '맞춰접기 (변→변)' };
  }
  const p = first.kind === 'point' ? first.p : (second as { p: Vec2 }).p;
  const edge = first.kind === 'edge' ? first : (second as { s: Segment });
  const line = pointOntoLine(p, edge.s);
  return line && { line, note: '맞춰접기 (점→변)' };
}
