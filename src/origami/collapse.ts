/**
 * Closing several creases at once.
 *
 * A simple fold takes one line and swings everything on one side of it. Most
 * of what origami books draw is not that: a squash, a rabbit ear, a reverse
 * fold, the collapse that turns a flat sheet into a base - in all of them
 * several creases close together and the paper has no choice about where it
 * goes. Done one line at a time the paper would have to tear, which is why the
 * sequence cannot be written as a run of simple folds.
 *
 * What makes it tractable is a fact about flat folded states: where a face
 * ends up depends only on WHICH CLOSED CREASES lie between it and the paper
 * you are holding, not on the order they were pressed in. Crossing a closed
 * crease reflects; crossing an open one changes nothing. So a folded state is
 * recovered from the set of closed creases alone - no replay of the folding
 * sequence, and no question of what happened first.
 *
 * Two useful things follow. The placement of a collapse is not a special case,
 * it is the same walk. And the walk itself tests flat-foldability: if a face
 * can be reached two ways and the two disagree, the paper is being asked to be
 * in two places, and the pattern does not fold flat there.
 */

import {
  affineApply, affineIdentity, affineInverse, affineMul, reflectionAbout,
} from '../geometry/fold.js';
import type { Affine } from '../geometry/fold.js';
import { addCreases, lineThroughPoints, faceAdjacency, faceArea } from './graph.js';
import type { EdgeAssignment, FoldGraph } from './graph.js';
import { faceOutline } from './folding.js';
import type { FoldedState, FoldSense } from './folding.js';
import { orderViolations } from './layers.js';
import { solveOrder } from './order.js';
import type { Vec2 } from '../geometry/math.js';

const EPS = 1e-7;

/** Is this edge closed - folded right over - in the given state? */
const isClosed = (graph: FoldGraph, edge: number): boolean =>
  graph.edges_assignment[edge] !== 'boundary'
  && Math.abs(graph.edges_foldAngle[edge] ?? 0) > Math.PI - 1e-6;

/** The reflection about an edge, in the sheet's own coordinates. */
function edgeReflection(graph: FoldGraph, edge: number): Affine {
  const [u, v] = graph.edges_vertices[edge]!;
  return reflectionAbout(lineThroughPoints(
    graph.vertices_coords[u]!, graph.vertices_coords[v]!));
}

const sameAffine = (a: Affine, b: Affine, tol = 1e-6): boolean =>
  a.every((v, i) => Math.abs(v - b[i]!) < tol);

export interface PlacementResult {
  readonly matrices: readonly Affine[];
  /** Faces that ended up somewhere other than where they started. */
  readonly moved: readonly boolean[];
  /** Set when the walk reached a face two ways and the two disagreed. */
  readonly conflict?: { readonly face: number };
}

/**
 * Where every face lies, given which creases are closed.
 *
 * Walked outward from one face across the shared edges. A closed crease
 * reflects the neighbour about itself; an open one leaves it alongside. The
 * reflection is written in sheet coordinates and composed on the right, which
 * is the same matrix as reflecting in the folded view and composing on the
 * left - and it means the walk never needs to know where anything is on
 * screen.
 */
export function placeFaces(
  graph: FoldGraph,
  closed: (edge: number) => boolean,
  anchor: number,
  was?: readonly Affine[],
): PlacementResult {
  const count = graph.faces_vertices.length;
  const matrices = new Array<Affine | null>(count).fill(null);
  const adjacency = faceAdjacency(graph);
  let conflict: { face: number } | undefined;

  matrices[anchor] = affineIdentity;
  const queue = [anchor];
  while (queue.length > 0) {
    const here = queue.shift()!;
    const from = matrices[here]!;
    for (const { face: there, edge } of adjacency.get(here) ?? []) {
      const next = closed(edge) ? affineMul(from, edgeReflection(graph, edge)) : from;
      const already = matrices[there];
      if (already) {
        if (!conflict && !sameAffine(already, next)) conflict = { face: there };
        continue;
      }
      matrices[there] = next;
      queue.push(there);
    }
  }

  // Paper that the walk could not reach is paper that is not attached; leave it
  // where it was rather than inventing a place for it.
  const out = matrices.map((m, i) => m ?? was?.[i] ?? affineIdentity);
  return {
    matrices: out,
    moved: out.map((m, i) => !was || !sameAffine(m, was[i]!)),
    conflict,
  };
}

