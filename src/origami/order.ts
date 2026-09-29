/**
 * Finding a stacking the paper can take, rather than assuming one.
 *
 * Folding assigns an order as it goes: the flap that travelled goes on top, or
 * underneath, and the rest keeps the order it had. That is a guess made one
 * fold at a time, and a pile has to satisfy every fold at once - so the guess
 * can be wrong even when each fold in turn looked reasonable, and it can be
 * arbitrary where nothing forces it. Both show. A wrong order is paper passing
 * through itself; an arbitrary one is two wings of the same aeroplane sitting
 * at different heights because one was sent to the top of the list and its
 * mirror image to the bottom.
 *
 * So this searches instead. The conditions are the two `layers.ts` audits for,
 * both local to a crease:
 *
 *  - a crease closed flat makes a pocket out of the two faces it joins, and
 *    another pocket over the same crease cannot be half inside it;
 *  - a face lying inside a pocket cannot run out past its closed end.
 *
 * Everything else follows from those plus transitivity, which a total order
 * gives for free. The search is over "which of these two faces is on top" for
 * every pair that shares any paper - nothing else is decided, because nothing
 * else is determined: faces that never meet have no order between them, and
 * leaving them alone is what keeps mirror images at the same height.
 */

import {
  area, clipTo, orderViolations, pastClosedEnd, segmentsShareRun, side, tacos, centroid,
} from './layers.js';
import { faceOutline } from './folding.js';
import type { FoldedState } from './folding.js';

/** i is above j, for i < j. Stored once per pair. */
type Pair = { readonly i: number; readonly j: number };

const keyOf = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export interface OrderSearch {
  /** The order found, bottom of the pile first, or null if there is none. */
  readonly order: readonly number[] | null;
  /** How many pairs the conditions actually decided between. */
  readonly pairs: number;
  /** Steps taken; a search that runs out returns null rather than guessing. */
  readonly steps: number;
  readonly exhausted: boolean;
}

export interface OrderOptions {
  /** Overlaps smaller than this are contact, not stacking. m^2. */
  readonly minArea?: number;
  /** Give up rather than hang; the caller keeps what it had. */
  readonly maxSteps?: number;
}

/**
 * A constraint over three or four faces, written as the pair relations it
 * forbids. Each entry says: if every listed pair has the listed value, the
 * paper is passing through itself.
 */
interface Forbidden {
  readonly terms: ReadonlyArray<{ readonly key: string; readonly above: boolean }>;
}

/*
 * The conditions depend on where the paper is, not on the order it is in: a
 * search started again from other orders (settleOrder does it from dozens)
 * asks the same questions of the same paper, and working them out - every
 * pocket, every three faces on one spot - took a second each time. Kept per
 * layout.
 */
interface Setup {
  readonly count: number;
  readonly pairs: Pair[];
  readonly index: Map<string, number>;
  readonly touching: Map<number, Forbidden[]>;
  readonly slotsOf: Map<Forbidden, number[]>;
}
const setups = new WeakMap<object, { matrices: unknown; minArea: number; setup: Setup }>();

