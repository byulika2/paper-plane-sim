/**
 * A fold session is a script, not a shape.
 *
 * Every state is the sheet replayed through an ordered list of steps, which
 * makes undo, step scrubbing and export fall out for free - and the script is
 * exactly what a crease-pattern exporter needs.
 */

import {
  affineApply,
  affineInverse,
  affineMul,
  affineIsMirrored,
  clipHalfPlane,
  flipLine,
  layerOutline,
  lineThrough,
  lineToLocal,
  modelBounds,
  plyFilter,
  pointInPolygon,
  signedDistance,
  totalArea,
} from '../geometry/fold.js';
import type { Affine, FoldModel, FoldSense, Layer, PlySelection } from '../geometry/fold.js';
import { faceOutline, flatSheet, flipOver, foldThroughPoints as graphFold, pressSheetCreases } from '../origami/folding.js';
import { orderViolations } from '../origami/layers.js';
import { solveOrder } from '../origami/order.js';
import { collapseAlong, collapseAtPoint, collapsePattern, settleOrder } from '../origami/collapse.js';
import { pliesAtLine } from '../origami/pocket.js';
import { faceAdjacency } from '../origami/graph.js';
import { pliesTogether, plyDepth, restingPose, spatialBounds } from '../origami/space.js';
import type { OrderViolation } from '../origami/layers.js';
import type { FoldedState } from '../origami/folding.js';
import {
  creasesInView, dedupeDimensions, dimensionsInView,
  segmentKey, traceCrease, traceDimension,
} from '../geometry/crease.js';
import type { Dimension, TaggedCrease, ViewCrease, ViewDimension } from '../geometry/crease.js';

import { applyRigid } from '../geometry/math.js';
import type { Vec2 } from '../geometry/math.js';
import { buildAirframe } from '../aero/airframe.js';
import type { RenderFace } from '../origami/space.js';
// Aliased: `Pick` is also a TypeScript built-in, used further down this file.
import type { Pick as AlignPick, Segment } from '../geometry/constructions.js';
import type { PaperProps } from '../paper/stock.js';

export interface FoldStep {
  readonly kind: 'fold';
  readonly a: Vec2;
  readonly b: Vec2;
  /** Any point on the half-plane that swings over. */
  readonly movingSide: Vec2;
  readonly sense: FoldSense;
  /**
   * Press the crease and open the sheet back up, leaving only a reference line.
   * This is not undo: the mark stays, the shape change does not.
   */
  readonly creaseOnly: boolean;
  readonly label: string;
  /**
   * How far the flap closes, in degrees. 180 lays it flat, which is what the
   * crease-pattern view always draws; anything less only shows up in 3D.
   */
  readonly angleDeg?: number;
  /**
   * Which plies travel with the fold. Leaving it out carries the whole stack,
   * which is what an ordinary fold does; naming the top or bottom few is what
   * makes a squash or a reverse fold possible.
   */
  readonly plies?: PlySelection;
  /** Tuck the paper inside, under what lay over it, rather than on top - a lock. */
  readonly tuck?: boolean;
  /** A reverse fold of a flap folded in half: in between the halves, or round them. */
  readonly reverse?: 'inside' | 'outside';
  /** Made as one of a pleat's two folds, so its line is drawn as a pleat. */
  readonly pleat?: boolean;
  /**
   * Also make the mirror of this fold about the sheet's centre line.
   *
   * Aeroplanes are symmetric, so almost every crease is made twice - once on
   * each side. Saying it once halves the script and keeps the two halves from
   * drifting apart when a dimension is edited later.
   */
  readonly symmetric?: boolean;
  /** Steps laid down by one macro share an id, so undo takes them back together. */
  readonly group?: number;
  /**
   * This fold was made and then opened out again.
   *
   * Not the same as a crease pressed on purpose as a reference line, even
   * though both leave the paper flat with a mark on it. Telling them apart is
   * what lets "다시접기" close the one you just opened without also closing the
   * guides you deliberately left open.
   */
  readonly unfolded?: boolean;
  /**
   * When it was opened, counted up across the script: the most recent is the
   * one 다시접기 closes, as hands close the last fold they opened first.
   */
  readonly unfoldedAt?: number;
  /**
   * The crease's pieces on the sheet, fixed when a fold made before it was
   * opened. A crease pressed through folded paper is recorded as a line in the
   * view it was made in; replayed after the paper beneath has been opened, that
   * line falls somewhere else. Pinned here, it stays where the paper has it.
   */
  readonly pinned?: readonly Segment[];
}

/**
 * A measured span drawn on the paper, the way a drawing carries a dimension.
 * It changes nothing about the shape; it records a distance and leaves two
 * reference points behind to fold to.
 */
export interface DimensionStep {
  readonly kind: 'dimension';
  readonly a: Vec2;
  readonly b: Vec2;
  readonly label: string;
  readonly group?: number;
}

/**
 * Turning the model over.
 *
 * Not a fold - nothing about the paper changes - but it belongs in the script,
 * because every fold after it is made from the other side and would come out
 * the wrong way round if the script were replayed without it.
 */
export interface FlipStep {
  readonly kind: 'flip';
  readonly label: string;
  readonly group?: number;
}

/**
 * Creases already on the paper, closed all at once.
 *
 * A squash, a rabbit ear, a reverse fold, the collapse that starts a base -
 * none of them is a run of simple folds, because the creases have to close
 * together or the paper would have to tear. So this step says only WHERE: the
 * place the lines meet. Which lines close follows from the pattern, and which
 * way each one goes is searched for rather than asked about, because a sense
 * moves no paper - it only decides how the flaps come to rest on each other.
 */
export interface CollapseStep {
  readonly kind: 'collapse';
  /** Where the creases meet, in the folded view as it stood when pointed at. */
  readonly at: Vec2;
  readonly label: string;
  readonly group?: number;
  /**
   * Creases through `at` that stay open, each named by a point on it.
   *
   * Leaving it out closes every crease that meets there, which is a base
   * collapsed from a flat sheet. Naming any makes it the partial kind - the
   * waterbomb that pushes one line's ends in and leaves the line across it
   * alone - and closes each of the rest along its whole run, on every ply.
   */
  readonly open?: readonly Vec2[];
  /**
   * The lines themselves, drawn on the unfolded sheet.
   *
   * For the moves a finger cannot name by one point: a swivel that turns a
   * flap about a corner and pleats the layers it drags past, a lock tucked
   * through a roll. Each line is where the paper creases and which way, or
   * `open` for a crease that is let out flat again - exactly what a crease
   * pattern drawing shows, so a move read off a pattern is written as it is
   * drawn. Given, they replace the pointing: the paper lands wherever these
   * lines, together with every crease already closed, put it.
   */
  readonly lines?: readonly PatternLine[];
}

export interface PatternLine {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly kind: 'mountain' | 'valley' | 'open';
}

export type Step = FoldStep | DimensionStep | FlipStep | CollapseStep;

export const isFold = (s: Step): s is FoldStep => s.kind === 'fold';