export interface CollapseResult {
  readonly state: FoldedState;
  /** Empty when the result is a stacking paper can take. */
  readonly violations: readonly string[];
  /** Set when the pattern cannot fold flat with these creases closed. */
  readonly conflict?: string;
}

/**
 * Close a set of creases together and put the paper back in order.
 *
 * The senses do not move any paper - a flat fold lands in the same place
 * whichever way round it went - but they decide which side of the pile each
 * flap comes to rest on, so they are what the layer search is given to work
 * with.
 */
export function closeCreases(
  state: FoldedState,
  edges: readonly number[],
  sense: (edge: number) => FoldSense,
): CollapseResult {
  const graph = state.graph;
  const wanted = new Set(edges);
  const assignment = [...graph.edges_assignment];
  const angle = [...graph.edges_foldAngle];
  for (const e of wanted) {
    if (graph.edges_assignment[e] === 'boundary') continue;
    const s = sense(e);
    assignment[e] = s;
    angle[e] = s === 'valley' ? Math.PI : -Math.PI;
  }
  const folded: FoldGraph = {
    ...graph, edges_assignment: assignment, edges_foldAngle: angle,
  };

  // Anchor on the biggest piece of paper that is not moving: that is the part
  // a hand would be holding, and holding it still is what stops the view
  // swinging round behind the flap.
  const anchor = graph.faces_vertices
    .map((loop, i) => ({ i, area: Math.abs(faceArea(graph, loop)) }))
    .sort((a, b) => b.area - a.area)[0]!.i;

  const placed = placeFaces(
    folded, (e) => isClosed(folded, e), anchor, state.faces_matrix);

  const next: FoldedState = {
    graph: folded,
    faces_matrix: placed.matrices,
    faces_order: state.faces_order,
    faces_moved: placed.moved,
    faces_bent: state.faces_bent,
  };
  if (placed.conflict) {
    return {
      state: next,
      violations: [],
      conflict: `면 ${placed.conflict.face}이 두 자리에 동시에 놓입니다 — `
        + '이 크리스들로는 평평하게 접히지 않습니다.',
    };
  }

  const ordered = restackCollapse(next, placed.moved);
  return {
    state: ordered.state,
    violations: ordered.violations,
  };
}

/**
 * Find a stacking the paper can take, moving only what the collapse moved.
 *
 * A simple fold knows where its flap goes: over the top, or under. A collapse
 * does not - several flaps arrive at once and their order among themselves is
 * part of the answer. Trying every order is out of reach on a real model, but
 * the paper that stayed put keeps the order it had, so the search is only over
 * where the travelling block goes and which way round it is: a couple of dozen
 * candidates, each one put to the same taco/tortilla audit the rest of the app
 * uses. The first that the paper can take is taken.
 */
function restackCollapse(
  state: FoldedState,
  moved: readonly boolean[],
): { state: FoldedState; violations: string[] } {
  const order = state.faces_order.length === state.graph.faces_vertices.length
    ? state.faces_order
    : state.graph.faces_vertices.map((_, i) => i);
  const stayed = order.filter((f) => !moved[f]);
  const travelling = order.filter((f) => moved[f]);
  if (travelling.length === 0) return { state, violations: [] };

  const candidates: number[][] = [];
  for (const block of [travelling, [...travelling].reverse()]) {
    for (let at = 0; at <= stayed.length; at++) {
      candidates.push([...stayed.slice(0, at), ...block, ...stayed.slice(at)]);
    }
  }

  let best: { order: number[]; violations: string[] } | null = null;
  for (const faces_order of candidates) {
    const tried = { ...state, faces_order };
    const violations = orderViolations(tried).map((v) => v.detail);
    if (violations.length === 0) return { state: tried, violations: [] };
    if (!best || violations.length < best.violations.length) {
      best = { order: faces_order, violations };
    }
  }
  return { state: { ...state, faces_order: best!.order }, violations: best!.violations };
}

/**
 * The creases that meet at a point, which is what a collapse is asked for by.
 *
 * Pointing at the place where the lines cross is how the move is described out
 * loud - "push here and it goes" - so that is what the caller hands over.
 */
