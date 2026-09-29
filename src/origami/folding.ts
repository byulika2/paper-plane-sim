/**
 * Folding, on the crease-pattern graph.
 *
 * A folded state is the pattern plus, for each face, where that face has been
 * carried to. Folding again is then the same operation as folding a flat sheet:
 * the line the user draws is one line on the screen but a different line on
 * each face, so it is pulled back into each face's own coordinates before the
 * crease is pressed.
 *
 * Nothing here can cut the paper. Faces are joined through shared edges in the
 * graph, and a fold only ever divides a face and moves one half - it never
 * separates a face from its neighbours.
 */

import {
  affineApply, affineIdentity, affineIsMirrored, affineMul,
  clipHalfPlane, lineToLocal, reflectionAbout, signedDistance,
} from '../geometry/fold.js';
import type { Affine, Line } from '../geometry/fold.js';
import type { Vec2 } from '../geometry/math.js';
import { addCreases, faceAdjacency, faceArea, lineThroughPoints, sheetGraph } from './graph.js';
import type { CreaseLine, EdgeAssignment, FoldGraph } from './graph.js';

export interface FoldedState {
  readonly graph: FoldGraph;
  /** Sheet coordinates to the folded view, one per face. */
  readonly faces_matrix: readonly Affine[];
  /**
   * Stacking order, bottom of the pile first. FOLD calls the general form
   * faceOrders; a flat fold only needs a total order.
   */
  readonly faces_order: readonly number[];
  /**
   * Which faces travelled in the fold that produced this state.
   *
   * Only the last one - it is not history, it is "what just moved", which is
   * what a preview has to shade. Without it the preview had no way to tell the
   * flap from the body and lit up the whole sheet, so a fold looked like it had
   * already swallowed the paper before anyone chose a side.
   */
  readonly faces_moved?: readonly boolean[];
  /**
   * The faces some fold has carried less than all the way over - a wing held
   * out at ninety degrees, and whatever is folded on it afterwards.
   *
   * History, unlike `faces_moved`. The layout lays such a face where a flat
   * fold would have put it, so its layout position is not where it is in the
   * air: drawing the model outward from one of them turns the whole thing a
   * quarter over. The drawing starts from paper that has never been bent, so
   * the body stays where it is while the wings and winglets are folded.
   */
  readonly faces_bent?: readonly boolean[];
}

export function flatSheet(width: number, height: number): FoldedState {
  return {
    graph: sheetGraph(width, height),
    faces_matrix: [affineIdentity],
    faces_order: [0],
  };
}

/** A face's outline as it appears in the folded view. */
export function faceOutline(state: FoldedState, face: number): Vec2[] {
  const matrix = state.faces_matrix[face]!;
  return state.graph.faces_vertices[face]!.map((v) =>
    affineApply(matrix, state.graph.vertices_coords[v]!));
}

export type FoldSense = 'valley' | 'mountain';

export interface FoldOptions {
  /** How far the flap closes, in degrees. 180 lays it flat. */
  readonly angleDeg?: number;
  /** Press the crease and open it again, leaving the pattern but not the shape. */
  readonly creaseOnly?: boolean;
  /** Restrict the fold to faces the caller allows, for squashes and reverses. */
  readonly allows?: (face: number, state: FoldedState) => boolean;
  /**
   * Fold the piece of paper this point is on, and nothing else.
   *
   * Counting plies - "the top twelve" - stops meaning the right thing as soon
   * as a fold divides the pile, which the first wing of an aeroplane does to
   * the second. A point does not drift: cut along the crease this fold is
   * about to make, and the paper still attached to that point is the piece
   * that moves. That is what a hand does when it takes hold of a wing, and it
   * is why the wings come away from each other - their only join is through
   * the fuselage strip, which the cut removes.
   *
   * Given in the folded view, as it stood when the point was chosen.
   */
  readonly piece?: Vec2;
  /** The piece's point on the sheet, which settles it where the view cannot. */
  readonly pieceSheet?: Vec2;
  /** Tuck the moving paper inside rather than over the top (a lock). */
  readonly tuck?: boolean;
  /**
   * A reverse fold of a flap that is folded in half - a tail or a nose.
   *
   * The front layers and the back layers of the flap fold opposite ways about
   * the same line: inside, both go in between the two halves; outside, both
   * wrap round the outside. The flap is everything past the line.
   */
  readonly reverse?: 'inside' | 'outside';
  /**
   * The half of a halved packet this point is on - all of it past the line.
   *
   * A wing is one half of the packet. Taken as a piece it can come away short:
   * the front of a half may be joined to the rest only through the keel strip,
   * across the very line being folded, and then it is left standing. A hand
   * folds the whole side. The halves are joined only along the spine - the
   * packet's folded edge, the far side from the line - so the half is the paper
   * reached from the point without crossing it.
   */
  readonly half?: Vec2;
}

/**
 * Fold everything on the far side of `line` over toward the near side.
 *
 * `line` is given in the folded view, with its normal pointing at the part that
 * should travel.
 */