export interface SessionState {
  /** The crease pattern and where each face has been carried to. */
  readonly state: FoldedState;
  /**
   * The same thing in the shape the drawing code already speaks: one entry per
   * face, bottom of the pile first, each with its outline on the paper and the
   * transform that carries it to the folded view.
   */
  readonly model: FoldModel;
  /** Marks in original sheet coordinates, each tagged with the step that made it. */
  readonly creases: readonly TaggedCrease[];
  /** Every piece of crease each step pressed, on the sheet, by step. */
  readonly stepCreases: readonly (readonly Segment[])[];
  /** The same marks brought into the current folded view. */
  readonly viewCreases: readonly ViewCrease[];
  /** Measured spans in original sheet coordinates. */
  readonly dimensions: readonly Dimension[];
  readonly viewDimensions: readonly ViewDimension[];
  /**
   * Places where the stack asks the paper to pass through itself.
   *
   * Paper does not cut, and it does not thread through a fold that is already
   * closed. A step that produces one of these is a step that cannot be made by
   * hand, however reasonable it looks on screen.
   */
  readonly impossible: readonly OrderViolation[];
  /** The first step that made the model impossible, or -1 if none did. */
  readonly blockedAt: number;
  /**
   * How many plies each step bends at once, by step; nought for anything that
   * is not a fold.
   *
   * This is what makes a step hard by hand: pressing one crease through a
   * thick pile. How much paper ends up stacked somewhere is not - a finished
   * nose is two dozen plies deep on every aeroplane in the book, and a warning
   * about that was shown for every one of them, so it warned about nothing.
   */
  readonly bent: readonly number[];
  /** For each fold, what it carried over: its share of the paper, and how many plies deep that lay on average. */
  readonly carried: readonly Carried[];
}

/**
 * Present the folded state as a stack of plies.
 *
 * The drawing, snapping and dimension code all speak in terms of an outline on
 * the paper plus a transform onto the view, which is exactly what a face is.
 * Handing them the faces in stacking order lets all of it carry over unchanged.
 */
function asModel(state: FoldedState, width: number, height: number): FoldModel {
  const layers: Layer[] = state.faces_order.map((face) => ({
    outline: state.graph.faces_vertices[face]!.map((v) => state.graph.vertices_coords[v]!),
    xf: state.faces_matrix[face]!,
    mirrored: state.faces_matrix[face]![0] * state.faces_matrix[face]![3]
      - state.faces_matrix[face]![1] * state.faces_matrix[face]![2] < 0,
  }));
  // Faces are joined through shared edges in the graph, so nothing here can
  // come apart; the flag only existed to detect that in the old model.
  return { layers, joined: layers.slice(1).map(() => false), width, height };
}

/**
 * Turn "the top two plies" into a test on faces.
 *
 * In the graph model the stack is the face order, so the top of the pile is the
 * end of that list. Naming faces rather than plies is what lets a squash or a
 * reverse fold move part of the paper without the rest - and unlike the old
 * model, nothing can be torn off by doing so, because the faces stay joined
 * through their shared edges either way.
 */
function facesAllowed(
  selection: PlySelection | undefined,
): ((face: number, state: FoldedState) => boolean) | undefined {
  if (!selection || selection.kind === 'all') return undefined;
  /*
   * One side of the packet, named by which way up its paper is.
   *
   * This is what a wing is: fold a model in half and the paper that travelled
   * is turned over while the paper that stayed is not, and those two groups
   * are the two sides. Counting from the top of the pile only names that group
   * while it happens to be contiguous - and the moment the first wing divides
   * the pile it is not, so the second wing took the wrong paper and the two
   * came out showing opposite faces.
   */
  if (selection.kind === 'side') {
    return (face, state) =>
      affineIsMirrored(state.faces_matrix[face]!) === selection.turned;
  }
  /*
   * A piece is not a filter on which faces get creased - every face the line
   * crosses is creased, as a real crease would be - but on which of them
   * travel afterwards. The fold itself works that out from the point, so
   * nothing is restricted here.
   */
  if (selection.kind === 'piece' || selection.kind === 'half' || selection.kind === 'stack'
    || selection.kind === 'wing') return undefined;
  return (face, state) => {
    const order = state.faces_order;
    const n = Math.max(0, Math.min(order.length, Math.round(selection.count)));
    const chosen = selection.kind === 'top'
      ? order.slice(order.length - n)
      : order.slice(0, n);
    return chosen.includes(face);
  };
}

/** Whether a traced crease lies along an edge of the paper that is folded. */
function onFoldEdge(state: FoldedState, seg: { a: Vec2; b: Vec2 }): boolean {
  const m: Vec2 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
  const { graph } = state;
  return graph.edges_vertices.some(([u, v], e) => {
    const kind = graph.edges_assignment[e];
    if (kind !== 'mountain' && kind !== 'valley') return false;
    const p = graph.vertices_coords[u]!;
    const q = graph.vertices_coords[v]!;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return false;
    const t = ((m[0] - p[0]) * dx + (m[1] - p[1]) * dy) / len2;
    if (t < -1e-9 || t > 1 + 1e-9) return false;
    return Math.hypot(p[0] + t * dx - m[0], p[1] + t * dy - m[1]) < 1e-7;
  });
}

/** Does mirroring this fold's line leave it where it was? */
function sameLine(
  step: { a: Vec2; b: Vec2 },
  mirror: (p: Vec2) => Vec2,
  tol = 1e-9,
): boolean {
  const a = mirror(step.a);
  const b = mirror(step.b);
  const dx = step.b[0] - step.a[0];
  const dy = step.b[1] - step.a[1];
  const off = (p: Vec2) => (p[0] - step.a[0]) * dy - (p[1] - step.a[1]) * dx;
  const len = Math.hypot(dx, dy);
  if (len < tol) return true;
  return Math.abs(off(a)) / len < tol && Math.abs(off(b)) / len < tol;
}

export interface Carried { readonly share: number; readonly plies: number; readonly depth: number }

/*
 * How much of a bundle's wrap the paper pays for: all of it, half a turn
 * round the bundle's average depth at the paper's own caliper. With nothing
 * fitted, that makes the pupil's square plane Unis 11.04 cm long folded, where
 * paper of no thickness makes 10.1 and the real one measures 11.1.
 */
const WRAP = 1;
/* A roll's crease lies in the front of the finished aeroplane, across it. */
const NOSE_SHARE = 0.4;

/**
 * How much longer real paper's rolls leave the nose than the drawing's, and
 * the depth of the bundle behind the nose, metres.
 *
 * The drawing folds paper of no thickness. Real paper rolled over a bundle n
 * plies deep has to go half a turn round it, and a roll is judged by its
 * bundle - rolled over by the bundle's own width - so the paper the turn takes
 * is paper the roll does not take in: every roll leaves the sheet a little
 * longer than the drawing, and the rolled nose comes out further forward. (It
 * was once counted the other way, the nose coming back by every roll's depth,
 * and a square plane's balance point came out ahead of its nose.)
 *
 * A roll is told by where it ends up, on the finished aeroplane `plies`: a
 * fold closed flat whose crease runs across the aeroplane in the front of it.
 * Told by the line's direction on the drawing, as it was, a tail flap, the
 * two folds of a pleat and a fold of one ply were rolls too, a sheet turned
 * sideways had none, and the bundle's depth was whichever fold came last.
 */