export function creasesAt(state: FoldedState, at: Vec2, tol = 1e-4): number[] {
  const graph = state.graph;
  let best = -1;
  let bestD = tol;
  graph.vertices_coords.forEach((p, i) => {
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best < 0) return [];
  const out: number[] = [];
  graph.edges_vertices.forEach(([u, v], e) => {
    if ((u === best || v === best) && graph.edges_assignment[e] !== 'boundary') out.push(e);
  });
  return out;
}

/** Where a vertex of the pattern has been carried to, on the face given. */
export function vertexInView(state: FoldedState, face: number, v: number): Vec2 {
  return affineApply(state.faces_matrix[face]!, state.graph.vertices_coords[v]!);
}

/** True when nothing of the outline moved, i.e. the collapse changed nothing. */
export function shapeUnchanged(a: FoldedState, b: FoldedState): boolean {
  if (a.graph.faces_vertices.length !== b.graph.faces_vertices.length) return false;
  return a.graph.faces_vertices.every((_, f) => {
    const pa = faceOutline(a, f);
    const pb = faceOutline(b, f);
    return pa.every((p, i) => Math.hypot(p[0] - pb[i]![0], p[1] - pb[i]![1]) < EPS);
  });
}

/**
 * Collapse where the finger is pointing.
 *
 * The move is described out loud by pointing - "push here and it goes" - so
 * that is what this takes: a place on the model. The creases that meet there
 * are the ones that close.
 *
 * Which sense each one takes is searched rather than reasoned out. It costs
 * nothing to search, because a sense moves no paper: a flat fold lands in the
 * same place whichever way it went round, so the assignment only decides how
 * the flaps come to rest on each other. That makes the layer audit the judge,
 * and an assignment it passes is one the hand can make.
 */
export function collapseAtPoint(
  state: FoldedState,
  at: Vec2,
  tol = 4e-3,
): CollapseResult & { readonly creases: number } {
  // The click is in the folded view; the creases are in the sheet. Every face
  // lying under the pointer offers its own reading of where that is on paper.
  const candidates: Vec2[] = [];
  state.graph.faces_vertices.forEach((_, f) => {
    const poly = faceOutline(state, f);
    if (pointInPolygon(poly, at, tol)) {
      candidates.push(affineApply(affineInverse(state.faces_matrix[f]!), at));
    }
  });
  if (candidates.length === 0) candidates.push(at);

  let edges: number[] = [];
  for (const p of candidates) {
    const found = creasesAt(state, p, tol);
    if (found.length > edges.length) edges = found;
  }
  if (edges.length < 3) {
    return {
      state,
      violations: [],
      conflict: edges.length === 0
        ? '여기에는 모을 크리스가 없습니다.'
        : `크리스가 ${edges.length}개뿐입니다 — 모으려면 셋 이상이 만나야 합니다.`,
      creases: edges.length,
    };
  }
  if (edges.length > 12) {
    return {
      state,
      violations: [],
      conflict: `크리스가 ${edges.length}개 만납니다 — 너무 많아 한 번에 모을 수 없습니다.`,
      creases: edges.length,
    };
  }

  let best: CollapseResult | null = null;
  let flatFoldable = false;
  for (let mask = 0; mask < (1 << edges.length); mask++) {
    const r = closeCreases(state, edges,
      (e) => (((mask >> edges.indexOf(e)) & 1) ? 'mountain' : 'valley'));
    if (r.conflict) continue;
    flatFoldable = true;
    // An assignment that changes nothing is not the move that was asked for.
    if (shapeUnchanged(state, r.state)) continue;
    if (r.violations.length === 0) return { ...r, creases: edges.length };
    if (!best || r.violations.length < best.violations.length) best = r;
  }
  if (best) return { ...best, creases: edges.length };
  return {
    state,
    violations: [],
    conflict: flatFoldable
      ? '이 크리스들을 모아도 종이가 움직이지 않습니다.'
      : '이 크리스들로는 평평하게 접히지 않습니다 — 각이 맞지 않습니다.',
    creases: edges.length,
  };
}

/** A crease line through a point of the folded view, and how far it runs. */
export interface LineThrough {
  /** Unit direction, in the folded view. */
  readonly dir: Vec2;
  /** The ends of its run through the point, for drawing and for pointing at. */
  readonly a: Vec2;
  readonly b: Vec2;
}

/**
 * The crease lines that pass through a point, as a hand would see them.
 *
 * One entry per line, however many plies and edges it is made of - which is
 * what someone choosing which lines to leave open is choosing between.
 */
export function linesThrough(state: FoldedState, at: Vec2, tol = 1e-5): LineThrough[] {
  const graph = state.graph;
  const faceOfEdge = new Map<number, number>();
  for (const [face, links] of faceAdjacency(graph)) {
    for (const { edge } of links) if (!faceOfEdge.has(edge)) faceOfEdge.set(edge, face);
  }
  const segs: Array<[Vec2, Vec2]> = [];
  graph.edges_vertices.forEach(([u, v], edge) => {
    const face = faceOfEdge.get(edge);
    if (face === undefined || graph.edges_assignment[edge] === 'boundary') return;
    segs.push([vertexInView(state, face, u), vertexInView(state, face, v)]);
  });
  const out: Array<{ dir: Vec2; lo: number; hi: number }> = [];
  for (const [p, q] of segs) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < tol) continue;
    const dir: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const along = (at[0] - p[0]) * dir[0] + (at[1] - p[1]) * dir[1];
    const off = Math.abs((at[0] - p[0]) * dir[1] - (at[1] - p[1]) * dir[0]);
    if (off > tol || along < -tol || along > len + tol) continue;
    if (out.some((d) => Math.abs(d.dir[0] * dir[1] - d.dir[1] * dir[0]) < 1e-6)) continue;
    out.push({ dir, lo: 0, hi: 0 });
  }
  // How far each runs through the point, over every ply it is pressed into.
  for (const line of out) {
    const runs = segs.flatMap(([p, q]) => {
      const offP = Math.abs((p[0] - at[0]) * line.dir[1] - (p[1] - at[1]) * line.dir[0]);
      const offQ = Math.abs((q[0] - at[0]) * line.dir[1] - (q[1] - at[1]) * line.dir[0]);
      if (offP > tol || offQ > tol) return [];
      const tp = (p[0] - at[0]) * line.dir[0] + (p[1] - at[1]) * line.dir[1];
      const tq = (q[0] - at[0]) * line.dir[0] + (q[1] - at[1]) * line.dir[1];
      return [[Math.min(tp, tq), Math.max(tp, tq)] as const];
    });
    for (let grew = true; grew;) {
      grew = false;
      for (const [lo, hi] of runs) {
        if (hi < line.lo - tol || lo > line.hi + tol) continue;
        if (lo < line.lo - tol || hi > line.hi + tol) {
          line.lo = Math.min(line.lo, lo);
          line.hi = Math.max(line.hi, hi);
          grew = true;
        }
      }
    }
  }
  return out.map(({ dir, lo, hi }) => ({
    dir,
    a: [at[0] + dir[0] * lo, at[1] + dir[1] * lo],
    b: [at[0] + dir[0] * hi, at[1] + dir[1] * hi],
  }));
}

