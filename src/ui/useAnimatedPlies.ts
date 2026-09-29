/**
 * The fold, seen happening.
 *
 * A fold that simply appears in its finished position is almost impossible to
 * read: you cannot tell which part moved or where it came from. Because the
 * three-dimensional replay already takes an angle per step, animating a fold is
 * just replaying it with the last angle swept from zero up to its target.
 *
 * A pending fold is appended the same way, so moving the angle control walks the
 * flap through the motion before anything is committed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { renderFaces } from '../origami/space.js';
import type { RenderFace } from '../origami/space.js';
import type { FoldedState } from '../origami/folding.js';
import { isFold, replay } from './foldSession.js';
import type { FoldStep, Step } from './foldSession.js';

const DURATION_MS = 460;
/** Ease out, so the flap settles rather than stopping dead. */
const ease = (t: number): number => 1 - (1 - t) ** 3;

export interface AnimatedPlies {
  readonly plies: readonly RenderFace[];
  /** Step index of the fold being previewed, or -1 when nothing is pending. */
  readonly previewIndex: number;
  readonly animating: boolean;
}

export function useAnimatedPlies(
  width: number,
  height: number,
  steps: readonly Step[],
  preview: FoldStep | null,
  thickness = 0,
  /**
   * The model as it stands. A preview is drawn with its still paper exactly
   * where this has it, so what is under the pointer does not change while the
   * half to fold is being chosen.
   */
  current?: FoldedState,
): AnimatedPlies {
  const folds = useMemo(() => steps.filter(isFold), [steps]);
  const [progress, setProgress] = useState(1);
  const seenRef = useRef<readonly FoldStep[]>(folds);

  useEffect(() => {
    /*
     * A fold made is the same steps with one more on the end. Another plane
     * opened is a different list that may happen to be longer, and was
     * animated as if its last fold had just been made - a whole replay a
     * frame for half a second, on every plane opened.
     */
    const was = seenRef.current;
    const grew = folds.length > was.length && (was.length > 0 ? was.every((f, i) => folds[i] === f) : folds.length === 1);
    const last = folds[folds.length - 1];
    seenRef.current = folds;
    // Creasing changes no shape, so there is nothing to watch.
    if (!grew || !last || last.creaseOnly) { setProgress(1); return; }

    let raf = 0;
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / DURATION_MS);
      setProgress(ease(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    setProgress(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [folds]);

  return useMemo(() => {
    const { list, previewIndex } = framedSteps(steps, preview, progress);
    return {
      plies: renderFaces(replay(width, height, list).state, previewIndex, thickness,
        preview && progress >= 1 ? current : undefined),
      previewIndex,
      animating: progress < 1,
    };
  }, [steps, progress, preview, width, height, thickness, current]);
}

/**
 * The steps the stage folds for one frame of the animation.
 *
 * Written out here rather than inside the hook so that it can be checked. What
 * the eye sees is whatever this returns, and the rest of the app - the crease
 * overlay, the snapping, the readout, every test - works from the step list
 * itself. Nothing makes the two agree, so when they stop agreeing they do it
 * silently: this once filtered the list down to the folds, which drops the
 * flips, and the aeroplane was drawn from twelve of its sixteen steps. It came
 * out 66 faces and 8.9cm across where the model is 52 faces and 13.8cm, and
 * the creases - correctly placed on the real model - hung in mid-air beside
 * the paper on screen.
 */
export function framedSteps(
  steps: readonly Step[],
  preview: FoldStep | null,
  progress: number,
): { readonly list: Step[]; readonly previewIndex: number } {
  // Only the last fold sweeps; turning the model over is not a fold and every
  // earlier step is already where it belongs.
  let lastFold = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (isFold(step) && !step.creaseOnly) { lastFold = i; break; }
  }
  const list: Step[] = steps.map((s, i) => (
    i === lastFold && progress < 1 && isFold(s)
      ? { ...s, angleDeg: (s.angleDeg ?? 180) * progress }
      : s
  ));
  /*
   * A pending fold is shown, not performed.
   *
   * Appending it as a real fold folded the paper the moment the line was
   * drawn - so the step where you choose which half goes over had nothing
   * left to choose. Appending it at zero degrees divides the paper along the
   * line and marks the half that would travel, while leaving every face
   * exactly where it is: the choice is visible, the fold has not happened.
   */
  const previewIndex = preview ? list.length : -1;
  if (preview) list.push({ ...preview, angleDeg: 0 });
  return { list, previewIndex };
}
