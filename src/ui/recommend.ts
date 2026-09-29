/**
 * The elevator a plane flies with until the pupil tunes one.
 *
 * Every paper aeroplane is tuned at the trailing edge before it is judged,
 * and how much it needs depends on how it was folded: a nose-heavy fold wants
 * the edge up, a tail-heavy one wants it down - and bending it costs height
 * to drag, which a fold that needs less of it does not pay. So an untuned
 * plane is not judged flat, which would mark it on a setting nobody throws
 * it with; it is judged at the bend that keeps it up longest on average, and
 * how wide that bend is, is chosen the same way.
 *
 * Worked out from the plane's one record every time, never stored: the
 * record keeps only what the pupil set.
 */

import type { Airframe } from '../aero/airframe.js';
import type { RenderFace } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';
import { defaultElevator } from './elevator.js';
import type { ElevatorTune } from './elevator.js';
import { flightBase, flightReport } from './flightReport.js';
import type { FlightSettings } from './flightReport.js';
import { runThrows, throwsAround } from './flightStats.js';
import { fly } from '../aero/flight.js';

/*
 * Two rounds. First every setting is flown into the same thirty throws of
 * slightly different air, in coarser time steps, to find the few worth a
 * closer look; then those few - and the elevator the plane already has - are
 * flown into the very hundred throws its score is taken from, and the longest
 * average wins. Judged by a dozen throws alone, a setting that got lucky beat
 * a better one, and the "recommended" elevator flew shorter than the plane's
 * own.
 */
const SCREEN_THROWS = 30;
const SCREEN_DT = 0.008;
const FINAL_THROWS = 100;
const FINALISTS = 5;
/*
 * Time aloft counts only for a plane that flies: a setting whose throws mostly
 * never come level - a nose held up, the paper sinking like a parachute - or
 * go over on their backs can stay up a long time, and is no tuning. A throw
 * flies when it comes out a transition or a glide; half the throws is the
 * bar; when no setting reaches it, time alone decides. (A loop that levels
 * off at the bottom used to pass, and a looping Dropship was recommended.)
 */
const FLIES = 0.5;
const flew = (kind: string) => kind === 'transition' || kind === 'glide';
/*
 * The edge is bent over a centimetre first. A bend that has to be steep to
 * do its work is also tried spread over a longer stretch, as it is by hand:
 * the same push from a gentler bend.
 */
const WIDTHS = [1, 2, 3] as const;
const STEEP = 15;

const regionOf = (t: ElevatorTune) => ({ y0: t.fromCm / 100, y1: (t.fromCm + t.widthCm) / 100, depth: t.depthCm / 100 });

function screen(
  af: Airframe, plies: readonly RenderFace[], paper: PaperProps, settings: FlightSettings, widthCm: number,
): { tune: ElevatorTune; time: number; flies: boolean }[] {
  const start = { ...defaultElevator(0), widthCm };
  const region = regionOf(start);
  const base = flightBase(af, plies, region);
  // The elevator only changes the launch, so the aeroplane is set up once.
  const { af: flown, m, launch } = flightReport(base, af, plies, paper, { ...settings, region, elevator: 0 });
  const air = throwsAround(launch, SCREEN_THROWS);
  const tried = new Map<number, { time: number; flies: boolean }>();
  const judge = (deg: number) => {
    let t = tried.get(deg);
    if (t === undefined) {
      const runs = air.map((l) => fly(flown, m, { ...l, elevatorDeg: deg }, SCREEN_DT));
      t = { time: runs.reduce((sum, r) => sum + r.time, 0) / runs.length,
        flies: runs.filter((r) => flew(r.kind)).length / runs.length >= FLIES };
      tried.set(deg, t);
    }
    return t;
  };
  // A setting that flies beats any that does not; among the same, the longer.
  const better = (a: number, b: number) => {
    const x = judge(a); const y = judge(b);
    return x.flies !== y.flies ? x.flies : x.time > y.time + 1e-6;
  };
  let top = 0;
  for (let d = -28; d <= 28; d += 4) if (better(d, top)) top = d;
  for (let d = top - 2; d <= top + 2; d += 1) judge(d);
  return [...tried].map(([angleDeg, j]) => ({ tune: { ...start, angleDeg }, ...j }));
}

/**
 * The plane's average time aloft with this elevator, over the throws its
 * score comes from, and whether enough of them came level to count as flying.
 */
function finalTime(af: Airframe, plies: readonly RenderFace[], paper: PaperProps, settings: FlightSettings, tune: ElevatorTune) {
  const region = regionOf(tune);
  const rep = flightReport(flightBase(af, plies, region), af, plies, paper, { ...settings, region, elevator: tune.angleDeg });
  const results = runThrows(rep.af, rep.m, throwsAround(rep.launch, FINAL_THROWS), 0, FINAL_THROWS);
  const n = Math.max(1, results.length);
  return {
    time: results.reduce((sum, r) => sum + r.time, 0) / n,
    flies: results.filter((r) => flew(r.kind)).length / n >= FLIES,
  };
}

export interface Judged { readonly tune: ElevatorTune; readonly time: number; readonly flies: boolean }

/** Of several, the one that flies longest - among those that fly, when any does; ties to the first. */
export function longest<T extends { time: number; flies: boolean }>(list: readonly T[]): T {
  const pool = list.some((x) => x.flies) ? list.filter((x) => x.flies) : list;
  return pool.reduce((a, b) => (b.time > a.time + 1e-6 ? b : a));
}

const known = new Map<string, Judged>();

/**
 * `key` names the plane and the throw, so the same question is answered once;
 * `current` is the elevator it has now, which the answer must beat to replace.
 */
export function recommendElevator(
  af: Airframe, plies: readonly RenderFace[], paper: PaperProps, settings: FlightSettings,
  key?: string, current?: ElevatorTune,
): ElevatorTune {
  return recommendElevatorTimed(af, plies, paper, settings, key, current).tune;
}

/** The same, with the average time aloft it gives over the hundred throws. */
export function recommendElevatorTimed(
  af: Airframe, plies: readonly RenderFace[], paper: PaperProps, settings: FlightSettings,
  key?: string, current?: ElevatorTune,
): Judged {
  const hit = key ? known.get(key) : undefined;
  if (hit) return hit;
  let tried = screen(af, plies, paper, settings, WIDTHS[0]);
  // Flying settings first, then the longer: the order the finalists are taken in.
  const rank = (x: { time: number; flies: boolean }, y: { time: number; flies: boolean }) => (Number(y.flies) - Number(x.flies)) || (y.time - x.time);
  const steep = (list: typeof tried) => Math.abs([...list].sort(rank)[0]!.tune.angleDeg) >= STEEP;
  for (const w of WIDTHS.slice(1)) {
    if (!steep(tried)) break;
    tried = [...tried, ...screen(af, plies, paper, settings, w)];
  }
  // The plane's own elevator first: a newcomer has to fly longer to replace it, not as long.
  // The same bend twice is flown once.
  const seen = new Set<string>();
  const finalists = [...(current ? [current] : []), ...[...tried].sort(rank).slice(0, FINALISTS).map((c) => c.tune)]
    .filter((t) => { const k = `${t.fromCm},${t.widthCm},${t.depthCm},${t.angleDeg}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const out = longest(finalists.map((tune) => ({ tune, ...finalTime(af, plies, paper, settings, tune) })));
  if (key) {
    if (known.size > 40) known.clear();
    known.set(key, out);
  }
  return out;
}