function foldAlong(
  state: FoldedState,
  line: Line,
  sense: FoldSense,
  options: FoldOptions = {},
): FoldedState {
  const {
    angleDeg = 180, creaseOnly = false, allows, piece, pieceSheet, half, tuck = false, reverse,
  } = options;
  const assignment: Exclude<EdgeAssignment, 'boundary'> =
    creaseOnly ? 'flat' : sense;

  // The crease is one line on screen; on each face it is wherever that face's
  // own paper has been carried to.
  const localLines = state.faces_matrix.map((matrix, face) => {
    if (allows && !allows(face, state)) return null;
    try {
      return lineToLocal(line, matrix);
    } catch {
      return null;
    }
  });

  /*
   * A reverse fold: which layers of the flap are its back half.
   *
   * Where each face lies past the line, the pile there is read bottom to top;
   * the lower half of it is the flap's back, the upper half its front. The two
   * halves then fold opposite ways, which is the whole of a reverse fold.
   */
  const backOf = reverse && !creaseOnly
    ? (() => {
      const outlines = state.faces_matrix.map((_, f) => faceOutline(state, f));
      const rank = new Map<number, number>();
      state.faces_order.forEach((f, i) => rank.set(f, i));
      return outlines.map((poly, f) => {
        const past = clipHalfPlane(poly, line);
        if (past.length < 3) return false;
        const c: Vec2 = [past.reduce((a, q) => a + q[0], 0) / past.length,
          past.reduce((a, q) => a + q[1], 0) / past.length];
        const pile = outlines.map((_, g) => g).filter((g) => inPolygon(outlines[g]!, c))
          .sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
        return pile.indexOf(f) < pile.length / 2;
      });
    })()
    : null;
  // Inside: the front turns away and the back toward you; outside the reverse.
  const flipped = (face: number) => (backOf
    ? (reverse === 'inside' ? !backOf[face] : backOf[face]!)
    : false);

  // The sense is what the hand does to the top of the pile; a face that has
  // already been turned over takes the opposite crease in its own paper.
  const turnedOver = (face: number) =>
    affineIsMirrored(state.faces_matrix[face]!) !== flipped(face);
  const crease = (lineOf: (face: number) => CreaseLine | null) => addCreases(
    state.graph, lineOf, assignment, creaseOnly ? 0 : angleDeg, turnedOver);

  let result = crease((face) => localLines[face] as CreaseLine | null);

  /*
   * Which paper actually travels.
   *
   * Everything past the line, unless a piece was named - in which case only
   * the part of it that is still joined to that point once the line is cut.
   */
  const finger = piece ?? half;
  const whole = half !== undefined && piece === undefined;
  let moving = finger
    ? pieceMoving(result, state, finger, line, whole, pieceSheet)
    : result.faces_moving;

  /*
   * Paper the hand never touched keeps no crease.
   *
   * Working out which piece travels needs the line drawn across the whole
   * model, because the piece is only defined once the line has divided it. But
   * a ply that is not in that piece was not folded, and creasing it anyway
   * left the model remembering bends that no hand made: the next fold read
   * those as places where the paper turns out of plane, and a wing folded flat
   * against the keel was taken for a wing standing at ninety degrees to it. So
   * the line is drawn a second time, over the piece alone.
   */
  if (finger) {
    const touched = new Array<boolean>(state.faces_matrix.length).fill(false);
    result.faces_source.forEach((src, i) => { if (moving[i]) touched[src] = true; });
    result = crease((face) => (touched[face] ? localLines[face] as CreaseLine | null : null));
    moving = pieceMoving(result, state, finger, line, whole, pieceSheet);
  }

  const reflect = reflectionAbout(line);
  const matrices: Affine[] = [];
  for (let i = 0; i < result.faces_source.length; i++) {
    const from = state.faces_matrix[result.faces_source[i]!]!;
    const travels = !creaseOnly && moving[i]!;
    matrices.push(travels ? affineMul(reflect, from) : from);
  }

  return {
    graph: settleCreasesOnLine(result, state, line, matrices, creaseOnly, angleDeg,
      sense === 'mountain' ? -1 : 1),
    faces_matrix: matrices,
    faces_order: restack({ ...result, faces_moving: moving },
      state.faces_order, sense, creaseOnly, angleDeg, tuck,
      backOf && reverse ? { kind: reverse, backOf } : undefined),
    faces_moved: creaseOnly ? undefined : moving,
    faces_bent: result.faces_source.map((src, i) => (state.faces_bent?.[src] ?? false)
      || (!creaseOnly && moving[i]! && Math.abs(angleDeg - 180) > 1e-6)),
  };
}