export function rollLength(
  steps: readonly Step[],
  session: Pick<SessionState, 'carried' | 'stepCreases'>,
  pitch: number,
  plies: readonly RenderFace[],
  paper: PaperProps,
): { extra: number; band: number } {
  const none = { extra: 0, band: 0 };
  if (plies.length < 2) return none;
  const af = buildAirframe(plies, paper, 8);
  if (!(af.length > 0)) return none;
  const inSpace = (q: Vec2) => {
    const f = plies.find((ply) => pointInPolygon(ply.outline, q));
    return f ? af.frame.toBody(applyRigid(f.transform, [q[0], q[1], 0])) : null;
  };
  let extra = 0;
  let band = 0;
  let front = -Infinity;
  steps.forEach((s, i) => {
    if (!isFold(s) || s.creaseOnly || (s.angleDeg ?? 180) < 179.5) return;
    const c = session.carried[i];
    if (!c || !(c.plies > 0)) return;
    // The longest piece of its crease, found on the finished aeroplane.
    const pieces = [...(session.stepCreases[i] ?? [])]
      .sort((p, q) => Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]) - Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]));
    const piece = pieces[0];
    if (!piece) return;
    // A hair inside each end, so the point is on a face and not on its edge.
    const at = (t: number): Vec2 => [piece.a[0] + (piece.b[0] - piece.a[0]) * t, piece.a[1] + (piece.b[1] - piece.a[1]) * t];
    const p = inSpace(at(0.1));
    const q = inSpace(at(0.9));
    if (!p || !q) return;
    const run = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const len = Math.hypot(run[0]!, run[1]!, run[2]!);
    const x = (p[0] + q[0]) / 2;
    if (!(len > 0) || Math.abs(run[0]!) / len > 0.5) return;
    if (af.cgFromNose - x > NOSE_SHARE * af.length) return;
    extra += WRAP * (Math.PI / 2) * pitch * c.plies;
    if (x > front) { front = x; band = c.depth; }
  });
  return { extra, band };
}

/**
 * The faces of one wing: past the fold line, the paper reached without
 * crossing the line, from the top of the pile or from the bottom.
 *
 * Cut along the line, what lies past it comes apart into the two halves of
 * the packet, each with whatever was folded into it, because the halves are
 * joined only along the spine on the other side of the line. The upper wing
 * is the piece the topmost paper past the line belongs to, the lower the
 * bottommost. Null when the paper past the line is all one piece - nothing
 * then tells a wing from the rest, and the fold takes all of it.
 */
export function wingFaces(state: FoldedState, a: Vec2, b: Vec2, movingSide: Vec2, upper: boolean): Set<number> | null {
  const g = state.graph;
  const side = (p: Vec2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const scale = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const toward = Math.sign(side(movingSide));
  const eps = 1e-7 * scale;
  const viewOf = (f: number, v: number) => affineApply(state.faces_matrix[f]!, g.vertices_coords[v]!);
  const past = g.faces_vertices.map((loop, f) => loop.some((v) => side(viewOf(f, v)) * toward > eps));
  // Joined past the line only: an edge wholly on the near side - the spine,
  // for a face that reaches back across the line to it - is not a join there.
  const joinsPast = (f: number, e: number) => g.edges_vertices[e]!.some((v) => side(viewOf(f, v)) * toward > eps);
  const piece = new Array<number>(g.faces_vertices.length).fill(-1);
  const adjacency = faceAdjacency(g);
  let pieces = 0;
  for (let f = 0; f < piece.length; f++) {
    if (!past[f] || piece[f] !== -1) continue;
    const stack = [f];
    piece[f] = pieces;
    while (stack.length) {
      const here = stack.pop()!;
      for (const { face, edge } of adjacency.get(here) ?? []) {
        if (!past[face] || piece[face] !== -1 || !joinsPast(here, edge)) continue;
        piece[face] = pieces;
        stack.push(face);
      }
    }
    pieces++;
  }
  if (pieces < 2) return null;
  const order = state.faces_order;
  const rank = new Map(order.map((f, i) => [f, i]));
  const ends = order.filter((f) => past[f]);
  const top = piece[ends[ends.length - 1]!]!;
  const bottom = piece[ends[0]!]!;
  if (top === bottom) return null;
  /*
   * Loose paper past the line - the tips of rolls tucked into the nose, joined
   * to the rest only back across the line - goes with the wing it lies among
   * in the pile, as it does in the hand: whichever wing's paper its own is
   * nearer to, by height.
   */
  const heights = (p: number) => piece.flatMap((q, f) => (q === p ? [rank.get(f)!] : []));
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  const topFloor = Math.min(...heights(top));
  const bottomCeiling = Math.max(...heights(bottom));
  const split = (topFloor + bottomCeiling) / 2;
  const out = new Set<number>();
  piece.forEach((p, f) => {
    if (p < 0) return;
    const goesUp = p === top || (p !== bottom && mean(heights(p)) > split);
    if (goesUp === upper) out.add(f);
  });
  return out;
}

/**
 * The pile made mirror-symmetric, when the paper is.
 *
 * A collapse's pile is searched for, and the search takes the first order
 * that works - which on a lock folded alike on both sides of the sheet can be
 * one order on the left and another on the right: two small pleats stacked
 * one way under one wing and the other way under the other, the two wings
 * then showing different paper at the same place. Paper folded alike lies
 * alike. So the left half's order is kept and the right half given the same
 * one, mirrored; used only if that order folds as well.
 */
export function symmetricOrder(state: FoldedState, width: number): FoldedState | null {
  const g = state.graph;
  const mid = width / 2;
  // The area's own centre: a face with one more vertex along an edge has the same one.
  const centre = (f: number): Vec2 => {
    const loop = g.faces_vertices[f]!.map((v) => g.vertices_coords[v]!);
    let a = 0; let x = 0; let y = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]!; const q = loop[(i + 1) % loop.length]!;
      const c = p[0] * q[1] - q[0] * p[1];
      a += c; x += (p[0] + q[0]) * c; y += (p[1] + q[1]) * c;
    }
    return Math.abs(a) < 1e-14 ? loop[0]! : [x / (3 * a), y / (3 * a)];
  };
  const cs = g.faces_vertices.map((_, f) => centre(f));
  /*
   * Twins found by distance, not by rounding: two centres a ten-millionth
   * apart rounded to different sides of a digit, and a face whose twin was
   * plainly there was taken for one without.
   */
  const mate = cs.map((c) => {
    const want: Vec2 = [2 * mid - c[0], c[1]];
    let best = -1; let bestD = 2e-5;
    cs.forEach((d, k) => { const e = Math.hypot(d[0] - want[0], d[1] - want[1]); if (e < bestD) { bestD = e; best = k; } });
    return best < 0 ? undefined : best;
  });
  // Mostly a mirror of itself, or nothing to make symmetric.
  if (mate.filter((m) => m === undefined).length > mate.length / 4) return null;
  /*
   * Twins on the sheet are twins in the model only if the folding treated
   * them alike: then every pair is carried to the view by one and the same
   * map once the sheet's own mirror is undone (M_twin = T M R for one T).
   * A fold made on one side only breaks that, and a mirrored pile forced
   * onto paper that is not mirrored could turn the wrong face up.
   */
  const R: Affine = [-1, 0, 0, 1, 2 * mid, 0];
  let T: Affine | null = null;
  const same = (a: Affine, b: Affine) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
  for (let f = 0; f < mate.length; f++) {
    const t = mate[f];
    if (t === undefined || t === f) continue;
    const here = affineMul(state.faces_matrix[t]!, affineMul(R, affineInverse(state.faces_matrix[f]!)));
    if (!T) T = here;
    else if (!same(T, here)) return null;
  }
  const pos = new Map(state.faces_order.map((f, i) => [f, i]));
  // Each face is placed where its left-hand twin is: a left face by itself, a right one by its mate.
  // A face without a twin keeps its own place.
  const rep = (f: number) => (cs[f]![0] <= mid + 1e-9 || mate[f] === undefined ? f : mate[f]!);
  const order = [...state.faces_order].sort((a, b) =>
    (pos.get(rep(a))! - pos.get(rep(b))!) || (cs[a]![0] - cs[b]![0]));
  if (order.every((f, i) => f === state.faces_order[i])) return null;
  const next = { ...state, faces_order: order };
  if (orderViolations(next).length === 0) return next;
  /*
   * Where the two halves' own paper overlaps at the middle, one of them has
   * to be on top, and no pile is symmetric there. Searched for from the
   * symmetric one, the order is changed only where it has to be - the middle
   * - and the rest keeps its mirror.
   */
  const found = solveOrder(next, { maxSteps: 100_000 });
  if (!found.order) return null;
  const settled = { ...state, faces_order: found.order };
  return orderViolations(settled).length === 0 ? settled : null;
}

