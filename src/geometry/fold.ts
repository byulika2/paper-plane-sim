/**
 * Flat-folding engine, "simple fold" model.
 *
 * The sheet is a stack of layers. Each layer keeps its outline in the ORIGINAL
 * sheet coordinates plus a 2D affine transform onto the current folded view.
 * A fold picks a line in the current view, splits every layer along it, and
 * reflects the moving side while reversing that side's stack order.
 *
 * This covers the entire vocabulary of the classic darts and gliders, and it
 * keeps per-layer sheet coordinates so mass, ply count and grain direction stay
 * attached to the paper rather than to the folded shape.
 */

import type { Vec2 } from './math.js';

/** 2D affine transform [a, b, c, d, tx, ty]: x' = a x + c y + tx, y' = b x + d y + ty. */
export type Affine = readonly [number, number, number, number, number, number];

export const affineIdentity: Affine = [1, 0, 0, 1, 0, 0];

export function affineApply(m: Affine, p: Vec2): Vec2 {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

export function affineMul(a: Affine, b: Affine): Affine {
  // Returns a ∘ b (apply b first).
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function affineInverse(m: Affine): Affine {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-15) throw new Error('affine transform is not invertible');
  const i = 1 / det;
  const a = m[3] * i, b = -m[1] * i, c = -m[2] * i, d = m[0] * i;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** True when the transform includes a reflection (odd number of flips). */
export const affineIsMirrored = (m: Affine): boolean => m[0] * m[3] - m[1] * m[2] < 0;

/** An infinite line, stored as the point set where dot(normal, p) = offset. */
export interface Line {
  readonly normal: Vec2;
  readonly offset: number;
}

export function lineThrough(a: Vec2, b: Vec2): Line {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) throw new Error('cannot build a fold line from two identical points');
  const normal: Vec2 = [-dy / len, dx / len];
  return { normal, offset: normal[0] * a[0] + normal[1] * a[1] };
}

export const signedDistance = (line: Line, p: Vec2): number =>
  line.normal[0] * p[0] + line.normal[1] * p[1] - line.offset;

/**
 * Pull a line in the folded view back into a layer's own sheet coordinates.
 *
 * Substituting the forward map into the line equation gives the rule:
 * n . (M x + t) = c  becomes  (M^T n) . x = c - n . t, so the normal travels by
 * the TRANSPOSE of the forward linear part. The inverse-transpose is the rule
 * for pushing a normal forward, and the two agree only when M is symmetric -
 * true for a single reflection, false as soon as a ply has been folded twice
 * and its transform has become a rotation.
 */
export function lineToLocal(line: Line, xf: Affine): Line {
  const n: Vec2 = [
    line.normal[0] * xf[0] + line.normal[1] * xf[1],
    line.normal[0] * xf[2] + line.normal[1] * xf[3],
  ];
  const len = Math.hypot(n[0], n[1]);
  if (len < 1e-15) throw new Error('layer transform collapses the plane');
  const shifted = line.offset - (line.normal[0] * xf[4] + line.normal[1] * xf[5]);
  return { normal: [n[0] / len, n[1] / len], offset: shifted / len };
}

/** Reflection of the plane about a line, as an affine transform. */
export function reflectionAbout(line: Line): Affine {
  const [nx, ny] = line.normal;
  return [
    1 - 2 * nx * nx,
    -2 * nx * ny,
    -2 * nx * ny,
    1 - 2 * ny * ny,
    2 * line.offset * nx,
    2 * line.offset * ny,
  ];
}

const EPS = 1e-9;

/** Clip a polygon to the half-plane where signedDistance >= 0 (Sutherland-Hodgman). */
export function clipHalfPlane(poly: readonly Vec2[], line: Line): Vec2[] {
  if (poly.length === 0) return [];
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const nxt = poly[(i + 1) % poly.length]!;
    const dCur = signedDistance(line, cur);
    const dNxt = signedDistance(line, nxt);
    if (dCur >= -EPS) out.push(cur);
    if ((dCur > EPS && dNxt < -EPS) || (dCur < -EPS && dNxt > EPS)) {
      const t = dCur / (dCur - dNxt);
      out.push([cur[0] + t * (nxt[0] - cur[0]), cur[1] + t * (nxt[1] - cur[1])]);
    }
  }
  return out.length >= 3 ? out : [];
}

