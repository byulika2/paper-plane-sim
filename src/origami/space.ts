/**
 * The folded model in three dimensions.
 *
 * With a crease pattern there is nothing to simulate: the shape follows from
 * the angles. Start at one face, then walk out across the hinges, turning each
 * neighbour about the edge they share by that edge's fold angle. Because every
 * face is reached through the paper rather than placed independently, the model
 * cannot come apart, and a crease can never end up in two places at once.
 *
 * This is what replaces reflecting each ply on its own: there is one hinge per
 * crease and one angle on it, so the handedness questions that dogged the ply
 * model do not arise.
 */

import { affineApply, affineInverse, lineToLocal, pointInPolygon, signedDistance } from '../geometry/fold.js';
import type { Line } from '../geometry/fold.js';
import {
  applyRigid, composeRigid, invertRigid, rigidIdentity, rotateRigid, rotationAbout,
  sub, unit,
} from '../geometry/math.js';
import type { Rigid, Vec2, Vec3 } from '../geometry/math.js';
import { faceAdjacency, faceArea } from './graph.js';
import type { FoldedState } from './folding.js';

const embed = (p: Vec2): Vec3 => [p[0], p[1], 0];

/** Near enough to be resting on it: a few sheets of paper, never a fold away. */
const CONTACT = 0.002;

export interface SpatialFace {
  /** Outline in three dimensions, metres. */
  readonly points: readonly Vec3[];
  /** Sheet coordinates to space. */
  readonly transform: Rigid;
  readonly face: number;
}

/*
 * A model's placement in space, worked out once. States are never changed in
 * place, so the state itself is the key; a preview asks for the same one on
 * every frame of hovering.
 */
const spaceCache = new WeakMap<FoldedState, SpatialFace[]>();
function spaceOf(state: FoldedState): SpatialFace[] {
  let spatial = spaceCache.get(state);
  if (!spatial) { spatial = foldInSpace(state); spaceCache.set(state, spatial); }
  return spatial;
}

/** The pose the face holding a given sheet point has in a model. */
function heldPose(state: FoldedState): (q: Vec2) => Rigid | null {
  const spatial = spaceOf(state);
  const loops = state.graph.faces_vertices.map((loop) =>
    loop.map((v) => state.graph.vertices_coords[v]!));
  return (q) => {
    const f = loops.findIndex((loop) => pointInPolygon(loop, q));
    return f >= 0 ? spatial[f]!.transform : null;
  };
}

/**
 * A point well inside a convex face: the centroid of its corners.
 *
 * Faces of a folded sheet are convex (every one is the sheet cut by straight
 * lines), so this is inside - and inside, not on an edge, is what makes the
 * lookup in another model land on one face rather than on a boundary.
 */
function interiorPoint(loop: readonly Vec2[]): Vec2 | null {
  if (loop.length < 3) return null;
  let x = 0;
  let y = 0;
  for (const p of loop) { x += p[0]; y += p[1]; }
  return [x / loop.length, y / loop.length];
}

/**
 * Place every face in space by walking the hinges out from one of them.
 *
 * The angle on an edge says how far the two faces sharing it turn apart. Which
 * way round that is depends on which side you approach from, and the edge's
 * direction as it runs through the current face's own loop settles it.
 */