/**
 * The creases the fold ran along: open or shut by where their faces ended up.
 *
 * Folding along a crease that is already there gives that crease this fold's
 * angle, which is right when the paper either side of it was lying flat - and
 * wrong when it was already folded about it. The Triangle's eighth step folds
 * the small triangle at the shoulders, the very line the seventh step turned
 * the nose about, and the layers of the triangle that had been folded under
 * the nose come back out flat beside it. Their crease was still marked shut,
 * so the audit took the two faces, now lying either side of it, for a pocket
 * and reported paper passing through paper that was nowhere near.
 *
 * For a flat fold the placement settles it: two faces joined along the line
 * are open if they ended up in the same place and shut if one is the other's
 * reflection. A fold stopped part way is left alone - its layout is drawn
 * flat while the paper is not.
 */
function settleCreasesOnLine(
  result: ReturnType<typeof addCreases>,
  state: FoldedState,
  line: Line,
  matrices: readonly Affine[],
  creaseOnly: boolean,
  angleDeg: number,
  sign: number,
): FoldGraph {
  if (creaseOnly || Math.abs(angleDeg - 180) > 1e-6) return result.graph;
  const graph = result.graph;
  const sides = new Map<number, number[]>();
  for (const [face, links] of faceAdjacency(graph)) {
    for (const { edge } of links) {
      const list = sides.get(edge);
      if (list) { if (!list.includes(face)) list.push(face); } else sides.set(edge, [face]);
    }
  }
  const same = (a: Affine, b: Affine) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-9);
  let angles: number[] | null = null;
  for (const [edge, faces] of sides) {
    if (faces.length !== 2 || graph.edges_assignment[edge] === 'boundary') continue;
    const [f] = faces;
    const was = state.faces_matrix[result.faces_source[f!]!]!;
    const [u, v] = graph.edges_vertices[edge]!;
    const p = affineApply(was, graph.vertices_coords[u]!);
    const q = affineApply(was, graph.vertices_coords[v]!);
    if (Math.abs(signedDistance(line, p)) > 1e-9 || Math.abs(signedDistance(line, q)) > 1e-9) {
      continue;
    }
    const open = same(matrices[faces[0]!]!, matrices[faces[1]!]!);
    const now = graph.edges_foldAngle[edge] ?? 0;
    const want = open ? 0 : (Math.abs(now) > Math.PI - 1e-6 ? now : sign * Math.PI);
    if (Math.abs(want - now) < 1e-12) continue;
    angles ??= [...graph.edges_foldAngle];
    angles[edge] = want;
  }
  return angles ? { ...graph, edges_foldAngle: angles } : graph;
}

/**
 * The paper still joined to a point once the fold's line is cut.
 *
 * Two faces stay together if they share an edge and are on the same side of
 * the line; crossing it is what the fold is about to sever. Flooding out from
 * the face under the point gives exactly the piece a hand would lift - and
 * because the wings of an aeroplane are joined to each other only through the
 * fuselage strip, cutting at the keel leaves each of them on its own.
 */
