/**
 * Reference designs, for the checks.
 *
 * A fold session is a script, so a design is just a script written out, with
 * every crease given in millimetres on the blank sheet. These two are here to
 * be folded by `validate` and `audit` - the dart because it is a whole
 * aeroplane and every measurement of it is known, the square because it is the
 * part of a real tutorial that has actually been read off the photographs.
 *
 * They are not offered in the app. A picker of ready-made designs was taken
 * out: the point is to fold your own.
 */

import { replay } from '../src/ui/foldSession.js';
import type { FoldStep, PatternLine, Step } from '../src/ui/foldSession.js';
import { layerOutline, modelBounds } from '../src/geometry/fold.js';
import type { Vec2 } from '../src/geometry/math.js';
import { paperProps } from '../src/paper/stock.js';
import { wingletSteps } from '../src/ui/winglets.js';

export interface Sample {
  readonly id: string;
  /** What the design is called, as the book that it came from calls it. */
  readonly name: string;
  build(width: number, height: number): Step[];
}

/**
 * The classic dart, with every crease written out.
 *
 * The corner folds are the 45 degree bisector of the top edge against the
 * centre line. Folding those new edges down again bisects a 45 degree line
 * against a vertical one, which comes out at 22.5 degrees - steep enough that
 * the crease leaves by the side of the sheet rather than the bottom.
 *
 * The keel stays closed at 180 and the wings come down 90 from it, which is
 * what leaves the keel standing and the wings flat. The wings take two folds,
 * not one: with real paper you turn the model over in between, and here that
 * means each fold names its own half of the stack.
 */
function dart(W: number, H: number): Step[] {
  const mid = W / 2;
  const secondExit = H - mid / Math.tan(Math.PI / 8);
  const keel = 0.020;

  const steps: Step[] = [
    { kind: 'fold', a: [mid, 0], b: [mid, H], movingSide: [W, H / 2],
      sense: 'valley', creaseOnly: true, label: '세로 중심선' },
    { kind: 'fold', a: [mid, H], b: [0, H - mid], movingSide: [0.01, H - 0.01],
      sense: 'valley', creaseOnly: false, symmetric: true,
      label: '모서리를 중심선에 (좌우)' },
    { kind: 'fold', a: [mid, H], b: [0, secondExit], movingSide: [0.02, H - 0.06],
      sense: 'valley', creaseOnly: false, symmetric: true,
      label: '두 번째 모서리 (좌우)' },
    { kind: 'fold', a: [mid, 0], b: [mid, H], movingSide: [W, H / 2],
      sense: 'mountain', creaseOnly: false, label: '세로 반으로' },
  ];

  /*
   * The stack splits into the half that stayed and the half that came over, and
   * that boundary - not the middle of the list - is where one wing ends and the
   * other begins. A mountain fold slides the travelling half underneath, so the
   * ones that have been turned over are the lower group.
   *
   * The two wings are folded the way hands fold them: one wing toward you, the
   * model turned over, and the other toward you the same way. This used to be
   * written as a mountain fold of the bottom plies, on the grounds that a
   * script never turns the model over - but that is not a move a pair of hands
   * makes, and the pile it left did not match the paper: drawn with thickness,
   * the two wings showed different faces of the sheet.
   */
  const stack = replay(W, H, steps).model.layers;
  const back = stack.filter((l) => l.mirrored).length;
  const front = stack.length - back;

  steps.push(
    { kind: 'fold', a: [mid - keel, 0], b: [mid - keel, H], movingSide: [0, H / 2],
      sense: 'valley', creaseOnly: false, angleDeg: 90,
      plies: { kind: 'top', count: front },
      label: `앞쪽 날개 90° (동체 ${(keel * 1000).toFixed(0)}mm, 위 ${front}겹)` },
    { kind: 'flip', label: '뒤집어요' },
  );
  // Turned over about its own middle, so the wing root is read from the far side.
  const { min, max } = modelBounds(replay(W, H, steps).model);
  const over = (x: number) => min[0] + max[0] - x;
  steps.push(
    { kind: 'fold', a: [over(mid - keel), 0], b: [over(mid - keel), H], movingSide: [over(0), H / 2],
      sense: 'valley', creaseOnly: false, angleDeg: 90,
      plies: { kind: 'top', count: back },
      label: `뒤쪽 날개 90° (위 ${back}겹)` },
    { kind: 'flip', label: '뒤집어요' },
  );
  return steps;
}


/**
 * A competition square, read off the tutorial photographs step by step.
 *
 * Only the moves the photographs actually settle are here. The opening is the
 * two 45 degree creases that run from the middle of the top edge down to the
 * side edges, a quarter of the way down; photograph 02 has them folded, giving
 * a point at the top, photograph 03 has the same two lines with the corners
 * brought to the point where they meet instead, and photograph 04 has the sheet
 * opened out again with those two creases and a horizontal one joining their
 * lower ends.
 *
 * What follows in the photographs - the width being taken in, the pleats, and
 * the chain of diamonds down the centre - is not written here. It was, as
 * guesses, and the guesses folded paper through paper: the layer audit stopped
 * the script at the first pleat. A guess that cannot be folded is worse than a
 * short script, so the script is short. `docs/square-tutorial.md` says what is
 * still to be read out of the photographs.
 */
function square(W: number, H: number): Step[] {
  const mid = W / 2;
  const meet = H - mid;                 // 192mm: where the two 45° creases land

  return [
    { kind: 'fold', a: [mid, 0], b: [mid, H], movingSide: [W, H / 2],
      sense: 'valley', creaseOnly: true, label: '1 세로 중심선 (자국)' },
    // Photograph 02: the crease runs from the middle of the top edge down to
    // the side edge, and the top edge folds in onto the centre line, so the
    // sheet comes to a point at the top.
    { kind: 'fold', a: [mid, H], b: [0, meet], movingSide: [0.001, H - 0.001],
      sense: 'valley', creaseOnly: false, symmetric: true,
      label: '2 윗변을 중심선에 (좌우 45°)' },
    // Photograph 04: the two creases and a horizontal one joining their ends.
    { kind: 'fold', a: [0, meet], b: [W, meet], movingSide: [mid, H],
      sense: 'valley', creaseOnly: true, label: '3 꼭짓점 높이 가로선 (자국)' },
  ];
}