/** Collapses already folded, by the steps that led to them. See replay. */
const COLLAPSE_MEMO = new Map<string, ReturnType<typeof collapsePattern>>();

/** Pile orders already searched for, by the steps that led to them. See replay. */
const ORDER_MEMO = new Map<string, { order: readonly number[]; bad: readonly OrderViolation[] }>();

export function replay(
  width: number,
  height: number,
  steps: readonly Step[],
  /** Caliper of one ply, metres. Not yet used by the graph engine. */
  thickness = 0,
): SessionState {
  void thickness;
  const creaseMap = new Map<string, { crease: TaggedCrease; rank: number }>();
  let state = flatSheet(width, height);
  let creases: TaggedCrease[] = [];
  let dimensions: Dimension[] = [];
  let impossible: readonly OrderViolation[] = [];
  let blockedAt = -1;
  const bent: number[] = steps.map(() => 0);
  const carried: Carried[] = steps.map(() => ({ share: 0, plies: 0, depth: 0 }));
  const stepCreases: Segment[][] = steps.map(() => []);
  const keepCrease = (seg: TaggedCrease, rank: number) => {
    const k = segmentKey(seg);
    const prior = creaseMap.get(k);
    // The latest fold along a line names it, unless it only pressed a
    // mark over a real fold: a point tucked back in on the crease it was
    // folded on is a lock line now, not the fold it was.
    if (!prior || rank >= prior.rank) creaseMap.set(k, { crease: seg, rank });
    stepCreases[seg.step]!.push({ a: seg.a, b: seg.b });
  };

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    try {
      if (step.kind === 'flip') {
        state = flipOver(state);
        continue;
      }
      /*
       * Creases already on the paper, closed together.
       *
       * The step carries only the place they meet, so it is replayed against
       * whatever the paper has become by now - which is what lets an earlier
       * step be edited without the collapse coming loose. A collapse that
       * cannot be made blocks the script here rather than quietly producing a
       * shape the hand could not reach.
       */
      if (step.kind === 'collapse') {
        /*
         * A collapse searches its pile - up to a million and a half steps -
         * and the same script is replayed for the model, the pile at rest,
         * every frame of an animation and every page printed. The answer
         * depends only on the steps so far, so it is kept like the folds' are.
         */
        const collapseKey = `${width},${height}|${JSON.stringify(steps.slice(0, index + 1))}`;
        let r = COLLAPSE_MEMO.get(collapseKey);
        if (!r) {
          try {
            r = step.lines
              ? collapsePattern(state, step.lines)
              : step.open
                ? collapseAlong(state, step.at, step.open)
                : collapseAtPoint(state, step.at);
          } catch (err) {
            // Failed is an answer too: kept, it is not searched for again on every replay.
            console.error(`replay: collapse at step ${index + 1} failed`, err);
            r = { state, violations: [], conflict: '이 선들로는 접을 수 없어요.' } as ReturnType<typeof collapsePattern>;
          }
          if (!r.conflict && r.violations.length === 0) r = { ...r, state: symmetricOrder(r.state, width) ?? r.state };
          COLLAPSE_MEMO.set(collapseKey, r);
          if (COLLAPSE_MEMO.size > 32) COLLAPSE_MEMO.delete(COLLAPSE_MEMO.keys().next().value!);
        }
        if (r.conflict) {
          if (blockedAt < 0) { blockedAt = index; impossible = []; }
          continue;
        }
        state = r.state;
        if (r.violations.length > 0 && blockedAt < 0) {
          blockedAt = index;
          impossible = orderViolations(state);
        }
        continue;
      }
      if (step.kind === 'dimension') {
        dimensions = dedupeDimensions([
          ...dimensions,
          ...traceDimension(asModel(state, width, height), step.a, step.b, index),
        ]);
        continue;
      }

      if (step.creaseOnly && step.pinned) {
        state = pressSheetCreases(state, step.pinned);
        for (const seg of step.pinned) keepCrease({ a: seg.a, b: seg.b, step: index }, 0);
        continue;
      }

      const mirrorAxis = width / 2;
      const mirror = (p: Vec2): Vec2 => [2 * mirrorAxis - p[0], p[1]];
      const apply = (a: Vec2, b: Vec2, movingSide: Vec2) => {
        const before = asModel(state, width, height);
        const traced = traceCrease(before, lineThrough(a, b), index);
        const taken = step.plies?.kind === 'stack'
          ? pliesAtLine(state, a, b, movingSide, step.plies.count)
          : step.plies?.kind === 'wing' ? wingFaces(state, a, b, movingSide, step.plies.upper) : null;
        state = graphFold(state, a, b, movingSide, step.sense, {
          angleDeg: step.angleDeg ?? 180,
          creaseOnly: step.creaseOnly,
          allows: taken ? (f) => taken.has(f) : facesAllowed(step.plies),
          piece: step.plies?.kind === 'piece' ? step.plies.at : undefined,
          pieceSheet: step.plies?.kind === 'piece' ? step.plies.sheet : undefined,
          tuck: step.tuck,
          reverse: step.reverse,
          half: step.plies?.kind === 'half' ? movingSide : undefined,
        });
        /*
         * Only where the paper was actually folded.
         *
         * The line is traced through every ply it crosses, which is right for
         * a fold that takes the whole stack. A fold of one piece or one half
         * leaves the rest uncreased, and drawing the line across it anyway put
         * creases on paper that was never touched - the Transition's front
         * flaps, folded on their own, drew their lines on across the tail.
         */
        const kept = step.creaseOnly ? traced : traced.filter((seg) => onFoldEdge(state, seg));
        for (const seg of kept) keepCrease(seg, step.creaseOnly ? 0 : 1);
        /*
         * All of the paper past the line and none left on the near side is
         * the model turned over, not folded: no ply bends round another. Counted
         * as bent, a fold along the leading edge came out as a roll through the
         * whole aeroplane - a warning about it, and the nose moved back by the
         * thickness of every ply, which put the balance out.
         */
        const turnedOver = !!state.faces_moved && state.faces_moved.every(Boolean);
        if (!step.creaseOnly && !turnedOver) {
          bent[index] = Math.max(bent[index] ?? 0, pliesBent(state, a, b, movingSide));
          const c = carriedBy(state, a, b, movingSide, width * height);
          const was = carried[index]!;
          carried[index] = { share: was.share + c.share, plies: Math.max(was.plies, c.plies), depth: Math.max(was.depth, c.depth) };
        }
      };

      apply(step.a, step.b, step.movingSide);
      /*
       * A crease the mirror sends back onto itself is made once, not twice.
       *
       * The test used to be "does it lie ON the centre line", which catches a
       * fold down the middle but not a fold ACROSS it: mirroring a horizontal
       * line about a vertical axis gives the same horizontal line, so the fold
       * was applied a second time to the paper it had just moved. Whichever
       * half you chose, the result came out the same - because the second
       * application undid the choice.
       */
      /*
       * Not for a fold that names its own paper. A piece or a half is one
       * particular sheet under the finger, and the mirror of the finger is on
       * some other paper - or on none, and a finger on nothing used to fold
       * everything past the line. The second wing is made the way the book
       * makes it: turn the model over and fold that half.
       */
      const namesItsPaper = step.plies?.kind === 'piece' || step.plies?.kind === 'half';
      if (step.symmetric && !namesItsPaper && !sameLine(step, mirror)) {
        apply(mirror(step.a), mirror(step.b), mirror(step.movingSide));
      }
      if (blockedAt < 0 && !step.creaseOnly) {
        let bad = orderViolations(state);
        /*
         * The pile the folding assigned is a guess made one fold at a time,
         * and a pile has to satisfy every fold at once - so when the guess
         * comes out impossible, the order is searched for instead of the step
         * being declared unfoldable. Only then: the search costs something,
         * and when the guess is already good it has nothing to add.
         */
        /*
         * The searches below take seconds on a thick pile that has no order
         * (a halving past a pocket squashed the wrong way hunted for five), and
         * the same script is replayed many times over - the model, the pile at
         * rest, each frame of a fold's animation. Their answer depends only on
         * the steps so far, so it is kept, the failure along with the rest.
         */
        const memoKey = bad.length > 0 ? `${width},${height}|${JSON.stringify(steps.slice(0, index + 1))}` : '';
        const known = memoKey ? ORDER_MEMO.get(memoKey) : undefined;
        if (known) {
          state = { ...state, faces_order: [...known.order] };
          bad = [...known.bad];
        } else if (bad.length > 0) {
          let found: ReturnType<typeof solveOrder> = { order: null, pairs: 0, steps: 0, exhausted: false };
          try { found = solveOrder(state); } catch (err) { console.error(`replay: order at step ${index + 1} failed`, err); }
          if (found.order) {
            const repaired = { ...state, faces_order: found.order };
            const left = orderViolations(repaired);
            if (left.length < bad.length) { state = repaired; bad = left; }
          }
          /*
           * And from elsewhere, when that search is stuck where it started.
           *
           * Folding one flap off a pile that a collapse interleaved - the
           * Triangle's seventh step lifts the nose out from among the flaps the
           * waterbomb tucked in - hands the search a guess it cannot get out of,
           * while an order with nothing wrong exists. Only run when the first
           * search failed, so the ordinary fold pays nothing for it.
           */
          if (bad.length > 0) {
            try {
              const settled = settleOrder(state);
              const left = orderViolations(settled.state);
              if (left.length < bad.length) { state = settled.state; bad = left; }
            } catch (err) { console.error(`replay: order at step ${index + 1} failed`, err); }
          }
          // Searched for, the pile of a fold made alike on both sides is made alike too.
          if (bad.length === 0 && step.symmetric) state = symmetricOrder(state, width) ?? state;
          ORDER_MEMO.set(memoKey, { order: [...state.faces_order], bad });
          if (ORDER_MEMO.size > 64) ORDER_MEMO.delete(ORDER_MEMO.keys().next().value!);
        }
        if (bad.length > 0) { blockedAt = index; impossible = bad; }
      }
    } catch (err) {
      /*
       * A step that throws is skipped rather than the whole session lost -
       * but not in silence. Half-applied (the first side of a mirrored fold
       * made, the second not) the model went on as if nothing were wrong: one
       * wing folded, flown. The step is where the model stops being right.
       */
      if (blockedAt < 0) { blockedAt = index; impossible = []; }
      console.error(`replay: step ${index + 1} failed`, err);
    }
  }

  creases = [...creaseMap.values()].map((e) => e.crease);
  const model = asModel(state, width, height);
  return {
    state,
    model,
    creases,
    stepCreases,
    viewCreases: creasesInView(model, creases),
    dimensions,
    viewDimensions: dimensionsInView(model, dimensions),
    impossible,
    blockedAt,
    bent,
    carried,
  };
}

