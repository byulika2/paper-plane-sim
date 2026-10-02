/**
 * Folding some of the plies, and the pocket that makes.
 *
 * Fold the top layer of a pile along a line and it goes, as long as nothing
 * holds it. But a layer is usually joined to the one under it somewhere - the
 * band rolled up at the nose is joined to the sheet along the edge it was
 * rolled over - and where the line crosses that join, the top layer cannot
 * turn alone: it drags the layer under it, and the paper at the corner opens
 * into a pocket. A hand then squashes the pocket flat one way or another, and
 * which way is a choice, not something the fold can settle by itself.
 *
 * So this finds the joins the line crosses and, for each, the ways the paper
 * there can lie flat. At the point where the line meets the join, the creases
 * that meet must satisfy the flat-folding rule (alternate angles adding to
 * 180 degrees), and with the fold line, the join and the line's continuation
 * in the lower layer fixed, one more crease is enough - its direction follows
 * from the rule. Each way is then folded for real and kept only if the paper
 * lies flat and stacks without passing through itself.
 */

import { affineApply, affineInverse } from '../geometry/fold.js';
import type { Vec2 } from '../geometry/math.js';
import { collapsePattern } from './collapse.js';
import { faceAdjacency } from './graph.js';
import { faceOutline } from './folding.js';
import type { FoldedState } from './folding.js';

export interface PocketLine {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly kind: 'mountain' | 'valley' | 'open';
}

export interface PocketWish {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly how: 'along' | 'align';
}

export interface PocketOption {
  /** What the hand does, for the pupil. */
  readonly label: string;
  readonly detail: string;
  /** The move, as lines on the unfolded sheet: a collapse step's `lines`. */
  readonly lines: readonly PocketLine[];
  /** The paper after it, for a preview. */
  readonly state: FoldedState;
  /** It folds along a line already pressed into the paper, other than the fold line itself. */
  readonly pressed?: boolean;
}

const EPS = 1e-9;
const isClosed = (s: FoldedState, e: number) =>
  s.graph.edges_assignment[e] !== 'boundary' && Math.abs(s.graph.edges_foldAngle[e] ?? 0) > Math.PI - 1e-6;

const side = (a: Vec2, b: Vec2, p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

function inPoly(poly: readonly Vec2[], p: Vec2): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const A = poly[i]!;
    const B = poly[j]!;
    if ((A[1] > p[1]) !== (B[1] > p[1]) && p[0] < (B[0] - A[0]) * (p[1] - A[1]) / (B[1] - A[1]) + A[0]) c = !c;
  }
  return c;
}

/** Where segment pq crosses the infinite line ab, as a parameter on pq, or null. */
function crossParam(p: Vec2, q: Vec2, a: Vec2, b: Vec2): number | null {
  const sp = side(a, b, p);
  const sq = side(a, b, q);
  if ((sp > EPS && sq > EPS) || (sp < -EPS && sq < -EPS) || Math.abs(sp - sq) < EPS) return null;
  return sp / (sp - sq);
}

/**
 * Plies as a hand counts them: paper joined by creases that are not folded is
 * one sheet, however many faces the pattern has cut it into.
 */