/**
 * Which lines to leave open for a collapse to go through, found by trying.
 *
 * Every way of leaving some of the lines through the point open is folded,
 * fewest open first, and the ones the paper takes - flat, without passing
 * through itself, and actually moving something - are handed back. A
 * waterbomb has two: leave the line across open, or the line along. Which is
 * meant is the folder's call, so both are offered rather than one chosen.
 */
export function openingsThatFold(
  state: FoldedState,
  at: Vec2,
  lines: readonly LineThrough[] = linesThrough(state, at),
  limit = 4,
): boolean[][] {
  const found: boolean[][] = [];
  const n = lines.length;
  if (n < 3 || n > 6) return found;
  const masks = Array.from({ length: (1 << n) - 1 }, (_, m) => m + 1)
    .filter((m) => n - bitCount(m) >= 2)
    .sort((a, b) => bitCount(a) - bitCount(b) || a - b);
  for (const mask of masks) {
    const open = lines.map((_, i) => ((mask >> i) & 1) === 1);
    const r = collapseAlong(state, at, openPoints(at, lines, open));
    if (r.conflict || r.violations.length > 0) continue;
    found.push(open);
    if (found.length >= limit) break;
  }
  return found;
}

/** A point on each line to be left open, which is how `collapseAlong` names them. */
export function openPoints(at: Vec2, lines: readonly LineThrough[], open: readonly boolean[]): Vec2[] {
  return lines.flatMap((line, i) => {
    if (!open[i]) return [];
    const far = Math.hypot(line.b[0] - at[0], line.b[1] - at[1]) >= Math.hypot(line.a[0] - at[0], line.a[1] - at[1])
      ? line.b : line.a;
    return [far];
  });
}