export const flipLine = (line: Line): Line => ({
  normal: [-line.normal[0], -line.normal[1]],
  offset: -line.offset,
});

export function polygonArea(poly: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** One sheet of paper in the stack. */
export interface Layer {
  /** Outline in original sheet coordinates, metres. */
  readonly outline: readonly Vec2[];
  /** Sheet coordinates -> current folded view. */
  readonly xf: Affine;
  /** Which face of the original sheet points "up" in the folded view. */
  readonly mirrored: boolean;
}

export interface FoldModel {
  /** Bottom of the stack first. */
  readonly layers: readonly Layer[];
  /**
   * Whether each neighbouring pair of plies is joined at a folded edge.
   * `joined[i]` covers plies `i` and `i + 1`.
   *
   * Paper does not come apart. When a fold divides a ply in two, the halves
   * stay attached along the crease, and any later fold that takes one without
   * the other would be tearing the sheet. Recording where the paper is still
   * continuous is what makes that detectable.
   */
  readonly joined: readonly boolean[];
  /** Sheet extents, metres. */
  readonly width: number;
  readonly height: number;
}

export function sheetModel(width: number, height: number): FoldModel {
  return {
    layers: [{
      outline: [[0, 0], [width, 0], [width, height], [0, height]],
      xf: affineIdentity,
      mirrored: false,
    }],
    joined: [],
    width,
    height,
  };
}

/**
 * Valley brings the flap toward the viewer; mountain tucks it behind the stack.
 *
 * There are only these two, because there is only one thing a pair of hands
 * does: fold the paper forward. Mountain is the same fold with the model turned
 * over, which is what the flip command is for. The tucks and wraps that origami
 * names separately - inside reverse, outside reverse - are not directions but
 * sequences of ordinary folds, and the folded-state engine has no way to
 * perform them, so offering them as directions only lied about what happened.
 */
export type FoldSense = 'valley' | 'mountain';

/**
 * Which plies a fold takes with it.
 *
 * A plain fold carries the whole stack. A squash fold opens one pocket and
 * flattens it: the plies on top move, the ones beneath stay where they are.
 * There is no way to say that with a line alone, so the fold has to name its
 * plies too.
 *
 * It is stored as "the top n" or "the bottom n" rather than as indices, so that
 * editing an earlier step - which changes how many plies there are - leaves the
 * intent intact.
 */
export type PlySelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'top'; readonly count: number }
  | { readonly kind: 'bottom'; readonly count: number }
  /*
   * One side of the packet, however the pile happens to be ordered.
   *
   * Folding a model in half leaves the paper that travelled turned over and
   * the paper that stayed the right way up, and those two groups are the two
   * sides - which is what a wing is. Counting plies from the top only names
   * that group while it happens to be contiguous, and after the first wing has
   * divided the pile it is not: the two wings then came out showing opposite
   * faces of the paper, which no folded sheet does. Naming the side directly
   * says what was meant in the first place.
   */
  | { readonly kind: 'side'; readonly turned: boolean }
  /*
   * The piece of paper this point is on.
   *
   * What a hand takes hold of. Counting plies names the right paper only while
   * the pile stays whole, and the first wing of an aeroplane divides it - so
   * the second wing, asked for by the same count, took the wrong paper and the
   * two came out showing opposite faces of the sheet. A point does not drift.
   */
  | {
    readonly kind: 'piece';
    readonly at: Vec2;
    /*
     * The same point on the sheet itself, when it is known.
     *
     * In the folded view two pieces can lie in one place - an aeroplane's two
     * wing tips are drawn folded flat onto each other in the layout, though in
     * the air they are a span apart - and the view point then names whichever
     * is on top of the pile, not the one that was pointed at. A point of the
     * sheet belongs to one face only.
     */
    readonly sheet?: Vec2;
  }
  /*
   * The half of a halved packet on the side the fold is made, all of it.
   *
   * What a wing is. The point is the one that says which side travels - the
   * hand is already on that half.
   */
  | { readonly kind: 'half' }
  /*
   * The top `count` sheets lying under the fold line, counted there, as a hand
   * counts the layers it lifts. Paper joined by unfolded creases is one sheet.
   */
  | { readonly kind: 'stack'; readonly count: number }
  /*
   * One wing of a halved packet: the paper past the fold line, cut there,
   * falls into pieces - the two halves, each with whatever is folded into it -
   * and this is the one on top of the pile or the one underneath.
   *
   * Counting its plies named it only while the count stayed right: change an
   * earlier step and the wing's number of plies changes with it, and the
   * stored count took paper from the other wing, or blocked the fold. And
   * which way up the paper lies does not name it either, once flaps folded
   * before the halving have been turned over with it. The pieces do not drift.
   */
  | { readonly kind: 'wing'; readonly upper: boolean };

