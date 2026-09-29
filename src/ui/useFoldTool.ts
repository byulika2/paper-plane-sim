/**
 * The drawing interaction, owned in one place.
 *
 * Every point that comes in is in FLAT CREASE-PATTERN coordinates, so the
 * machine below never needs to know which view the user is working in.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clipHalfPlane, flipLine, layerOutline, lineThrough, polygonArea, signedDistance,
} from '../geometry/fold.js';
import type { FoldModel, FoldSense, PlySelection } from '../geometry/fold.js';
import { alignFold, midpoint } from '../geometry/constructions.js';
import type { Pick } from '../geometry/constructions.js';
import type { Vec2 } from '../geometry/math.js';
import { cm, pleatSteps } from './foldSession.js';
import type { FoldStep, Step } from './foldSession.js';

export type Tool = 'select' | 'line' | 'align' | 'measure';

export type Pending =
  /** A line being drawn: one end placed, waiting for the other. */
  | { t: 'anchor'; a: Vec2 }
  /**
   * The first end of the thing being matched.
   *
   * Aligning takes two clicks to say WHAT is being brought over - the two ends
   * of an edge, or the same point twice for a corner - and then one more to say
   * where it goes. Naming it with two clicks rather than one is what lets you
   * pick an edge that has no crease along it yet, which is most of them.
   */
  | { t: 'alignFrom'; a: Vec2 }
  | { t: 'align'; first: Pick }
  | {
    t: 'side'; a: Vec2; b: Vec2; note: string; movingSide?: Vec2;
    /** For a line laid on a line: the line that moves, and the one it goes onto. */
    moved?: [Vec2, Vec2]; onto?: [Vec2, Vec2];
  }
  | null;

/**
 * What the pending line measures against.
 *
 * Snapping puts the line on a corner or a crease, which is how folding usually
 * works; but sometimes the answer really is "15mm from the centre line", and
 * then the only honest way to get 15.0 rather than 14.7 is to type it. This is
 * the reading that can be typed over: a distance from the nearest thing the
 * line runs parallel to.
 */
export interface LineReading {
  /** What it runs parallel to, or null when it runs parallel to nothing. */
  readonly from: string | null;
  /** Perpendicular distance from that, centimetres. Meaningless without `from`. */
  readonly cm: number;
  /** How long the fold line is across the paper, centimetres. */
  readonly lengthCm: number;
  /** Which way it points, degrees anticlockwise from the sheet's foot. */
  readonly bearingDeg: number;
  /** True when the line is not yet exactly parallel to `from`. */
  readonly offAngle: boolean;
}

interface Args {
  tool: Tool;
  /** Sheet size, for measuring a line against the paper's own lines. */
  sheetWidth: number;
  sheetHeight: number;
  /**
   * What the align tool is aligning: a point, or a line.
   *
   * They are different asks and they take a different number of clicks. A
   * point is "put this there" - two clicks, the second being the answer. A
   * line has to be said with both its ends first, because a line already on
   * the paper runs further than the piece anyone means by it.
   */
  alignMode: 'point' | 'edge';
  angleDeg: number;
  plies: PlySelection;
  symmetric: boolean;
  /** Spacing used by the pleat macro, metres. */
  pleatSpacing: number;
  /** The stack as it stands, so the pleat knows how thick the flap will be. */
  model: FoldModel;
  onStep(step: Step): void;
}

const dist = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/** The lines on a blank sheet that a fold is usually laid parallel to. */
const REFERENCES = (w: number, h: number): Array<{ from: string; at: Vec2; dir: Vec2 }> => [
  { from: '세로 중심선', at: [w / 2, 0], dir: [0, 1] },
  { from: '가로 중심선', at: [0, h / 2], dir: [1, 0] },
  { from: '왼쪽 변', at: [0, 0], dir: [0, 1] },
  { from: '오른쪽 변', at: [w, 0], dir: [0, 1] },
  { from: '아래 변', at: [0, 0], dir: [1, 0] },
  { from: '위 변', at: [0, h], dir: [1, 0] },
];
const pickPoint = (p: Pick): Vec2 => (p.kind === 'point' ? p.p : p.at);