function constraintsOf(state: FoldedState, minArea: number): Setup {
  const kept = setups.get(state.graph);
  if (kept && kept.matrices === state.faces_matrix && kept.minArea === minArea) return kept.setup;
  const count = state.graph.faces_vertices.length;
  const outlines = state.graph.faces_vertices.map((_, f) => faceOutline(state, f));
  const pockets = tacos(state);

  /*
   * Only paper that shares paper gets an order.
   *
   * Two faces that never meet cannot be above or below each other in any sense
   * the paper cares about, so the search does not decide between them and the
   * answer keeps whatever order they arrived in.
   */
  const pairs: Pair[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (area(clipTo(outlines[i]!, outlines[j]!)) < minArea) continue;
      index.set(keyOf(i, j), pairs.length);
      pairs.push({ i, j });
    }
  }

  /*
   * "c lies between a and b" as a statement about pairs.
   *
   * Written out rather than looked up in an order, because during the search
   * there is no order yet - only the relations decided so far.
   */
  const betweenTerms = (c: number, a: number, b: number) => {
    const ca = keyOf(c, a);
    const cb = keyOf(c, b);
    const ab = keyOf(a, b);
    if (!index.has(ca) || !index.has(cb) || !index.has(ab)) return null;
    return { ca, cb, ab, c, a, b };
  };
  const forbidden: Forbidden[] = [];
  const add = (terms: Forbidden['terms']) => { forbidden.push({ terms }); };

  /*
   * Two pockets over the same crease cannot be threaded through each other.
   *
   * Either both of one pocket's faces lie inside the other's, or neither does.
   * Exactly one is the impossible case, and it is forbidden by writing out the
   * four ways it can happen.
   */
  for (let x = 0; x < pockets.length; x++) {
    for (let y = x + 1; y < pockets.length; y++) {
      const p = pockets[x]!;
      const q = pockets[y]!;
      if (!segmentsShareRun(p, q)) continue;
      const [a, b] = p.faces;
      const [c, d] = q.faces;
      if (new Set([a, b, c, d]).size < 4) continue;
      const cIn = betweenTerms(c, a, b);
      const dIn = betweenTerms(d, a, b);
      if (!cIn || !dIn) continue;
      // between(c) != between(d) is forbidden, for each way that can arise.
      for (const cAboveA of [true, false]) {
        for (const dAboveA of [true, false]) {
          // c between, d not.
          add([
            { key: cIn.ca, above: flip(c, a, cAboveA) },
            { key: cIn.cb, above: flip(c, b, !cAboveA) },
            { key: dIn.ca, above: flip(d, a, dAboveA) },
            { key: dIn.cb, above: flip(d, b, dAboveA) },
          ]);
          // d between, c not.
          add([
            { key: dIn.ca, above: flip(d, a, dAboveA) },
            { key: dIn.cb, above: flip(d, b, !dAboveA) },
            { key: cIn.ca, above: flip(c, a, cAboveA) },
            { key: cIn.cb, above: flip(c, b, cAboveA) },
          ]);
        }
      }
    }
  }

  /* A face inside a pocket cannot run out past its closed end. */
  for (const pocket of pockets) {
    const [a, b] = pocket.faces;
    const shared = clipTo(outlines[a]!, outlines[b]!);
    if (area(shared) < minArea) continue;
    const keep = side(pocket.a, pocket.b, centroid(shared)) >= 0;
    for (let c = 0; c < count; c++) {
      if (c === a || c === b) continue;
      if (area(clipTo(outlines[c]!, shared)) < minArea) continue;
      if (area(pastClosedEnd(outlines[c]!, pocket.a, pocket.b, keep)) < minArea) continue;
      const t = betweenTerms(c, a, b);
      if (!t) continue;
      for (const cAboveA of [true, false]) {
        add([
          { key: t.ca, above: flip(c, a, cAboveA) },
          { key: t.cb, above: flip(c, b, !cAboveA) },
        ]);
      }
    }
  }

  /** "a is above b" written for the pair's own storage order. */
  function flip(a: number, b: number, above: boolean): boolean {
    return a < b ? above : !above;
  }

  /*
   * Transitivity where it applies (ORIPA's rule): three faces that all lie on
   * one spot are stacked in a line there, so "a over b, b over c" puts a over
   * c. Written as the two cycles it forbids. Only where the three share paper:
   * faces that overlap two by two in different places may wind round.
   */
  const boxOf = (poly: readonly (readonly number[])[]) => {
    let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
    for (const q of poly) { x0 = Math.min(x0, q[0]!); x1 = Math.max(x1, q[0]!); y0 = Math.min(y0, q[1]!); y1 = Math.max(y1, q[1]!); }
    return [x0, x1, y0, y1] as const;
  };
  const boxes = outlines.map(boxOf);
  for (let x = 0; x < pairs.length; x++) {
    const { i: a, j: b } = pairs[x]!;
    const ab = clipTo(outlines[a]!, outlines[b]!);
    const bb = boxOf(ab);
    for (let c = b + 1; c < count; c++) {
      const ac = keyOf(a, c);
      const bc = keyOf(b, c);
      if (!index.has(ac) || !index.has(bc)) continue;
      const bx = boxes[c]!;
      if (bx[0] > bb[1] || bx[1] < bb[0] || bx[2] > bb[3] || bx[3] < bb[2]) continue;
      if (area(clipTo(ab, outlines[c]!)) < minArea) continue;
      const kab = keyOf(a, b);
      // a>b, b>c, c>a  and its reverse.
      add([{ key: kab, above: true }, { key: bc, above: true }, { key: ac, above: false }]);
      add([{ key: kab, above: false }, { key: bc, above: false }, { key: ac, above: true }]);
    }
  }

  // Which constraints mention each pair, so only those are rechecked.
  const touching = new Map<number, Forbidden[]>();
  const slotsOf = new Map<Forbidden, number[]>();
  for (const f of forbidden) {
    const slots: number[] = [];
    for (const t of f.terms) {
      const at = index.get(t.key);
      if (at === undefined) continue;
      slots.push(at);
      const list = touching.get(at);
      if (list) list.push(f); else touching.set(at, [f]);
    }
    slotsOf.set(f, slots);
  }

  const setup = { count, pairs, index, touching, slotsOf };
  setups.set(state.graph, { matrices: state.faces_matrix, minArea, setup });
  return setup;
}