/**
 * How many plies a fold just bent, at the thickest place along its crease.
 *
 * Read after the fold: the paper that travelled now lies against the line on
 * the side it came to, so a point a hair that side of the line, anywhere
 * along it, is covered by one travelling face per ply bent there.
 */
function pliesBent(state: FoldedState, a: Vec2, b: Vec2, movingSide: Vec2): number {
  const moved = state.faces_moved;
  if (!moved) return 0;
  let line = lineThrough(a, b);
  if (signedDistance(line, movingSide) < 0) line = flipLine(line);
  const faces = state.graph.faces_vertices.map((_, f) => f).filter((f) => moved[f]);
  const outlines = faces.map((f) => faceOutline(state, f));
  if (outlines.length === 0) return 0;
  const inverse = faces.map((f) => affineInverse(state.faces_matrix[f]!));
  const [nx, ny] = line.normal;
  const foot: Vec2 = [nx * line.offset, ny * line.offset];
  const along: Vec2 = [-ny, nx];
  const ts = outlines.flat().map((p) => (p[0] - foot[0]) * along[0] + (p[1] - foot[1]) * along[1]);
  const lo = Math.min(...ts);
  const hi = Math.max(...ts);
  let most = 0;
  for (let i = 0; i < 64; i++) {
    const t = lo + ((i + 0.5) / 64) * (hi - lo);
    // The travelling paper came over to the far side of the line.
    const p: Vec2 = [foot[0] + along[0] * t - nx * 1e-5, foot[1] + along[1] * t - ny * 1e-5];
    // Counted where the paper really is: the layout piles standing wings on each other.
    const here = outlines.flatMap((poly, k) => (pointInPolygon(poly, p)
      ? [{ face: faces[k]!, sheet: affineApply(inverse[k]!, p) }] : []));
    if (here.length <= most) continue;
    most = Math.max(most, pliesTogether(state, here));
  }
  return most;
}

/**
 * What a fold just carried over: the travelling paper's share of the sheet,
 * and how many plies deep it lies on average - its area over the ground it
 * covers, the strip from the line out to its far edge.
 */
