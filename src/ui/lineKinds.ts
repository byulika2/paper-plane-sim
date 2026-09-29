/**
 * The kinds of line on the paper, and how each one is drawn.
 *
 * Origami books code their lines, and pupils read that code: a dashed line is
 * folded toward you, a dash-dot line away, a thin solid one was pressed and
 * opened again. The model used to show every crease as the same solid ribbon
 * in one of three colours, while the flat drawing used dashes - two codes for
 * one thing. This is the one code both views draw from, with the kinds this
 * app's folds actually make: a fold held part way (the wings at ninety
 * degrees) and a point tucked in to lock.
 */

import { isFold } from './foldSession.js';
import type { Step } from './foldSession.js';
import type { FoldGraph } from '../origami/graph.js';
import type { Vec2 } from '../geometry/math.js';

export type LineKind = 'valley' | 'mountain' | 'crease' | 'raise' | 'tuck' | 'reverse' | 'pleat';

export interface LineStyle {
  /** What a pupil calls it. */
  readonly label: string;
  readonly hint: string;
  /** For the model. */
  readonly tint: number;
  /** For the flat drawing and the legend. */
  readonly css: string;
  /**
   * Dash and gap lengths, alternating, in the flat drawing's pixels. Empty is
   * a solid line. The model scales the same pattern to the size of the plane.
   */
  readonly dash: readonly number[];
  /** Relative line weight. */
  readonly weight: number;
}

/*
 * Drawn the way ORIPA draws a crease pattern, which is how the patterns pupils
 * find are shared: mountain red, valley blue, a line pressed and opened again
 * cyan, all solid. The special folds below keep their names for the hints, and
 * are drawn as the mountain or valley they are (see `lineKindOf`).
 */
export const LINE_STYLES: Record<LineKind, LineStyle> = {
  valley: {
    label: '골접기', hint: '앞으로(보는 쪽으로) 접은 선',
    tint: 0x2563eb, css: '#2563eb', dash: [], weight: 1,
  },
  mountain: {
    label: '산접기', hint: '뒤로 접은 선',
    tint: 0xdc2626, css: '#dc2626', dash: [], weight: 1,
  },
  crease: {
    label: '접었다 편 자국', hint: '접었다가 다시 펴서 자국만 남은 선',
    tint: 0x06b6d4, css: '#22d3ee', dash: [], weight: 0.75,
  },
  raise: {
    label: '세워 접기', hint: '날개처럼 끝까지 접지 않고 세운 선',
    tint: 0x15803d, css: '#22c55e', dash: [4, 3], weight: 1.1,
  },
  tuck: {
    label: '안으로 넣기', hint: '겹 사이로 밀어 넣어 잠근 선',
    tint: 0x7c3aed, css: '#a855f7', dash: [1.5, 3], weight: 1.3,
  },
  reverse: {
    label: '뒤집어 접기', hint: '반 접힌 끝을 안쪽이나 바깥쪽으로 뒤집어 넣은 선',
    tint: 0xbe185d, css: '#ec4899', dash: [9, 3, 2, 3, 2, 3], weight: 1.2,
  },
  pleat: {
    label: '계단 접기', hint: '앞으로 한 번, 뒤로 한 번 접어 계단을 만든 선',
    tint: 0x0e7490, css: '#06b6d4', dash: [5, 2, 5, 5], weight: 1.1,
  },
};

/**
 * The last fold, picked out so a walk-through shows where it just folded: a
 * highlighter laid under the line, so its own colour still says which way.
 */
export const LATEST_STYLE = { label: '방금 접은 선', tint: 0xfde047, css: '#fde047' } as const;

/** Which kind of line a step leaves on the paper. */
export function lineKindOf(step: Step | undefined): LineKind {
  if (!step || !isFold(step) || step.creaseOnly) return 'crease';
  // A crease pattern knows only mountain and valley; a tuck or a wing stood
  // at ninety degrees is still folded one way or the other.
  return step.sense === 'mountain' ? 'mountain' : 'valley';
}

/**
 * How the paper itself is creased along a mark, read off the folded sheet -
 * the way a crease pattern (ORIPA's, a book's) draws it: seen from the front
 * of the sheet, whatever turned over on the way. One fold pressed through a
 * pile leaves mountains on some plies and valleys on others; a roll is a run
 * of alternating lines. Coloured by the step that made it, every line of the
 * roll came out the same. Also how far that crease is closed, in degrees.
 */
export function sheetKind(graph: FoldGraph, seg: { readonly a: Vec2; readonly b: Vec2 }): { kind: LineKind; angle: number } | null {
  const m: Vec2 = [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2];
  const dx = seg.b[0] - seg.a[0];
  const dy = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return null;
  for (let e = 0; e < graph.edges_vertices.length; e++) {
    const assignment = graph.edges_assignment[e];
    if (assignment === 'boundary') continue;
    const [u, v] = graph.edges_vertices[e]!;
    const p = graph.vertices_coords[u]!;
    const q = graph.vertices_coords[v]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const el = Math.hypot(ex, ey);
    if (!(el > 1e-9)) continue;
    // Along the mark, and under its middle.
    if (Math.abs(ex * dy - ey * dx) / (el * len) > 1e-4) continue;
    const t = ((m[0] - p[0]) * ex + (m[1] - p[1]) * ey) / (el * el);
    if (t < -1e-6 || t > 1 + 1e-6) continue;
    if (Math.abs((m[0] - p[0]) * ey - (m[1] - p[1]) * ex) / el > 1e-6) continue;
    const angle = Math.abs(graph.edges_foldAngle[e] ?? 0) * 180 / Math.PI;
    if (assignment === 'flat' || angle < 0.5) return { kind: 'crease', angle: 0 };
    return { kind: assignment === 'mountain' ? 'mountain' : 'valley', angle };
  }
  return null;
}

/** The kinds in the order a legend lists them. */
export const LINE_ORDER: readonly LineKind[] = [
  'valley', 'mountain', 'crease',
];
