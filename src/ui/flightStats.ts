/**
 * Many throws, not one.
 *
 * No two throws meet the same air: even indoors it drifts, and outdoors it
 * gusts. One simulated throw is therefore one lucky or unlucky throw, and a
 * number from it says less than it seems to. The flying screen shows what ten
 * or a hundred throws around the chosen one come to - the average, the usual
 * spread, the best - and judges the aeroplane on those.
 *
 * The throws are seeded, so the same settings always give the same numbers:
 * a pupil changing one thing sees the effect of that thing, not of chance.
 */

import type { Airframe } from '../aero/airframe.js';
import type { PlaneSpec } from '../aero/spec.js';
import { fly, wingBending } from '../aero/flight.js';
import type { AeroModel, Flight, FlightKind, FlightScore, Launch } from '../aero/flight.js';
import type { PaperProps } from '../paper/stock.js';
import type { Grade } from './flightReport.js';

/*
 * The throw is the pupil's, as set: what differs from one to the next is the
 * air it meets, and the hand's own small wobble (below). One standard deviation each, indoors - still room air
 * moves at less than 0.2 m/s (the comfort limit rooms are ventilated to) -
 * and `gust` times that outdoors, where a 2 m/s breeze gusts by a fifth.
 *
 * A steady wind only carries the whole flight along, so it is the rise and
 * fall of the air that changes how long a flight lasts: the vertical spread
 * grows outdoors with the rest, or indoors and outdoors came out the same
 * length. Held steady over the flight it stays small - 0.2 m/s held steady is
 * a thermal, and doubles the flight of a glider sinking at 0.7.
 */
/*
 * And the hand: thrown with the wings level, but no hand lets go exactly
 * level - a degree or two either way, one standard deviation of 2° here (an
 * estimate, not a measurement). It matters: a throw exactly level that goes
 * over the top comes back down the same way it went up, where any tilt at
 * all lets it roll out at the top as a real one does.
 */
const SPREAD = { gust: 0.15, side: 0.12, rise: 0.05, bank: 2 };
const SEED = 20260926;

/** A small, fast, seedable generator (mulberry32). */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The chosen throw, repeated into slightly different air: the same list every time. */
export function throwsAround(launch: Launch, n: number, seed = SEED): Launch[] {
  const next = random(seed);
  const normal = () => {
    const u = Math.max(1e-9, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const out: Launch[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      ...launch,
      headwind: launch.headwind + (launch.gust ?? 1) * SPREAD.gust * normal(),
      crosswind: launch.crosswind + (launch.gust ?? 1) * SPREAD.side * normal(),
      updraft: (launch.updraft ?? 0) + (launch.gust ?? 1) * SPREAD.rise * normal(),
      bankDeg: (launch.bankDeg ?? 0) + SPREAD.bank * normal(),
    });
  }
  return out;
}

export interface ThrowResult {
  readonly time: number;
  readonly height: number;
  readonly distance: number;
  readonly kind: FlightKind;
  readonly score: FlightScore;
  readonly maxLoad: number;
  readonly flight: Flight;
}

/** Throws `from` to `to` of the list, for working through it a slice at a time. */
export function runThrows(af: Airframe, m: AeroModel, launches: readonly Launch[], from: number, to: number): ThrowResult[] {
  const out: ThrowResult[] = [];
  for (let i = from; i < Math.min(to, launches.length); i++) {
    // An 8 ms step gives the same flights as 1-4 ms for these gliders - every
    // book plane's time to a hundredth of a second, the same kind of flight,
    // at three elevator settings - at half the cost, which a hundred throws need.
    const f = fly(af, m, launches[i]!, 0.008);
    out.push({
      time: f.time, height: f.maxHeight, distance: Math.abs(f.distance), kind: f.kind,
      score: f.score, maxLoad: f.maxLoad, flight: f,
    });
  }
  return out;
}

export interface Spread { readonly mean: number; readonly low: number; readonly high: number; readonly best: number }

export interface FlightStats {
  readonly n: number;
  readonly time: Spread;
  readonly height: Spread;
  readonly distance: Spread;
  readonly kinds: Readonly<Record<FlightKind, number>>;
  /** The throw with the middle time: the one to draw. */
  readonly typical: Flight;
  /** The throw whose time is nearest the average: the one the wind tunnel follows through. */
  readonly nearMean: Flight;
  /** Other throws' paths, thinned, to draw faintly behind it. */
  readonly others: readonly Flight['path'][];
  readonly grades: readonly Grade[];
  /** The glide ratio, from the glides that happened: the distance event's figure. */
  readonly glideRatio: number | null;
  /** Throws still up when the flight was stopped at 90 s: a thermal held them. */
  readonly capped: number;
}