/**
 * The nine-step aeroplane from the book.
 *
 * Written straight off the page: halve it, bring both corners at one end to
 * the middle, fold the point over, bring the new corners in, bring the two
 * points together, halve it, a wing either side, and a centimetre of each tip
 * turned up for winglets. Nothing here is a guess - every line is either the
 * middle of something or an edge laid onto the middle, which is how the page
 * says it.
 *
 * The page draws the sheet on its side; this folds it standing up, because
 * turning the paper round is not a fold. The same construction written with
 * the two axes swapped gives the same aeroplane, so the book's `u` runs along
 * the long edge and `v` across it, and `at` puts them back on the sheet. That
 * is the whole of the difference - there is no landscape stock to choose.
 */
function jet(width: number, height: number): Step[] {
  const long = Math.max(width, height);
  const across = Math.min(width, height);
  /** The book's coordinates - u along the sheet, v across it - put on the sheet. */
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);

  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });

  const S = across;
  const L = long;
  const steps: Step[] = [
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '① 반으로 접었다 펴기', { creaseOnly: true }),
    f(at(0, S / 2), at(S / 2, S), at(0, S), '② 한쪽 귀를 중심선에'),
    f(at(0, S / 2), at(S / 2, 0), at(0, 0), '② 반대쪽 귀를 중심선에'),
    f(at(S / 2, 0), at(S / 2, S), at(0, S / 2), '③ 삼각형 부분 접기'),
    f(at(S / 2, S / 2), at(S, S), at(S / 2, S), '④ 한쪽 귀를 중심선에'),
    f(at(S / 2, S / 2), at(S, 0), at(S / 2, 0), '④ 반대쪽 귀를 중심선에'),
    f(at(S * 0.75, 0), at(S * 0.75, S), at(0, S / 2), '⑤ 두 점이 만나도록'),
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '⑥ 반으로'),
  ];

  /*
   * The two wings, and then the two winglets - each named by pointing at it.
   *
   * A wing was asked for by counting plies: "the top twelve". That names the
   * right paper only while the pile is whole, and folding the first wing
   * divides it - so the second wing, asked for by the same count, took the
   * wrong paper and the two came out showing opposite faces of the sheet. No
   * folded sheet does that; halve one and the outside of the packet is a
   * single face, which is why the book draws both wings the same colour.
   *
   * A point does not drift. Cut along the crease the fold is about to make and
   * the paper still joined to that point is the piece that moves - which is
   * exactly what a hand takes hold of. The two wings come away separately
   * because their only join to each other runs through the fuselage strip, and
   * the cut at the keel removes it.
   */
  /*
   * Where the wing creases is not a measurement - it is two corners meeting.
   *
   * The page says to fold the wing so that two vertices come together and the
   * crease runs parallel to the body, which fixes the line exactly: at the nose
   * the model has its point on the spine and a corner half way out, and the
   * crease is midway between them. Written instead as a keel 25mm wide - close,
   * and read off nothing - it missed by a millimetre and change, and the number
   * said nothing about why it was that number.
   */
  const acrossAxis = height >= width ? 0 : 1;
  const alongAxis = height >= width ? 1 : 0;
  const noseCorners = () => {
    const corners = replay(width, height, steps).model.layers
      .flatMap((l) => layerOutline(l));
    const nose = Math.min(...corners.map((q) => q[alongAxis]!));
    const there = corners
      .filter((q) => Math.abs(q[alongAxis]! - nose) < 1e-9)
      .map((q) => q[acrossAxis]!)
      .sort((a, b) => b - a);
    return [...new Set(there.map((v) => Math.round(v * 1e6) / 1e6))];
  };
  const [spine, shoulder] = noseCorners();
  const wingV = (spine! + shoulder!) / 2;
  /*
   * The finger goes on the wing, which means on the paper as it now lies -
   * the shaping folds have carried the model well away from the middle of the
   * sheet it was cut from, and a point measured there is off the paper.
   */
  const middleU = () => {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    return height >= width ? (min[1] + max[1]) / 2 : (min[0] + max[0]) / 2;
  };
  const wing = (label: string, sense: 'valley' | 'mountain'): Step =>
    f(at(0, wingV), at(L, wingV), at(middleU(), 0), label, {
      sense, angleDeg: 90, plies: { kind: 'piece', at: at(middleU(), wingV / 2) },
    });
  /*
   * One wing down, turn the model over, the other one - which is what the book
   * says and what the hands do.
   *
   * Turning over mirrors the flat layout about its own middle, so afterwards
   * the keel line, the finger and the half that travels all have to be read on
   * the other side. And the second fold is written as a mountain although the
   * hand does the very same thing twice: the paper it takes hold of has been
   * turned over, and a crease is named for what the hand does to the top of
   * the pile, so the engine wants the opposite word for the same act.
   */
  steps.push(wing('⑦ 날개', 'valley'));
  steps.push({ kind: 'flip', label: '뒤집어요' });
  {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    const over = (v: number) => (height >= width ? min[0] + max[0] - v : v);
    const v = over(wingV);
    steps.push(f(at(0, v), at(L, v), at(middleU(), over(0)), '⑧ 반대쪽 날개', {
      sense: 'valley', angleDeg: 90,
      plies: { kind: 'piece', at: at(middleU(), over(wingV / 2)) },
    }));
  }
  steps.push({ kind: 'flip', label: '뒤집어요' });

  /*
   * ⑨ A centimetre in from each wing's own edge - and the same way round: one
   * winglet, turn the model over, the other.
   *
   * Written as two folds on the spot, the second undid the first: it is the
   * same line and the same finger, so it took hold of the paper that had just
   * been turned up and put it back down. The wings are two separate pieces and
   * each has to be come at from its own side.
   */
  const axis = height >= width ? 0 : 1;
  /*
   * Turning the model over swaps the two ends of the layout, so the tip that
   * was the far edge is now the near one. Read as the far edge both times, the
   * second winglet was folded a centimetre from the wing ROOT - through the
   * thick of the model rather than the two plies at the tip - and came out as
   * a wall of paper standing up beside the fuselage.
   */
  const outerEdge = (turned: boolean) => {
    const v = replay(width, height, steps).model.layers
      .flatMap((l) => layerOutline(l)).map((q) => q[axis]);
    return turned ? Math.min(...v) : Math.max(...v);
  };
  const winglet = (label: string, sense: 'valley' | 'mountain', turned: boolean) => {
    const edge = outerEdge(turned);
    const inward = turned ? 0.01 : -0.01;
    const tipV = edge + inward;
    steps.push(f(at(0, tipV), at(L, tipV), at(middleU(), edge), label, {
      sense, angleDeg: 90,
      plies: { kind: 'piece', at: at(middleU(), edge + inward * 0.4) },
    }));
  };
  winglet('⑨ 윙릿 1cm', 'valley', false);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  winglet('⑨ 윙릿 1cm (반대쪽)', 'valley', true);
  steps.push({ kind: 'flip', label: '뒤집어요' });

  return steps;
}

