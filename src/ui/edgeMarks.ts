/**
 * Where a crease meets the edge of the blank, and how far that is along the
 * edge from the chosen reference.
 *
 * This is the number you can actually measure with a ruler before folding,
 * and it is what handwritten instructions quote. The flat drawing on screen
 * and the printed pages both mark creases with it, so they read the same.
 */

import type { TaggedCrease } from '../geometry/crease.js';
import type { Vec2 } from '../geometry/math.js';

export type EdgeSide = 'top' | 'bottom' | 'left' | 'right';

export interface EdgeMark {
  readonly p: Vec2;
  readonly metres: number;
  readonly side: EdgeSide;
}

export function edgeMarks(
  creases: readonly TaggedCrease[], sheetWidth: number, sheetHeight: number,
  dimRef: 'corner' | 'centre',
): EdgeMark[] {
  const tol = 1e-6;
  const seen = new Map<string, EdgeMark>();
  for (const c of creases) {
    for (const p of [c.a, c.b]) {
      let side: EdgeSide | null = null;
      let along = 0;
      let span = 0;
      if (Math.abs(p[1] - sheetHeight) < tol) { side = 'top'; along = p[0]; span = sheetWidth; }
      else if (Math.abs(p[1]) < tol) { side = 'bottom'; along = p[0]; span = sheetWidth; }
      else if (Math.abs(p[0]) < tol) { side = 'left'; along = p[1]; span = sheetHeight; }
      else if (Math.abs(p[0] - sheetWidth) < tol) { side = 'right'; along = p[1]; span = sheetHeight; }
      if (!side) continue;
      const metres = dimRef === 'centre'
        ? Math.abs(along - span / 2)
        : Math.min(along, span - along);
      const key = `${side}:${metres.toFixed(5)}`;
      if (!seen.has(key)) seen.set(key, { p, metres, side });
    }
  }
  return [...seen.values()];
}

/** What the mark says: a crease on the middle of an edge is just "가운데". */
export const markLabel = (m: EdgeMark, dimRef: 'corner' | 'centre'): string =>
  (dimRef === 'centre' && m.metres < 5e-4 ? '가운데' : `${(m.metres * 100).toFixed(1)}cm`);
