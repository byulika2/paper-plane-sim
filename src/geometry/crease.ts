/**
 * Crease memory.
 *
 * Folding a sheet and opening it again leaves a line behind, and the next fold
 * is usually measured against that line - "fold in half, unfold, now bring the
 * corners to the centre". Undo cannot express that, because undo removes the
 * step; creasing keeps the mark and throws away only the shape change.
 *
 * Creases are stored in ORIGINAL SHEET coordinates, never in the folded view.
 * That way a mark stays attached to the piece of paper it was pressed into and
 * reappears wherever that piece happens to lie after later folds.
 */

import {
  affineApply, affineInverse, lineToLocal, pointInPolygon,
} from './fold.js';
import type { FoldModel, Line } from './fold.js';
import { distanceToSegment } from './constructions.js';
import type { Vec2 } from './math.js';
import type { Segment } from './constructions.js';

const EPS = 1e-9;

/** The parts of `line` that lie inside a polygon, as segments. */
function clipLineToPolygon(poly: readonly Vec2[], line: Line): Segment[] {
  const d: Vec2 = [-line.normal[1], line.normal[0]];
  const p0: Vec2 = [line.normal[0] * line.offset, line.normal[1] * line.offset];
  return lineIntervals(poly, p0, d)
    .filter(([lo, hi]) => hi - lo > EPS)
    .map(([lo, hi]) => ({
      a: [p0[0] + d[0] * lo, p0[1] + d[1] * lo] as Vec2,
      b: [p0[0] + d[0] * hi, p0[1] + d[1] * hi] as Vec2,
    }));
}

/** The parts of a segment that lie inside a polygon. */
function clipSegmentToPolygon(poly: readonly Vec2[], s: Segment): Segment[] {
  const d: Vec2 = [s.b[0] - s.a[0], s.b[1] - s.a[1]];
  if (Math.hypot(d[0], d[1]) < EPS) return [];
  return lineIntervals(poly, s.a, d)
    .map(([lo, hi]): [number, number] => [Math.max(0, lo), Math.min(1, hi)])
    .filter(([lo, hi]) => hi - lo > EPS)
    .map(([lo, hi]) => ({
      a: [s.a[0] + d[0] * lo, s.a[1] + d[1] * lo] as Vec2,
      b: [s.a[0] + d[0] * hi, s.a[1] + d[1] * hi] as Vec2,
    }));
}

/** One copy of each distinct mark; the same crease is pressed on every ply. */
function dedupe<T extends Segment>(segs: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const s of segs) if (!seen.has(segmentKey(s))) seen.set(segmentKey(s), s);
  return [...seen.values()];
}

/**
 * Parameter ranges along the ray `p0 + t*d` that fall inside the polygon.
 * Crossings alternate inside and outside, starting outside at t = -infinity.
 */
function lineIntervals(
  poly: readonly Vec2[],
  p0: Vec2,
  d: Vec2,
): Array<[number, number]> {
  const nx = -d[1];
  const ny = d[0];
  const scale = nx * nx + ny * ny;
  if (scale < EPS) return [];
  const offset = nx * p0[0] + ny * p0[1];
  const dd = d[0] * d[0] + d[1] * d[1];

  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = nx * a[0] + ny * a[1] - offset;
    const db = nx * b[0] + ny * b[1] - offset;
    if (da >= 0 === db >= 0) continue;
    const u = da / (da - db);
    const hit: Vec2 = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
    ts.push(((hit[0] - p0[0]) * d[0] + (hit[1] - p0[1]) * d[1]) / dd);
  }
  ts.sort((x, y) => x - y);

  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < ts.length; i += 2) out.push([ts[i]!, ts[i + 1]!]);
  return out;
}

/** A crease remembers which step pressed it, so it can be selected later. */
export interface TaggedCrease extends Segment {
  readonly step: number;
}

