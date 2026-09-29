/**
 * Pan and zoom for the drawing panels.
 *
 * The transform is folded into the coordinate mapping rather than applied as an
 * SVG transform, so strokes stay one pixel wide and labels stay the same size at
 * every scale. A drawing should behave like a drawing, not like a photograph
 * being enlarged.
 */

import type { Vec2 } from '../geometry/math.js';

/** Fallback panel size, used until the panel has been measured. */
export const VIEW = 580;
export const PAD = 42;

/** The panel's own size in CSS pixels; the drawing is mapped straight onto it. */
export interface PanelSize {
  readonly w: number;
  readonly h: number;
}

const defaultPanel: PanelSize = { w: VIEW, h: VIEW };

export interface Viewport {
  readonly zoom: number;
  readonly pan: readonly [number, number];
}

export const identityViewport: Viewport = { zoom: 1, pan: [0, 0] };

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 8;

/**
 * Zoom about the middle of the paper.
 *
 * Zooming under the cursor is what a map does, and it is wrong here: the paper
 * is the subject, and on a drawing board you pull the sheet closer, you do not
 * slide it sideways because of where your hand happened to be. `mapping` already
 * holds the paper's own middle at the centre of the panel, so keeping the pan
 * untouched is exactly what keeps that point still while the scale changes.
 */
export function zoomViewport(v: Viewport, factor: number): Viewport {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
  return zoom === v.zoom ? v : { zoom, pan: v.pan };
}

export interface Mapping {
  readonly scale: number;
  toPx(p: Vec2): [number, number];
  fromPx(vx: number, vy: number): Vec2;
}

/**
 * Build the paper-to-viewport mapping for a sheet of the given size.
 *
 * `focus` is the point of the paper to hold in the middle of the panel. Folding
 * eats the sheet away toward one corner, so holding the folded shape's own
 * centre keeps it under the cursor instead of letting it wander off. The scale
 * still comes from the whole sheet, so the drawing does not resize as it is
 * folded - only its position is corrected.
 */
export function mapping(
  v: Viewport,
  sheetWidth: number,
  sheetHeight: number,
  focus?: Vec2,
  panel: PanelSize = defaultPanel,
): Mapping {
  // The drawing is mapped onto the panel as it actually is, not onto a square
  // letterboxed inside it: a square viewBox throws away whatever the zoom
  // pushes past its edge, which is how the paper came to be cut off on screen.
  const usable = Math.max(40, Math.min(panel.w, panel.h) - PAD - 26);
  const scale = (usable / Math.max(sheetWidth, sheetHeight)) * v.zoom;
  const at: Vec2 = focus ?? [sheetWidth / 2, sheetHeight / 2];
  const originX = panel.w / 2 - at[0] * scale;
  const originY = panel.h / 2 + at[1] * scale;
  return {
    scale,
    toPx: (p) => [
      originX + p[0] * scale + v.pan[0],
      originY - p[1] * scale + v.pan[1],
    ],
    fromPx: (vx, vy) => [
      (vx - originX - v.pan[0]) / scale,
      (originY + v.pan[1] - vy) / scale,
    ],
  };
}