/**
 * The paper actually under the pointer, as the 3D view saw it.
 *
 * The folded view is the layout, where pieces can lie on top of one another
 * that are a span apart in the air - an aeroplane's two wing tips. What the
 * pointer was on is the sheet point, and whether that paper faces you the
 * other way round from the layout, in which case a fold toward you is a
 * mountain there.
 */
export interface PaperPoint {
  readonly sheet: Vec2 | null;
  readonly turned: boolean | null;
}

export interface FoldTool {
  readonly pending: Pending;
  /**
   * What to do next, in one line.
   *
   * Both views show it, because a fold can now be drawn in either and a prompt
   * that only appears on the other side of the screen is worse than none.
   */
  readonly prompt: string;
  /** Which half the pointer is over, for shading and for the live preview. */
  readonly hoverSide: Vec2 | null;
  setHoverSide(p: Vec2 | null, where?: PaperPoint | null): void;
  /**
   * The fold that would be committed right now. Drawing this into the 3D scene
   * is what makes a fold visible before it is made.
   */
  readonly preview: FoldStep | null;
  /** A click in flat coordinates; `pick` is only used by the align tool. */
  tap(p: Vec2, pick: Pick | null, where?: PaperPoint | null): void;
  /** A drag settles a whole line in one gesture. */
  dragLine(a: Vec2, b: Vec2): void;
  /** Hand a ready-made fold line straight to the chooser. */
  settleLine(a: Vec2, b: Vec2, note: string, movingSide?: Vec2): void;
  /** The pending line's distance from what it runs parallel to. */
  readonly reading: LineReading | null;
  /** Slide the pending line, parallel to itself, to that distance, in cm. */
  moveTo(cm: number): void;
  /** Swing it about its own middle to that bearing, in degrees. */
  rotateTo(deg: number): void;
  /**
   * Fold now, when the construction has already named the half that travels.
   * Null for a plain drawn line, where nobody has said yet.
   */
  commitFold(): (() => void) | null;
  commitCrease(): void;
  /** Fold and fold back: one gesture, two creases. */
  commitPleat(): void;
  cancel(): void;
  /**
   * Whether the next fold tucks its paper in between the layers rather than
   * laying it over the top - a lock, like the Transition's nose. One fold
   * only: it switches itself off once used.
   */
  readonly tuck: boolean;
  setTuck(on: boolean): void;
  /**
   * The next fold as a reverse fold of a flap folded in half: its point turned
   * in between the halves, or round the outside. One fold only, like tuck.
   */
  readonly reverse: 'inside' | 'outside' | null;
  setReverse(kind: 'inside' | 'outside' | null): void;
}