const bitCount = (m: number) => { let c = 0; for (let x = m; x; x >>= 1) c += x & 1; return c; };

/**
 * Collapse along the creases through a point, leaving the ones named open.
 *
 * The collapse above closes every crease that meets at one vertex of one ply,
 * and that is the right move for a base folded from a flat sheet. Two things
 * stop it being the move a book draws on a model that is already folded.
 *
 * Not every crease through the point closes. A waterbomb collapse pushes the
 * ends of one line in and folds the diagonals, and the line across the other
 * way stays exactly as it was - the Triangle's middle line is not folded until
 * step ten. Closing it anyway asks for a different base, and the answer that
 * came back was that the angles do not close.
 *
 * And the crease runs through every ply, not just one. On a model several
 * sheets thick the point being pushed is a vertex of some plies and the middle
 * of a face on others; closing only the edges of one ply's vertex leaves the
 * same crease open on the ply beneath it, and the walk finds the paper asked
 * to be in two places. So each line is closed along its whole run through the
 * point, on every ply it was pressed into.
 */
export function collapseAlong(
  state: FoldedState,
  at: Vec2,
  /** Points on creases through `at` - in the folded view - that stay open. */
  open: readonly Vec2[] = [],
  tol = 1e-5,
): CollapseResult & { readonly creases: number } {
  const graph = state.graph;
  const adjacency = faceAdjacency(graph);
  // One face per edge is enough to see where it lies: a crease sits on the
  // reflection line between its two faces, so both put it in the same place.
  const faceOfEdge = new Map<number, number>();
  for (const [face, links] of adjacency) {
    for (const { edge } of links) if (!faceOfEdge.has(edge)) faceOfEdge.set(edge, face);
  }
  const seen = (edge: number): [Vec2, Vec2] | null => {
    const face = faceOfEdge.get(edge);
    if (face === undefined || graph.edges_assignment[edge] === 'boundary') return null;
    const [u, v] = graph.edges_vertices[edge]!;
    return [vertexInView(state, face, u), vertexInView(state, face, v)];
  };

  // The directions of the creases that pass through the point, one per line.
  const directions: Vec2[] = [];
  graph.edges_vertices.forEach((_, edge) => {
    const seg = seen(edge);
    if (!seg) return;
    const [p, q] = seg;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < tol) return;
    const dir: Vec2 = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
    const along = (at[0] - p[0]) * dir[0] + (at[1] - p[1]) * dir[1];
    const off = Math.abs((at[0] - p[0]) * dir[1] - (at[1] - p[1]) * dir[0]);
    if (off > tol || along < -tol || along > len + tol) return;
    if (!directions.some((d) => Math.abs(d[0] * dir[1] - d[1] * dir[0]) < 1e-6)) {
      directions.push(dir);
    }
  });

  const offLine = (dir: Vec2, p: Vec2) =>
    Math.abs((p[0] - at[0]) * dir[1] - (p[1] - at[1]) * dir[0]);
  const closing = directions.filter((dir) => !open.some((p) => offLine(dir, p) < 1e-4));
  if (closing.length < 2) {
    return {
      state,
      violations: [],
      conflict: directions.length === 0
        ? '여기에는 모을 크리스가 없습니다.'
        : `닫을 선이 ${closing.length}개뿐입니다 — 모으려면 둘 이상이어야 합니다.`,
      creases: closing.length,
    };
  }

  /*
   * Each line's whole run through the point, on every ply.
   *
   * Only the run that actually reaches the point: the same line may cross the
   * model again somewhere unconnected, and a crease pressed there belongs to
   * some other move.
   */
  const edges: number[] = [];
  for (const dir of closing) {
    const on: Array<{ edge: number; lo: number; hi: number }> = [];
    graph.edges_vertices.forEach((_, edge) => {
      const seg = seen(edge);
      if (!seg) return;
      const [p, q] = seg;
      if (offLine(dir, p) > tol || offLine(dir, q) > tol) return;
      const tp = (p[0] - at[0]) * dir[0] + (p[1] - at[1]) * dir[1];
      const tq = (q[0] - at[0]) * dir[0] + (q[1] - at[1]) * dir[1];
      on.push({ edge, lo: Math.min(tp, tq), hi: Math.max(tp, tq) });
    });
    let lo = 0;
    let hi = 0;
    for (let grew = true; grew;) {
      grew = false;
      for (const run of on) {
        if (run.hi < lo - tol || run.lo > hi + tol) continue;
        if (run.lo < lo - tol || run.hi > hi + tol) {
          lo = Math.min(lo, run.lo);
          hi = Math.max(hi, run.hi);
          grew = true;
        }
      }
    }
    for (const run of on) if (run.lo >= lo - tol && run.hi <= hi + tol) edges.push(run.edge);
  }

  // A sense moves no paper, so it is not searched here; the layer order is.
  const closed = closeCreases(state, edges, () => 'valley');
  if (closed.conflict) return { ...closed, creases: closing.length };
  if (shapeUnchanged(state, closed.state)) {
    return {
      state,
      violations: [],
      conflict: '이 크리스들을 모아도 종이가 움직이지 않습니다.',
      creases: closing.length,
    };
  }
  /*
   * The pile the paper actually makes, tried before any other.
   *
   * Passing the layer audit is not the same as being the pile. Paper that the
   * collapse never laid across other paper is free to go either side of it as
   * far as the audit can tell, and the first order found for the Triangle's
   * waterbomb put the tucked-in side flaps ON TOP of the nose - legal, and
   * wrong: the next step folds the nose's point forward, and through flaps
   * that were never there it could not go. No order after that one was any
   * good, because the damage was in the pile it had been handed.
   *
   * The real pile follows the paper's own path: the part that stayed where it
   * was, then each part reached across one more of the creases just closed,
   * laid on the one before - a zigzag, which is what a collapse is.
   */
  for (const order of zigzagOrders(closed.state, new Set(edges), state.faces_order)) {
    const tried = { ...closed.state, faces_order: order };
    if (orderViolations(tried).length === 0) {
      return { state: tried, violations: [], creases: closing.length };
    }
  }
  if (closed.violations.length === 0) return { ...closed, creases: closing.length };
  const settled = settleOrder(closed.state);
  return { state: settled.state, violations: settled.violations, creases: closing.length };
}