const quantile = (sorted: readonly number[], q: number) => {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
};
const spread = (xs: readonly number[]): Spread => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    mean: s.reduce((a, b) => a + b, 0) / Math.max(1, s.length),
    low: quantile(s, 0.1), high: quantile(s, 0.9), best: s[s.length - 1] ?? 0,
  };
};
const median = (xs: readonly number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);

/**
 * The batch, summed up, and the aeroplane judged on it.
 *
 * Each grade is taken from the typical throw (the median of the measure) and
 * then held down by how often it failed outright: a transition that happens in
 * seven throws out of ten is worth seven tenths of one that always happens.
 *
 * The scales are anchored to what long-flight aeroplanes are known to do,
 * kept here and not shown to the pupil:
 * - climb: the guide has a national-team overhand throw reach past 25 m, and
 *   the fastest hand throw on record is 25.8 m/s, whose speed alone could buy
 *   34 m - so keeping 60% of v^2/2g is a full score; hand-launch glider flying
 *   finds launch height dominates duration, so the climb is scored first and
 *   losing it to a loop costs heavily.
 * - transition: the guide's ideal rolls level at the top without dropping, so
 *   no height lost in under a second is full marks; losing as much as the
 *   climb is none.
 * - sink: paper gliders sink roughly 0.6 to 1.0 m/s; 0.4 m/s (well-built
 *   duration models - the indoor record of 31.2 s from about 15 m implies
 *   about 0.5) is full, 1.2 is none. Birdman's guide figure of 15 to 20 s
 *   average sits in the middle, as it should.
 * - strength: the tip bending under the hardest tenth of the throws; under 5%
 *   of the half span is full, half the half span is none - past a third the
 *   small-bend sums stop meaning a number, and the wing is folding.
 */