export function solveOrder(state: FoldedState, options: OrderOptions = {}): OrderSearch {
  const { minArea = 1e-8, maxSteps = 200_000 } = options;
  const { count, pairs, touching, slotsOf } = constraintsOf(state, minArea);
  const value = new Array<boolean | null>(pairs.length).fill(null);
  /*
   * Start from the order the folding assigned.
   *
   * It is usually right, and when it is the search confirms it without
   * exploring anything. When it is not, the first value tried is still the
   * most likely one, which is what keeps the search small.
   */
  const rank = new Map<number, number>();
  state.faces_order.forEach((face, at) => rank.set(face, at));
  const seed = pairs.map(({ i, j }) => (rank.get(i) ?? i) > (rank.get(j) ?? j));

  // Decide the pairs that constraints mention first; the rest are free.
  const bound = pairs.map((_, at) => (touching.get(at)?.length ?? 0));
  const order = pairs.map((_, at) => at)
    .filter((at) => bound[at]! > 0)
    .sort((a, b) => bound[b]! - bound[a]!);

  /*
   * Deciding with propagation, as ORIPA does: every choice is followed at
   * once by all it forces - a forbidden pattern with every term but one in
   * place forces that last pair the other way - so a wrong choice shows at
   * once, not many choices later. Searched with a stack of its own rather
   * than by recursion: a thick pile has thousands of pairs, and one call per
   * pair ran the call stack out.
   */
  const trail: number[] = [];
  const assign = (slot: number, v: boolean): boolean => {
    value[slot] = v;
    trail.push(slot);
    const queue = [slot];
    while (queue.length) {
      const at = queue.pop()!;
      for (const f of touching.get(at) ?? []) {
        let open = -1;
        let openAbove = false;
        let satisfied = false;
        let unknown = 0;
        f.terms.forEach((t, k) => {
          const s2 = slotsOf.get(f)![k]!;
          const val = value[s2];
          if (val === null) { unknown++; open = s2; openAbove = t.above; }
          else if (val !== t.above) satisfied = true;
        });
        if (satisfied) continue;
        if (unknown === 0) return false;              // every term in place: paper through paper
        if (unknown === 1) {                            // the last one is forced the other way
          value[open] = !openAbove;
          trail.push(open);
          queue.push(open);
        }
      }
    }
    return true;
  };
  // Undoing moves the scan back only as far as the earliest pair it frees.
  const posOf = new Map(order.map((slot, i) => [slot, i]));
  let cursor = 0;
  const undoTo = (mark: number) => {
    while (trail.length > mark) {
      const slot = trail.pop()!;
      value[slot] = null;
      const p = posOf.get(slot);
      if (p !== undefined && p < cursor) cursor = p;
    }
  };

  let steps = 0;
  let exhausted = false;
  // Each decision: the trail's length before it, the slot, and whether its second value has been tried.
  const decisions: Array<{ mark: number; slot: number; second: boolean }> = [];
  let ok = true;
  for (;;) {
    if (steps++ > maxSteps) { exhausted = true; ok = false; break; }
    while (cursor < order.length && value[order[cursor]!] !== null) cursor++;
    if (cursor >= order.length) break;                  // every constrained pair decided
    const slot = order[cursor]!;
    const mark = trail.length;
    decisions.push({ mark, slot, second: false });
    if (assign(slot, seed[slot]!)) continue;
    // Conflict: undo, and try the other value of the latest decision still with one left.
    let resolved = false;
    while (decisions.length) {
      const d = decisions[decisions.length - 1]!;
      undoTo(d.mark);
      if (!d.second) {
        d.second = true;
        steps++;
        if (assign(d.slot, !seed[d.slot]!)) { resolved = true; break; }
        continue;
      }
      decisions.pop();
    }
    if (!resolved) { ok = false; break; }
  }
  if (!ok) {
    return { order: null, pairs: pairs.length, steps, exhausted };
  }

  /*
   * Only what the search decided goes into the pile as a rule. The pairs no
   * condition touches keep the order they arrived in through the laying-out
   * itself, which takes the oldest face ready each time; written in as rules
   * too, their old order could close a loop with a pair the search had to
   * turn round, and a pile that exists was reported as none.
   */
  const decided = value.map((v) => v !== null);
  for (let at = 0; at < pairs.length; at++) if (value[at] === null) value[at] = seed[at]!;
  const total = toTotalOrder(count, pairs, value as boolean[], state.faces_order, decided);

  /*
   * The search has to mark its own work.
   *
   * Deciding every pair is not the same as producing a pile: the conditions
   * are checked pair by pair while transitivity only appears once they are
   * laid out in a line, so an assignment that satisfied each condition on its
   * own can still come out as an order the paper cannot take. An answer worse
   * than the one it was handed is no answer, so it says so and the caller
   * keeps what it had.
   */
  if (total === null) return { order: null, pairs: pairs.length, steps, exhausted };
  const found = orderViolations({ ...state, faces_order: total }).length;
  if (found === 0) return { order: total, pairs: pairs.length, steps, exhausted };
  const had = orderViolations(state).length;
  return {
    order: found < had ? total : null,
    pairs: pairs.length,
    steps,
    exhausted,
  };
}