/**
 * Stack a collapse the way the paper goes: one fold further, one layer higher.
 *
 * Every face is given the number of just-closed creases between it and the
 * paper that did not move. Those at the same count lie together; each count is
 * laid on the one before, and a layer reached across an odd number of them has
 * been turned over, so its own plies come in the reverse of the order they
 * had. Folded towards you the layers climb; folded away they go under - both
 * are offered, towards you first, because a flap pushed in and turned over is
 * shown on top in the drawings.
 */
function zigzagOrders(
  state: FoldedState,
  closedNow: ReadonlySet<number>,
  before: readonly number[],
): number[][] {
  const graph = state.graph;
  const count = graph.faces_vertices.length;
  const adjacency = faceAdjacency(graph);
  const moved = state.faces_moved ?? [];
  const depth = new Array<number>(count).fill(Infinity);
  const queue: number[] = [];
  for (let f = 0; f < count; f++) if (!moved[f]) { depth[f] = 0; queue.push(f); }
  // Crossing a crease closed by this collapse costs one; anything else, none.
  while (queue.length > 0) {
    const here = queue.shift()!;
    for (const { face: there, edge } of adjacency.get(here) ?? []) {
      const step = closedNow.has(edge) ? 1 : 0;
      if (depth[here]! + step >= depth[there]!) continue;
      depth[there] = depth[here]! + step;
      if (step === 0) queue.unshift(there); else queue.push(there);
    }
  }
  const layers = new Map<number, number[]>();
  const known = before.length === count ? before : graph.faces_vertices.map((_, f) => f);
  for (const face of known) {
    const d = Number.isFinite(depth[face]!) ? depth[face]! : 0;
    const list = layers.get(d);
    if (list) list.push(face); else layers.set(d, [face]);
  }
  const counts = [...layers.keys()].sort((a, b) => a - b);
  const laid = (d: number) => (d % 2 === 1 ? [...layers.get(d)!].reverse() : layers.get(d)!);
  const towards = counts.flatMap(laid);
  const away = [...counts].reverse().flatMap(laid);
  return [towards, away];
}