/**
 * Triangle - the second aeroplane from the book, folded as the page draws it.
 *
 * The opening is the same as the Dropship's: halve it, both ears to the middle
 * line. Where it parts company is the third step - the two slanted edges the
 * ears just made are folded to the middle line as well, which is the angle
 * bisector at the point and makes a long narrow dart of the whole sheet.
 *
 * One to three are read straight off the page and measure right. The rest stop
 * here, and not for want of reading the page.
 *
 * Step six is a collapse: two creases crossing in an X on the middle line are
 * pressed and released (four and five), and then both sides are pushed inward
 * until the ringed points - the two ends of the line across the model at the
 * place the creases meet - touch the middle. What the engine has is a collapse
 * that closes EVERY crease meeting at a point flat, and this move does not do
 * that: the middle line has to stay open until step ten folds the model in
 * half. Asked for it anyway, the collapse answers that the angles do not
 * close, and closing only some of them moves no paper at all. Tried by hand
 * here with the X at forty-five degrees, and with a sweep of other lines
 * through the ringed points, nothing folded into what page 27 draws.
 *
 * So this is a missing move, not a missing measurement. It wants either a
 * collapse that may leave a crease open, or an inside-reverse fold of its own.
 */
function triangle(width: number, height: number): Step[] {
  const long = Math.max(width, height);
  const across = Math.min(width, height);
  /** The book's coordinates - u along the sheet, v across it - put on the sheet. */
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);

  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });

  const S = across;
  const L = long;
  /*
   * Where the third step's crease leaves the sheet.
   *
   * The ear fold left an edge at 45 degrees from the point on the middle line.
   * Laying that edge onto the middle line folds about the bisector, at half
   * the angle, and a line at 22.5 degrees from the point reaches the side of
   * the sheet at half the width over tan 22.5 - which is (S/2)(root 2 + 1),
   * about 25.3cm on A4, so it runs off the long edge and not the end.
   */
  const bisector = (S / 2) * (Math.SQRT2 + 1);

  /*
   * Where the two creases meet, which is what the collapse is measured from.
   *
   * The ear the second step folded in has its tip on the edge of the sheet; the
   * third step lays that edge onto the middle line, carrying the tip with it,
   * and the two tips land on the middle line at the same place. That meeting
   * point is the length of the ear's own edge from the nose - half the width
   * over cos 45, which is the width over root two.
   */
  const meet = (S / 2) * Math.SQRT2;
  /*
   * The two places the page rings, and the crease that reaches each.
   *
   * Folding the nose back at that meeting point leaves a line straight across
   * the model, and its two ends are what the hands push in. Pushed in, the
   * paper has to hinge somewhere, and the only line through those ends that
   * the model will take flat runs back to the far end of the middle line -
   * every other one tried leaves a vertex whose angles do not close.
   */

  const steps: Step[] = [
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '① 반으로 접었다 펴기', { creaseOnly: true }),
    f(at(0, S / 2), at(S / 2, S), at(0, S), '② 한쪽 귀를 중심선에'),
    f(at(0, S / 2), at(S / 2, 0), at(0, 0), '② 반대쪽 귀를 중심선에'),
    f(at(0, S / 2), at(bisector, S), at(0, S), '③ 한쪽을 중심선에 한 번 더'),
    f(at(0, S / 2), at(bisector, 0), at(0, 0), '③ 반대쪽을 중심선에 한 번 더'),
    /*
     * The X, pressed and let go: one stroke each.
     *
     * Both cross the middle line at the meeting point, at forty-five degrees.
     * That angle is not a choice: the ringed points sit on the line across the
     * model, and a crease at forty-five to it is the one that reflects a point
     * of that line onto the middle - which is where the page says they end up.
     */
    f(at(meet - S / 2, 0), at(meet + S / 2, S), at(L, 0), '④ 선대로 접었다 펴기',
      { creaseOnly: true }),
    f(at(meet - S / 2, S), at(meet + S / 2, 0), at(L, S), '⑤ 반대쪽도 선대로 접었다 펴기',
      { creaseOnly: true }),
    /*
     * The line the ringed points sit on.
     *
     * The page does not press this one separately - pushing the two ends in
     * forms it - but the engine folds only along creases that exist, so it is
     * pressed here as a mark. Its two ends are the rings.
     */
    f(at(meet, 0), at(meet, S), at(0, S / 2), '⑥ ⭕를 잇는 선 (자국)', { creaseOnly: true }),
    /*
     * Both rings pushed in until they touch the middle line.
     *
     * A waterbomb: the X and the line between the rings close, and the middle
     * line stays open - the model is not halved until step ten. So the middle
     * line is named as the one left alone.
     */
    {
      kind: 'collapse', at: at(meet, S / 2), open: [at(L, S / 2)],
      label: '⑥ 양쪽 ⭕를 안쪽으로 밀어 넣으며',
    },
  ];

  /*
   * ⑦ The nose's point, forward again along the line through two points.
   *
   * The waterbomb turned the nose back over the body, so it now lies on top as
   * a diamond whose far point is the middle of the tail edge. Its two side
   * corners are the ringed points: each is where the front stroke of the X met
   * the edge the third step made, carried back with the nose - on the model's
   * own outline, at 2 x meet - S/2 from the front. The page folds the diamond's
   * far half forward about the line joining them, and only the diamond: the
   * point is taken hold of, and the body underneath is not joined to it there.
   */
  const ring = 2 * meet - S / 2;
  steps.push(f(at(ring, 0), at(ring, S), at(L, S / 2), '⑦ 두 점이 이어지게', {
    plies: { kind: 'piece', at: at(L - 0.03, S / 2 - 0.004) },
  }));
  steps.push({ kind: 'flip', label: '뒤집어요' });

  /*
   * ⑧ The small triangle at the long nose's shoulders, front layers only.
   *
   * Turned over, the model shows the long nose running forward from two
   * shoulders, and between the shoulders and the body's own point a small
   * triangle. Its layers are folded back over the shoulder line; the long nose
   * behind them stays. That line is the crease the nose was turned about in
   * seven, so the layers of the triangle that lay folded under the nose come
   * out flat beside it - a crease opening, which the engine now records as
   * one.
   */
  steps.push(f(at(ring, 0), at(ring, S), at(0, S / 2), '⑧ 두 점이 이어지게 앞장만', {
    plies: { kind: 'piece', at: at((meet + ring) / 2 + 0.01, S / 2 - 0.004) },
  }));
  steps.push({ kind: 'flip', label: '뒤집어요' });

  /*
   * ⑨ The point to a mark seven centimetres back along the middle.
   *
   * The page measures this one and says so. The arrow runs from the point to
   * the mark, so the point is brought to it: the crease is half way, at right
   * angles to the middle line.
   */
  const tip = 2 * ring - L;
  const bluntAt = tip + 0.07 / 2;
  steps.push(f(at(bluntAt, 0), at(bluntAt, S), at(tip, S / 2), '⑨ 7cm 지점에 맞춰'));

  // ⑩ Halved along the middle line - the one crease the waterbomb left open.
  steps.push(f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '⑩ 반으로'));

  /*
   * ⑪⑫ The wings, a centimetre and a half below the spine at both ends.
   *
   * Measured, and the page says so: a mark at each end and the wing folded on
   * the line joining them, which is parallel to the spine.
   *
   * A wing is one half of the packet, all of it. Taken hold of by a point, as
   * the Dropship's are, it came away as the tail end only: on this model the
   * front of each half - the long nose, the turned-back triangle - is joined
   * to the tail only through the keel strip, across the very line being
   * folded, so it stood up through the wing as a wall four centimetres tall.
   * Halving the model laid the half that travelled on top of the pile in one
   * block, so the first wing is that block and the second is the rest, which
   * turning the model over brings to the top whole.
   */
  const keel = 0.015;
  const wingV = S / 2 - keel;
  const fingerU = L - 0.02;
  steps.push(f(at(0, wingV), at(L, wingV), at(fingerU, wingV / 2), '⑪ 날개 (1.5cm)', {
    angleDeg: 90, plies: { kind: 'half' },
  }));
  steps.push({ kind: 'flip', label: '뒤집어요' });
  {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    const over = (v: number) => (height >= width ? min[0] + max[0] - v : v);
    steps.push(f(at(0, over(wingV)), at(L, over(wingV)), at(fingerU, over(wingV / 2)),
      '⑫ 반대쪽 날개', {
        sense: 'valley', angleDeg: 90, plies: { kind: 'half' },
      }));
  }
  steps.push({ kind: 'flip', label: '뒤집어요' });

  /*
   * ⑬ Winglets, a centimetre and a half in from each wing's own edge.
   *
   * Turned the other way from the keel, as on the Dropship: the keel hangs
   * below and the tips turn up. Turning the model over swaps which end of the
   * layout the tip is at, so the second is read from the near edge.
   */
  const axis = height >= width ? 0 : 1;
  const outerEdge = (turned: boolean) => {
    const v = replay(width, height, steps).model.layers
      .flatMap((l) => layerOutline(l)).map((q) => q[axis]);
    return turned ? Math.min(...v) : Math.max(...v);
  };
  const winglet = (label: string, sense: 'valley' | 'mountain', turned: boolean) => {
    const edge = outerEdge(turned);
    const inward = turned ? 0.015 : -0.015;
    steps.push(f(at(0, edge + inward), at(L, edge + inward), at(fingerU, edge), label, {
      sense, angleDeg: 90,
      plies: { kind: 'piece', at: at(fingerU, edge + inward * 0.4) },
    }));
  };
  winglet('⑬ 윙릿 1.5cm', 'valley', false);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  winglet('⑬ 윙릿 1.5cm (반대쪽)', 'valley', true);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  return steps;
}