function pieceMoving(
  result: ReturnType<typeof addCreases>,
  state: FoldedState,
  at: Vec2,
  line: Line,
  /** Walk through the paper that stays too, stopping only at the spine. */
  wholeHalf = false,
  /** The finger's point on the sheet, when the view point is ambiguous. */
  sheet?: Vec2,
): boolean[] {
  const count = result.faces_source.length;
  // Where each new face lies before anything has moved.
  const placed = result.faces_source.map((src) => state.faces_matrix[src]!);
  const outlineOf = (i: number) => result.graph.faces_vertices[i]!
    .map((v) => affineApply(placed[i]!, result.graph.vertices_coords[v]!));

  // The topmost face under the finger, among the paper that is going to move.
  const rank = new Map<number, number>();
  state.faces_order.forEach((face, position) => rank.set(face, position));
  let start = -1;
  let best = -Infinity;
  for (let i = 0; i < count; i++) {
    if (!result.faces_moving[i]) continue;
    if (!inPolygon(outlineOf(i), at)) continue;
    const depth = rank.get(result.faces_source[i]!) ?? 0;
    if (depth > best) { best = depth; start = i; }
  }
  // A point of the sheet names one face outright, wherever the pile has put it.
  if (sheet) {
    for (let i = 0; i < count; i++) {
      if (!result.faces_moving[i]) continue;
      const loop = result.graph.faces_vertices[i]!.map((v) => result.graph.vertices_coords[v]!);
      if (inPolygon(loop, sheet)) { start = i; break; }
    }
  }
  // Nothing under the finger: fold the lot, which is what was asked for before
  // pieces existed and is the only sensible thing left to do.
  if (start < 0) return [...result.faces_moving];

  const adjacency = faceAdjacency(result.graph);
  /*
   * An edge lying along the line is cut too, even with paper on one side of it.
   *
   * A new crease divides faces and leaves the pieces on opposite sides, so the
   * walk never met an edge on the line with moving paper both sides of it.
   * Folding along a crease that is already closed does: two flaps folded
   * about it lie on the same side, joined along the very line, and the walk
   * went straight across. The Triangle's eighth step folds the small triangle
   * at the shoulders, which is exactly the crease the seventh step turned the
   * nose about - and the nose came along with it, all twenty-four faces.
   */
  const onLine = (edge: number, face: number): boolean => {
    const [u, v] = result.graph.edges_vertices[edge]!;
    const m = placed[face]!;
    const p = affineApply(m, result.graph.vertices_coords[u]!);
    const q = affineApply(m, result.graph.vertices_coords[v]!);
    return Math.abs(signedDistance(line, p)) < 1e-9 && Math.abs(signedDistance(line, q)) < 1e-9;
  };
  const keep = new Array<boolean>(count).fill(false);
  keep[start] = true;
  if (wholeHalf) {
    /*
     * The spine: the edge of the packet furthest back from the line, where the
     * two halves are joined. Everything else may be walked through - the
     * paper that stays included, since that is how the front of a half is
     * joined to the rest of it - and what is kept is what lies past the line.
     */
    const side = (p: Vec2) => signedDistance(line, p);
    /*
     * Only paper lying in the plane the finger is on. The first wing, already
     * standing, is drawn lying flat in the layout - past the spine, since it
     * was folded about a line inside it - and read as paper it made the far
     * edge of the model its own tip, and the walk went over the real spine.
     */
    const planeWas = planeGroups(state.graph, faceAdjacency(state.graph));
    const planeOf = (i: number) => planeWas[result.faces_source[i]!] ?? -1;
    const home = planeOf(start);
    let back = 0;
    for (let i = 0; i < count; i++) {
      if (planeOf(i) !== home) continue;
      for (const p of outlineOf(i)) back = Math.min(back, side(p));
    }
    const onSpineLine = (edge: number, face: number): boolean => {
      const [u, v] = result.graph.edges_vertices[edge]!;
      const m = placed[face]!;
      return Math.abs(side(affineApply(m, result.graph.vertices_coords[u]!)) - back) < 1e-9
        && Math.abs(side(affineApply(m, result.graph.vertices_coords[v]!)) - back) < 1e-9;
    };
    /*
     * Not every crease on that line is the spine.
     *
     * The middle line of a model carries creases from long before it was
     * halved - flaps folded to it, ears laid along it - and those join paper
     * within one half. Blocking them all cut the front of each half off from
     * its own tail. The halving is told apart by how it sits in the pile: it
     * wraps every ply round the outside, pairing the bottom ply with the top,
     * the second with the second from the top, and so on - so the places of
     * its two faces in the pile add up to the same number for every one of its
     * pockets. A crease inside one half pairs two neighbours somewhere on its
     * own side, and their sum is whatever it happens to be. The spine is the
     * pockets sharing the commonest sum.
     *
     * Asking instead where in the pile the most pockets cross found the right
     * place and two wrong ones with just as many - a half's own creases on the
     * middle line are nested too - and the first of those was taken.
     */
    const rankOfNew = (i: number) => rank.get(result.faces_source[i]!) ?? 0;
    const pockets: Array<{ edge: number; lo: number; hi: number }> = [];
    for (const [face, links] of adjacency) {
      if (planeOf(face) !== home) continue;
      for (const { face: other, edge } of links) {
        if (other <= face || planeOf(other) !== home) continue;
        if (!onSpineLine(edge, face)) continue;
        const a = rankOfNew(face);
        const b = rankOfNew(other);
        pockets.push({ edge, lo: Math.min(a, b), hi: Math.max(a, b) });
      }
    }
    const sums = new Map<number, number>();
    for (const pk of pockets) sums.set(pk.lo + pk.hi, (sums.get(pk.lo + pk.hi) ?? 0) + 1);
    let common = -1;
    let most = 0;
    for (const [sum, n] of [...sums].sort((x, y) => x[0] - y[0])) {
      if (n > most) { most = n; common = sum; }
    }
    const spine = new Set(pockets.filter((pk) => pk.lo + pk.hi === common).map((pk) => pk.edge));
    const onSpine = (edge: number) => spine.has(edge);
    const reached = new Array<boolean>(count).fill(false);
    reached[start] = true;
    const queue = [start];
    while (queue.length > 0) {
      const here = queue.shift()!;
      for (const { face: there, edge } of adjacency.get(here) ?? []) {
        if (reached[there] || planeOf(there) !== home || onSpine(edge)) continue;
        // Two flaps folded about the line itself are still cut apart by it.
        if (result.faces_moving[here] && result.faces_moving[there] && onLine(edge, here)) continue;
        reached[there] = true;
        queue.push(there);
      }
    }
    for (let i = 0; i < count; i++) keep[i] = reached[i]! && result.faces_moving[i]!;
  } else {
    const queue = [start];
    while (queue.length > 0) {
      const here = queue.shift()!;
      for (const { face: there, edge } of adjacency.get(here) ?? []) {
        // Crossing the line is what the fold severs; the walk does not cross it.
        if (keep[there] || !result.faces_moving[there]) continue;
        if (onLine(edge, here)) continue;
        keep[there] = true;
        queue.push(there);
      }
    }
  }
  /*
   * Paper the piece has trapped comes with it.
   *
   * A flap folded down into the pile is held there by the plies either side of
   * it and not by a crease of its own, so cutting along the fold line leaves it
   * loose - and the walk above, which only follows creases, leaves it behind.
   * A hand does not: it takes hold of a wing and everything folded inside that
   * wing goes with it. So paper on the moving side that lies between two plies
   * of the piece, over the same ground as both, travels too.
   *
   * The cost of leaving it out was an aeroplane whose two wings carried
   * different paper: each wing came away as the four faces it is joined to and
   * left the eight it had folded inside standing behind, and since the halves
   * are stacked one inside the other, the paper left behind by the first wing
   * was then picked up by the second.
   */
  const rankOf = (i: number) => rank.get(result.faces_source[i]!) ?? 0;
  const overlaps = (a: number, b: number) =>
    Math.abs(polygonArea(clipToConvex(outlineOf(a), outlineOf(b)))) > 1e-8;

  /*
   * Only paper lying in the same plane can trap anything.
   *
   * The layout draws every face flat, so a wing standing at ninety degrees is
   * drawn lying over the one opposite it and the two look stacked when in
   * space they are nowhere near each other. Read there, a winglet turned up on
   * one tip was found to be holding the whole of the other wing captive and
   * carried it along. Faces stay in one plane across a crease that is either
   * open or closed right down; a crease caught part way is where one plane
   * ends and the next begins - read on the model as it stands now, before this
   * fold's own crease has divided anything.
   */
  const before = planeGroups(state.graph, faceAdjacency(state.graph));
  const plane = result.faces_source.map((src) => before[src] ?? -1);

  for (let grew = true; grew;) {
    grew = false;
    const held: number[] = [];
    for (let i = 0; i < count; i++) if (keep[i]) held.push(i);
    for (let f = 0; f < count; f++) {
      if (keep[f] || !result.faces_moving[f]) continue;
      const here = rankOf(f);
      let above = false;
      let below = false;
      for (const h of held) {
        if (above && below) break;
        const there = rankOf(h);
        if (there === here || plane[h] !== plane[f]) continue;
        if (there > here ? above : below) continue;
        if (!overlaps(f, h)) continue;
        if (there > here) above = true; else below = true;
      }
      if (above && below) { keep[f] = true; grew = true; }
    }
  }

  return keep;
}