/**
 * Find a stacking that the first guess got wrong, starting from several places.
 *
 * The search in `order.ts` starts from the order it is handed and keeps it
 * wherever nothing forces otherwise, which is what keeps paper that never
 * meets from being shuffled. After a collapse, or a fold of one flap out of a
 * pile that a collapse interleaved, the order it is handed is a guess made
 * one move at a time, and from there it can get stuck: the Triangle's waterbomb
 * came back with no answer at all, while the same search started from other
 * orders finds one with nothing wrong. So it is started again from a handful
 * of others - the same handful every time, because a replay that came out
 * differently on a second run would not be a replay.
 */
export function settleOrder(
  state: FoldedState,
): { state: FoldedState; violations: string[] } {
  const base = [...state.faces_order];
  let seed = 0x2545f491;
  // A fixed sequence, not a random one: the same starts, in the same order.
  const next = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };
  const starts: number[][] = [base, [...base].reverse()];
  for (let i = 0; i < 62; i++) {
    const shuffled = [...base];
    for (let k = shuffled.length - 1; k > 0; k--) {
      const j = Math.floor(next() * (k + 1));
      [shuffled[k], shuffled[j]] = [shuffled[j]!, shuffled[k]!];
    }
    starts.push(shuffled);
  }
  let best: { order: readonly number[]; violations: string[] } | null = null;
  /*
   * A budget over all the starts together. Where no order exists - a pile
   * made impossible some steps back - every start ran to its own limit, and
   * sixty-four of them held the screen for twenty seconds on each replay only
   * to say the same thing. Counted in search steps, not seconds, so a replay
   * still comes out the same on every machine.
   */
  let budget = 400_000;
  for (const start of starts) {
    if (budget <= 0) break;
    const tried = { ...state, faces_order: start };
    const found = solveOrder(tried, { maxSteps: Math.min(50_000, budget) });
    budget -= Math.max(1, found.steps);
    const order = found.order ?? start;
    const violations = orderViolations({ ...state, faces_order: order }).map((v) => v.detail);
    if (violations.length === 0) return { state: { ...state, faces_order: order }, violations };
    if (!best || violations.length < best.violations.length) best = { order, violations };
  }
  return { state: { ...state, faces_order: best!.order }, violations: best!.violations };
}

/** Inside the outline, or close enough to its edge to count. */
function pointInPolygon(poly: readonly Vec2[], p: Vec2, tol: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2))
      : 0;
    if (Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)) <= tol) return true;
  }
  return false;
}

/**
 * Fold to a crease pattern: press these lines on the sheet, let out the ones
 * marked open, and put the paper where all the closed creases together say.
 *
 * The lines are in sheet coordinates - a drawing of the unfolded paper, which
 * is how crease patterns are shared. Each one creases only the paper it runs
 * across, so a line that stops at a corner stops there. Placement is the same
 * walk every collapse uses; the pile is kept where it can be and searched for
 * where it cannot, and a pattern that cannot lie flat or cannot be stacked
 * says so rather than tearing or passing through itself.
 */
/**
 * How near a squash line has to come to a face's edge to lie on it, m: the
 * rounding of the arithmetic, no more. Taken wider it caught a line from a
 * corner a fiftieth of a millimetre off a crease, which then was neither
 * split off nor folded on.
 */
const ON_EDGE = 1e-7;