function plyGroups(s: FoldedState): number[] {
  const n = s.graph.faces_vertices.length;
  const group = new Array<number>(n).fill(-1);
  const adj = faceAdjacency(s.graph);
  let g = 0;
  for (let f = 0; f < n; f++) {
    if (group[f] !== -1) continue;
    const stack = [f];
    group[f] = g;
    while (stack.length) {
      const here = stack.pop()!;
      for (const { face, edge } of adj.get(here) ?? []) {
        if (group[face] !== -1 || isClosed(s, edge)) continue;
        group[face] = g;
        stack.push(face);
      }
    }
    g++;
  }
  /*
   * A roll is one sheet too. Rolled like a camber, the layers are joined by
   * folds that all run the same way, and a hand lifts them as one: so sheets
   * joined by parallel folds count together - all but the biggest of them,
   * which is the sheet the roll sits on.
   */
  const area = new Array<number>(g).fill(0);
  s.graph.faces_vertices.forEach((loop, f) => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = s.graph.vertices_coords[loop[i]!]!;
      const q = s.graph.vertices_coords[loop[(i + 1) % loop.length]!]!;
      a += p[0] * q[1] - q[0] * p[1];
    }
    area[group[f]!] = (area[group[f]!] ?? 0) + Math.abs(a) / 2;
  });
  const parent = Array.from({ length: g }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  const byDir = new Map<number, Array<[number, number]>>();
  for (const [f, list] of adj) {
    for (const { face, edge } of list) {
      if (face < f || !isClosed(s, edge) || group[f] === group[face]) continue;
      const [u, v] = s.graph.edges_vertices[edge]!;
      const p = affineApply(s.faces_matrix[f]!, s.graph.vertices_coords[u]!);
      const q = affineApply(s.faces_matrix[f]!, s.graph.vertices_coords[v]!);
      const dir = Math.round(((Math.atan2(q[1] - p[1], q[0] - p[0]) * 180 / Math.PI) + 180) % 180);
      const list2 = byDir.get(dir) ?? [];
      list2.push([group[f]!, group[face]!]);
      byDir.set(dir, list2);
    }
  }
  for (const pairs of byDir.values()) {
    // Components of sheets joined by folds of this one direction.
    const local = new Map<number, number>();
    const lf = (x: number): number => { const p = local.get(x) ?? x; if (p === x) return x; const r = lf(p); local.set(x, r); return r; };
    for (const [x, y] of pairs) { const rx = lf(x); const ry = lf(y); if (rx !== ry) local.set(rx, ry); }
    const comps = new Map<number, number[]>();
    for (const [x, y] of pairs) for (const z of [x, y]) {
      const r = lf(z);
      const c = comps.get(r) ?? [];
      if (!c.includes(z)) c.push(z);
      comps.set(r, c);
    }
    for (const members of comps.values()) {
      if (members.length < 3) continue; // one flap on a sheet is just a flap
      const base = members.reduce((m, z) => (area[z]! > area[m]! ? z : m), members[0]!);
      const rolled = members.filter((z) => z !== base);
      for (const z of rolled.slice(1)) parent[find(z)] = find(rolled[0]!);
    }
  }
  return group.map((x) => find(x));
}

/**
 * The top `count` plies under the fold line, on the side that travels: the
 * sheets a hand lifts when it takes that many layers at the line.
 */
export function pliesAtLine(s: FoldedState, a: Vec2, b: Vec2, moving: Vec2, count: number): Set<number> {
  const group = plyGroups(s);
  const outlines = s.graph.faces_vertices.map((_, f) => faceOutline(s, f));
  const rank = new Map<number, number>();
  s.faces_order.forEach((f, i) => rank.set(f, i));
  const dir: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const nrm: Vec2 = [-dir[1] / len, dir[0] / len];
  const toward = side(a, b, moving) > 0 ? 1 : -1;
  const chosen = new Set<number>();
  // Sample just inside the travelling side, all along the line's run over the paper.
  for (let t = -1; t <= 2; t += 0.01) {
    const on: Vec2 = [a[0] + dir[0] * t, a[1] + dir[1] * t];
    const sgn = side(a, b, [on[0] + nrm[0], on[1] + nrm[1]]) > 0 ? 1 : -1;
    const p: Vec2 = [on[0] + nrm[0] * 1e-3 * sgn * toward, on[1] + nrm[1] * 1e-3 * sgn * toward];
    const under = outlines.map((o, f) => f).filter((f) => inPoly(outlines[f]!, p))
      .sort((x, y) => (rank.get(y) ?? 0) - (rank.get(x) ?? 0));
    const groupsHere: number[] = [];
    for (const f of under) if (!groupsHere.includes(group[f]!)) groupsHere.push(group[f]!);
    // Only where there is paper left behind: elsewhere "the top one" is simply all there is.
    if (groupsHere.length > count) for (const g of groupsHere.slice(0, count)) chosen.add(g);
  }
  const faces = new Set<number>();
  group.forEach((g, f) => { if (chosen.has(g)) faces.add(f); });
  return faces;
}