/**
 * Which faces share a plane once the model is stood up in space.
 *
 * A crease left open or folded right down leaves the two faces parallel; one
 * caught part way turns the paper out of the plane it was in. Flooding over
 * the first kind and stopping at the second groups the faces exactly as space
 * does, without having to place any of them.
 */
function planeGroups(
  graph: FoldGraph,
  adjacency: ReturnType<typeof faceAdjacency>,
): number[] {
  const flatAcross = (edge: number) => {
    const deg = Math.abs(((graph.edges_foldAngle[edge] ?? 0) * 180) / Math.PI);
    return deg < 1e-6 || deg > 180 - 1e-6;
  };
  const group = new Array<number>(graph.faces_vertices.length).fill(-1);
  let next = 0;
  for (let seed = 0; seed < group.length; seed++) {
    if (group[seed]! >= 0) continue;
    const here = next++;
    group[seed] = here;
    const queue = [seed];
    while (queue.length > 0) {
      const face = queue.shift()!;
      for (const { face: there, edge } of adjacency.get(face) ?? []) {
        if (group[there]! >= 0 || !flatAcross(edge)) continue;
        group[there] = here;
        queue.push(there);
      }
    }
  }
  return group;
}

/** Twice the signed area of a loop, halved. Empty loops have none. */
function polygonArea(poly: readonly Vec2[]): number {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice / 2;
}

/**
 * What two faces have in common, as a polygon.
 *
 * Faces of a crease pattern are convex, so clipping one against each edge of
 * the other in turn is exact and needs no general polygon library.
 */
function clipToConvex(poly: readonly Vec2[], against: readonly Vec2[]): Vec2[] {
  if (against.length < 3) return [];
  const middle: Vec2 = [
    against.reduce((a, p) => a + p[0], 0) / against.length,
    against.reduce((a, p) => a + p[1], 0) / against.length,
  ];
  let out = [...poly];
  for (let i = 0; i < against.length && out.length >= 3; i++) {
    const a = against[i]!;
    const b = against[(i + 1) % against.length]!;
    let edge: Line;
    try {
      edge = lineThroughPoints(a, b) as Line;
    } catch {
      continue;
    }
    // The half-plane the polygon itself lies in, which winding settles.
    const keepSide = signedDistance(edge, middle) >= 0
      ? edge
      : { normal: [-edge.normal[0], -edge.normal[1]] as Vec2, offset: -edge.offset };
    out = clipHalfPlane(out, keepSide);
  }
  return out;
}

/** Is the point inside this outline? Faces are convex, so this is exact. */
function inPolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1])
      && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  return inside;
}