export function collapsePattern(
  state: FoldedState,
  given: readonly { readonly a: Vec2; readonly b: Vec2; readonly kind: 'mountain' | 'valley' | 'open' }[],
): CollapseResult {
  /*
   * Ends that fall within a thousandth of a millimetre of a corner of the
   * pattern are that corner: a line run out to the next crease by stepping
   * along it stops a hair short or long, and a line meant to lie on a crease
   * already there then ran a hair beside it.
   */
  const corner = (p: Vec2): Vec2 => state.graph.vertices_coords.find((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6) ?? p;
  const lines = given.map((l) => ({ ...l, a: corner(l.a), b: corner(l.b) }));
  let graph = state.graph;
  let matrices = [...state.faces_matrix];
  let order = state.faces_order.length === graph.faces_vertices.length
    ? [...state.faces_order] : graph.faces_vertices.map((_, i) => i);
  let bent = state.faces_bent ? [...state.faces_bent] : undefined;
  /*
   * The line runs through the face's paper - not merely along its edge. A
   * line laid exactly on a crease already there (a squash along a line
   * pressed before) touches the faces on both sides of it, and splitting a
   * face along its own edge left a face of no area that the walk could not
   * place, so the squash read as one that cannot lie flat.
   */
  const crosses = (g: FoldGraph, f: number, a: Vec2, b: Vec2): boolean => {
    const poly = g.faces_vertices[f]!.map((v) => g.vertices_coords[v]!);
    const offEdges = (p: Vec2) => poly.every((u, i) => {
      const w = poly[(i + 1) % poly.length]!;
      const vx = w[0] - u[0]; const vy = w[1] - u[1];
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - u[0]) * vx + (p[1] - u[1]) * vy) / len2)) : 0;
      return Math.hypot(p[0] - u[0] - t * vx, p[1] - u[1] - t * vy) > ON_EDGE;
    });
    for (let i = 1; i < 64; i++) {
      const t = i / 64;
      const p: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
      if (pointInPolygon(poly, p, -1e-9) && offEdges(p)) return true;
    }
    return false;
  };
  for (const l of lines) {
    const line = lineThroughPoints(l.a, l.b);
    const g = graph;
    const res = addCreases(g, (f) => (crosses(g, f, l.a, l.b) ? line : null), 'flat', 0);
    const children = new Map<number, number[]>();
    res.faces_source.forEach((f, i) => {
      const list = children.get(f);
      if (list) list.push(i); else children.set(f, [i]);
    });
    matrices = res.faces_source.map((f) => matrices[f]!);
    if (bent) bent = res.faces_source.map((f) => bent![f] ?? false) as typeof bent;
    order = order.flatMap((f) => children.get(f) ?? []);
    graph = res.graph;
  }

  const onLine = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) < 2e-6;
  };
  const assignment = [...graph.edges_assignment] as EdgeAssignment[];
  const angle = [...graph.edges_foldAngle];
  graph.edges_vertices.forEach(([u, v], e) => {
    if (assignment[e] === 'boundary') return;
    const p = graph.vertices_coords[u]!;
    const q = graph.vertices_coords[v]!;
    for (const l of lines) {
      if (!onLine(p, l.a, l.b) || !onLine(q, l.a, l.b)) continue;
      assignment[e] = l.kind === 'open' ? 'flat' : l.kind;
      angle[e] = l.kind === 'valley' ? Math.PI : l.kind === 'mountain' ? -Math.PI : 0;
    }
  });
  const folded: FoldGraph = { ...graph, edges_assignment: assignment, edges_foldAngle: angle };
  const anchor = folded.faces_vertices
    .map((loop, i) => ({ i, area: Math.abs(faceArea(folded, loop)) }))
    .sort((a, b) => b.area - a.area)[0]!.i;
  const walked = placeFaces(folded, (e) => isClosed(folded, e), anchor);
  // The walk starts the held piece at rest; it stays where it was instead,
  // turned over if the model had been turned over.
  const held = matrices[anchor]!;
  const placedMatrices = walked.matrices.map((m) => affineMul(held, m));
  const placed = {
    ...walked,
    matrices: placedMatrices,
    moved: placedMatrices.map((m, i) => !sameAffine(m, matrices[i]!)),
  };
  let next: FoldedState = {
    graph: folded, faces_matrix: placed.matrices, faces_order: order,
    faces_moved: placed.moved, faces_bent: bent ?? state.faces_bent,
  };
  if (placed.conflict) {
    return { state: next, violations: [], conflict: '이 선들로는 평평하게 접히지 않습니다.' };
  }
  let bad = orderViolations(next);
  if (bad.length > 0) {
    const found = solveOrder(next, { maxSteps: 1_500_000 });
    if (found.order) {
      const tried = { ...next, faces_order: found.order };
      const left = orderViolations(tried);
      if (left.length < bad.length) { next = tried; bad = left; }
    }
  }
  if (bad.length > 0) {
    const settled = settleOrder(next);
    if (settled.violations.length < bad.length) { next = settled.state; bad = orderViolations(next); }
  }
  return { state: next, violations: bad.map((v) => v.detail) };
}