export function summarize(
  results: readonly ThrowResult[], spec: PlaneSpec, paper: PaperProps,
): FlightStats {
  const n = results.length;
  if (n === 0) throw new Error('summarize: no throws to summarize');
  const kinds: Record<FlightKind, number> = { transition: 0, glide: 0, stall: 0, loop: 0, dive: 0, short: 0 };
  for (const r of results) kinds[r.kind]++;
  const byTime = [...results].sort((a, b) => a.time - b.time);
  const typical = byTime[Math.floor((n - 1) / 2)]!.flight;
  const meanTime = results.reduce((a, r) => a + r.time, 0) / n;
  const nearMean = results.reduce((a, r) => (Math.abs(r.time - meanTime) < Math.abs(a.time - meanTime) ? r : a)).flight;
  const others = results
    .filter((r) => r.flight !== typical)
    .slice(0, 24)
    .map((r) => r.flight.path.filter((_, i) => i % 4 === 0));

  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const share = (k: number) => (n > 0 ? k / n : 0);

  const climbShare = median(results.map((r) => r.score.climbShare));
  const climb = median(results.map((r) => r.score.climb));
  const loopedUp = share(results.filter((r) => r.score.loopedClimbing).length);

  const leveled = results.filter((r) => r.score.transitionLoss !== null);
  const levelShare = share(leveled.length);
  const tLoss = median(leveled.map((r) => r.score.transitionLoss! / Math.max(1, r.score.climb)));
  const tLossM = median(leveled.map((r) => r.score.transitionLoss!));
  const tTime = median(leveled.map((r) => r.score.transitionTime ?? 0));

  const glided = results.filter((r) => r.score.glideSink !== null);
  const glideShare = share(glided.length);
  const sink = median(glided.map((r) => r.score.glideSink!));
  const minSinks = results.map((r) => r.score.minSink).filter((v): v is number => v !== null);
  const minSink = minSinks.length ? Math.min(...minSinks) : null;
  const ratios = results.map((r) => r.score.glideRatio).filter((v): v is number => v !== null);

  const hardLoad = quantile([...results.map((r) => r.maxLoad)].sort((a, b) => a - b), 0.9);
  const bend = wingBending(spec, paper, hardLoad);

  const times = (k: number, of: string) => `${n}번 중 ${k}번 ${of}`;
  const grades: Grade[] = [
    {
      key: 'climb', label: '고도 확보',
      score: clamp((climbShare / 0.6) * 100 - loopedUp * 40),
      value: `보통 ${climb.toFixed(1)}m 올라가요${loopedUp > 0 ? ` · ${times(Math.round(loopedUp * n), '올라가다 뒤집힘')}` : ''}`,
      hint: loopedUp > 0.2
        ? '올라가다가 뒤로 뒤집히는 일이 많아요(루프). 엘리베이터를 조금 내리거나, 코를 더 튼튼하게 해요.'
        : '던진 힘이 높이로 얼마나 바뀌었는지예요. 루프 없이 곧게 올라갈수록 높아요.',
    },
    {
      key: 'transition', label: '트랜지션',
      score: leveled.length === 0 ? 0
        // Losing none of the climb is full marks, losing all of it none; a
      // second and a half to come level is normal, slower costs a little.
      : clamp((100 - tLoss * 100 - Math.max(0, tTime - 1.5) * 15) * levelShare),
      value: leveled.length === 0 ? '수평으로 돌아오지 못했어요'
        : `보통 ${tLossM.toFixed(1)}m 내려오며 ${tTime.toFixed(1)}초 만에 수평${levelShare < 1 ? ` · ${times(leveled.length, '성공')}` : ''}`,
      // No throw came level: say why it happens and what fixes it, not just 0.
      hint: leveled.length === 0
        ? '꼭대기에서 코가 자리를 못 잡고 거의 평평하게 떨어졌어요. 무게중심이 균형점보다 뒤에 있으면 이렇게 돼요. ‘가장 오래 나는 값 찾기’를 눌러 보세요.'
        : '꼭대기에서 빨리, 높이를 적게 잃고 수평이 될수록 좋아요. 무게중심과 엘리베이터로 맞춰요.',
    },
    {
      key: 'sink', label: '싱크레이트',
      score: glided.length === 0 ? 0 : clamp(((1.2 - sink) / 0.8) * 100 * glideShare),
      value: glided.length === 0 ? '활공하지 못했어요'
        : `1초에 ${sink.toFixed(2)}m씩 내려와요${minSink ? ` (가장 잘 맞추면 ${minSink.toFixed(2)}m)` : ''}`,
      hint: glided.length === 0
        ? '수평으로 돌아오지 못해서 활공할 때 내려오는 빠르기를 잴 수 없었어요. 트랜지션부터 맞추면 잴 수 있어요.'
        : '활공할 때 천천히 내려올수록 오래 떠 있어요. 날개가 넓고 가벼울수록 좋아요.',
    },
    {
      key: 'strength', label: '강도',
      score: clamp(100 - ((bend.share - 0.05) / 0.45) * 100),
      value: bend.share > 1 ? '세게 던지면 날개가 크게 휘어요 (모양이 망가질 수 있어요)'
        : `세게 던질 때 날개 끝이 ${(bend.tipDeflection * 1000).toFixed(1)}mm 휘어요 (무게의 ${hardLoad.toFixed(0)}배 힘)`,
      hint: '세게 던질 때 날개가 버티는 정도예요. 날개 앞을 여러 번 말면 튼튼해져요.',
    },
  ];

  return {
    n,
    time: spread(results.map((r) => r.time)),
    height: spread(results.map((r) => r.height)),
    distance: spread(results.map((r) => r.distance)),
    kinds, typical, nearMean, others, grades,
    glideRatio: ratios.length ? median(ratios) : null,
    capped: results.filter((r) => r.time >= 89.9).length,
  };
}

/*
 * Worked-out batches, by aeroplane and settings, so going back to the flying
 * screen - or downloading it - does not throw them all again.
 */
const cache = new WeakMap<object, Map<string, FlightStats>>();

export function cachedStats(owner: object, key: string): FlightStats | undefined {
  return cache.get(owner)?.get(key);
}

export function keepStats(owner: object, key: string, stats: FlightStats): void {
  let m = cache.get(owner);
  if (!m) { m = new Map(); cache.set(owner, m); }
  if (m.size > 60) m.clear();
  m.set(key, stats);
}

/** All at once, for the download: from the cache when it is there. */
export function statsNow(
  owner: object, key: string, af: Airframe, m: AeroModel, launch: Launch, n: number,
  spec: PlaneSpec, paper: PaperProps,
): FlightStats {
  const hit = cachedStats(owner, key);
  if (hit) return hit;
  const launches = throwsAround(launch, n);
  const stats = summarize(runThrows(af, m, launches, 0, n), spec, paper);
  keepStats(owner, key, stats);
  return stats;
}

/** What the batch depends on, as a key. */
export function statsKey(launch: Launch, n: number, extra: readonly unknown[]): string {
  return JSON.stringify([launch, n, extra]);
}

/** Kinds in the order they are worth telling. */
export const KIND_NAMES: readonly [FlightKind, string][] = [
  ['transition', '트랜지션'], ['glide', '활공'], ['stall', '실속'], ['loop', '루프'], ['dive', '노즈다이브'], ['short', '금방 떨어짐'],
];