/**
 * Put the faces back in order after a fold.
 *
 * The flap turns over, so the faces that travelled invert among themselves,
 * and a valley lays them on what stayed put while a mountain slides them
 * under. But only where they actually land on it: paper that comes to rest
 * somewhere else has no stacking relation to the paper it never touches, and
 * moving the whole flap to the top or the bottom of the pile invents one.
 *
 * That invention showed up as an aeroplane whose two wings sat at different
 * heights. They are mirror images and they do not overlap each other at all,
 * so nothing decides their order - but one fold had sent its wing to the top
 * of the list and the other had sent its wing to the bottom, and the thickness
 * each then stood off by was counted from a different depth of pile. Faces
 * that meet nothing keep the place they had.
 */
function restack(
  result: ReturnType<typeof addCreases>,
  previous: readonly number[],
  sense: FoldSense,
  creaseOnly: boolean,
  /** How far the flap closed; only a flap that comes back down turns over. */
  angleDeg: number,
  /** Tuck the flap inside, under the paper that lay over it. */
  tuck = false,
  /** A reverse fold, with which source faces are the flap's back half. */
  reverseOf?: { kind: 'inside' | 'outside'; backOf: readonly boolean[] },
): number[] {
  const rank = new Map<number, number>();
  previous.forEach((face, position) => rank.set(face, position));
  const was = (i: number) => rank.get(result.faces_source[i]!) ?? 0;
  const byOldPosition = (a: number, b: number) => was(a) - was(b);

  const all = result.faces_source.map((_, i) => i);
  if (creaseOnly) return all.sort(byOldPosition);

  const stayed = all.filter((i) => !result.faces_moving[i]!);
  const moved = all.filter((i) => result.faces_moving[i]!);
  if (moved.length === 0 || stayed.length === 0) return all.sort(byOldPosition);

  /*
   * The whole flap moves together.
   *
   * Placing each face only against the paper it actually overlaps is the truer
   * rule - a wing folded out to the side of a model meets none of the paper it
   * was cut from, and sending it to the top of the pile invents a relation
   * that is not there. Three ways of doing that were tried and every one put
   * the dart's own folds through each other: the pile cannot be reordered
   * piecemeal, because the order has to satisfy every fold at once. That wants
   * the ordering SEARCHED rather than assigned fold by fold, which is a larger
   * job and is what `layers.ts` audits for rather than solves.
   *
   * The cost of leaving it is visible: an aeroplane's two wings are mirror
   * images, and because one fold sends its wing to the top of the list while
   * the other sends its wing to the bottom, they stand off by different depths
   * of pile and sit at slightly different heights.
   */
  /*
   * A flap turns its pile over whichever way it goes and however far.
   *
   * The pile here is the layout's - the model folded flat - so a flap stopped
   * at ninety degrees is stacked as if it had come right over. This used to
   * keep the order of a flap swung away at ninety, to make a wing folded
   * toward you and its partner folded away come out matching. That was
   * compensating for turning the model over drawing its mirror image: with the
   * turn a real turn, folding away is the same move as turning over, folding
   * toward you and turning back, and that move inverts the flap like any
   * other. Keeping the order made the two routes to one aeroplane stack its
   * wings differently. Which way up a wing's plies read in the air is the
   * drawing's business (renderFaces), not the pile's.
   */
  const inOrder = moved.slice().sort(byOldPosition).reverse();
  const rest = stayed.slice().sort(byOldPosition);
  /*
   * A reverse fold: each half of the flap turns over against its own half of
   * the model. Inside, the back's layers land just above the back of the model
   * and the front's just below its front, so both are between the halves;
   * outside, they wrap round the back and the front.
   */
  if (reverseOf) {
    const isBack = (i: number) => reverseOf.backOf[result.faces_source[i]!] ?? false;
    const back = moved.filter(isBack).sort(byOldPosition).reverse();
    const front = moved.filter((i) => !isBack(i)).sort(byOldPosition).reverse();
    const ranks = (list: number[]) => list.map(was);
    const cut = back.length && front.length
      ? (Math.max(...ranks(back)) + Math.min(...ranks(front))) / 2
      : ranks(moved).sort((a, b) => a - b)[Math.floor(moved.length / 2)]!;
    const low = rest.filter((i) => was(i) < cut);
    const high = rest.filter((i) => was(i) >= cut);
    return reverseOf.kind === 'inside'
      ? [...low, ...back, ...front, ...high]
      : [...back, ...low, ...high, ...front];
  }
  /*
   * A point tucked inside: against the paper it was lying on, not over the
   * paper lying on it.
   *
   * Normally a flap folded toward you lands on top of the pile. A lock is the
   * exception: the back layer's point comes forward, meets the back of the
   * front layers, and ends up between the two (the Transition's ninth step).
   * Only a fold that asks for it is stacked this way; doing it for every fold
   * reordered the existing aeroplanes into piles the search could not settle.
   */
  if (tuck) {
    /*
     * Right over the paper it is joined to along the fold - that is what it
     * swings against and cannot get past. Its place in the list says nothing
     * here: a point unfolded out beyond the model shares its spot with no
     * other paper, so the list could have it anywhere.
     */
    const joined = new Set<number>();
    for (const [face, links] of faceAdjacency(result.graph)) {
      if (!result.faces_moving[face]) continue;
      for (const { face: other } of links) if (!result.faces_moving[other]) joined.add(other);
    }
    if (joined.size > 0) {
      const anchor = Math.max(...[...joined].map(was));
      const below = rest.filter((i) => was(i) <= anchor).length;
      return [...rest.slice(0, below), ...inOrder, ...rest.slice(below)];
    }
  }
  return sense === 'valley' ? [...rest, ...inOrder] : [...inOrder, ...rest];
}