export function foldInSpace(state: FoldedState, hold?: FoldedState): SpatialFace[] {
  const { graph } = state;
  const count = graph.faces_vertices.length;
  const adjacency = faceAdjacency(graph);
  const placed = new Array<Rigid | null>(count).fill(null);

  /*
   * Start the walk from the paper that is holding still.
   *
   * The seed face is the one left where it is; everything else is placed
   * relative to it. Start from the flap and the arithmetic is just as correct,
   * but what you see is the flap sitting motionless while the whole model
   * swings round behind it - which is not what folding paper looks like. You
   * hold the sheet and move the flap.
   *
   * Which paper is holding still is not a guess: the fold that produced this
   * state recorded it. Among the faces that did not travel, the largest is the
   * body, and it is the same face from one step to the next, so the view does
   * not jump either. Guessing from handedness - the largest piece never turned
   * over - was close but not the same thing, and it picked the flap often
   * enough that the model still swung round.
   */
  const order = graph.faces_vertices.map((_, i) => i).sort((a, b) => {
    const travelled = (f: number) => (state.faces_moved?.[f] ? 1 : 0);
    // Paper never bent part way lies in the layout where it is in the air.
    const bent = (f: number) => (state.faces_bent?.[f] ? 1 : 0);
    const size = (f: number) => Math.abs(faceArea(graph, graph.faces_vertices[f]!));
    return travelled(a) - travelled(b) || bent(a) - bent(b) || size(b) - size(a);
  });

  /*
   * The first face goes where the flat layout has it, not where the sheet had it.
   *
   * Placed at the sheet's own coordinates, the whole model came out in the
   * frame of whichever face the walk happened to start from - and when that
   * face had been turned over, the model was drawn as its mirror image. That
   * showed while a fold was being set up: the half that would travel counts as
   * moving, so a different face was chosen to hold still, and the model jumped
   * across its own spine on screen. The paper the user meant to point at was
   * no longer under the pointer, and the fold went the wrong way. Put where the
   * layout puts it - turned over, if it has been - every choice of first face
   * draws the same model.
   */
  const layoutPose = (face: number): Rigid => {
    const m = state.faces_matrix[face];
    if (!m) return rigidIdentity;
    const det = m[0] * m[3] - m[1] * m[2] < 0 ? -1 : 1;
    return { r: [m[0], m[2], 0, m[1], m[3], 0, 0, 0, det], t: [m[4], m[5], 0] };
  };
  /*
   * ...except in a preview, where nothing is the layout's to decide.
   *
   * The layout rule holds only while every crease lies flat. A wing held at
   * ninety degrees sits in the layout where a flat fold would have put it, and
   * a fold appended on the same line re-reads that crease - so the preview of
   * the Triangle's second wing laid the first wing flat, exactly where the
   * second one was. Pointing at the second wing then caught the first, and the
   * fold took the wrong half; nothing on screen said so.
   *
   * A preview is a fold of zero degrees: by definition no paper has moved. So
   * given the model as it stands, every face is put where that model has it,
   * found by a point of the sheet - which no fold renumbers. The walk below
   * only fills in a face the lookup could not place.
   */
  const queued: number[] = [];
  if (hold) {
    const held = heldPose(hold);
    graph.faces_vertices.forEach((loop, face) => {
      const inside = interiorPoint(loop.map((v) => graph.vertices_coords[v]!));
      const pose = inside ? held(inside) : null;
      if (pose) { placed[face] = pose; queued.push(face); }
    });
  }
  const walk = (queue: number[]) => {
    while (queue.length > 0) {
      const here = queue.shift()!;
      const transform = placed[here]!;
      const loop = graph.faces_vertices[here]!;

      for (const { face: there, edge } of adjacency.get(here) ?? []) {
        if (placed[there]) continue;
        const [u, v] = graph.edges_vertices[edge]!;

        // Take the hinge in the direction it runs through this face, so that
        // crossing it from either side gives the same result.
        let from = u;
        let to = v;
        for (let i = 0; i < loop.length; i++) {
          if (loop[i] === v && loop[(i + 1) % loop.length] === u) {
            from = v; to = u; break;
          }
        }

        const p0 = applyRigid(transform, embed(graph.vertices_coords[from]!));
        const p1 = applyRigid(transform, embed(graph.vertices_coords[to]!));
        const angle = graph.edges_foldAngle[edge] ?? 0;
        placed[there] = angle === 0
          ? transform
          : composeRigid(rotationAbout(p0, sub(p1, p0), angle), transform);
        queue.push(there);
      }
    }
  };
  walk(queued);
  for (const seed of order) {
    if (placed[seed]) continue;
    placed[seed] = layoutPose(seed);
    walk([seed]);
  }

  return graph.faces_vertices.map((loop, face) => {
    const transform = placed[face] ?? rigidIdentity;
    return {
      face,
      transform,
      points: loop.map((v) => applyRigid(transform, embed(graph.vertices_coords[v]!))),
    };
  });
}

/** Creases in the flat pattern, with how each one folds. */
export interface PatternCrease {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly assignment: 'mountain' | 'valley' | 'flat';
  readonly angleDeg: number;
}

export function patternCreases(state: FoldedState): PatternCrease[] {
  const out: PatternCrease[] = [];
  state.graph.edges_vertices.forEach(([u, v], i) => {
    const assignment = state.graph.edges_assignment[i]!;
    if (assignment === 'boundary') return;
    out.push({
      a: state.graph.vertices_coords[u]!,
      b: state.graph.vertices_coords[v]!,
      assignment,
      angleDeg: Math.abs(((state.graph.edges_foldAngle[i] ?? 0) * 180) / Math.PI),
    });
  });
  return out;
}

/** Creases where they appear in the folded view, for drawing on the draft. */
export function viewCreases(state: FoldedState): Array<{ a: Vec2; b: Vec2 }> {
  const seen = new Set<string>();
  const out: Array<{ a: Vec2; b: Vec2 }> = [];
  const adjacency = faceAdjacency(state.graph);

  state.graph.faces_vertices.forEach((_, face) => {
    for (const { edge } of adjacency.get(face) ?? []) {
      if (state.graph.edges_assignment[edge] === 'boundary') continue;
      const [u, v] = state.graph.edges_vertices[edge]!;
      const matrix = state.faces_matrix[face]!;
      const a = affineApply(matrix, state.graph.vertices_coords[u]!);
      const b = affineApply(matrix, state.graph.vertices_coords[v]!);
      const key = [a, b].map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b });
    }
  });
  return out;
}

/**
 * The spatial faces in the shape the renderer already speaks.
 *
 * It asks for an outline in space, a normal, and which way up the face is; all
 * of that falls out of the walk, so the drawing code needs no changes.
 */