export const segmentKey = (s: Segment): string => {
  const ka = `${s.a[0].toFixed(5)},${s.a[1].toFixed(5)}`;
  const kb = `${s.b[0].toFixed(5)},${s.b[1].toFixed(5)}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

/**
 * Press a crease along `line` into the model as it currently stands, and return
 * the marks in sheet coordinates. One gesture creases every ply it passes
 * through, which is exactly what happens to real paper.
 */
export function traceCrease(model: FoldModel, line: Line, step: number): TaggedCrease[] {
  const marks: TaggedCrease[] = [];
  for (const layer of model.layers) {
    const local = lineToLocal(line, layer.xf);
    for (const piece of clipLineToPolygon(layer.outline, local)) {
      marks.push({ ...piece, step });
    }
  }
  return dedupe(marks);
}

export interface ViewCrease extends TaggedCrease {
  /** Index of the ply this mark is currently riding on. */
  readonly layer: number;
  /** The same mark where it lies on the sheet: on the paper it was pressed into and no other. */
  readonly sheetA: Vec2;
  readonly sheetB: Vec2;
}

/** Bring stored sheet-space marks into the current folded view. */
export function creasesInView(
  model: FoldModel,
  creases: readonly TaggedCrease[],
): ViewCrease[] {
  const out: ViewCrease[] = [];
  model.layers.forEach((layer, index) => {
    for (const crease of creases) {
      for (const piece of clipSegmentToPolygon(layer.outline, crease)) {
        out.push({
          a: affineApply(layer.xf, piece.a),
          b: affineApply(layer.xf, piece.b),
          step: crease.step,
          layer: index,
          sheetA: piece.a,
          sheetB: piece.b,
        });
      }
    }
  });
  // Plies stacked on top of each other repeat the same mark in the same place: the topmost is kept, the one in sight.
  const seen = new Map<string, ViewCrease>();
  for (const c of out) seen.set(segmentKey(c), c);
  return [...seen.values()];
}

/**
 * Point marks and dimensions.
 *
 * A dot you put on the paper to fold to later, and the measured distance
 * between two of them. Like a crease they live in sheet coordinates, so they
 * ride along with their scrap of paper through every later fold, and one
 * gesture marks every ply beneath the pointer - the same rule creases follow,
 * so all three kinds of mark behave alike.
 */

/** Inside the outline, or close enough to its edge to count. */
function onPly(poly: readonly Vec2[], p: Vec2, tol: number): boolean {
  if (pointInPolygon(poly, p)) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (distanceToSegment(p, { a, b }) <= tol) return true;
  }
  return false;
}

const pointKey = (p: Vec2): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** A measured span between two points on the same ply. */
export interface Dimension {
  readonly a: Vec2;
  readonly b: Vec2;
  /**
   * The step that recorded it.
   *
   * Carried the same way a crease carries its step, so that pointing at a span
   * on the model finds the entry in the script that made it - which is what
   * lets one be selected and its length changed after the fact.
   */
  readonly step: number;
}

export interface ViewDimension extends Dimension {
  readonly layer: number;
  /** Where it was measured on the sheet. */
  readonly sheetA: Vec2;
  readonly sheetB: Vec2;
  /** Measured length, metres. Folding never changes it. */
  readonly length: number;
}

const dimKey = (d: Dimension): string => {
  const ka = pointKey(d.a);
  const kb = pointKey(d.b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

export const dedupeDimensions = (dims: readonly Dimension[]): Dimension[] => {
  const seen = new Map<string, Dimension>();
  for (const d of dims) if (!seen.has(dimKey(d))) seen.set(dimKey(d), d);
  return [...seen.values()];
};

/**
 * Record a measured span, in sheet coordinates, on the paper it was drawn on.
 *
 * It is anchored to a ply that carries its FIRST end. Requiring one ply to
 * carry both was wrong: a crease divides the pattern into faces without
 * dividing the paper, so as soon as a centre line had been pressed, every span
 * that crossed it was thrown away as "not on the paper" - which is the opposite
 * of what a crease does. The far end only has to be on the model somewhere.
 */
export function traceDimension(
  model: FoldModel,
  a: Vec2,
  b: Vec2,
  step: number,
  tol = 1e-5,
): Dimension[] {
  const far = model.layers.some((layer) =>
    onPly(layer.outline, affineApply(affineInverse(layer.xf), b), tol));
  if (!far) return [];

  const out: Dimension[] = [];
  for (const layer of model.layers) {
    const inv = affineInverse(layer.xf);
    const la = affineApply(inv, a);
    if (!onPly(layer.outline, la, tol)) continue;
    out.push({ a: la, b: affineApply(inv, b), step });
  }
  return dedupeDimensions(out);
}

/** Bring stored spans into the current folded view. */
export function dimensionsInView(
  model: FoldModel,
  dims: readonly Dimension[],
  tol = 1e-5,
): ViewDimension[] {
  const seen = new Map<string, ViewDimension>();
  model.layers.forEach((layer, index) => {
    for (const d of dims) {
      // Anchored by its first end, the way it was recorded.
      if (!onPly(layer.outline, d.a, tol)) continue;
      const a = affineApply(layer.xf, d.a);
      const b = affineApply(layer.xf, d.b);
      const key = dimKey({ a, b, step: d.step });
      if (seen.has(key)) continue;
      seen.set(key, {
        a, b, step: d.step, layer: index, sheetA: d.a, sheetB: d.b,
        length: Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]),
      });
    }
  });
  return [...seen.values()];
}