export function useFoldTool({
  tool, alignMode, angleDeg, plies, symmetric, pleatSpacing, model, onStep,
  sheetWidth, sheetHeight,
}: Args): FoldTool {
  const [pending, setPending] = useState<Pending>(null);
  const [hoverSide, setHoverSideRaw] = useState<Vec2 | null>(null);
  const [hoverWhere, setHoverWhere] = useState<PaperPoint | null>(null);
  const [tuck, setTuckRaw] = useState(false);
  const [reverse, setReverseRaw] = useState<'inside' | 'outside' | null>(null);
  // The special folds are one at a time: choosing one lets go of the others.
  const setTuck = useCallback((on: boolean) => { setTuckRaw(on); if (on) setReverseRaw(null); }, []);
  const setReverse = useCallback((kind: 'inside' | 'outside' | null) => {
    setReverseRaw(kind); if (kind) setTuckRaw(false);
  }, []);
  const setHoverSide = useCallback((p: Vec2 | null, where?: PaperPoint | null) => {
    setHoverSideRaw(p);
    setHoverWhere(p ? where ?? null : null);
  }, []);

  const cancel = useCallback(() => {
    setPending(null); setHoverSide(null); setTuckRaw(false); setReverseRaw(null);
  }, [setHoverSide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  // Switching tools abandons whatever was half-drawn.
  useEffect(() => { cancel(); }, [tool, cancel]);

  /*
   * A piece is named by pointing, so the picker only says "the piece" and the
   * point comes from the click: where it landed, and on which paper.
   */
  const pliesAt = useCallback((at: Vec2, where: PaperPoint | null | undefined): PlySelection =>
    (plies.kind === 'piece'
      ? { kind: 'piece', at, ...(where?.sheet ? { sheet: where.sheet } : {}) }
      : plies), [plies]);

  const emitFold = useCallback((
    a: Vec2, b: Vec2, movingSide: Vec2, s: FoldSense, note: string,
    where?: PaperPoint | null,
  ) => {
    const chosen = pliesAt(movingSide, where);
    const bits = [note];
    if (angleDeg < 179.5) bits.push(`${angleDeg}°`);
    if (plies.kind === 'side') bits.push(plies.turned ? '저쪽 면' : '이쪽 면');
    else if (plies.kind === 'piece') bits.push('누른 곳만');
    else if (plies.kind === 'half') bits.push('반쪽');
    else if (plies.kind === 'stack') bits.push(`위${plies.count}겹`);
    else if (plies.kind === 'wing') bits.push(plies.upper ? '위 날개' : '아래 날개');
    else if (plies.kind !== 'all') {
      bits.push(`${plies.kind === 'top' ? '위' : '아래'}${plies.count}겹`);
    }
    if (symmetric && plies.kind !== 'half' && plies.kind !== 'piece') bits.push('좌우');
    if (tuck) bits.push('안으로 넣기');
    if (reverse) bits.push(reverse === 'inside' ? '안으로 뒤집기' : '밖으로 뒤집기');
    onStep({
      kind: 'fold', a, b, movingSide, sense: reverse ? 'valley' : s, creaseOnly: false, angleDeg,
      // A reverse fold takes the whole flap past the line, both halves.
      plies: reverse || chosen.kind === 'all' ? undefined : chosen,
      tuck: tuck || undefined,
      reverse: reverse ?? undefined,
      symmetric: symmetric || undefined,
      label: bits.join(' '),
    });
    setTuck(false);
    cancel();
  }, [onStep, angleDeg, plies, symmetric, cancel, pliesAt, tuck, reverse]);

  const emitDimension = useCallback((a: Vec2, b: Vec2) => {
    onStep({
      kind: 'dimension', a, b,
      label: `치수 ${cm(dist(a, b))}`,
    });
    cancel();
  }, [onStep, cancel]);

  const settle = useCallback((a: Vec2, b: Vec2, note: string, hint?: Vec2,
    lines?: { moved: [Vec2, Vec2]; onto: [Vec2, Vec2] }) => {
    let movingSide: Vec2 | undefined;
    if (hint && Math.abs(signedDistance(lineThrough(a, b), hint)) > 1e-6) movingSide = hint;
    setPending({ t: 'side', a, b, note, movingSide, ...lines });
  }, []);

  /*
   * Which half travels when nobody has said.
   *
   * The smaller one. A fold takes the flap over the body, not the body over the
   * flap, so the lesser share of the paper is the right guess - and having a
   * guess is what makes the buttons work at all. Without one they did nothing
   * until the pointer happened to pass over the model, which reads as the
   * button being broken.
   */
  const fallbackSide = useMemo<Vec2 | null>(() => {
    if (pending?.t !== 'side') return null;
    let line;
    try {
      line = lineThrough(pending.a, pending.b);
    } catch {
      return null;
    }
    let near = 0;
    let far = 0;
    for (const layer of model.layers) {
      const poly = layerOutline(layer);
      near += polygonArea(clipHalfPlane(poly, line));
      far += polygonArea(clipHalfPlane(poly, flipLine(line)));
    }
    const mid = midpoint(pending.a, pending.b);
    const towards = near <= far ? 1 : -1;
    const step = 0.004 * towards;
    return [mid[0] + line.normal[0] * step, mid[1] + line.normal[1] * step];
  }, [pending, model]);

  /**
   * The half that travels: chosen, hovered, or - only as a last resort -
   * guessed.
   *
   * The guess exists so the buttons are never dead: pressing "앞으로" without
   * having pointed at a side should still fold something sensible rather than
   * silently do nothing.
   */
  const movingSide = pending?.t === 'side'
    ? (pending.movingSide ?? hoverSide ?? fallbackSide)
    : null;

  /**
   * What the preview shows, which is NOT the same thing.
   *
   * A preview built on the guess folds the paper the moment the line is drawn,
   * before anyone has said which half goes over - so the fold appears to have
   * already happened and there is nothing left to decide. The preview waits
   * for a real answer: a side pointed at, or one clicked.
   */
  const chosenSide = pending?.t === 'side'
    ? (pending.movingSide ?? hoverSide)
    : null;

  const tap = useCallback((p: Vec2, pick: Pick | null, where?: PaperPoint | null) => {
    // The select tool never draws; picking existing steps is handled by the
    // view. Nor do the flap and collapse tools: one hands App a hinge, the
    // other a place where creases meet, and App takes it from there.
    if (tool === 'select') return;
    /*
     * Paper only folds one way, so saying which half is saying everything.
     *
     * Toward you, always - that is the only fold a pair of hands makes. The
     * other direction is the same fold with the model turned over first, which
     * is what 뒤집기 is for. So there is no direction left to ask about: the
     * click that names the half is the fold.
     *
     * This is why the straight-line tool needs no chooser at all. The ones
     * that are genuinely different operations - a crease pressed and opened, a
     * pleat, a reverse fold - are not directions and do not belong in the same
     * question.
     */
    if (pending?.t === 'side') {
      /*
       * A half that is already settled is not up for election.
       *
       * The straight-line tool has nothing to go on until someone points at a
       * half, so there the click IS the answer. Aligning and pointing at a
       * piece are different: saying "bring this corner onto that point" names
       * the paper that travels as part of saying it, and so does pointing at
       * the piece you want folded. Letting the next click overrule that was
       * how an align fold could be made to move the wrong half - and then it
       * aligned nothing, which is the one thing it exists to do.
       */
      if (pending.movingSide) {
        emitFold(pending.a, pending.b, pending.movingSide, 'valley', pending.note);
        return;
      }
      /*
       * Toward you - as you see it, not as the layout lies.
       *
       * Where the paper pointed at faces you the other way round from the
       * layout, the layout's valley folds it away from you, so the fold is
       * written as the layout's mountain. On a flat model this never happens.
       */
      emitFold(pending.a, pending.b, p, where?.turned ? 'mountain' : 'valley', pending.note, where);
      return;
    }

    if (tool === 'measure') {
      if (pending?.t !== 'anchor') { setPending({ t: 'anchor', a: p }); return; }
      if (dist(pending.a, p) > 1e-4) emitDimension(pending.a, p);
      return;
    }

    if (tool === 'align') {
      /*
       * Aligning a point is two clicks: this one, to there.
       *
       * The second click IS the answer - a point has no extent and no second
       * end, so asking for a third would be asking the same question twice.
       */
      if (alignMode === 'point') {
        if (pending?.t !== 'alignFrom') { setPending({ t: 'alignFrom', a: p }); return; }
        const built = alignFold({ kind: 'point', p: pending.a }, pick ?? { kind: 'point', p });
        if (!built) { cancel(); return; }
        settle(built.line.a, built.line.b, built.note, pending.a);
        return;
      }
      /*
       * Aligning a line takes both of its ends first.
       *
       * A line already on the paper runs where the paper put it, and the piece
       * of it anyone means is almost never the whole thing - the top edge of a
       * sheet straddles the centre line, so "that edge" is two different asks
       * depending on which half. Naming the two ends says which piece, and the
       * ends are what the snapping can catch exactly.
       */
      if (pending?.t !== 'alignFrom' && pending?.t !== 'align') {
        setPending({ t: 'alignFrom', a: p });
        return;
      }
      if (pending.t === 'alignFrom') {
        if (dist(pending.a, p) < 1e-4) return;   // a line needs two places
        setPending({
          t: 'align',
          first: { kind: 'edge', s: { a: pending.a, b: p }, at: midpoint(pending.a, p) },
        });
        return;
      }
      // 3. - which line it goes onto.
      const target: Pick = pick ?? { kind: 'point', p };
      const built = alignFold(pending.first, target);
      if (!built) { cancel(); return; }
      settle(built.line.a, built.line.b, built.note, pickPoint(pending.first),
        pending.first.kind === 'edge' && target.kind === 'edge'
          ? { moved: [pending.first.s.a, pending.first.s.b], onto: [target.s.a, target.s.b] } : undefined);
      return;
    }

    if (pending?.t !== 'anchor') { setPending({ t: 'anchor', a: p }); return; }
    if (dist(pending.a, p) > 1e-3) settle(pending.a, p, '직선');
  }, [pending, tool, alignMode, emitFold, emitDimension, settle, cancel]);

  const dragLine = useCallback((a: Vec2, b: Vec2) => {
    if (dist(a, b) <= 1e-3) return;
    if (tool === 'measure') emitDimension(a, b);
    else settle(a, b, '직선');
  }, [tool, emitDimension, settle]);

  const commitFold = useCallback((): (() => void) | null => {
    if (pending?.t !== 'side' || !pending.movingSide) return null;
    const { a, b, movingSide, note } = pending;
    return () => emitFold(a, b, movingSide, 'valley', note);
  }, [pending, emitFold]);

  const commitPleat = useCallback(() => {
    if (pending?.t !== 'side' || !movingSide) return;
    for (const step of pleatSteps(model, pending.a, pending.b, movingSide, 'valley', pleatSpacing, {
      angleDeg,
      plies: plies.kind === 'all' ? undefined : plies,
      symmetric: symmetric || undefined,
    })) onStep(step);
    cancel();
  }, [pending, movingSide, pleatSpacing, model, angleDeg, plies, symmetric, onStep, cancel]);

  const commitCrease = useCallback(() => {
    if (pending?.t !== 'side') return;
    const line = lineThrough(pending.a, pending.b);
    const mid = midpoint(pending.a, pending.b);
    onStep({
      kind: 'fold', a: pending.a, b: pending.b,
      movingSide: [mid[0] + line.normal[0] * 0.01, mid[1] + line.normal[1] * 0.01],
      sense: 'valley', creaseOnly: true, symmetric: symmetric || undefined,
      label: `${pending.note} · 자국${symmetric ? ' 좌우' : ''}`,
    });
    cancel();
  }, [pending, onStep, symmetric, cancel]);

  const preview = useMemo<FoldStep | null>(() => {
    if (pending?.t !== 'side' || !chosenSide) return null;
    // The same fold the click would make, piece and sense included.
    const where = pending.movingSide ? null : hoverWhere;
    const chosen = pliesAt(chosenSide, where);
    return {
      kind: 'fold', a: pending.a, b: pending.b, movingSide: chosenSide,
      sense: where?.turned ? 'mountain' : 'valley', creaseOnly: false, angleDeg,
      plies: reverse || chosen.kind === 'all' ? undefined : chosen,
      tuck: tuck || undefined,
      reverse: reverse ?? undefined,
      symmetric: symmetric || undefined,
      label: pending.note,
    };
  }, [pending, chosenSide, angleDeg, symmetric, hoverWhere, pliesAt, tuck, reverse]);

  /*
   * Measure the pending line against the paper.
   *
   * A fold is nearly always parallel to something already there - the centre
   * line, an edge - so that is what it is quoted against. When it is parallel
   * to nothing, quoting it from the sheet's own origin at least gives a number
   * that can be typed over.
   */
  const reading = useMemo<LineReading | null>(() => {
    if (pending?.t !== 'side') return null;
    let line;
    try {
      line = lineThrough(pending.a, pending.b);
    } catch {
      return null;
    }
    // Which way the normal points depends on the order the two ends were
    // clicked, which is not something the reading should depend on.
    if (line.normal[0] < -1e-9 || (Math.abs(line.normal[0]) <= 1e-9 && line.normal[1] < 0)) {
      line = { normal: [-line.normal[0], -line.normal[1]] as Vec2, offset: -line.offset };
    }
    // A line drawn by hand is never exactly parallel to anything, so a strict
    // test would mean this reading almost never appears. Within a couple of
    // degrees counts as "meant to be parallel"; typing a distance then lays it
    // exactly parallel, which is the only way to actually land on 15.0.
    /*
     * Three degrees, and offered rather than done: a line a pointer let go of
     * is usually a hair off the reference, and the button that lays it exactly
     * parallel then shows. Squaring it unasked lost the folds a book tapers
     * on purpose, a degree or two over the length of a wing.
     */
    const PARALLEL = Math.sin((3 * Math.PI) / 180);
    const refs = REFERENCES(sheetWidth, sheetHeight);
    /*
     * How long the crease is on the paper, not how long the line is.
     *
     * A construction stretches its line right across the plane so that both
     * sides are unambiguous, which made the align tool announce creases a metre
     * long. What the hand cares about is the part that lands on paper.
     */
    let lengthCm = 0;
    for (const layer of model.layers) {
      const poly = layerOutline(layer);
      let lo = Infinity;
      let hi = -Infinity;
      const dir: Vec2 = [-line.normal[1], line.normal[0]];
      for (let i = 0; i < poly.length; i++) {
        const u = poly[i]!;
        const v = poly[(i + 1) % poly.length]!;
        const du = signedDistance(line, u);
        const dv = signedDistance(line, v);
        if ((du > 0) === (dv > 0) || Math.abs(du - dv) < 1e-15) continue;
        const t = du / (du - dv);
        const at: Vec2 = [u[0] + t * (v[0] - u[0]), u[1] + t * (v[1] - u[1])];
        const s2 = at[0] * dir[0] + at[1] * dir[1];
        lo = Math.min(lo, s2);
        hi = Math.max(hi, s2);
      }
      if (hi > lo) lengthCm = Math.max(lengthCm, (hi - lo) * 100);
    }
    if (lengthCm === 0) lengthCm = dist(pending.a, pending.b) * 100;
    const bearingDeg = ((Math.atan2(pending.b[1] - pending.a[1], pending.b[0] - pending.a[0])
      * 180) / Math.PI + 360) % 180;
    let best: { from: string; cm: number; off: number } | null = null;
    for (const r of refs) {
      const off = Math.abs(r.dir[0] * line.normal[0] + r.dir[1] * line.normal[1]);
      if (off > PARALLEL) continue;
      const at = -signedDistance(line, r.at) * 100;
      if (!best || Math.abs(at) < Math.abs(best.cm)) best = { from: r.from, cm: at, off };
    }
    return {
      from: best?.from ?? null,
      cm: best?.cm ?? 0,
      lengthCm,
      bearingDeg,
      offAngle: (best?.off ?? 0) > 1e-9,
    };
  }, [pending, sheetWidth, sheetHeight, model]);

  const moveTo = useCallback((want: number) => {
    if (pending?.t !== 'side' || !reading?.from) return;
    const ref = REFERENCES(sheetWidth, sheetHeight).find((r) => r.from === reading.from);
    if (!ref) return;
    /*
     * Lay the line exactly parallel at the distance asked for.
     *
     * Nudging it along its own normal would keep whatever fraction of a degree
     * it was drawn off by, and a fold that is 15.0mm at one end and 15.4 at the
     * other is not what anybody meant by "15mm from the centre line".
     */
    const dir = ref.dir;
    /*
     * The same way round as the reading, or typing back the number on screen
     * moves the line. The reading turns its normal to point right (or up, for a
     * horizontal line); taken straight off the reference it pointed left for
     * every vertical one, so "-1.5 from the centre line" landed 1.5 to the
     * right of it and the field then read +1.5.
     */
    let n: Vec2 = [-dir[1], dir[0]];
    if (n[0] < -1e-9 || (Math.abs(n[0]) <= 1e-9 && n[1] < 0)) n = [-n[0], -n[1]];
    const base: Vec2 = [ref.at[0] + n[0] * (want / 100), ref.at[1] + n[1] * (want / 100)];
    const mid = midpoint(pending.a, pending.b);
    // Keep the line where it sits along its own length, and how long it is.
    const along = (mid[0] - base[0]) * dir[0] + (mid[1] - base[1]) * dir[1];
    const half = Math.max(dist(pending.a, pending.b) / 2, 1e-4);
    const centre: Vec2 = [base[0] + dir[0] * along, base[1] + dir[1] * along];
    const a: Vec2 = [centre[0] - dir[0] * half, centre[1] - dir[1] * half];
    const b: Vec2 = [centre[0] + dir[0] * half, centre[1] + dir[1] * half];
    let movingSide = pending.movingSide;
    if (movingSide) {
      /*
       * Keep the travelling half on the side it was chosen on.
       *
       * Both sides are read against one normal. The old line and the new one
       * can run opposite ways, and measured against their own normals a point
       * that had not moved could read as having crossed.
       */
      const across = lineThrough(a, b).normal;
      const side = (p: Vec2, on: Vec2) => (p[0] - on[0]) * across[0] + (p[1] - on[1]) * across[1];
      const was = side(movingSide, pending.a);
      const now = side(movingSide, a);
      if ((was > 0) !== (now > 0)) {
        const s = Math.sign(was || 1);
        movingSide = [centre[0] + across[0] * 0.01 * s, centre[1] + across[1] * 0.01 * s];
      }
    }
    setPending({ ...pending, a, b, movingSide });
  }, [pending, reading, sheetWidth, sheetHeight]);

  /** Swing the pending line about its own middle, so its position is kept. */
  const rotateTo = useCallback((deg: number) => {
    if (pending?.t !== 'side') return;
    const mid = midpoint(pending.a, pending.b);
    const half = dist(pending.a, pending.b) / 2;
    const t = (deg * Math.PI) / 180;
    const u: Vec2 = [Math.cos(t) * half, Math.sin(t) * half];
    setPending({ ...pending,
      a: [mid[0] - u[0], mid[1] - u[1]],
      b: [mid[0] + u[0], mid[1] + u[1]] });
  }, [pending]);

  const prompt = pending?.t === 'side'
    ? '③ 접어 넘길 쪽을 클릭하면 앞으로 접힙니다'
    : pending?.t === 'alignFrom'
      ? (alignMode === 'point' ? '② 이 점을 어디로 보낼지 클릭' : '② 맞출 선의 끝점을 클릭')
      : pending?.t === 'align'
        ? '③ 이 선을 어디에 붙일지 클릭'
      : pending?.t === 'anchor'
        ? (tool === 'measure' ? '② 끝점을 클릭하면 길이가 기록됩니다' : '② 끝점을 클릭')
        : tool === 'align'
            ? (alignMode === 'point' ? '① 옮길 점을 클릭' : '① 맞출 선의 시작점을 클릭')
          : tool === 'measure'
            ? '① 재기 시작점을 클릭'
            : tool === 'select'
              ? '접는 선을 골라 각도와 방향을 고칩니다'
              : '① 시작점을 클릭하거나 그대로 드래그';

  return {
    pending, hoverSide, setHoverSide, preview, prompt, reading, moveTo, rotateTo, tuck, setTuck,
    reverse, setReverse,
    tap, dragLine, settleLine: settle, commitFold, commitCrease, commitPleat, cancel,
  };
}