export interface RenderFace {
  readonly points: readonly Vec3[];
  readonly outline: readonly Vec2[];
  readonly area: number;
  readonly stack: number;
  readonly normal: Vec3;
  /**
   * How far this face was raised for its own thickness, as a vector.
   *
   * Anything drawn ON the paper has to be raised with it. The marks are placed
   * by the same hinge walk but from the mathematical surface, which has no
   * thickness at all - so without this the creases stayed on the surface while
   * the paper rose off it, and a folded model showed its guide lines floating
   * clear of the sheet they were pressed into.
   */
  readonly lift: Vec3;
  readonly mirrored: boolean;
  readonly movedBy: number;
  /** Which face of the crease pattern this is. */
  readonly face: number;
  /**
   * Sheet coordinates to space, and its inverse.
   *
   * Going back the other way is what lets the model be folded by pointing at
   * it: a point picked off the screen lands on a face, the inverse puts it
   * back on that face's own paper, and the fold machinery - which has always
   * spoken in paper coordinates - needs to know nothing about the camera.
   */
  readonly transform: Rigid;
  readonly inverse: Rigid;
  /**
   * How many plies of paper lie stacked where this face is, itself included:
   * the faces lying flat against it, above and below. Where they differ across
   * the face, the thickest part.
   */
  readonly pile: number;
}

/**
 * Whether the paper at a point of the sheet faces the viewer the other way
 * round from the layout.
 *
 * The layout is the model folded flat, and a fold's sense is worked there:
 * a valley brings paper toward the layout's top. For most of a model that is
 * toward you. For a wing held out at ninety degrees it can be away - the
 * layout has that wing folded flat onto the body, face down - and a valley
 * then folds the paper away from you, in the one place you can see it most
 * plainly: an aeroplane's two winglets, folded the same way, came out one up
 * and one down. True means "a fold toward you here is a mountain in the
 * layout". Null when the point is on no face or the face stands edge-on.
 */
export function turnedFromViewerAt(
  state: FoldedState,
  sheet: Vec2,
  /**
   * Which way is toward the viewer, in the model's own coordinates. Straight
   * up off the table (-z) unless the drawing has stood the model up some other
   * way - the flight attitude - in which case "toward you" goes with it.
   */
  toward: Vec3 = [0, 0, -1],
): boolean | null {
  const spatial = spaceOf(state);
  const face = state.graph.faces_vertices.findIndex((loop) =>
    pointInPolygon(loop.map((v) => state.graph.vertices_coords[v]!), sheet));
  if (face < 0) return null;
  const normal = rotateRigid(spatial[face]!.transform, [0, 0, 1]);
  const facing = normal[0] * toward[0] + normal[1] * toward[1] + normal[2] * toward[2];
  if (Math.abs(facing) < 0.5) return null;
  const m = state.faces_matrix[face]!;
  const turned = m[0] * m[3] - m[1] * m[2] < 0;
  // The layout's top is -normal for a face the right way round, +normal for
  // one turned over - the same reading as the pile's.
  return (turned ? facing : -facing) < 0;
}

/**
 * Give every ply its own thickness.
 *
 * A flat fold puts two faces in the same plane, and paper of no thickness put
 * there twice is not paper: the two fight for the same pixels and the model
 * comes out looking slashed where it is in fact simply doubled. Real paper
 * solves this by being 0.1mm thick, so the model does too - each face is lifted
 * off the one below by its depth in the stack.
 *
 * A fold turns a face over, so its own outward normal points the other way;
 * the sign keeps the whole pile growing in one direction.
 *
 * That direction is the sheet's own MINUS z, because that is the way the view
 * faces: paper +z points away from a camera looking down at the table. Getting
 * this backwards buried the pile instead of raising it - a flap folded flat
 * went UNDER the paper it had just been folded onto, so the body's white face
 * covered it and a finished fold left no trace, while the same fold held at
 * 170 degrees showed its darker back perfectly well.
 *
 * How FAR a face rises is not its place in the order but how much paper is
 * actually under it THERE. A model with fifty faces has faces near the top of
 * the order lying by themselves out at the wing tip, with nothing beneath them
 * at all; raising those by fifty calipers tore them off the paper they are
 * joined to, and the model came apart into slices with daylight between them.
 * Paper only stands off what it is resting on.
 */
function liftEachBy(
  points: readonly Vec3[],
  normal: Vec3,
  rises: readonly number[],
): Vec3[] {
  if (rises.every((r) => r === 0)) return points as Vec3[];
  return points.map((p, k) => {
    const rise = rises[k] ?? 0;
    return [
      p[0] + normal[0] * rise,
      p[1] + normal[1] * rise,
      p[2] + normal[2] * rise,
    ] as Vec3;
  });
}