export const ALL_PLIES: PlySelection = { kind: 'all' };

/** Layers are stored bottom first, so "top" means the end of the list. */
export function plyFilter(
  selection: PlySelection | undefined,
  layers: readonly Layer[],
): ((index: number) => boolean) | undefined {
  if (!selection || selection.kind === 'all') return undefined;
  // A side is named by which way up its paper is, not by where it sits.
  if (selection.kind === 'side') {
    return (index) => layers[index]?.mirrored === selection.turned;
  }
  /*
   * A piece is resolved against the crease pattern, which this flat stack of
   * plies does not carry - so nothing is restricted here. The flat model is
   * kept for drawing and for reading a click back onto the paper; the folding
   * itself goes through the graph, where the piece means what it says.
   */
  if (selection.kind === 'piece' || selection.kind === 'half' || selection.kind === 'stack'
    || selection.kind === 'wing') return undefined;
  const layerCount = layers.length;
  const n = Math.max(0, Math.min(layerCount, Math.round(selection.count)));
  if (n >= layerCount) return undefined;
  if (n === 0) return () => false;
  return selection.kind === 'top'
    ? (index) => index >= layerCount - n
    : (index) => index < n;
}

/** How many plies a selection actually covers, for labels. */
export const plyCount = (selection: PlySelection | undefined, layerCount: number): number => {
  if (!selection || selection.kind === 'all') return layerCount;
  // A side is whatever half of the pile is facing that way; the count is not
  // known without the model, so the honest answer for a label is "about half".
  if (selection.kind === 'side') return Math.round(layerCount / 2);
  // A piece is however much paper is joined to that spot; not knowable here.
  if (selection.kind === 'piece') return layerCount;
  // So is a half; about half the pile, but the label should not guess.
  if (selection.kind === 'half') return Math.round(layerCount / 2);
  if (selection.kind === 'stack') return Math.min(layerCount, selection.count);
  if (selection.kind === 'wing') return Math.round(layerCount / 2);
  return Math.max(0, Math.min(layerCount, Math.round(selection.count)));
};

/**
 * Fold everything on the positive side of `line` over to the negative side.
 * Pass a line whose normal points at the part that should move.
 */
/** Shift a line sideways, along its own normal. */
const offsetLine = (line: Line, by: number): Line => ({
  normal: line.normal,
  offset: line.offset + by,
});