/**
 * Press creases whose place on the sheet is already known, moving nothing.
 *
 * A crease made on folded paper lands on the sheet as several pieces - one
 * for each ply the line went through, each where that ply had been carried.
 * Open the fold beneath it and those pieces stay exactly where they are on
 * the paper; what changes is only where the paper now lies. Pressed again as
 * one line in the view, the crease would be recomputed on the opened paper and
 * come out as a different line - the V a corner leaves across a halved sheet
 * came back straight. So each piece is pressed as itself, on the sheet, into
 * the faces it crosses and no others.
 */
export function pressSheetCreases(
  state: FoldedState,
  pieces: readonly { readonly a: Vec2; readonly b: Vec2 }[],
): FoldedState {
  let out = state;
  for (const piece of pieces) {
    const len = Math.hypot(piece.b[0] - piece.a[0], piece.b[1] - piece.a[1]);
    if (!(len > 1e-9)) continue;
    const line = lineThroughPoints(piece.a, piece.b);
    const g = out.graph;
    const crosses = g.faces_vertices.map((vs) => pieceCrossesFace(vs.map((v) => g.vertices_coords[v]!), piece));
    const result = addCreases(g, (face) => (crosses[face] ? line : null), 'flat', 0);
    const rank = new Map<number, number>();
    out.faces_order.forEach((face, position) => rank.set(face, position));
    const was = (i: number) => rank.get(result.faces_source[i]!) ?? 0;
    out = {
      graph: result.graph,
      faces_matrix: result.faces_source.map((src) => out.faces_matrix[src]!),
      faces_order: result.faces_source.map((_, i) => i).sort((x, y) => was(x) - was(y)),
      faces_bent: result.faces_source.map((src) => out.faces_bent?.[src] ?? false),
    };
  }
  return out;
}

/** Whether a stretch of the segment lies inside the (convex) face. */
function pieceCrossesFace(poly: readonly Vec2[], piece: { readonly a: Vec2; readonly b: Vec2 }): boolean {
  const d: Vec2 = [piece.b[0] - piece.a[0], piece.b[1] - piece.a[1]];
  let lo = 0;
  let hi = 1;
  // Clip the segment against each edge's inner half-plane (either winding).
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const turn = area >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    const e: Vec2 = [q[0] - p[0], q[1] - p[1]];
    // Inside means to the left of an anticlockwise edge.
    const side = (x: Vec2) => turn * (e[0] * (x[1] - p[1]) - e[1] * (x[0] - p[0]));
    const s0 = side(piece.a);
    const s1 = side([piece.a[0] + d[0], piece.a[1] + d[1]]);
    const ds = s1 - s0;
    if (Math.abs(ds) < 1e-15) { if (s0 < -1e-12) return false; continue; }
    const t = -s0 / ds;
    if (ds > 0) lo = Math.max(lo, t); else hi = Math.min(hi, t);
    if (hi - lo <= 1e-9) return false;
  }
  return (hi - lo) * Math.hypot(d[0], d[1]) > 1e-7;
}

/** Fold along the line through two points; `movingSide` says which half travels. */
export function foldThroughPoints(
  state: FoldedState,
  a: Vec2,
  b: Vec2,
  movingSide: Vec2,
  sense: FoldSense,
  options: FoldOptions = {},
): FoldedState {
  let line = lineThroughPoints(a, b) as Line;
  if (signedDistance(line, movingSide) < 0) {
    line = { normal: [-line.normal[0], -line.normal[1]], offset: -line.offset };
  }
  return foldAlong(state, line, sense, options);
}

/** Total paper in the state; folding must never change it. */
export const paperArea = (state: FoldedState): number =>
  state.graph.faces_vertices.reduce((t, f) => t + Math.abs(faceArea(state.graph, f)), 0);

/** How many faces lie over a point of the folded view: the local thickness. */
export function plyCountAt(state: FoldedState, p: Vec2): number {
  let count = 0;
  for (let f = 0; f < state.graph.faces_vertices.length; f++) {
    const poly = faceOutline(state, f);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const u = poly[i]!;
      const v = poly[j]!;
      if ((u[1] > p[1]) !== (v[1] > p[1])) {
        const x = u[0] + ((p[1] - u[1]) / (v[1] - u[1])) * (v[0] - u[0]);
        if (p[0] < x) inside = !inside;
      }
    }
    if (inside) count++;
  }
  return count;
}