/**
 * 트랜지션, from the book's three pages (steps one to thirteen).
 *
 * The opening is the Triangle's without the ears: the middle pressed, the two
 * big diagonal creases from the nose corners, and - turned over - the line
 * straight across through where they cross, which on a sheet with no ears
 * folded in is half the width back from the nose. Pushing that line's two
 * ends in makes a waterbomb: a triangle pointing forward from the square's
 * back edge, the tail rectangle behind it.
 *
 * Steps fourteen to seventeen close the model again, mark a line eleven
 * centimetres back and cut the tail off along it with scissors. This app
 * folds and never cuts, so the model stops at thirteen, open and ready to fly;
 * without the cut those marks have nothing to do.
 */
function transition(width: number, height: number): Step[] {
  const long = Math.max(width, height);
  const across = Math.min(width, height);
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);
  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });
  const S = across;
  const L = long;

  const steps: Step[] = [
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '① 반으로 접었다 펴기', { creaseOnly: true }),
    // A corner of the nose laid on the far long edge: the crease runs at 45
    // degrees from the other nose corner and meets that edge a width back.
    f(at(0, S), at(S, 0), at(0, 0), '② 큰 삼각형 모양으로 접었다 펴기', { creaseOnly: true }),
    f(at(0, 0), at(S, S), at(0, S), '③ 반대쪽도 큰 삼각형으로 접었다 펴기', { creaseOnly: true }),
    { kind: 'flip', label: '뒤집어요' },
    // Straight across through the middle of the X, half the width back.
    f(at(S / 2, 0), at(S / 2, S), at(0, S / 2), '④ X자 가운데에 맞춰 접었다 펴기',
      { creaseOnly: true }),
    { kind: 'flip', label: '뒤집어요' },
    // The two ends of that line pushed in; the middle line stays open.
    {
      kind: 'collapse', at: at(S / 2, S / 2), open: [at(L, S / 2)],
      label: '⑤ 양쪽 ⭕를 안쪽으로 밀어 넣으며',
    },
  ];

  /*
   * ⑥ Each front flap's outer corner to the point, front layer only.
   *
   * The waterbomb's front is two right triangles meeting on the middle line,
   * the point half a width back from the nose and the base corners on the
   * square's back edge. Bringing a base corner to the point folds the flap
   * about the line from the middle of the base to the middle of its slanted
   * edge - the two are the same distance from the base's midpoint, so that is
   * the line that takes one onto the other.
   */
  steps.push(f(at(S, S / 2), at((3 * S) / 4, S / 4), at(S - 0.004, 0.004),
    '⑥ 꼭짓점끼리 이어지게 앞장만', { plies: { kind: 'piece', at: at(S - 0.006, 0.008) } }));
  steps.push(f(at(S, S / 2), at((3 * S) / 4, (3 * S) / 4), at(S - 0.004, S - 0.004),
    '⑥ 반대쪽도 앞장만', { plies: { kind: 'piece', at: at(S - 0.006, S - 0.008) } }));

  // ⑦ The point to the middle of the base: the crease is half way between.
  const lock = (3 * S) / 4;
  steps.push(f(at(lock, 0), at(lock, S), at(S / 2 + 0.01, S / 2), '⑦ 두 점이 만나도록'));

  /*
   * ⑧ The front small triangle opened out again.
   *
   * Taken hold of by the point on top: what comes with it is the paper joined
   * to it without crossing the crease - the point's back and front layers,
   * held together along its slanted edges. The halves the sixth step folded
   * over are joined to the rest only across this crease, so their points stay
   * folded in.
   */
  steps.push(f(at(lock, 0), at(lock, S), at(lock + 0.01, S / 2), '⑧ 앞장의 작은 삼각형만 다시 펴기', {
    plies: { kind: 'piece', at: at(0.8 * S, 0.49 * S) },
  }));

  /*
   * ⑨ And tucked in to lock it.
   *
   * The same four layers go back on the same crease, but inside: coming
   * forward from behind, the point meets the back of the front layers and
   * slides in between - which is what keeps the nose from springing open.
   * From outside it looks just as it did after seven.
   */
  steps.push(f(at(lock, 0), at(lock, S), at(lock - 0.01, S / 2), '⑨ 안쪽으로 접어 넣어 잠그기', {
    plies: { kind: 'piece', at: at(lock - 0.02, 0.49 * S) }, tuck: true,
  }));

  // ⑩ Halved along the middle line, the one crease the waterbomb left open.
  steps.push(f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '⑩ 반으로 접기'));

  // ⑪⑫ The wings, 1.5cm from the spine at both ends - as on the Triangle.
  const keel = 0.015;
  const wingV = S / 2 - keel;
  const fingerU = L - 0.02;
  steps.push(f(at(0, wingV), at(L, wingV), at(fingerU, wingV / 2), '⑪ 날개 접기 (1.5cm)', {
    angleDeg: 90, plies: { kind: 'half' },
  }));
  steps.push({ kind: 'flip', label: '뒤집어요' });
  {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    const over = (v: number) => (height >= width ? min[0] + max[0] - v : v);
    steps.push(f(at(0, over(wingV)), at(L, over(wingV)), at(fingerU, over(wingV / 2)),
      '⑫ 반대쪽 날개도 똑같이', { angleDeg: 90, plies: { kind: 'half' } }));
  }
  steps.push({ kind: 'flip', label: '뒤집어요' });

  // ⑬ Winglets, 1.5cm in from each wing's own edge, turned up away from the keel.
  const axis = height >= width ? 0 : 1;
  const outerEdge = (turned: boolean) => {
    const v = replay(width, height, steps).model.layers
      .flatMap((l) => layerOutline(l)).map((q) => q[axis]);
    return turned ? Math.min(...v) : Math.max(...v);
  };
  const winglet = (label: string, turned: boolean) => {
    const edge = outerEdge(turned);
    const inward = turned ? 0.015 : -0.015;
    steps.push(f(at(0, edge + inward), at(L, edge + inward), at(fingerU, edge), label, {
      angleDeg: 90, plies: { kind: 'piece', at: at(fingerU, edge + inward * 0.4) },
    }));
  };
  winglet('⑬ 윙릿 접기 (1.5cm)', false);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  winglet('⑬ 반대쪽 윙릿도', true);
  steps.push({ kind: 'flip', label: '뒤집어요' });

  return steps;
}