/** How many plies lie under the line on the travelling side, at the thickest place. */
export function pliesUnderLine(s: FoldedState, a: Vec2, b: Vec2, moving: Vec2): number {
  const group = plyGroups(s);
  const outlines = s.graph.faces_vertices.map((_, f) => faceOutline(s, f));
  const dir: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const nrm: Vec2 = [-dir[1] / len, dir[0] / len];
  const toward = side(a, b, moving) > 0 ? 1 : -1;
  let most = 0;
  for (let t = -1; t <= 2; t += 0.01) {
    const on: Vec2 = [a[0] + dir[0] * t, a[1] + dir[1] * t];
    const sgn = side(a, b, [on[0] + nrm[0], on[1] + nrm[1]]) > 0 ? 1 : -1;
    const p: Vec2 = [on[0] + nrm[0] * 1e-3 * sgn * toward, on[1] + nrm[1] * 1e-3 * sgn * toward];
    const gs = new Set<number>();
    outlines.forEach((o, f) => { if (inPoly(o, p)) gs.add(group[f]!); });
    most = Math.max(most, gs.size);
  }
  return most;
}

interface Ray { readonly dir: Vec2; readonly angle: number }
/*
 * Two directions the same to a hundredth of a radian, round the circle: a
 * horizontal ray comes out at 0 or at 6.283 by the last bit, and compared
 * by plain difference those were two different lines.
 */
const sameAngle = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d) < 0.01;
};
/** How far apart two directions are, radians, the short way round. */
const angleGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
};
/** How near a 맞춰 접기 crease has to come to a pressed one to fold on it: five degrees. */
const SNAP_TO_PRESSED = (5 * Math.PI) / 180;
const rayOf = (d: Vec2): Ray => {
  const n = Math.hypot(d[0], d[1]) || 1;
  const dir: Vec2 = [d[0] / n, d[1] / n];
  return { dir, angle: (Math.atan2(dir[1], dir[0]) + 2 * Math.PI) % (2 * Math.PI) };
};

/** From p along d, up to the first folded crease or the edge of the sheet. */
/**
 * A crease carried on through the folds it meets.
 *
 * Pressed through folded paper, a crease does not stop at a fold it crosses:
 * the paper beyond is turned over, so the line carries on mirrored in that
 * fold and turned the other way, mountain for valley. Stopped there instead,
 * the line ends in the middle of the paper, where nothing can lie flat. Traced
 * to an edge of the paper - a few turns at most.
 */