export function renderFaces(
  state: FoldedState,
  movedBy = -1,
  /** Caliper of one ply, metres. Zero draws the mathematical surface. */
  caliper = 0,
  /** The model as it stands, when this one is a preview of it; see foldInSpace. */
  hold?: FoldedState,
): RenderFace[] {
  const pose = foldInSpace(state, hold);
  /*
   * The pile is worked out on the model as it rests, then carried to the pose.
   *
   * How much paper lies under a face, and which way its pile grows, depend on
   * which faces lie flat against which - and in the drawing's own pose, which
   * keeps the body still while the wings are raised, a finished aeroplane
   * lies on its side with its wings on edge. Worked out there, the two sides
   * of the nose were stacked by different rules and one came out a ply higher
   * than the other, seen head-on. On the model resting on its wings the two
   * sides are mirror images, and a rise measured along a face's own normal
   * means the same thing in any pose, so it is measured there and applied here.
   */
  const spatial = state.faces_bent ? foldInSpace(restingPose(state)) : pose;
  const position = new Map<number, number>();
  state.faces_order.forEach((face, i) => position.set(face, i));

  /*
   * How many faces lie under each one, where the paper actually is.
   *
   * Counted in space, not in the flattened layout. A wing held at ninety
   * degrees is drawn lying flat in the crease pattern, so measured there the
   * whole model piles up on itself - a dart came out fourteen plies thick at a
   * place the app itself reports as four. Paper only rests on paper it is
   * lying against: facing the same way, in the same plane, and actually
   * underneath.
   */
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const middle = (pts: readonly Vec3[]): Vec3 => {
    const n = Math.max(1, pts.length);
    return [pts.reduce((a, q) => a + q[0], 0) / n, pts.reduce((a, q) => a + q[1], 0) / n,
      pts.reduce((a, q) => a + q[2], 0) / n];
  };
  const centres = spatial.map((f) => middle(f.points));
  const normals = spatial.map((f) => unit(rotateRigid(f.transform, [0, 0, 1])));
  /*
   * Which paper is under which, read the right way up for each face.
   *
   * The pile's order is the layout's, and the layout is read from its own top.
   * A wing is drawn there folded flat onto the body, so for one of an
   * aeroplane's two wings the layout's top is the side facing away from you:
   * its plies are in the right order counted from the other end. Read
   * straight, that wing was drawn with its innermost ply outermost - the other
   * face of the paper showing, on one wing only. So the order is turned round
   * for a face whose layout top points away from the viewer; which way that is
   * follows from whether the layout has it turned over and which way it faces
   * in the air. The pile itself still grows toward the viewer, below.
   */
  const rank = spatial.map((f, i) => {
    const r = position.get(f.face) ?? 0;
    const m = state.faces_matrix[f.face]!;
    const turned = m[0] * m[3] - m[1] * m[2] < 0;
    const nz = normals[i]![2];
    if (Math.abs(nz) < 1e-6) return r;
    // The layout's top is -normal for a face the right way round, +normal for
    // one turned over; the viewer is toward -z.
    const topTowardViewer = (turned ? nz : -nz) < 0;
    return topTowardViewer ? r : -r;
  });

  /*
   * Counted corner by corner, not once for the whole face.
   *
   * How much paper is underneath is not the same everywhere on a face. A wing
   * is lying on the whole fuselage at its root and on nothing at all at its
   * tip, and raising all of it by the root's depth lifted the tip with it - so
   * the two wings of an aeroplane, which meet at the tips, were left a
   * millimetre apart there. Real paper does not do that: it rides up over the
   * thick part and comes back down, which is what lifting each corner by what
   * is under THAT corner gives.
   */
  /*
   * Which storey of the pile each face is on: one above the highest face it
   * lies on, anywhere.
   *
   * Counting the faces under each corner, as it used to, gave a face over a
   * pocket a lower corner than the face beneath it - under one corner lay
   * three small faces, under the other one big one - and the two passed
   * through each other: the back of the paper came through the front in a
   * saw-toothed grey, on one side of a symmetric plane and not the other.
   * By storeys, a face that lies on another is always at least one higher.
   */
  const touching = (i: number, j: number) => Math.abs(dot(normals[i]!, normals[j]!)) >= 0.99
    && Math.abs(dot(normals[i]!, sub3(centres[i]!, centres[j]!))) <= CONTACT;
  const probesOf = spatial.map((f, i) => [centres[i]!, ...f.points.map((q): Vec3 => [
    q[0] + (centres[i]![0] - q[0]) * 0.05, q[1] + (centres[i]![1] - q[1]) * 0.05, q[2] + (centres[i]![2] - q[2]) * 0.05,
  ])]);
  const overlaps = (i: number, j: number) => probesOf[i]!.some((p) => coversPoint(spatial[j]!.points, normals[j]!, p))
    || probesOf[j]!.some((p) => coversPoint(spatial[i]!.points, normals[i]!, p));
  const storey = new Array<number>(spatial.length).fill(0);
  const upward = spatial.map((_, i) => i).sort((a, b) => rank[a]! - rank[b]!);
  upward.forEach((i, at) => {
    for (let t = 0; t < at; t++) {
      const j = upward[t]!;
      if (rank[j]! >= rank[i]! || !touching(i, j) || !overlaps(i, j)) continue;
      storey[i] = Math.max(storey[i]!, storey[j]! + 1);
    }
  });

  const underCorner = spatial.map((f, i) => f.points.map((corner, k) => {
    /*
     * Asked a hair inside the corner rather than at it - on both sides.
     *
     * Creases line up, so a face's corners sit exactly on the edges of the
     * paper beneath them, and a point on a boundary belongs to neither side.
     * Asked there, a face lying squarely on a pile was told nothing was under
     * it at all and stayed level with what it was resting on.
     *
     * One point toward the middle was not enough either: on a right-angled
     * ear that direction runs straight along a crease of the paper below, so
     * the answer was rounding - and the two ears of the Dropship, the same
     * fold made on each side, came out a ply apart at the same corner. Two
     * points, one leaning toward each neighbouring corner, straddle any line
     * through the corner; paper under either is under the corner, since the
     * sheet rides up over the thicker side.
     */
    const pts = f.points;
    const prev = pts[(k + pts.length - 1) % pts.length]!;
    const next = pts[(k + 1) % pts.length]!;
    const lean = (a: Vec3, b: Vec3): Vec3 => [
      corner[0] + (a[0] - corner[0]) * 0.03 + (b[0] - corner[0]) * 0.01,
      corner[1] + (a[1] - corner[1]) * 0.03 + (b[1] - corner[1]) * 0.01,
      corner[2] + (a[2] - corner[2]) * 0.03 + (b[2] - corner[2]) * 0.01,
    ];
    const probes = [lean(prev, next), lean(next, prev)];
    // Standing on the highest storey under the corner, not on a count of them.
    let count = 0;
    for (let j = 0; j < spatial.length; j++) {
      if (j === i || rank[j]! >= rank[i]!) continue;
      if (!touching(i, j)) continue;
      if (probes.some((p) => coversPoint(spatial[j]!.points, normals[j]!, p))) count = Math.max(count, storey[j]! + 1);
    }
    return count;
  }));

  /*
   * A pile standing on edge is centred on where it stands.
   *
   * A pile lying down grows up off the table, which is right: paper rests on
   * paper. The keel stands on edge, its two sides pressed together on the
   * aeroplane's middle, and grown the same way it went all to one side - a
   * body half a centimetre off the middle, the wings joined to one edge of it.
   * Each side's paper lies on its own side of the middle, so a standing pile
   * is moved back by half its height.
   */
  const standing = normals.map((n) => Math.abs(n[2]) < 0.35);
  const group = spatial.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i]!)));
  for (let i = 0; i < spatial.length; i++) {
    if (!standing[i]) continue;
    for (let j = i + 1; j < spatial.length; j++) {
      if (standing[j] && touching(i, j) && overlaps(i, j)) group[root(i)] = root(j);
    }
  }
  const tallest = new Map<number, number>();
  for (let i = 0; i < spatial.length; i++) {
    if (!standing[i]) continue;
    const top = Math.max(storey[i]!, ...underCorner[i]!);
    tallest.set(root(i), Math.max(tallest.get(root(i)) ?? 0, top));
  }
  const settle = spatial.map((_, i) => (standing[i] ? (tallest.get(root(i)) ?? 0) / 2 : 0));
  const settleAt = new Map(spatial.map((f, i) => [f.face, settle[i]!]));

  const underAt = new Map(spatial.map((f, i) => [f.face, underCorner[i]!]));
  const storeyAt = new Map(spatial.map((f, i) => [f.face, storey[i]!]));

  /*
   * The whole pile at each face, for shading paper by how thick it is there.
   *
   * Asked a little way in toward each corner and the thickest answer kept:
   * one point in the middle can land on the edge of the paper below, and the
   * set of points is the same for a face and its mirror image, so two sides
   * of an aeroplane shade alike.
   */
  const pileAt = spatial.map((f, i) => {
    const middle = centres[i]!;
    let most = 1;
    for (const corner of f.points) {
      const p: Vec3 = [
        middle[0] + (corner[0] - middle[0]) * 0.1,
        middle[1] + (corner[1] - middle[1]) * 0.1,
        middle[2] + (corner[2] - middle[2]) * 0.1,
      ];
      let count = 1;
      for (let j = 0; j < spatial.length; j++) {
        if (j === i) continue;
        if (Math.abs(dot(normals[i]!, normals[j]!)) < 0.99) continue;
        if (Math.abs(dot(normals[i]!, sub3(centres[i]!, centres[j]!))) > CONTACT) continue;
        if (coversPoint(spatial[j]!.points, normals[j]!, p)) count++;
      }
      most = Math.max(most, count);
    }
    return most;
  });

  return spatial.map((f, index) => {
    const shown = pose[index]!;
    const loop = state.graph.faces_vertices[f.face]!;
    const outline = loop.map((v) => state.graph.vertices_coords[v]!);
    let twice = 0;
    for (let i = 0; i < outline.length; i++) {
      const p = outline[i]!;
      const q = outline[(i + 1) % outline.length]!;
      twice += p[0] * q[1] - q[0] * p[1];
    }
    const matrix = state.faces_matrix[f.face]!;
    const mirrored = matrix[0] * matrix[3] - matrix[1] * matrix[2] < 0;
    const normal = unit(rotateRigid(f.transform, [0, 0, 1]));
    const stack = position.get(f.face) ?? 0;
    /*
     * Which way the pile grows, taken from where the paper actually faces.
     *
     * It used to be read off `mirrored`, which says the flat LAYOUT is a
     * reflection - a different question, and on a model with any depth the two
     * answers part company. Two faces pointing the same way and with the same
     * paper beneath them were then raised in opposite directions: an
     * aeroplane's two wings are mirror images and one sat a millimetre above
     * the other. The pile grows toward the viewer, so a face is pushed along
     * its own normal by whichever sign takes it that way.
     */
    const facing = Math.abs(normal[2]) > 1e-6
      ? -Math.sign(normal[2])
      : (mirrored ? 1 : -1);
    const corners = underAt.get(f.face) ?? [];
    const back = settleAt.get(f.face) ?? 0;
    const rises = f.points.map((_, k) => facing * (Math.max(corners[k] ?? 0, storeyAt.get(f.face) ?? 0) - back) * caliper);
    // The marks drawn on the face ride with its middle, which is the best a
    // single offset can do for something spread across the whole of it.
    const rise = rises.reduce((a, r) => a + r, 0) / Math.max(1, rises.length);
    // Measured on the resting model, applied along the face's normal as drawn.
    const drawnNormal = unit(rotateRigid(shown.transform, [0, 0, 1]));
    return {
      points: liftEachBy(shown.points, drawnNormal, rises),
      lift: [drawnNormal[0] * rise, drawnNormal[1] * rise, drawnNormal[2] * rise] as Vec3,
      outline,
      area: Math.abs(twice) / 2,
      stack,
      normal: drawnNormal,
      mirrored,
      // Only the paper that actually travelled carries the step's mark.
      movedBy: state.faces_moved?.[f.face] ? movedBy : -1,
      face: f.face,
      transform: shown.transform,
      inverse: invertRigid(shown.transform),
      pile: pileAt[index]!,
    };
  }).sort((a, b) => a.stack - b.stack);
}