/**
 * 이지로크 스카이킹, from the book's two pages of steps.
 *
 * Ears to the middle, the nose thrown back a centimetre past where they end,
 * the new corners folded in twice, and the point of the thrown-back nose
 * brought forward over them - the easy lock of the name. Every point is found
 * from a crease or an edge; the only measurements are the ones the page
 * prints (1cm, 1.5cm, 1cm).
 */
function skyking(width: number, height: number): Step[] {
  const long = Math.max(width, height);
  const across = Math.min(width, height);
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);
  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });
  const S = across;
  const L = long;
  const t = Math.tan(Math.PI / 8);

  const steps: Step[] = [
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '① 반으로 접었다 펴기', { creaseOnly: true }),
    { kind: 'flip', label: '뒤집어요' },
    f(at(0, S / 2), at(S / 2, S), at(0, S), '② 한쪽 귀를 중심선에'),
    f(at(0, S / 2), at(S / 2, 0), at(0, 0), '② 반대쪽 귀를 중심선에'),
  ];

  // ③ The nose triangle thrown back, a centimetre past the ears' own ends.
  const back = S / 2 + 0.01;
  steps.push(f(at(back, 0), at(back, S), at(0, S / 2), '③ 1cm 지점을 잇는 선대로 접기'));

  /*
   * ④ The new corners to the middle, pressed and let go.
   *
   * Laying the front edge on the middle line folds about the line at 45
   * degrees from where the two meet, which reaches the side of the model half
   * a width back.
   */
  const side = back + S / 2;
  steps.push(f(at(back, S / 2), at(side, 0), at(back, 0), '④ 가운데 선에 맞춰 접었다 펴기',
    { creaseOnly: true }));
  steps.push(f(at(back, S / 2), at(side, S), at(back, S), '④ 반대쪽도 접었다 펴기',
    { creaseOnly: true }));

  /*
   * ⑤ Each corner folded so the side edge lies along the crease from four.
   *
   * The two meet at the side, half a width back, at 45 degrees; the fold
   * halves that, and at 22.5 degrees from there it meets the front edge
   * half a width times tan 22.5 in from the side.
   */
  const cut = (S / 2) * t;
  steps.push(f(at(side, 0), at(back, cut), at(back, 0), '⑤ ④의 선에 맞춰 접기'));
  steps.push(f(at(side, S), at(back, S - cut), at(back, S), '⑤ 반대쪽도'));

  // ⑥ Then on the crease from four.
  steps.push(f(at(back, S / 2), at(side, 0), at(back + 0.005, 0.002), '⑥ ④의 선대로 접기'));
  steps.push(f(at(back, S / 2), at(side, S), at(back + 0.005, S - 0.002), '⑥ 반대쪽도'));

  /*
   * ⑦ The lock: the thrown-back nose's point, brought forward over the flaps.
   *
   * Its point shows in the V between the two flaps. The page rings where each
   * of its slanted edges crosses a flap's inner edge and folds on the line
   * through the two. The slanted edge runs from where the ear's end landed,
   * a centimetre behind the fold, to the point two folds back; the flap's inner
   * edge is the fifth step's crease laid over by the sixth, from the side at
   * half a width back to the middle line a (half width x tan 22.5) short of it.
   */
  const tipU = 2 * back;
  const edgeFrom = 2 * back - S / 2;
  const inner = (S / 2) / (side - (side - cut));
  // v = u - edgeFrom  meets  v = (side - u) * inner
  const lockU = (edgeFrom + side * inner) / (1 + inner);
  steps.push(f(at(lockU, 0), at(lockU, S), at(tipU - 0.004, S / 2), '⑦ 두 점을 잇는 선대로 접어 잠그기', {
    plies: { kind: 'piece', at: at(tipU - 0.006, S / 2 - 0.002) },
  }));

  // ⑧ The model's point to the lock's point, which is now two folds forward.
  const lockTip = 2 * lockU - tipU;
  const blunt = (back + lockTip) / 2;
  steps.push(f(at(blunt, 0), at(blunt, S), at(back + 0.003, S / 2), '⑧ 두 점이 만나도록 접기'));

  /*
   * ⑨ Halved away from you - the lock outside: turned over, then halved
   * toward you. Not turned back: that would put the spine on the far edge,
   * and the wings are measured from the spine.
   */
  steps.push({ kind: 'flip', label: '뒤집어요' });
  steps.push(f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '⑨ 뒤로 반 접기'));

  // ⑩⑪ The wings, 1.5cm from the spine at both ends.
  const keel = 0.015;
  const wingV = S / 2 - keel;
  const fingerU = L - 0.02;
  steps.push(f(at(0, wingV), at(L, wingV), at(fingerU, wingV / 2), '⑩ 날개 접기 (1.5cm)', {
    angleDeg: 90, plies: { kind: 'half' },
  }));
  steps.push({ kind: 'flip', label: '뒤집어요' });
  {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    const over = (v: number) => (height >= width ? min[0] + max[0] - v : v);
    steps.push(f(at(0, over(wingV)), at(L, over(wingV)), at(fingerU, over(wingV / 2)),
      '⑪ 반대쪽 날개도 똑같이', { angleDeg: 90, plies: { kind: 'half' } }));
  }
  steps.push({ kind: 'flip', label: '뒤집어요' });

  // ⑫ Winglets, 1cm in from each wing's own edge, turned up away from the keel.
  const axis = height >= width ? 0 : 1;
  const outerEdge = (turned: boolean) => {
    const v = replay(width, height, steps).model.layers
      .flatMap((l) => layerOutline(l)).map((q) => q[axis]);
    return turned ? Math.min(...v) : Math.max(...v);
  };
  const winglet = (label: string, turned: boolean) => {
    const edge = outerEdge(turned);
    const inward = turned ? 0.01 : -0.01;
    steps.push(f(at(0, edge + inward), at(L, edge + inward), at(fingerU, edge), label, {
      angleDeg: 90, plies: { kind: 'piece', at: at(fingerU, edge + inward * 0.4) },
    }));
  };
  winglet('⑫ 윙릿 접기 (1cm)', false);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  winglet('⑫ 반대쪽 윙릿도', true);
  steps.push({ kind: 'flip', label: '뒤집어요' });
  return steps;
}