function carriedBy(state: FoldedState, a: Vec2, b: Vec2, movingSide: Vec2, sheetArea: number): Carried {
  const moved = state.faces_moved;
  if (!moved || !(sheetArea > 0)) return { share: 0, plies: 0, depth: 0 };
  let line = lineThrough(a, b);
  if (signedDistance(line, movingSide) < 0) line = flipLine(line);
  const outlines = state.graph.faces_vertices.map((_, f) => f).filter((f) => moved[f]).map((f) => faceOutline(state, f));
  if (outlines.length === 0) return { share: 0, plies: 0, depth: 0 };
  const areaOf = (poly: readonly Vec2[]) => Math.abs(poly.reduce((sum, p, i) => {
    const q = poly[(i + 1) % poly.length]!;
    return sum + p[0] * q[1] - q[0] * p[1];
  }, 0)) / 2;
  const area = outlines.reduce((sum, poly) => sum + areaOf(poly), 0);
  const [nx, ny] = line.normal;
  const foot: Vec2 = [nx * line.offset, ny * line.offset];
  const along: Vec2 = [-ny, nx];
  const pts = outlines.flat();
  const ts = pts.map((p) => (p[0] - foot[0]) * along[0] + (p[1] - foot[1]) * along[1]);
  // The travelling paper came over to the far side of the line.
  const depth = Math.max(0, ...pts.map((p) => -signedDistance(line, p)));
  const ground = (Math.max(...ts) - Math.min(...ts)) * depth;
  return { share: area / sheetArea, plies: ground > 1e-12 ? area / ground : 0, depth };
}

export interface SnapPoint {
  readonly p: Vec2;
  readonly kind: 'corner' | 'mark' | 'midpoint' | 'crease' | 'grid';
}

/**
 * Points a fold line is allowed to land on. Real folding is corner-to-corner
 * and edge-to-crease, so free-floating lines are almost never what is wanted.
 */