function traceOn(s: FoldedState, p: Vec2, d: Vec2, kind: 'mountain' | 'valley'): PocketLine[] {
  const g = s.graph;
  const out: PocketLine[] = [];
  let from = p;
  let dir = d;
  let k = kind;
  for (let turn = 0; turn < 6; turn++) {
    const far: Vec2 = [from[0] + dir[0] * 10, from[1] + dir[1] * 10];
    let best = 1;
    let hit = -1;
    g.edges_vertices.forEach(([u, v], e) => {
      const edge = g.edges_assignment[e] === 'boundary';
      if (!edge && !isClosed(s, e)) return;
      const A = g.vertices_coords[u]!;
      const B = g.vertices_coords[v]!;
      const t = crossParam(from, far, A, B);
      if (t === null || t * 10 < 1e-6) return;
      const q: Vec2 = [from[0] + (far[0] - from[0]) * t, from[1] + (far[1] - from[1]) * t];
      const along = ((q[0] - A[0]) * (B[0] - A[0]) + (q[1] - A[1]) * (B[1] - A[1])) / (((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2) || 1);
      if (along < -1e-6 || along > 1 + 1e-6) return;
      if (t < best) { best = t; hit = e; }
    });
    const to: Vec2 = [from[0] + (far[0] - from[0]) * best, from[1] + (far[1] - from[1]) * best];
    out.push({ a: from, b: to, kind: k });
    if (hit < 0 || g.edges_assignment[hit] === 'boundary') break;
    // Mirrored in the fold it met, and turned the other way.
    const [u, v] = g.edges_vertices[hit]!;
    const A = g.vertices_coords[u]!;
    const B = g.vertices_coords[v]!;
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const e: Vec2 = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
    const dot = dir[0] * e[0] + dir[1] * e[1];
    dir = [2 * dot * e[0] - dir[0], 2 * dot * e[1] - dir[1]];
    k = k === 'valley' ? 'mountain' : 'valley';
    from = to;
  }
  return out;
}

function runOn(s: FoldedState, p: Vec2, d: Vec2): Vec2 {
  const g = s.graph;
  const far: Vec2 = [p[0] + d[0] * 10, p[1] + d[1] * 10];
  let best = 1;
  g.edges_vertices.forEach(([u, v], e) => {
    const closedOrEdge = g.edges_assignment[e] === 'boundary' || isClosed(s, e);
    if (!closedOrEdge) return;
    const A = g.vertices_coords[u]!;
    const B = g.vertices_coords[v]!;
    const t = crossParam(p, far, A, B);
    if (t === null || t * 10 < 1e-6) return;
    const q: Vec2 = [p[0] + (far[0] - p[0]) * t, p[1] + (far[1] - p[1]) * t];
    // Must lie on the edge's own run, not its extension.
    const along = ((q[0] - A[0]) * (B[0] - A[0]) + (q[1] - A[1]) * (B[1] - A[1])) / (((B[0] - A[0]) ** 2 + (B[1] - A[1]) ** 2) || 1);
    if (along < -1e-6 || along > 1 + 1e-6) return;
    if (t < best) best = t;
  });
  return [p[0] + (far[0] - p[0]) * best, p[1] + (far[1] - p[1]) * best];
}

/**
 * The ways to squash the pocket a fold of some plies makes, or none when the
 * plies are free to turn on their own.
 *
 * `a`, `b`, `moving` are the fold as drawn in the folded view; `plies` the
 * faces that were taken. `mirror`, when given, is the sheet's centre line for
 * a fold made on both sides at once.
 */
interface Hinge { P: Vec2; A: number; B: number; edge: number }

/**
 * Where the plies being folded are joined, across the fold line, to paper that
 * is not: the places a pocket opens. None, and the plies are free to turn.
 */
export function pocketHinges(s: FoldedState, a: Vec2, b: Vec2, plies: ReadonlySet<number>): Hinge[] {
  const g = s.graph;
  const adj = faceAdjacency(g);
  const hinges: Hinge[] = [];
  for (const [f, list] of adj) {
    if (!plies.has(f)) continue;
    for (const { face, edge } of list) {
      if (plies.has(face) || !isClosed(s, edge)) continue;
      const [u, v] = g.edges_vertices[edge]!;
      const pu = affineApply(s.faces_matrix[f]!, g.vertices_coords[u]!);
      const pv = affineApply(s.faces_matrix[f]!, g.vertices_coords[v]!);
      const t = crossParam(pu, pv, a, b);
      if (t === null || t < -1e-9 || t > 1 + 1e-9) continue;
      const Pv: Vec2 = [pu[0] + (pv[0] - pu[0]) * t, pu[1] + (pv[1] - pu[1]) * t];
      const P = affineApply(affineInverse(s.faces_matrix[f]!), Pv);
      if (hinges.some((h) => Math.hypot(h.P[0] - P[0], h.P[1] - P[1]) < 1e-5)) continue;
      hinges.push({ P, A: f, B: face, edge });
    }
  }
  return hinges;
}

export function pocketOptions(
  s: FoldedState, a: Vec2, b: Vec2, moving: Vec2, plies: ReadonlySet<number>, mirrorX?: number,
  /**
   * Lines the pupil has asked for, in the folded view. `along` is a line
   * already on the paper, picked to squash along (선대로 접기); `align` is the
   * crease that lays one line onto another, as 맞춰 접기 makes it, and may be
   * wanted square to itself as well. Where one runs through the pocket's
   * corner it is tried as a crease there, in each sheet it crosses - and then
   * only the ways that use it are offered.
   */
  wanted: readonly PocketWish[] = [],
  /** Lines pressed into the paper, on the sheet: creases folded and opened again, which are no edges of the folded state. */
  pressed: readonly { a: Vec2; b: Vec2 }[] = [],
): PocketOption[] {
  const g = s.graph;
  const movSign = Math.sign(side(a, b, moving));
  const hinges = pocketHinges(s, a, b, plies);
  if (hinges.length === 0) return [];

  // One pocket, and its mirror when the fold is made on both sides.
  const h = hinges[0]!;
  const toSheet = (face: number, q: Vec2) => affineApply(affineInverse(s.faces_matrix[face]!), q);
  const [u, v] = g.edges_vertices[h.edge]!;
  const U = g.vertices_coords[u]!;
  const Vv = g.vertices_coords[v]!;
  // The join, split at P: the run that travels with the lifted plies, and the run that stays.
  const along: Vec2 = [Vv[0] - U[0], Vv[1] - U[1]];
  const probeView = affineApply(s.faces_matrix[h.A]!, [h.P[0] + along[0] * 0.01, h.P[1] + along[1] * 0.01]);
  const forward = Math.sign(side(a, b, probeView)) === movSign;
  const hm = rayOf(forward ? along : [-along[0], -along[1]]);
  const hs = rayOf(forward ? [-along[0], -along[1]] : along);
  // The fold line's run in each of the two layers, away from P into that layer.
  const lineIn = (face: number): Ray => {
    const qa = toSheet(face, a);
    const qb = toSheet(face, b);
    const d: Vec2 = [qb[0] - qa[0], qb[1] - qa[1]];
    // Pick the direction that goes into the face.
    const poly = g.faces_vertices[face]!.map((x) => g.vertices_coords[x]!);
    const probe = (k: number): Vec2 => [h.P[0] + d[0] * k * 1e-4, h.P[1] + d[1] * k * 1e-4];
    return rayOf(inPoly(poly, probe(1)) ? d : [-d[0], -d[1]]);
  };
  // The crease edges from the corner: a line drawn along one of them is it, to the last digit.
  const edgeRays: Ray[] = g.edges_vertices.flatMap(([u, v], e) => {
    if (g.edges_assignment[e] === 'boundary') return [];
    const A = g.vertices_coords[u]!;
    const B = g.vertices_coords[v]!;
    const from = Math.hypot(A[0] - h.P[0], A[1] - h.P[1]) < 1e-6 ? B
      : Math.hypot(B[0] - h.P[0], B[1] - h.P[1]) < 1e-6 ? A : null;
    return from ? [rayOf([from[0] - h.P[0], from[1] - h.P[1]])] : [];
  });
  const exactly = (r: Ray) => edgeRays.find((q) => sameAngle(q.angle, r.angle)) ?? r;
  const L = exactly(lineIn(h.A));
  const Lb = exactly(lineIn(h.B));

  const mir = (l: PocketLine): PocketLine | null => (mirrorX === undefined ? null
    : { a: [2 * mirrorX - l.a[0], l.a[1]], b: [2 * mirrorX - l.b[0], l.b[1]], kind: l.kind });
  const seg = (r: Ray, kind: PocketLine['kind']): PocketLine => ({ a: h.P, b: runOn(s, h.P, r.dir), kind });

  /*
   * Every way the corner can lie flat, found rather than guessed.
   *
   * The creases that may meet at P: the fold line in the lifted sheets (always),
   * the join that stays (always), the join that travels (kept or let open),
   * and any of a few natural lines in the sheet underneath - the fold line
   * carried straight on across the join (the triangle's diagonal, usually),
   * the fold line as it lies over that sheet, and the lines halfway between
   * these - plus, when the count is odd, the one crease the flat-folding rule
   * then asks for. Each set that satisfies the rule is folded for real; the
   * ones that lie flat and stack are offered, one per distinct result.
   */
  const straight = rayOf([-L.dir[0], -L.dir[1]]);
  // The creases already pressed into the paper that run from the corner.
  const pressedRays: Ray[] = edgeRays.concat(pressed.flatMap((m) => {
    // A pressed line through the corner runs from it both ways, as far as it goes.
    const d: Vec2 = [m.b[0] - m.a[0], m.b[1] - m.a[1]];
    const len = Math.hypot(d[0], d[1]);
    if (!(len > 1e-9)) return [];
    const off = Math.abs((h.P[0] - m.a[0]) * d[1] - (h.P[1] - m.a[1]) * d[0]) / len;
    if (off > 1e-5) return [];
    const t = ((h.P[0] - m.a[0]) * d[0] + (h.P[1] - m.a[1]) * d[1]) / (len * len);
    return [...(t > 1e-6 ? [rayOf([-d[0], -d[1]])] : []), ...(t < 1 - 1e-6 ? [rayOf(d)] : [])];
  })).filter((r) => ![L, Lb, hm, hs].some((x) => sameAngle(x.angle, r.angle)));
  const wishRays = wanted.flatMap((w) => [h.A, h.B].flatMap((face) => {
    const qa = toSheet(face, w.a);
    const qb = toSheet(face, w.b);
    const d: Vec2 = [qb[0] - qa[0], qb[1] - qa[1]];
    const len = Math.hypot(d[0], d[1]);
    if (!(len > 1e-9)) return [];
    // Through the corner, or it is no crease of this pocket.
    const off = Math.abs((h.P[0] - qa[0]) * d[1] - (h.P[1] - qa[1]) * d[0]) / len;
    if (off > 0.002) return [];
    // A line picked off the paper is that line. The crease 맞춰 접기 makes is
    // one of the two that halve the angle between one line and the other, and
    // the pocket may need the other, square to it.
    const dirs: Vec2[] = w.how === 'along' ? [d, [-d[0], -d[1]]] : [d, [-d[0], -d[1]], [-d[1], d[0]], [d[1], -d[0]]];
    /*
     * Lined up by eye against a line already pressed into the paper, the hand
     * folds on that line: the crease that is there takes the fold, and the
     * paper that does not fit is pushed out sideways by the creases left to
     * find. Within a few degrees of a pressed crease through the corner, 맞춰
     * 접기 uses the pressed crease. Taken exactly as aimed, it folded a few
     * degrees off the line the paper was creased on.
     */
    return dirs.map((q) => {
      const ray = rayOf(q);
      const pressed = w.how === 'align' ? pressedRays.find((c) => angleGap(c.angle, ray.angle) < SNAP_TO_PRESSED) : undefined;
      return { ray: pressed ?? ray, name: w.how === 'along' ? '고른 선' : pressed ? '맞춘 선(자국 따라)' : '맞춘 선' };
    });
  }));
  /*
   * 선대로 접기 means a line that is on the paper. Seen from above, the line
   * picked lies over both layers at the corner, but it is a crease in only one
   * of them - the other has nothing there to fold along. Where one of them has
   * it, that one is meant.
   */
  const isCrease = (r: Ray) => g.edges_vertices.some(([u, v], e) => {
    if (g.edges_assignment[e] === 'boundary') return false;
    const A = g.vertices_coords[u]!;
    const B = g.vertices_coords[v]!;
    const from = Math.hypot(A[0] - h.P[0], A[1] - h.P[1]) < 1e-6 ? B
      : Math.hypot(B[0] - h.P[0], B[1] - h.P[1]) < 1e-6 ? A : null;
    return !!from && sameAngle(rayOf([from[0] - h.P[0], from[1] - h.P[1]]).angle, r.angle);
  });
  if (wishRays.some((w) => w.name === '고른 선' && isCrease(w.ray))) {
    for (let i = wishRays.length - 1; i >= 0; i--) {
      if (wishRays[i]!.name === '고른 선' && !isCrease(wishRays[i]!.ray)) wishRays.splice(i, 1);
    }
  }
  // Asked for a line that misses the corner: nothing here uses it.
  if (wanted.length > 0 && wishRays.length === 0) return [];
  const usesWish = (rays: readonly Ray[]) => wishRays.length === 0
    || rays.some((r) => wishRays.some((w) => sameAngle(w.ray.angle, r.angle)));
  const bis = (p: Ray, q: Ray) => rayOf([p.dir[0] + q.dir[0], p.dir[1] + q.dir[1]]);
  const pool: Array<{ ray: Ray; name: string }> = [
    { ray: straight, name: '대각선' },
    { ray: Lb, name: '접는 선을 따라' },
    { ray: bis(hm, straight), name: '사이 선' },
    { ray: bis(hm, Lb), name: '사이 선' },
    { ray: bis(straight, hs), name: '사이 선' },
    ...wishRays,
  ].filter((c, i, all) => all.findIndex((d) => sameAngle(d.ray.angle, c.ray.angle)) === i
    && ![L, hm, hs].some((r) => sameAngle(r.angle, c.ray.angle)))
    /*
     * A line that runs where a crease is already pressed is that crease,
     * exactly: worked out from a line picked on screen it ran a hair beside
     * it, which split off a sliver of paper and no longer folded flat.
     */
    .map((c) => {
      const there = pressedRays.find((q) => sameAngle(q.angle, c.ray.angle));
      return there ? { ...c, ray: there } : c;
    });
  const kawasaki = (angles: number[]): boolean => {
    const g2 = [...angles].sort((x, y) => x - y);
    let alt = 0;
    for (let i = 0; i < g2.length; i += 2) alt += g2[i + 1]! - g2[i]!;
    return Math.abs(alt - Math.PI) < 0.004;
  };
  const extra = (angles: number[]): number[] => {
    // One more crease so the set folds flat: try it in every gap.
    const g2 = [...angles].sort((x, y) => x - y);
    const outX: number[] = [];
    for (let i = 0; i < g2.length; i++) {
      const lo = g2[i]!;
      const hi = i === g2.length - 1 ? g2[0]! + 2 * Math.PI : g2[i + 1]!;
      const altAt = (x: number) => {
        const all = [...g2, x].map((v) => (v - lo + 2 * Math.PI) % (2 * Math.PI)).sort((p, q) => p - q);
        let alt = 0;
        for (let k = 0; k < all.length; k += 2) alt += (all[k + 1] ?? 2 * Math.PI) - all[k]!;
        return alt;
      };
      const x0 = lo + 0.02; const x1 = hi - 0.02;
      if (x1 <= x0) continue;
      const f0 = altAt(x0) - Math.PI; const f1 = altAt(x1) - Math.PI;
      if (f0 * f1 > 0) continue;
      const x = x0 + (x1 - x0) * (f0 / (f0 - f1));
      if (Math.abs(altAt(x) - Math.PI) < 0.004) outX.push(x % (2 * Math.PI));
    }
    return outX;
  };
  interface Plan { closed: Ray[]; open: Ray[]; names: string[] }
  const plans: Plan[] = [];
  for (const joinOpen of [true, false]) {
    for (let mask = 0; mask < (1 << pool.length); mask++) {
      const chosen = pool.filter((_, i) => (mask >> i) & 1);
      if (chosen.length > 2) continue;
      const fixed = [L, hs, ...(joinOpen ? [] : [hm]), ...chosen.map((c) => c.ray)];
      const angles = fixed.map((r) => r.angle);
      const sets: Ray[][] = [];
      if (angles.length % 2 === 0 && kawasaki(angles)) sets.push([]);
      if (angles.length % 2 === 1) for (const x of extra(angles)) sets.push([rayOf([Math.cos(x), Math.sin(x)])]);
      for (const more of sets) {
        if (!usesWish([...chosen.map((c) => c.ray), ...more])) continue;
        plans.push({
          closed: [L, ...chosen.map((c) => c.ray), ...more],
          open: joinOpen ? [hm] : [],
          names: [...chosen.map((c) => c.name), ...(more.length ? ['새 선'] : []), ...(joinOpen ? ['붙은 모서리 펴짐'] : [])],
        });
      }
    }
  }

  const reach = Math.hypot(runOn(s, h.P, L.dir)[0] - h.P[0], runOn(s, h.P, L.dir)[1] - h.P[1]);
  const signature = (st: FoldedState) => {
    // Where a ring of points round the corner lands: two results that agree
    // on these are the same squash.
    const gg = st.graph;
    const bits: string[] = [];
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * 2 * Math.PI;
      const p: Vec2 = [h.P[0] + Math.cos(t) * 0.008, h.P[1] + Math.sin(t) * 0.008];
      const f = gg.faces_vertices.findIndex((loop) => inPoly(loop.map((x) => gg.vertices_coords[x]!), p));
      if (f < 0) { bits.push('-'); continue; }
      const q = affineApply(st.faces_matrix[f]!, p);
      bits.push(`${Math.round(q[0] * 2000)},${Math.round(q[1] * 2000)}`);
    }
    return bits.join('|');
  };
  const out: PocketOption[] = [];
  const seen = new Set<string>();
  /*
   * Small squashes first: creases that reach no further from the corner than
   * the fold line itself does. A fold line that ends a little way past the
   * corner - near the tip of a triangle already folded - made every squash
   * longer than it, and the fold was offered none at all and went ahead as if
   * nothing held the ply. Then any squash that lies flat is offered.
   */
  for (const small of [true, false]) {
    // A line asked for may reach far from the corner - the diagonal a squash
    // runs along usually does - so then the long ways are looked at as well.
    if (!small && out.length > 0 && wishRays.length === 0) break;
    for (const plan of plans) {
      const local = plan.closed.every((r) => {
        const e = runOn(s, h.P, r.dir);
        return Math.hypot(e[0] - h.P[0], e[1] - h.P[1]) <= reach * 1.05 + 1e-9;
      });
      if (small && !local) continue;
      if (!small && local) continue;
      // Each crease stopped at the first fold it meets, and carried on through it.
      for (const carried of [false, true]) {
        const lines: PocketLine[] = [
          ...plan.closed.flatMap((r) => (carried ? traceOn(s, h.P, r.dir, 'valley') : [seg(r, 'valley')])),
          ...plan.open.map((r) => seg(r, 'open')),
        ];
        if (carried && lines.length === plan.closed.length + plan.open.length) continue;
        const all = [...lines, ...lines.map(mir).filter((l): l is PocketLine => l !== null)];
        const r = collapsePattern(s, all);
        if (r.conflict || r.violations.length > 0) continue;
        const sig = signature(r.state);
        if (seen.has(sig)) continue;
        seen.add(sig);
        const n = out.length + 1;
        out.push({
          label: `방법 ${n}`,
          detail: [...plan.names, ...(carried ? ['접힌 곳 따라 이어짐'] : [])].join(' · ') || '접는 선만',
          lines: all, state: r.state,
          pressed: plan.closed.some((x) => pressedRays.some((q) => sameAngle(q.angle, x.angle))),
        });
      }
    }
  }
  /*
   * With the line to use named, paper squashed by hand closes as few creases
   * as it can: the ways that fold more than that are the same squash with an
   * extra pleat tucked in, which no hand made. Only the plainest are offered.
   */
  if (wishRays.length > 0 && out.length > 1) {
    const creases = (o: PocketOption) => o.lines.filter((l) => l.kind !== 'open').length;
    const least = Math.min(...out.map(creases));
    return out.filter((o) => creases(o) === least).map((o, i) => ({ ...o, label: `방법 ${i + 1}` }));
  }
  return out;
}