/**
 * 버드맨, from the book's two pages of steps.
 *
 * A flying wing with a rolled leading edge. The nose edge is brought to a mark
 * 1.8cm in front of the middle, and the strip that makes is then halved and
 * rolled over, halved and rolled over again, twice - a thick, stiff front edge
 * for a wing with almost nothing behind it. Halved, a keel 1.5cm deep at the
 * front and 0.8cm at the back, and winglets a centimetre in from each tip.
 *
 * The last step presses a curve into the thick part with a finger (벤딩).
 * That shapes the paper without folding it, so it is left to the pupil.
 */
function birdman(width: number, height: number): Step[] {
  const long = Math.max(width, height);
  const across = Math.min(width, height);
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);
  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });
  const S = across;
  const L = long;
  const mark = L / 2 - 0.018;

  const steps: Step[] = [
    f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '① 반으로 접었다 펴기', { creaseOnly: true }),
    f(at(L / 2, 0), at(L / 2, S), at(0, S / 2), '② 반대로 반 접었다 펴기', { creaseOnly: true }),
    // ③ A mark 1.8cm toward the nose from where the two creases cross.
    { kind: 'dimension', a: at(L / 2, S / 2), b: at(mark, S / 2), label: '③ 1.8cm 지점에 표시' },
  ];

  /*
   * ④ The middle of the nose edge onto the mark: the crease is half way.
   * Then the strip that makes, rolled: halved (the half by the fold goes
   * over), rolled over on its own edge, halved again, rolled twice more. Each
   * halving folds at the middle of the strip, each roll at its far edge.
   */
  let edge = mark / 2;
  steps.push(f(at(edge, 0), at(edge, S), at(0.001, S / 2), '④ 앞끝을 ③의 1.8cm 표시에 맞춰 접기'));
  let strip = edge; // width of the folded strip, from `edge` toward the tail
  const half = (label: string) => {
    const line = edge + strip / 2;
    steps.push(f(at(line, 0), at(line, S), at(edge + 0.0005, S / 2), label));
    edge = line;
    strip /= 2;
  };
  const roll = (label: string) => {
    const line = edge + strip;
    steps.push(f(at(line, 0), at(line, S), at(edge + 0.0005, S / 2), label));
    edge = line;
  };
  half('⑤ 접은 부분을 반으로 접기');
  roll('⑥ 선대로 접기');
  half('⑦ 접은 부분을 반으로 접기');
  roll('⑧ 선대로 접기');
  roll('⑨ 선대로 한 번 더 접기');

  // ⑩ Halved along the middle.
  steps.push(f(at(0, S / 2), at(L, S / 2), at(L / 2, S), '⑩ 반으로 접기'));

  /*
   * ⑪⑫ The wings: the keel 1.5cm deep at the front, 0.8cm at the back.
   *
   * Each wing is one half of the halved packet. Found by its spine, as the
   * other planes' are, the rolled edge's many plies hid which pairs meet at
   * the spine and both halves went at once; but halving laid the half that
   * travelled on top of the pile whole, so it is simply the top half of the
   * plies - and turning over brings the other half to the top.
   */
  const front = edge;
  const fingerU = L - 0.02;
  const wingAt = (u: number) => S / 2 - (0.015 + (0.008 - 0.015) * (u - front) / (L - front));
  // The wing's tip edge before it is folded: the packet's far side, straight
  // along the body - the sheet's own edges, brought together by the halving.
  const axis = height >= width ? 0 : 1;
  const tipV = Math.min(...replay(width, height, steps).model.layers
    .flatMap((l) => layerOutline(l)).map((q) => q[axis]!));
  steps.push(f(at(front, wingAt(front)), at(L, wingAt(L)), at(fingerU, wingAt(fingerU) / 2),
    '⑪ 날개 접기 (앞 1.5cm · 뒤 0.8cm)', { angleDeg: 90, plies: { kind: 'wing', upper: true } }));
  /*
   * Turning over mirrors the page about the middle of the model as it is at
   * that moment, and each fold moves that middle - so every flip is measured
   * where it happens, and a line on the first page is carried through all of
   * them to the page it is folded on.
   */
  const flips: number[] = [];
  const flip = () => {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    flips.push(min[axis]! + max[axis]!);
    steps.push({ kind: 'flip', label: '뒤집어요' });
  };
  const toPage = (v: number) => (height >= width
    ? flips.reduce((w, c) => c - w, v) : v);
  flip();
  steps.push(f(at(front, toPage(wingAt(front))), at(L, toPage(wingAt(L))),
    at(fingerU, toPage(wingAt(fingerU) / 2)), '⑫ 반대쪽 날개도 똑같이',
    { angleDeg: 90, plies: { kind: 'wing', upper: true } }));
  flip();

  /*
   * ⑬ Winglets, 1cm in from each wing's tip - marked at the front and at the
   * back, so the crease runs along the tip edge the whole chord.
   *
   * The book opens the wing flat to mark it, and there the tip is the sheet's
   * straight edge. Folded, the wing lies turned over its slanted crease, 1.5cm
   * at the nose and 0.8cm at the tail, and the tip with it: a crease drawn
   * parallel to the body there met the tip only part way and made each winglet
   * a triangle where the book has a strip. So the line is marked where the book
   * marks it, on the open wing, turned over the wing's crease to where that
   * paper lies now, and carried to the page it is folded on.
   */
  const mirror = (u: number, v: number): [number, number] => {
    const a = [front, wingAt(front)];
    const du = L - front;
    const dv = wingAt(L) - wingAt(front);
    const t = ((u - a[0]!) * du + (v - a[1]!) * dv) / (du * du + dv * dv);
    return [2 * (a[0]! + t * du) - u, 2 * (a[1]! + t * dv) - v];
  };
  const on = (u: number, d: number): Vec2 => {
    const [mu, mv] = mirror(u, tipV + d);
    return at(mu, toPage(mv));
  };
  const winglet = (label: string) => steps.push(f(on(0, 0.01), on(L, 0.01), on(fingerU, 0.003),
    label, { angleDeg: 90, plies: { kind: 'piece', at: on(fingerU, 0.006) } }));
  winglet('⑬ 윙릿 접기 (1cm)');
  flip();
  winglet('⑬ 반대쪽 윙릿도');
  flip();
  return steps;
}