export function fold(
  model: FoldModel,
  line: Line,
  sense: FoldSense = 'valley',
  movesPly?: (index: number) => boolean,
  /**
   * Caliper of one ply, metres. Zero folds ideal paper with no thickness.
   *
   * Real paper has to go somewhere. Folding a stack, the plies on the outside
   * of the bend travel further than the ones on the inside, so their creases
   * land progressively short and the flap comes out smaller than the geometry
   * says. Staggering each ply's crease by its depth in the stack reproduces
   * that, and it is why a nose folded from eight plies never quite reaches
   * where the drawing puts it.
   */
  thickness = 0,
): FoldModel {
  const stay: Layer[] = [];
  const moved: Layer[] = [];

  // Which ply of the old stack each new one came from.
  const source = new Map<Layer, number>();

  // Which plies travel, so that each one's depth in the bend is known before
  // any of them is cut.
  const travelling: number[] = [];
  if (thickness > 0) {
    model.layers.forEach((layer, index) => {
      if (movesPly && !movesPly(index)) return;
      if (clipHalfPlane(layer.outline, lineToLocal(line, layer.xf)).length >= 3) {
        travelling.push(index);
      }
    });
  }
  // The ply at the top of the moving stack sits against the inside of the bend;
  // the rest wrap around it, each one further out by its own caliper.
  const depth = new Map<number, number>();
  travelling.forEach((index, i) => depth.set(index, travelling.length - 1 - i));

  model.layers.forEach((layer, index) => {
    // A ply left out of the selection is not even cut: it passes through whole.
    if (movesPly && !movesPly(index)) { source.set(layer, index); stay.push(layer); return; }

    // Nudging the crease toward the moving side is what makes the flap fall
    // short: less paper goes round the bend, so the free edge stops early.
    const shifted = thickness > 0 && depth.has(index)
      ? offsetLine(line, thickness * depth.get(index)!)
      : line;
    const local = lineToLocal(shifted, layer.xf);
    const movingPart = clipHalfPlane(layer.outline, local);
    const stayingPart = clipHalfPlane(layer.outline, flipLine(local));

    if (stayingPart.length >= 3) {
      const kept = { ...layer, outline: stayingPart };
      source.set(kept, index);
      stay.push(kept);
    }
    if (movingPart.length >= 3) {
      const flap: Layer = {
        outline: movingPart,
        xf: affineMul(reflectionAbout(shifted), layer.xf),
        mirrored: !layer.mirrored,
      };
      source.set(flap, index);
      moved.push(flap);
    }
  });

  // Where the paper is still continuous after the fold. A divided ply stays
  // attached along the crease, and pairs that were already joined keep their
  // join as long as both halves travel together.
  const joinOf = (list: Layer[], src: Map<Layer, number>): boolean[] => {
    const out: boolean[] = [];
    for (let i = 0; i + 1 < list.length; i++) {
      const a = src.get(list[i]!);
      const b = src.get(list[i + 1]!);
      out.push(a !== undefined && b !== undefined && Math.abs(a - b) === 1
        && !!model.joined[Math.min(a, b)]);
    }
    return out;
  };

  // The flap turns over as one piece, so its stack order inverts. A valley fold
  // lays it on top of what stayed put; a mountain fold slides it underneath.
  moved.reverse();
  const list = sense === 'valley' ? [...stay, ...moved] : [...moved, ...stay];
  const joins = joinOf(list, source);
  // The two halves of every divided ply are still joined along the crease.
  for (let i = 0; i + 1 < list.length; i++) {
    const a = source.get(list[i]!);
    const b = source.get(list[i + 1]!);
    if (a !== undefined && a === b) joins[i] = true;
  }
  return { ...model, layers: list, joined: joins };
}

/** Fold along the line through two points in the current view. */
export function foldThrough(
  model: FoldModel,
  a: Vec2,
  b: Vec2,
  movingSide: Vec2,
  sense: FoldSense = 'valley',
  selection?: PlySelection,
  thickness = 0,
): FoldModel {
  let line = lineThrough(a, b);
  if (signedDistance(line, movingSide) < 0) line = flipLine(line);
  return fold(model, line, sense, plyFilter(selection, model.layers), thickness);
}

/** Thickest point of the stack, in plies. Paper stops folding somewhere near 8. */
export function maxPlies(model: FoldModel, samples = 120): number {
  const { min, max } = modelBounds(model);
  let worst = 0;
  for (let i = 0; i < samples; i++) {
    const p: Vec2 = [
      min[0] + ((i + 0.5) / samples) * (max[0] - min[0]),
      min[1] + ((i + 0.5) / samples) * (max[1] - min[1]),
    ];
    let n = 0;
    for (const layer of model.layers) if (pointInPolygon(layerOutline(layer), p)) n++;
    worst = Math.max(worst, n);
  }
  return worst;
}

export function pointInPolygon(poly: readonly Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if ((a[1] > p[1]) !== (b[1] > p[1])) {
      const x = a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
      if (p[0] < x) inside = !inside;
    }
  }
  return inside;
}

/** Outline of a layer in the current folded view. */
export const layerOutline = (layer: Layer): Vec2[] =>
  layer.outline.map((p) => affineApply(layer.xf, p));

/** Axis-aligned bounds of the folded silhouette. */
export function modelBounds(model: FoldModel): { min: Vec2; max: Vec2 } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const layer of model.layers) {
    for (const p of layerOutline(layer)) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** Total paper area across all layers. Folding must conserve this. */
export const totalArea = (model: FoldModel): number =>
  model.layers.reduce((sum, l) => sum + polygonArea(l.outline), 0);