/**
 * Where a line of the folded view runs across the model in space.
 *
 * A fold is one straight line on the paper, but the paper is no longer flat, so
 * on screen it is a run of segments that bend at every crease it crosses. Each
 * face is clipped to the line's two sides and the crease is carried into space
 * by that face's own transform, which is what draws the fold where the hand
 * would actually make it.
 */
export function lineInSpace(
  state: FoldedState,
  line: Line,
): Array<{ a: Vec3; b: Vec3; face: number }> {
  const spatial = foldInSpace(state);
  const out: Array<{ a: Vec3; b: Vec3; face: number }> = [];

  state.graph.faces_vertices.forEach((loop, face) => {
    let local: Line;
    try {
      local = lineToLocal(line, state.faces_matrix[face]!);
    } catch {
      return;
    }
    const poly = loop.map((v) => state.graph.vertices_coords[v]!);
    const ends: Vec2[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const dp = signedDistance(local, p);
      const dq = signedDistance(local, q);
      if (Math.abs(dp) < 1e-12) { ends.push(p); continue; }
      if ((dp > 0) !== (dq > 0) && Math.abs(dp - dq) > 1e-15) {
        const t = dp / (dp - dq);
        ends.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    if (ends.length < 2) return;
    const place = spatial[face]!.transform;
    out.push({
      a: applyRigid(place, embed(ends[0]!)),
      b: applyRigid(place, embed(ends[ends.length - 1]!)),
      face,
    });
  });
  return out;
}

/**
 * Where a segment of the folded view runs across the model in space.
 *
 * `lineInSpace` draws a whole line; a crease is a piece of one, so it has to be
 * clipped to its own extent as well as to each face. It appears once per ply it
 * lies on, which is the truth: a crease pressed through four plies is four
 * creases, and the hand can touch any of them.
 */
export function segmentInSpace(
  state: FoldedState,
  a: Vec2,
  b: Vec2,
  /**
   * `a` and `b` on the sheet rather than in the folded view: the segment is
   * then drawn on the paper it is on and nowhere else, not on every ply that
   * happens to lie over or under it.
   */
  onSheet = false,
): Array<{ a: Vec3; b: Vec3; face: number; sa: Vec2; sb: Vec2 }> {
  const spatial = foldInSpace(state);
  const out: Array<{ a: Vec3; b: Vec3; face: number; sa: Vec2; sb: Vec2 }> = [];

  state.graph.faces_vertices.forEach((loop, face) => {
    const inv = onSheet ? null : affineInverse(state.faces_matrix[face]!);
    const p = inv ? affineApply(inv, a) : a;
    const q = inv ? affineApply(inv, b) : b;
    const poly = loop.map((v) => state.graph.vertices_coords[v]!);

    // Clip the parameter range against every edge of the convex face.
    let lo = 0;
    let hi = 1;
    const hand = polygonHand(poly);
    for (let i = 0; i < poly.length; i++) {
      const u = poly[i]!;
      const v = poly[(i + 1) % poly.length]!;
      const side = (r: Vec2) =>
        hand * ((v[0] - u[0]) * (r[1] - u[1]) - (v[1] - u[1]) * (r[0] - u[0]));
      const dp = side(p);
      const dq = side(q);
      // Both ends inside this edge: nothing to clip. Getting this wrong - and
      // clamping anyway - threw away every segment that lay wholly within a
      // face, which is most of them, so no crease was ever drawn.
      if (dp >= 0 && dq >= 0) continue;
      if (dp < 0 && dq < 0) { lo = 1; hi = 0; break; }
      const t = dp / (dp - dq);
      if (dp < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
    }
    if (hi - lo < 1e-9) return;

    const at = (t: number): Vec2 => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
    const place = spatial[face]!.transform;
    out.push({
      a: applyRigid(place, embed(at(lo))),
      b: applyRigid(place, embed(at(hi))),
      face,
      // The same piece on the sheet.
      sa: at(lo),
      sb: at(hi),
    });
  });
  return out;
}

function polygonHand(poly: readonly Vec2[]): number {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    twice += p[0] * q[1] - q[0] * p[1];
  }
  return twice >= 0 ? 1 : -1;
}


/**
 * Does this face lie over that point, looking along the face's own normal?
 *
 * Asked per corner rather than per face, because how much paper is underneath
 * is not the same everywhere on a face - a wing rests on the whole fuselage at
 * its root and on nothing at its tip.
 */
/**
 * The model as it would rest on a table, rather than as it is being held.
 *
 * While folding, the drawing keeps still the paper that has never been bent
 * part way, so the body stays put while wings and winglets are raised. A
 * finished model put down rests on its largest piece instead - an aeroplane on
 * its wings - and that is the attitude its size is quoted in: span, length and
 * how tall it stands mean the same whichever way it was held while folding.
 */
export const restingPose = (state: FoldedState): FoldedState =>
  (state.faces_bent ? { ...state, faces_bent: undefined } : state);

/**
 * The turn in plan that puts a resting aeroplane's mirror line down its length.
 *
 * A model rests on its largest face, a wing, and the rest of it is placed from
 * there. Where the wing was folded parallel to the body that leaves the keel
 * along the length; Birdman's wing is folded 1.5cm in at the nose and 0.8cm at
 * the tail, and resting on it turned the whole aeroplane three degrees in plan,
 * so its span and length were measured across a slant. A symmetric shape's
 * principal axes lie along its mirror line, so the turn is onto them, by the
 * angle nearest zero: none at all for a model already square.
 */
export function planTurn(faces: readonly { readonly points: readonly Vec3[] }[]): (p: Vec3) => Vec3 {
  const plane = faces.map((f) => {
    const q = f.points;
    let nx = 0; let ny = 0; let nz = 0;
    for (let i = 0; i < q.length; i++) {
      const a = q[i]!;
      const b = q[(i + 1) % q.length]!;
      nx += a[1] * b[2] - a[2] * b[1];
      ny += a[2] * b[0] - a[0] * b[2];
      nz += a[0] * b[1] - a[1] * b[0];
    }
    const k = Math.max(1, q.length);
    return {
      area: Math.hypot(nx, ny, nz) / 2,
      x: q.reduce((t, p) => t + p[0], 0) / k,
      y: q.reduce((t, p) => t + p[1], 0) / k,
    };
  });
  const total = plane.reduce((t, f) => t + f.area, 0);
  if (total <= 0) return (p) => p;
  const cx = plane.reduce((t, f) => t + f.area * f.x, 0) / total;
  const cy = plane.reduce((t, f) => t + f.area * f.y, 0) / total;
  let xx = 0; let yy = 0; let xy = 0;
  for (const f of plane) {
    const dx = f.x - cx; const dy = f.y - cy;
    xx += f.area * dx * dx; yy += f.area * dy * dy; xy += f.area * dx * dy;
  }
  // Round in plan, the axes are anywhere: leave it as it lies.
  const spread = xx + yy;
  if (!(spread > 0) || (Math.abs(xx - yy) < 1e-6 * spread && Math.abs(xy) < 1e-6 * spread)) return (p) => p;
  let t = 0.5 * Math.atan2(2 * xy, xx - yy);
  if (t > Math.PI / 4) t -= Math.PI / 2;
  if (t < -Math.PI / 4) t += Math.PI / 2;
  if (Math.abs(t) < 1e-9) return (p) => p;
  const c = Math.cos(t); const s = Math.sin(t);
  return (p) => [c * p[0] + s * p[1], -s * p[0] + c * p[1], p[2]];
}

/**
 * The box the finished model stands in, metres: across, along, and off the table.
 *
 * Measured in space rather than on the flat layout. The layout draws every
 * face in one plane, so a model with anything standing up is reported as the
 * flattened drawing of itself: a finished aeroplane fourteen centimetres
 * across came out as seven, which is the width of the drawing, not the
 * aeroplane.
 */
export function spatialBounds(state: FoldedState): { min: Vec3; max: Vec3 } {
  const faces = foldInSpace(state);
  const turn = planTurn(faces);
  const points = faces.flatMap((f) => f.points.map(turn));
  if (points.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  const at = (k: 0 | 1 | 2) => points.map((p) => p[k]);
  return {
    min: [Math.min(...at(0)), Math.min(...at(1)), Math.min(...at(2))],
    max: [Math.max(...at(0)), Math.max(...at(1)), Math.max(...at(2))],
  };
}

/**
 * How many plies are stacked at the thickest place, counted in space.
 *
 * Paper stacks only on paper it is lying against: facing the same way, in the
 * same plane, and over the same ground. Counted on the flat layout instead,
 * where a wing standing at ninety degrees is drawn lying over the fuselage,
 * the whole aeroplane piles up at one spot - the app reported 48 plies through
 * a nose the same app draws as twelve, and warned that it could not be folded.
 *
 * Asked at every face's corners and its middle. The deepest pile is where the
 * most faces overlap, and that patch is inside the smallest of them, so its
 * middle finds what its corners can miss.
 */
/**
 * Of the paper at these places - each a face and a point of the sheet on it,
 * all drawn at one spot of the layout - the most that really lie together.
 *
 * The layout draws a standing wing folded flat onto the body, so two wings
 * a span apart in the air are stacked there as one pile; counted in the
 * layout, a fold made to both wings at once was twice as thick as either.
 * In space the two are apart, and only paper at the same place counts.
 */
export function pliesTogether(state: FoldedState, at: ReadonlyArray<{ face: number; sheet: Vec2 }>): number {
  if (at.length < 2) return at.length;
  const byFace = new Map(spaceOf(state).map((f) => [f.face, f]));
  const spots = at.flatMap(({ face, sheet }) => {
    const f = byFace.get(face);
    return f ? [{ p: applyRigid(f.transform, [sheet[0], sheet[1], 0]), n: unit(rotateRigid(f.transform, [0, 0, 1])) }] : [];
  });
  let most = 0;
  for (const a of spots) {
    let n = 0;
    for (const b of spots) {
      if (Math.abs(a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]) < 0.99) continue;
      if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > CONTACT) continue;
      n++;
    }
    most = Math.max(most, n);
  }
  return most;
}

export function plyDepth(state: FoldedState): number {
  const spatial = foldInSpace(state);
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const middle = (pts: readonly Vec3[]): Vec3 => {
    const n = Math.max(1, pts.length);
    return [pts.reduce((a, q) => a + q[0], 0) / n, pts.reduce((a, q) => a + q[1], 0) / n,
      pts.reduce((a, q) => a + q[2], 0) / n];
  };
  const centres = spatial.map((f) => middle(f.points));
  const normals = spatial.map((f) => unit(rotateRigid(f.transform, [0, 0, 1])));

  let worst = 0;
  spatial.forEach((f, i) => {
    // A hair inside, because creases line up and a point on a boundary
    // belongs to neither side.
    const asked: Vec3[] = [centres[i]!, ...f.points.map((corner) => [
      corner[0] + (centres[i]![0] - corner[0]) * 0.02,
      corner[1] + (centres[i]![1] - corner[1]) * 0.02,
      corner[2] + (centres[i]![2] - corner[2]) * 0.02,
    ] as Vec3)];
    for (const p of asked) {
      let deep = 0;
      for (let j = 0; j < spatial.length; j++) {
        if (Math.abs(dot(normals[i]!, normals[j]!)) < 0.99) continue;
        const gap = dot(normals[i]!, [
          centres[i]![0] - centres[j]![0],
          centres[i]![1] - centres[j]![1],
          centres[i]![2] - centres[j]![2],
        ]);
        if (Math.abs(gap) > CONTACT) continue;
        if (coversPoint(spatial[j]!.points, normals[j]!, p)) deep++;
      }
      worst = Math.max(worst, deep);
    }
  });
  return worst;
}

function coversPoint(under: readonly Vec3[], normal: Vec3, p: Vec3): boolean {
  if (under.length < 3) return false;
  const plane = planeAxes(under, normal);
  if (!plane) return false;
  const ring = under.map(plane.flatten);
  const at = plane.flatten(p);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if ((a[1] > at[1]) !== (b[1] > at[1])
      && at[0] < a[0] + ((at[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
  }
  return inside;
}

/** Two directions spanning the face's plane, and the flattening onto them. */
function planeAxes(poly: readonly Vec3[], normal: Vec3) {
  let u: Vec3 = [poly[1]![0] - poly[0]![0], poly[1]![1] - poly[0]![1], poly[1]![2] - poly[0]![2]];
  const along = u[0] * normal[0] + u[1] * normal[1] + u[2] * normal[2];
  u = unit([u[0] - normal[0] * along, u[1] - normal[1] * along, u[2] - normal[2] * along]);
  if (!(Math.abs(u[0]) + Math.abs(u[1]) + Math.abs(u[2]) > 0.5)) return null;
  const v: Vec3 = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  const o = poly[0]!;
  return {
    flatten: (q: Vec3): Vec2 => [
      (q[0] - o[0]) * u[0] + (q[1] - o[1]) * u[1] + (q[2] - o[2]) * u[2],
      (q[0] - o[0]) * v[0] + (q[1] - o[1]) * v[1] + (q[2] - o[2]) * v[2],
    ],
  };
}