/** Whether a face shows its front or back, which a fold turns over. */
export const faceIsFlipped = (state: FoldedState, face: number): boolean =>
  affineIsMirrored(state.faces_matrix[face]!);

/**
 * Turn the whole model over.
 *
 * Paper is only ever folded one way - toward you - and everything else is done
 * by turning the model over first. So this is not a fold at all: the paper is
 * untouched, no crease is made, no angle changes. What changes is which side
 * faces you, and that is two things at once - the view is handed the other way
 * round, and the pile is seen from the bottom, so its order reverses.
 *
 * Every fold made afterwards is then a valley again, and comes out a mountain
 * on the side you started from, which is exactly what happens on a table.
 *
 * The creases do not change. A crease's angle belongs to the paper, measured
 * from the sheet's own front, and turning the model over is a rigid motion no
 * crease can feel. This used to flip every angle and swap every mountain for a
 * valley, which together with the layout's own mirror made the turned model a
 * reflection rather than the same model seen from underneath. While every fold
 * lay flat the two cannot be told apart; once a wing stood at ninety degrees
 * they can - it stayed pointing up after the turn - and a wing folded toward
 * you on the other side then went the same way as the first, so the only way
 * to finish an aeroplane was a mountain fold no pair of hands makes.
 */
export function flipOver(state: FoldedState): FoldedState {
  let lo = Infinity;
  let hi = -Infinity;
  state.graph.faces_vertices.forEach((_, face) => {
    for (const p of faceOutline(state, face)) {
      lo = Math.min(lo, p[0]);
      hi = Math.max(hi, p[0]);
    }
  });
  if (!(hi > lo)) return state;
  // Turned about its own middle, so the model stays where it is on screen.
  const axis = (lo + hi) / 2;
  const mirror: Affine = [-1, 0, 0, 1, 2 * axis, 0];

  return {
    graph: state.graph,
    faces_matrix: state.faces_matrix.map((m) => affineMul(mirror, m)),
    faces_order: [...state.faces_order].reverse(),
    faces_bent: state.faces_bent,
  };
}

/**
 * The crease a flap would turn on, and where it would go.
 *
 * Pointing at a piece of paper and saying "fold that over" is how anyone
 * describes origami out loud, and it is unambiguous whenever the piece is a
 * flap: bounded by creases on one side and the edge of the sheet on the
 * others. When several creases bound it, the one shared with the largest
 * neighbour is the hinge - you fold the flap onto the body, not the body onto
 * the flap.
 *
 * Returns the hinge in FOLDED VIEW coordinates, which is what a fold step
 * speaks, along with a point inside the piece that travels.
 */
export function flapAt(
  state: FoldedState,
  face: number,
): { a: Vec2; b: Vec2; inside: Vec2 } | null {
  const adjacency = faceAdjacency(state.graph);
  let best: { edge: number; area: number } | null = null;
  for (const { face: other, edge } of adjacency.get(face) ?? []) {
    const kind = state.graph.edges_assignment[edge];
    if (kind === 'boundary') continue;
    const area = Math.abs(faceArea(state.graph, state.graph.faces_vertices[other]!));
    if (!best || area > best.area) best = { edge, area };
  }
  if (!best) return null;

  const [u, v] = state.graph.edges_vertices[best.edge]!;
  const matrix = state.faces_matrix[face]!;
  const outline = faceOutline(state, face);
  const centre = outline.reduce(
    (t, p) => [t[0] + p[0] / outline.length, t[1] + p[1] / outline.length] as Vec2,
    [0, 0] as Vec2,
  );
  return {
    a: affineApply(matrix, state.graph.vertices_coords[u]!),
    b: affineApply(matrix, state.graph.vertices_coords[v]!),
    inside: centre,
  };
}

/** Which face of the folded view a point lands on, topmost first. */
export function faceUnder(state: FoldedState, p: Vec2, tol = 1e-9): number | null {
  for (let i = state.faces_order.length - 1; i >= 0; i--) {
    const face = state.faces_order[i]!;
    const poly = faceOutline(state, face);
    let inside = false;
    let nearest = Infinity;
    for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
      const u = poly[a]!;
      const v = poly[b]!;
      if ((u[1] > p[1]) !== (v[1] > p[1])) {
        const x = u[0] + ((p[1] - u[1]) / (v[1] - u[1])) * (v[0] - u[0]);
        if (p[0] < x) inside = !inside;
      }
      const dx = v[0] - u[0];
      const dy = v[1] - u[1];
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / len2))
        : 0;
      nearest = Math.min(nearest, Math.hypot(p[0] - (u[0] + t * dx), p[1] - (u[1] + t * dy)));
    }
    if (inside || nearest <= tol) return face;
  }
  return null;
}