/**
 * 오르막길 (Highest), from the WEPLAY cafe tutorial and the crease pattern a
 * reader drew of it in ORIPA.
 *
 * The tutorial folds, opens everything out, and folds again along the lines
 * it made: the centre, the lines 1.5cm either side of it and the corner
 * diagonals are pressed and let out; the band's lines are rolled into the
 * flat sheet first; then the corners go in and the nose is rolled down along
 * the lines already there. Nine roll lines, 1.925cm apart on A4 from the
 * third, the last at the pencilled "11.5" from the tail.
 *
 * The fifth roll is where the nose locks. Rolled at that line, the corner
 * flap and the band meet the diagonal at one point (V), and the tutorial's
 * "선 정리 · 선 밀고 · 내려접기" turns the flap's lower part in about V so the
 * side edge runs along a steeper line, the band's layers pleating round the
 * point. On the reader's pattern that is a fan of lines out of V; here it is
 * one collapse along those lines, their angles set so the fold lies flat
 * (alternate angles round V adding to 180 degrees) and the layers stack.
 *
 * The tutorial's ORIPA drawing has the same eight creases round V with the
 * same mountains and valleys, at angles within 2.5 degrees of these (read off
 * a screenshot of it: 84, 116 and 237.5). Put in instead, the lock no longer
 * stacked - nine places passed through each other - so a screenshot is not
 * exact enough; the pattern's own file would be.
 */