/**
 * The pairwise answers laid out as one pile.
 *
 * A topological sort of "is above", falling back on the order the faces
 * arrived in wherever nothing was decided - which is most of them, and is
 * exactly the point: paper that never meets should not be shuffled.
 */
function toTotalOrder(
  count: number,
  pairs: readonly Pair[],
  value: readonly boolean[],
  previous: readonly number[],
  decided?: readonly boolean[],
): number[] | null {
  const below = new Map<number, Set<number>>();
  for (let f = 0; f < count; f++) below.set(f, new Set());
  pairs.forEach(({ i, j }, at) => {
    if (decided && !decided[at]) return;
    // value true means i is above j.
    if (value[at]) below.get(i)!.add(j); else below.get(j)!.add(i);
  });

  const was = new Map<number, number>();
  previous.forEach((f, at) => was.set(f, at));
  const remaining = new Set<number>(Array.from({ length: count }, (_, f) => f));
  const out: number[] = [];
  while (remaining.size > 0) {
    /*
     * One at a time, and the one that was lowest before.
     *
     * Taking every face that is ready in one go looks like the same thing and
     * is not: paper that overlaps nothing is ready from the very start, so a
     * whole batch of it came out ahead of everything else and the pile was
     * reshuffled where nothing had asked for it. Emitting the oldest ready
     * face and looking again keeps the order it was handed wherever the
     * conditions leave it free - which is most of it.
     */
    let next = -1;
    for (const f of remaining) {
      let clear = true;
      for (const g of below.get(f)!) if (remaining.has(g)) { clear = false; break; }
      if (!clear) continue;
      if (next < 0 || (was.get(f) ?? f) < (was.get(next) ?? next)) next = f;
    }
    if (next < 0) return null;   // a cycle: not a pile at all
    out.push(next);
    remaining.delete(next);
  }
  return out;
}