export function snapPoints(
  model: FoldModel,
  viewCreases: readonly ViewCrease[],
  viewDimensions: readonly ViewDimension[] = [],
): SnapPoint[] {
  const seen = new Map<string, SnapPoint>();
  const push = (p: Vec2, kind: SnapPoint['kind']) => {
    const key = `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
    const prior = seen.get(key);
    // Corners beat midpoints beat crease ends when they coincide.
    if (!prior || rank(kind) < rank(prior.kind)) seen.set(key, { p, kind });
  };
  // A dot the user placed on purpose outranks anything derived automatically.
  const rank = (k: SnapPoint['kind']) =>
    k === 'mark' ? 0 : k === 'corner' ? 1 : k === 'midpoint' ? 2 : k === 'crease' ? 3 : 4;

  for (const layer of model.layers) {
    const poly = layerOutline(layer);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % poly.length]!;
      push(a, 'corner');
      push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], 'midpoint');
    }
  }
  for (const c of viewCreases) {
    push(c.a, 'crease');
    push(c.b, 'crease');
    push([(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2], 'crease');
  }
  for (const d of viewDimensions) {
    push(d.a, 'mark');
    push(d.b, 'mark');
  }
  /*
   * Where one line crosses another as they lie on screen: a crease seen
   * running under a flap's edge, or two creases on different plies. Neither
   * is a corner of any one piece of paper, but it is a place the eye aims at
   * - the end of the line a pocket is squashed along, 맞춰 접기's second
   * click - and without it the click landed a millimetre or two off.
   */
  const segs: Array<[Vec2, Vec2]> = viewCreases.map((c) => [c.a, c.b]);
  for (const layer of model.layers) {
    const poly = layerOutline(layer);
    for (let i = 0; i < poly.length; i++) segs.push([poly[i]!, poly[(i + 1) % poly.length]!]);
  }
  // Boxes first: most pairs are nowhere near each other.
  const box = segs.map(([a, b]) => [Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[1], b[1])] as const);
  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i]!;
    const ux = b[0] - a[0]; const uy = b[1] - a[1];
    const bi = box[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const bj = box[j]!;
      if (bj[0] > bi[1] + 1e-9 || bj[1] < bi[0] - 1e-9 || bj[2] > bi[3] + 1e-9 || bj[3] < bi[2] - 1e-9) continue;
      const [c, d] = segs[j]!;
      const vx = d[0] - c[0]; const vy = d[1] - c[1];
      const den = ux * vy - uy * vx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / den;
      const u = ((c[0] - a[0]) * uy - (c[1] - a[1]) * ux) / den;
      if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
      push([a[0] + ux * t, a[1] + uy * t], 'crease');
    }
  }
  return [...seen.values()];
}

function nearestSnap(
  points: readonly SnapPoint[],
  p: Vec2,
  radius: number,
): SnapPoint | null {
  let best: SnapPoint | null = null;
  let bestD = radius;
  for (const sp of points) {
    const d = Math.hypot(sp.p[0] - p[0], sp.p[1] - p[1]);
    if (d < bestD) { bestD = d; best = sp; }
  }
  return best;
}

/**
 * Settle a raw pointer position onto something the paper actually has.
 *
 * Paper features win over the grid, because folds are made to the paper: you
 * bring a corner to a crease, not to 47mm. The grid is the fallback for the
 * places where there is nothing to aim at.
 *
 * Both views share this. A fold made by pointing at the model in space has to
 * land on the same corner it would have landed on in the flat draft, or the two
 * views would quietly disagree about what the script says.
 */
export function resolveSnap(
  snaps: readonly SnapPoint[],
  raw: Vec2,
  /** How far a point may be dragged to a feature, in paper units. */
  radius: number,
  /** Grid step in millimetres; 0 turns the grid off. */
  snapMm: number,
): { p: Vec2; snap: SnapPoint | null } {
  const vertex = nearestSnap(snaps, raw, radius);
  if (vertex) return { p: vertex.p, snap: vertex };
  if (snapMm > 0) {
    const step = snapMm / 1000;
    const g: Vec2 = [Math.round(raw[0] / step) * step, Math.round(raw[1] / step) * step];
    if (Math.hypot(g[0] - raw[0], g[1] - raw[1]) < radius) {
      return { p: g, snap: { p: g, kind: 'grid' } };
    }
  }
  return { p: raw, snap: null };
}

/**
 * What was clicked: a point of the paper, or an edge of it.
 *
 * The align tool needs to know which, because bringing a corner to an edge and
 * bringing two corners together are different constructions. A corner wins over
 * an edge when both are within reach - a corner is a smaller target, so aiming
 * at one is nearly always deliberate.
 */
export function pickAt(
  model: FoldModel,
  viewCreases: readonly ViewCrease[],
  snaps: readonly SnapPoint[],
  p: Vec2,
  radius: number,
  /**
   * What the pointer is allowed to catch.
   *
   * A corner sits at the end of two edges, so "whatever is nearest" is a coin
   * toss there - and the two answers build different creases, so it was never
   * clear which question had been asked. Saying in advance whether a point or
   * a line is wanted makes the same click mean the same thing every time.
   */
  want?: 'point' | 'edge',
): AlignPick | null {
  if (want !== 'edge') {
    const vertex = nearestSnap(snaps.filter((s) => s.kind !== 'grid'), p, radius);
    if (vertex) return { kind: 'point', p: vertex.p };
    if (want === 'point') return null;
  }

  let best: { s: Segment; at: Vec2; d: number } | null = null;
  const keep = (hit: { s: Segment; at: Vec2; d: number }) => { best = hit; };
  const consider = (a: Vec2, b: Vec2) => {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
    const at: Vec2 = [a[0] + t * vx, a[1] + t * vy];
    const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
    if (d < radius && (!best || d < best.d)) keep({ s: { a, b }, at, d });
  };

  for (const layer of model.layers) {
    const poly = layerOutline(layer);
    for (let i = 0; i < poly.length; i++) {
      consider(poly[i]!, poly[(i + 1) % poly.length]!);
    }
  }
  for (const c of viewCreases) consider(c.a, c.b);

  const found = best as { s: Segment; at: Vec2; d: number } | null;
  return found ? { kind: 'edge', s: found.s, at: found.at } : null;
}

/**
 * A length on the paper, written the way this program quotes lengths.
 *
 * Centimetres, to one decimal. Origami instructions are written in centimetres
 * - "1.5cm either side of the centre line" - and a millimetre is the finest
 * distinction that matters when the tool doing the folding is a thumbnail, so
 * one decimal place says everything there is to say.
 */
export const cm = (metres: number): string => `${(metres * 100).toFixed(1)}cm`;

/** The same, from a figure already in millimetres. */
const cmFromMm = (mm: number): string => `${(mm / 10).toFixed(1)}cm`;

export interface FoldStats {
  readonly layerCount: number;
  /** Plies at the thickest place, counted where the paper actually is. */
  readonly maxPlies: number;
  /** Caliper at the thickest point, mm. */
  readonly maxThicknessMm: number;
  /** Paper area after folding vs. the original sheet; should always be 1. */
  readonly areaRatio: number;
  /**
   * The model's own size, in space: across, along, and how far it stands off
   * the table. The flat layout is the drawing of the model, not the model -
   * an aeroplane fourteen centimetres across is drawn seven wide - so anything
   * shown to the eye is measured here instead.
   */
  readonly spanMm: number;
  readonly lengthMm: number;
  readonly standMm: number;
  /** Size of the flattened drawing, mm. The crease pattern lives here. */
  readonly widthMm: number;
  readonly heightMm: number;
  readonly creaseCount: number;
  readonly dimensionCount: number;
  /** True once some step bends more plies at once than a hand can press. */
  readonly tooThick: boolean;
  /** The step that bends the most plies at once, and how many; -1 when none. */
  readonly hardestStep: number;
  readonly hardestPlies: number;
}

/**
 * How many plies one crease can be pressed through by hand.
 *
 * Set by what the book asks of a child, not by a rule of thumb: every
 * aeroplane in it bends twelve or thirteen plies at once at the nose when it is
 * halved and when the wings go down, and those are folded every day. Past
 * about eighteen - two millimetres of paper - the crease will not lie where
 * it is drawn. 오르막길 halves seventeen, through a nose rolled nine times, and
 * people fold it; sixteen called that too thick.
 */
const PLY_LIMIT = 18;

/**
 * How many crease lines the sheet carries, unfolded: each straight line
 * counted once.
 *
 * The session keeps a crease for every piece of every ply a fold pressed
 * through, which is what drawing it on the model needs - but a nose rolled
 * nine times and halved came to hundreds of them, and a pupil who opens the
 * paper out counts the lines on it.
 */
export function sheetCreaseLines(state: FoldedState): number {
  const g = state.graph;
  const lines = new Set<string>();
  g.edges_vertices.forEach(([u, v], e) => {
    if (g.edges_assignment[e] === 'boundary') return;
    const p = g.vertices_coords[u]!;
    const q = g.vertices_coords[v]!;
    let ang = Math.atan2(q[1] - p[1], q[0] - p[0]);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI - 1e-6) ang = 0;
    const off = -Math.sin(ang) * p[0] + Math.cos(ang) * p[1];
    lines.add(`${(ang * 180 / Math.PI).toFixed(1)}@${(off * 1e4).toFixed(0)}`);
  });
  return lines.size;
}

export function foldStats(session: SessionState, paper: PaperProps): FoldStats {
  const plies = plyDepth(session.state);
  let hardestStep = -1;
  let hardestPlies = 0;
  session.bent.forEach((n, i) => { if (n > hardestPlies) { hardestPlies = n; hardestStep = i; } });
  const { min, max } = modelBounds(session.model);
  const box = spatialBounds(restingPose(session.state));
  return {
    layerCount: session.model.layers.length,
    maxPlies: plies,
    maxThicknessMm: plies * paper.foldedPitch * 1000,
    areaRatio: totalArea(session.model) / paper.area,
    spanMm: (box.max[0] - box.min[0]) * 1000,
    lengthMm: (box.max[1] - box.min[1]) * 1000,
    standMm: (box.max[2] - box.min[2]) * 1000,
    widthMm: (max[0] - min[0]) * 1000,
    heightMm: (max[1] - min[1]) * 1000,
    creaseCount: sheetCreaseLines(session.state),
    dimensionCount: session.dimensions.length,
    tooThick: hardestPlies > PLY_LIMIT,
    hardestStep,
    hardestPlies,
  };
}

export type BuiltStep = Omit<FoldStep, 'sense' | 'kind'>;

/** Built-in folds that are worth a dedicated button. */
export interface Preset {
  readonly id: string;
  readonly name: string;
  readonly hint: string;
  readonly creaseOnly: boolean;
  build(model: FoldModel): BuiltStep[];
}

function halfVertical(model: FoldModel, creaseOnly: boolean): BuiltStep {
  const { min, max } = modelBounds(model);
  const mid = (min[0] + max[0]) / 2;
  return {
    a: [mid, min[1]], b: [mid, max[1]],
    movingSide: [max[0] - 1e-4, (min[1] + max[1]) / 2],
    creaseOnly,
    label: creaseOnly ? '세로 중심선' : '세로 반으로',
  };
}

/**
 * The two top corners onto the centre line: the pointed nose almost every
 * paper aeroplane begins with. The nose is the top of the sheet as drawn,
 * the short edge; each crease runs from the middle of it down at 45 degrees.
 */
function triangleNose(model: FoldModel): BuiltStep[] {
  const { min, max } = modelBounds(model);
  const mid = (min[0] + max[0]) / 2;
  const half = mid - min[0];
  return [
    {
      a: [mid, min[1]], b: [min[0], min[1] + half],
      movingSide: [min[0] + 1e-3, min[1] + 1e-3],
      creaseOnly: false, label: '세모 접기 (왼쪽 모서리를 가운데로)',
    },
    {
      a: [mid, min[1]], b: [max[0], min[1] + half],
      movingSide: [max[0] - 1e-3, min[1] + 1e-3],
      creaseOnly: false, label: '세모 접기 (오른쪽 모서리도 가운데로)',
    },
  ];
}

function halfHorizontal(model: FoldModel, creaseOnly: boolean): BuiltStep {
  const { min, max } = modelBounds(model);
  const mid = (min[1] + max[1]) / 2;
  return {
    a: [min[0], mid], b: [max[0], mid],
    movingSide: [(min[0] + max[0]) / 2, max[1] - 1e-4],
    creaseOnly,
    label: creaseOnly ? '가로 중심선' : '가로 반으로',
  };
}

/**
 * The two lines a fuselage is folded on.
 *
 * A keel is not a parallel strip: the nose is deeper than the tail, so the two
 * creases run in from the centre line at one distance at the front and another
 * at the back. Given those two numbers the lines follow, on both sides, and the
 * taper comes out the same every time - which by hand takes a ruler and two
 * careful marks per side.
 *
 * Equal numbers give the parallel strip, so this is also the plain pair of
 * guide creases either side of the centre line; there is no second macro for
 * that case.
 */
export function keelLines(
  model: FoldModel,
  frontMm: number,
  backMm: number,
  group: number,
): BuiltStep[] {
  const { min, max } = modelBounds(model);
  const mid = (min[0] + max[0]) / 2;
  const front = frontMm / 1000;
  const back = backMm / 1000;
  const label = `동체 앞 ${cmFromMm(frontMm)} · 뒤 ${cmFromMm(backMm)}`;
  const out: BuiltStep[] = [];
  for (const side of [-1, 1]) {
    // The nose is the top of the sheet, the tail the bottom.
    const a: Vec2 = [mid + side * front, max[1]];
    const b: Vec2 = [mid + side * back, min[1]];
    if (Math.abs(a[0] - mid) < 1e-9 && Math.abs(b[0] - mid) < 1e-9) continue;
    if (a[0] < min[0] - 1e-9 || a[0] > max[0] + 1e-9) continue;
    if (b[0] < min[0] - 1e-9 || b[0] > max[0] + 1e-9) continue;
    out.push({
      a,
      b,
      movingSide: [mid + side * (Math.max(front, back) + 0.01), (min[1] + max[1]) / 2],
      creaseOnly: true,
      label,
      group,
    });
  }
  return out;
}

/**
 * The move that turns a flat pattern into an aeroplane.
 *
 * Fold the whole thing in half down the middle, then bring a wing down either
 * side of the fuselage. By hand it is three actions and one of them is turning
 * the model over: you fold one wing down, flip, fold the other down the same
 * way. A script has no hands and never turns the model over, so the second
 * wing is written the way it looks from where the first was made - opposite
 * sense, and the other half of the stack.
 *
 * Which plies belong to which wing is not a guess. Folding in half leaves the
 * paper that travelled turned over and the paper that stayed the right way up,
 * and that split - not the middle of the list - is exactly where one wing ends
 * and the other begins. So the stack is replayed and counted.
 *
 * The wings stop short of flat on purpose. At 180 they would lie back against
 * the fuselage and there would be no aeroplane; the angle is what leaves the
 * keel standing with a wing either side of it.
 */
export function bodyAndWings(
  width: number,
  height: number,
  before: readonly Step[],
  frontMm: number,
  backMm: number,
  wingDeg: number,
  group: number,
): Step[] {
  const { min, max } = modelBounds(replay(width, height, before).model);
  const mid = (min[0] + max[0]) / 2;
  if (max[0] - min[0] < 1e-6 || max[1] - min[1] < 1e-6) return [];

  const body: Step = {
    kind: 'fold', a: [mid, min[1]], b: [mid, max[1]], movingSide: [max[0], (min[1] + max[1]) / 2],
    sense: 'mountain', creaseOnly: false, angleDeg: 180, group,
    label: '몸통 · 세로 반으로',
  };

  // The half that travelled went underneath, so what is left lies to the left
  // of the middle, and the fuselage line is measured in from there.
  const front = frontMm / 1000;
  const back = backMm / 1000;
  const nose: Vec2 = [mid - front, max[1]];
  const tail: Vec2 = [mid - back, min[1]];
  if (nose[0] < min[0] - 1e-9 || tail[0] < min[0] - 1e-9) return [];

  const stack = replay(width, height, [...before, body]).model.layers;
  const turned = stack.filter((l) => l.mirrored).length;
  const upright = stack.length - turned;
  if (turned === 0 || upright === 0) return [];

  const away: Vec2 = [min[0] - 0.01, (min[1] + max[1]) / 2];
  const keel = `동체 앞 ${cmFromMm(frontMm)} · 뒤 ${cmFromMm(backMm)}`;
  return [
    body,
    { kind: 'fold', a: nose, b: tail, movingSide: away,
      sense: 'valley', creaseOnly: false, angleDeg: wingDeg, group,
      plies: { kind: 'wing', upper: true },
      label: `앞쪽 날개 · V자 ${2 * (90 - wingDeg)}° (${keel})` },
    { kind: 'fold', a: nose, b: tail, movingSide: away,
      sense: 'mountain', creaseOnly: false, angleDeg: wingDeg, group,
      plies: { kind: 'wing', upper: false },
      label: `뒤쪽 날개 · V자 ${2 * (90 - wingDeg)}°` },
  ];
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'half-v', name: '세로 반으로', creaseOnly: false,
    hint: '긴 축을 따라 좌우 대칭으로 접습니다.',
    build: (m) => [halfVertical(m, false)],
  },
  {
    id: 'half-h', name: '가로 반으로', creaseOnly: false,
    hint: '짧은 축을 따라 접습니다.',
    build: (m) => [halfHorizontal(m, false)],
  },
  {
    id: 'triangle', name: '세모 접기', creaseOnly: false,
    hint: '위쪽 두 모서리를 가운데 선에 맞춰 접어 뾰족한 코를 만들어요.',
    build: (m) => triangleNose(m),
  },
  {
    id: 'crease-v', name: '세로 중심선', creaseOnly: true,
    hint: '세로로 접었다 펴서 중심선만 남깁니다. 대부분의 종이비행기 1단계.',
    build: (m) => [halfVertical(m, true)],
  },
  {
    id: 'crease-h', name: '가로 중심선', creaseOnly: true,
    hint: '가로로 접었다 펴서 기준선만 남깁니다.',
    build: (m) => [halfHorizontal(m, true)],
  },
];

/**
 * A pleat: fold once, then fold back the other way a set distance along.
 *
 * Two things have to be got right. The second crease is quoted on the flat
 * sheet but has to be given in the folded view, and the first fold has already
 * mirrored it: a line `d` beyond the crease lands `d` short of it once the flap
 * comes over. And the second crease exists only on the flap - the paper lying
 * under it was never creased - so the second fold has to name the flap's plies
 * rather than taking the whole stack with it.
 */
export function pleatSteps(
  model: FoldModel,
  a: Vec2,
  b: Vec2,
  movingSide: Vec2,
  sense: FoldSense,
  spacing: number,
  extras: Pick<FoldStep, 'angleDeg' | 'plies' | 'symmetric'> = {},
): FoldStep[] {
  let line = lineThrough(a, b);
  if (signedDistance(line, movingSide) < 0) line = flipLine(line);

  // How many plies the first fold will actually carry over.
  const selected = plyFilter(extras.plies, model.layers);
  let flapPlies = 0;
  model.layers.forEach((layer, i) => {
    if (selected && !selected(i)) return;
    if (clipHalfPlane(layer.outline, lineToLocal(line, layer.xf)).length >= 3) flapPlies++;
  });

  const [nx, ny] = line.normal;
  const back = (p: Vec2): Vec2 => [p[0] - nx * spacing, p[1] - ny * spacing];
  const a2 = back(a);
  const b2 = back(b);
  const mid: Vec2 = [(a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2];
  const beyond: Vec2 = [mid[0] - nx * 0.001, mid[1] - ny * 0.001];
  const opposite: FoldSense = sense === 'mountain' ? 'valley' : 'mountain';
  const group = Date.now();
  const step = cm(spacing);

  return [
    { kind: 'fold', a, b, movingSide, sense, creaseOnly: false, ...extras,
      group, pleat: true, label: `계단 접기 ${step} (1/2)` },
    {
      kind: 'fold', a: a2, b: b2, movingSide: beyond, sense: opposite,
      creaseOnly: false, angleDeg: extras.angleDeg, symmetric: extras.symmetric,
      // A valley fold lays the flap on top of the stack; a mountain tucks it under.
      plies: { kind: sense === 'mountain' ? 'bottom' : 'top', count: flapPlies },
      group, pleat: true, label: `계단 접기 ${step} (2/2)`,
    },
  ];
}