export const HIGHEST_LOCK = { F: 240, E: 117, B: 83 };
function highest(width: number, height: number): Step[] {
  const at = (u: number, v: number): Vec2 => (height >= width ? [v, u] : [u, v]);
  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string,
    extra: Partial<FoldStep> = {}): Step => ({
    kind: 'fold', a, b, movingSide: moving, sense: 'valley',
    creaseOnly: false, label, ...extra,
  });
  const S = Math.min(width, height);
  const L = Math.max(width, height);
  const axis = height >= width ? 0 : 1;
  const flips: number[] = [];
  const steps: Step[] = [];
  const flip = (label = '뒤집어요') => {
    const { min, max } = modelBounds(replay(width, height, steps).model);
    flips.push(min[axis]! + max[axis]!);
    steps.push({ kind: 'flip', label });
  };
  const toPage = (v: number) => (height >= width ? flips.reduce((w, c) => c - w, v) : v);
  const n = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩', '⑪', '⑫', '⑬', '⑭', '⑮', '⑯', '⑰', '⑱', '⑲', '⑳',
    '㉑', '㉒', '㉓', '㉔', '㉕', '㉖', '㉗', '㉘', '㉙', '㉚'];
  let k = 0;
  const no = () => n[k++] ?? `${k}.`;
  const cm = (m: number) => `${(m * 100).toFixed(1)}cm`;
  const last = L - 0.115;
  const gap = (last - 0.028) / 8;
  const rolls = [0.014, 0.028, ...Array.from({ length: 8 }, (_, i) => 0.028 + gap * (i + 1))];
  const wingV = S / 2 - 0.015;

  // Pressed and let out: the lines everything is folded back along.
  steps.push(f(at(0, S / 2), at(L, S / 2), at(L / 2, S), `${no()} 반으로 접었다 펴기`, { creaseOnly: true }));
  steps.push(f(at(0, S / 2), at(S / 2, 0), at(0.002, 0.002), `${no()} 모서리를 가운데 선에 맞춰 접었다 펴기`, { creaseOnly: true, symmetric: true }));
  // The band's lines rolled into the flat sheet first: the tutorial rolls the
  // edge up strip by strip and opens it again. (The first of them, at the
  // corners' reach, is pressed by the roll itself: pressed ahead, it would
  // cross the lock's lines where they meet the side.)
  for (const line of rolls.slice(6)) {
    steps.push(f(at(line, 0), at(line, S), at(line - 0.003, S / 2), `${no()} 앞쪽을 ${cm(line)} 선까지 말아 자국 내기`, { creaseOnly: true }));
  }

  // Folded again along them.
  steps.push(f(at(0, S / 2), at(S / 2, 0), at(0.002, 0.002), `${no()} 왼쪽 모서리를 자국대로 가운데에 맞춰 접기`));
  steps.push(f(at(0, S / 2), at(S / 2, S), at(0.002, S - 0.002), `${no()} 오른쪽 모서리도 자국대로 접기`));
  flip();
  rolls.slice(0, 4).forEach((line, i) => {
    const label = i === 0 ? `${no()} 뾰족한 코끝을 ${cm(line)} 선에서 접어 내리기`
      : `${no()} 접은 부분을 통째로 ${cm(line)} 선까지 말아 접기`;
    steps.push(f(at(line, toPage(0)), at(line, toPage(S)), at(Math.max(0.001, line - 0.003), toPage(S / 2)), label));
  });

  /*
   * The fifth roll and the lock, one move. Lines on the unfolded sheet (its
   * own coordinates, width across and length from the nose), left half; the
   * right is its mirror.
   */
  const V: Vec2 = [S / 2 - rolls[4]!, rolls[4]!];
  const deg = Math.PI / 180;
  const ray = (angleDeg: number): Vec2 => {
    // From V at an angle measured with y up, out to the sheet's nose or side edge.
    const dx = Math.cos(angleDeg * deg);
    const dy = -Math.sin(angleDeg * deg);
    const ks = [dx < 0 ? -V[0] / dx : Infinity, dy < 0 ? -V[1] / dy : Infinity].filter((t) => t > 0);
    const t = Math.min(...ks);
    return [V[0] + dx * t, V[1] + dy * t];
  };
  const toCorner = Math.atan2(V[1], -V[0]) / deg;
  const { F, E, B } = HIGHEST_LOCK;
  // The last pleat line follows from the others: alternate angles round V add to 180.
  const D = B - (180 - (toCorner - 90) - E + F - 360 + 45);
  const sheet = (p: Vec2): Vec2 => (height >= width ? [p[0], p[1]] : [p[1], p[0]]);
  const half: PatternLine[] = [
    { a: V, b: [S / 2, V[1]], kind: 'mountain' },          // the fifth roll line
    { a: [V[0], 0], b: V, kind: 'mountain' },               // the same line through the flap
    { a: V, b: ray(toCorner), kind: 'valley' },             // pleat to the corner
    { a: V, b: ray(B), kind: 'valley' },
    { a: V, b: ray(D), kind: 'mountain' },
    { a: V, b: ray(E), kind: 'valley' },
    { a: V, b: ray(F), kind: 'mountain' },                  // the new side edge
    { a: V, b: [0, S / 2], kind: 'open' },                  // the corner fold below V lets out
    // The flap wraps the band the other way from the fourth roll down: the lock.
    { a: [V[0] + (rolls[4]! - rolls[3]!), 0], b: [V[0] + (rolls[4]! - rolls[3]!), rolls[3]!], kind: 'mountain' },
    { a: [V[0] + (rolls[4]! - rolls[3]!), rolls[3]!], b: V, kind: 'mountain' },
  ];
  const lines = [...half, ...half.map((l) => ({ ...l, a: [S - l.a[0], l.a[1]] as Vec2, b: [S - l.b[0], l.b[1]] as Vec2 }))]
    .map((l) => ({ ...l, a: sheet(l.a), b: sheet(l.b) }));
  steps.push({
    kind: 'collapse', at: at(rolls[4]!, toPage(V[0])), lines,
    label: `${no()} ${cm(rolls[4]!)} 선까지 말면서 코 옆 잠그기 (선 정리 · 선 밀고 · 내려접기)`,
  });

  rolls.slice(5).forEach((line, i) => {
    const label = i === 4 ? `${no()} 마지막으로 자국대로 한 번 더 말아 접기 (${cm(line)}, 꼬리에서 11.5cm)`
      : `${no()} 자국대로 ${cm(line)} 선까지 말아 접기`;
    steps.push(f(at(line, toPage(0)), at(line, toPage(S)), at(line - 0.003, toPage(S / 2)), label));
  });

  steps.push(f(at(0, toPage(wingV)), at(L, toPage(wingV)), at(L / 2, toPage(0)), `${no()} 가운데에서 1.5cm 선 접었다 펴기`, { creaseOnly: true, symmetric: true }));
  steps.push(f(at(0, toPage(S / 2)), at(L, toPage(S / 2)), at(L / 2, toPage(S)), `${no()} 반으로 접기`));
  const fingerU = L - 0.02;
  steps.push(f(at(last, toPage(wingV)), at(L, toPage(wingV)), at(fingerU, toPage(wingV / 2)),
    `${no()} 날개 접기 (가운데에서 1.5cm)`, { angleDeg: 90, plies: { kind: 'wing', upper: true } }));
  flip();
  steps.push(f(at(last, toPage(wingV)), at(L, toPage(wingV)), at(fingerU, toPage(wingV / 2)),
    `${no()} 반대쪽 날개도 똑같이`, { angleDeg: 90, plies: { kind: 'wing', upper: true } }));
  flip();

  // Winglets, 1cm, the way the folding screen's 윙렛 접기 makes them.
  const paper = paperProps({ id: 'custom', name: '종이', widthMm: width * 1000, heightMm: height * 1000 }, 90);
  const tips = wingletSteps(width, height, steps, 10, paper, 1);
  if (Array.isArray(tips)) steps.push(...tips.map((t) => ({ ...t, label: `${no()} ${t.label}` })));
  return steps;
}

export const SAMPLES: readonly Sample[] = [
  { id: 'dart', name: '다트', build: dart },
  { id: 'square', name: '스퀘어', build: square },
  { id: 'jet', name: '드롭십', build: jet },
  { id: 'triangle', name: '트라이앵글', build: triangle },
  { id: 'transition', name: '트랜지션', build: transition },
  { id: 'skyking', name: '이지로크 스카이킹', build: skyking },
  { id: 'birdman', name: '버드맨', build: birdman },
  { id: 'highest', name: '오르막길', build: highest },
];
