/**
 * One throw, worked out: what the flying screen shows and what the download
 * prints.
 *
 * The flying screen used to hold its choices and its sums to itself, so the
 * moment it closed there was nothing to print. Both now read from here: the
 * choices live with the app, so they are still there when the pupil comes
 * back to the screen, and the page that goes into the download is the same
 * page, worked out the same way.
 */

import type { Airframe } from '../aero/airframe.js';
import {
  aeroModel, fly, glideMargin, noseBulge, thicknessFormFactor, wingBending, withCgAt, withDihedral, withNoseBulge, withNoseWeight,
} from '../aero/flight.js';
import type { AeroModel, Bending, FlapRegion, Flight, FlightKind, Launch, NoseBulge } from '../aero/flight.js';
import type { RenderFace } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';

export interface FlightSettings {
  /** Throw speed, m/s. */
  readonly speed: number;
  readonly angle: number;
  readonly height: number;
  readonly bank: number;
  /** Held on its side either way; overhand lets go higher. */
  readonly grip?: 'over' | 'under';
  /** Where the elevator is on the wing, from the model's tuning. */
  readonly region?: FlapRegion;
  readonly updraft: number;
  /** How gusty the air is from throw to throw: 1 indoors, more outside. */
  readonly gust?: number;
  /** Where the pupil measured the balance point, cm from the nose; null to use the model's. */
  readonly cgInput: number | null;
  readonly headwind: number;
  readonly crosswind: number;
  readonly elevator: number;
  readonly clips: number;
  /** Wings set in a V, degrees; null to start from the model's. */
  readonly vee: number | null;
  /** How many throws the numbers are averaged over. */
  readonly throws?: 10 | 100;
}

/*
 * A long-flight throw, as the guide teaches it: hard, steeply up, the
 * aeroplane held on its side - and thrown by a grown-up, so a finished plane
 * is judged, and tuned, at a throw it is built to take.
 */
export const DEFAULT_FLIGHT: FlightSettings = {
  speed: 20, angle: 80, height: 2.2, bank: 90, grip: 'over', updraft: 0, cgInput: null,
  headwind: 0, crosswind: 0, elevator: 0, clips: 0, vee: null,
};

export const KIND_TEXT: Record<FlightKind, { title: string; tip: string }> = {
  transition: {
    title: '높이 올라갔다가 꼭대기에서 수평으로 돌아와 활공해요 (트랜지션)',
    tip: '잘 맞춰졌어요! 오래 날리기에 딱 좋은 비행이에요.',
  },
  glide: { title: '부드럽게 미끄러지듯 날아요', tip: '잘 맞춰졌어요!' },
  stall: {
    title: '머리를 들었다가 뚝 떨어지기를 반복해요 (실속)',
    tip: '꼬리를 덜 올리거나, 조금 약하게 던져 보세요.',
  },
  loop: {
    title: '뒤로 한 바퀴 뒤집혀요 (루프 현상)',
    tip: '뒤집히는 동안 높이를 잃어요. 엘리베이터(날개 뒤끝)를 조금 내려 보세요.',
  },
  dive: {
    title: '코가 아래로 꺾여 떨어져요 (노즈다이브 현상)',
    tip: '엘리베이터(날개 뒤끝)를 조금 올려 보세요.',
  },
  short: {
    title: '금방 떨어져요',
    tip: '더 높은 곳에서 던지거나 조금 더 세게, 살짝 위로 던져 보세요.',
  },
};

export type Tone = 'good' | 'warn' | 'bad';
export interface Grade {
  readonly key: 'climb' | 'transition' | 'sink' | 'strength' | 'balance';
  readonly label: string;
  /** Out of 100. */
  readonly score: number;
  readonly value: string;
  readonly hint: string;
}
export interface Rating { readonly tone: Tone; readonly v: number; readonly text: string }

/** The slow part, which depends only on the folded shape. */
export interface FlightBase { readonly bulge: NoseBulge; readonly bare: AeroModel }

export function flightBase(airframe: Airframe, plies: readonly RenderFace[], region?: FlapRegion): FlightBase {
  const bulge = noseBulge(airframe, plies);
  const bare = withNoseBulge(airframe, aeroModel(airframe, region), bulge);
  // The wing as thick as its stacked paper: friction scaled by the section's form factor.
  const { ff } = thicknessFormFactor(airframe, plies);
  return { bulge, bare: { ...bare, wetShare: bare.wetShare * ff, cd0: bare.cd0 + (ff - 1) * (bare.cd0 - bare.cdForm) } };
}

export interface FlightReport {
  readonly bulge: NoseBulge;
  readonly af: Airframe;
  readonly m: AeroModel;
  readonly launch: Launch;
  readonly flight: Flight;
  readonly bend: Bending;
  readonly vee: number;
  /** How firmly it holds its glide, as a static margin (see `glideMargin`): what 밸런스 grades. */
  readonly margin: number;
  /** The folded model's wings are flat, so the V is the usual pre-flight one. */
  readonly flatWing: boolean;
  /** The model's own balance point, cm from the nose, to one decimal. */
  readonly computedCg: number;
  readonly balance: Rating;
  readonly roll: Rating;
  readonly yaw: Rating;
  readonly strong: Rating;
  /** The long-flight scores: 고도 확보, 트랜지션, 싱크레이트, 강도. */
  readonly grades: readonly Grade[];
  readonly kind: { title: string; tip: string };
  /** Grams per 100cm² of wing. */
  readonly loading: number;
}

/**
 * The wings' V a plane flies with: its own record's, or - when it never set
 * one - what the folded model already has, a flat wing starting at 15°. Every
 * view of the plane uses this one rule, so the list, the flying screen and the
 * wind tunnel all show and fly the same aeroplane.
 */
export function flyingVee(airframe: Airframe, recorded: number | null | undefined): number {
  const measured = Math.round((airframe.dihedral * 180) / Math.PI);
  // Folded flat, a long-flight wing is always set in a V before it is thrown
  // (Birdman's book says 20°), so a flat model starts at 15°.
  if (recorded !== null && recorded !== undefined) return recorded;
  return Math.abs(measured) < 3 ? 15 : Math.max(-10, Math.min(30, measured));
}

/*
 * Let go, the aeroplane opens: the two sides of the body, pressed together in
 * the hand, spread apart underneath - some 20 to 30 degrees between them - and
 * each wing, fixed to its side, tips down with it by half of that. A V set at
 * 20 degrees in the hand flies nearly flat. The V a plane is set to is the
 * one in the hand; it flies with this much less - but no lower than flat,
 * where the lift that bends the wings up holds them: thrown, a plane flies
 * nearly level, not drooping.
 */
export const BODY_SPREAD = 25;
export function airborneVee(vee: number): number {
  return Math.max(Math.min(vee, 0), vee - BODY_SPREAD / 2);
}

/**
 * The wings set to their flying V, as a change to body-frame points.
 *
 * Each wing turns about the line where it leaves the keel - the top of the
 * keel, on the centre line - and only by what the folding has not already
 * given it: a model folded with its wings up needs less lifting than one
 * folded flat. The keel itself, the paper within a few millimetres of the
 * centre line, stays where it is.
 */
export function liftWings(
  airframe: Airframe, plies: readonly RenderFace[], veeDeg: number,
): (q: readonly [number, number, number]) => [number, number, number] {
  const measured = (airframe.dihedral * 180) / Math.PI;
  const turn = ((veeDeg - measured) * Math.PI) / 180;
  const KEEL = 0.003;
  // Top of the keel: the highest paper on the centre line (body z is down).
  let rootZ = Infinity;
  for (const f of plies) {
    for (const p of f.points) {
      const q = airframe.frame.toBody(p);
      if (Math.abs(q[1]) < KEEL && q[2] < rootZ) rootZ = q[2];
    }
  }
  if (!Number.isFinite(rootZ)) rootZ = 0;
  const c = Math.cos(turn);
  const sn = Math.sin(turn);
  return (q) => {
    const y = q[1];
    if (Math.abs(y) < KEEL || Math.abs(turn) < 1e-4) return [q[0], q[1], q[2]];
    const s = Math.sign(y);
    const z = q[2] - rootZ;
    // Up is -z: a positive turn lifts the tip.
    return [q[0], y * c + s * z * sn, rootZ + z * c - s * y * sn];
  };
}

export function flightReport(
  base: FlightBase, airframe: Airframe, plies: readonly RenderFace[], paper: PaperProps,
  s: FlightSettings,
): FlightReport {
  const flatWing = Math.abs(Math.round((airframe.dihedral * 180) / Math.PI)) < 3;
  const vee = flyingVee(airframe, s.vee);
  // The plies are real paper's already (see `lengthenNose`): the balance point is theirs.
  const computedCg = Math.round(airframe.cgFromNose * 1000) / 10;

  /*
   * The lift is the opened wings': nearly flat. The rolling level is left to
   * the V as it was set - flown flat, the wings that turn a thrown plane
   * upright again were given none of the push that does it, and the planes
   * that climb on their side and come out at the top, which is what the V is
   * set for, spiralled in instead.
   */
  const opened = withDihedral(airframe, base.bare, airborneVee(vee));
  const v = { af: { ...opened.af, dihedral: (vee * Math.PI) / 180 }, m: opened.m };
  const c = s.cgInput !== null ? withCgAt(v.af, v.m, s.cgInput / 100)
    : v;
  const { af, m } = withNoseWeight(c.af, c.m, s.clips * 0.5);
  const launch: Launch = {
    speed: s.speed, angleDeg: s.angle, height: s.height, headwind: s.headwind,
    crosswind: s.crosswind, elevatorDeg: s.elevator, bankDeg: s.bank, updraft: s.updraft,
    ...((s.gust ?? 1) !== 1 ? { gust: s.gust } : {}),
  };
  const flight = fly(af, m, launch);
  const bend = wingBending(af, plies, paper, flight.maxLoad);

  const margin = glideMargin(af, m, s.elevator);
  /*
   * The balance meter is the balance grade, not a second verdict with its own
   * thresholds: at a margin of 20% the sheet said "알맞게 앞에" while the card
   * and the flying screen said "앞이 무거워요".
   */
  const bg = balanceGrade(margin);
  const balance: Rating = {
    tone: bg.score >= 70 ? 'good' : bg.score >= 40 ? 'warn' : 'bad',
    v: bg.score / 100,
    text: margin < 0 ? `${bg.value}. 머리를 들다가 실속하기 쉬워요.`
      : margin > 0.15 ? `${bg.value}. 엘리베이터(날개 뒤끝)를 많이 올려야 해요.`
        : `${bg.value}. 흔들려도 제자리로 돌아와요.`,
  };
  const dihedral = (af.dihedral * 180) / Math.PI;
  const roll: Rating = dihedral < -2
    ? { tone: 'bad', v: 0.2, text: '날개가 아래로 처졌어요. 옆으로 구르기 쉬워요.' }
    : dihedral < 2
      ? { tone: 'warn', v: 0.5, text: '날개가 평평해요. 날개를 살짝 V자로 올리면 더 똑바로 날아요.' }
      : dihedral < 15
        ? { tone: 'good', v: 0.85, text: '날개가 살짝 V자예요. 좌우로 잘 버텨요.' }
        : { tone: 'warn', v: 0.6, text: '날개가 많이 올라갔어요. 좌우로 출렁일 수 있어요.' };
  const finShare = af.wingArea > 0 ? af.finArea / af.wingArea : 0;
  const yaw: Rating = finShare < 0.03
    ? { tone: 'bad', v: 0.2, text: '세로로 선 부분(몸통·윙렛)이 작아요. 방향이 쉽게 틀어져요.' }
    : { tone: 'good', v: Math.min(1, 0.4 + finShare * 4), text: '몸통과 윙렛이 방향을 잘 잡아 줘요.' };
  // Past a third of the half span the small-bend sums stop meaning a number:
  // that wing is folding up in the throw.
  const strong: Rating = bend.share < 0.15
    ? { tone: 'good', v: 0.9, text: '튼튼해요. 세게 던져도 날개가 거의 휘지 않아요.' }
    : bend.share < 0.4
      ? { tone: 'warn', v: 0.55, text: '조금 휘어요. 세게 던지면 날개 모양이 바뀔 수 있어요.' }
      : { tone: 'bad', v: 0.2, text: '크게 휘어요. 세게 던지면 날개가 꺾일 수 있어요. 날개 앞을 여러 번 말아 두껍게 하면 튼튼해져요.' };

  /*
   * The four things a long-flight aeroplane is judged on, each out of 100,
   * with the figure behind it. The scales are set so the book's aeroplanes
   * spread across them: a climb that keeps 60% of the throw's height, a
   * transition that loses nothing, a glide sinking 0.4 m/s, a wing that
   * bends less than 5% of its half span - each a full score.
   */
  const sc = flight.score;
  const clamp = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
  const grades: Grade[] = [
    {
      key: 'climb', label: '고도 확보',
      score: clamp((Math.min(1, sc.climbShare) / 0.6) * 100 - (sc.loopedClimbing ? 30 : 0)),
      value: `${sc.climb.toFixed(1)}m 올라감 · 던진 힘의 ${Math.round(Math.min(1, sc.climbShare) * 100)}%`,
      hint: sc.loopedClimbing
        ? '올라가다가 뒤로 뒤집혔어요(루프). 엘리베이터를 조금 내리거나, 코를 더 튼튼하게 해요.'
        : '던진 힘이 높이로 얼마나 바뀌었는지예요. 루프 없이 곧게 올라갈수록 높아요.',
    },
    {
      key: 'transition', label: '트랜지션',
      score: sc.transitionLoss === null ? 0
        : clamp(100 - (sc.transitionLoss / Math.max(1, sc.climb)) * 100 - Math.max(0, (sc.transitionTime ?? 0) - 1.5) * 15),
      value: sc.transitionLoss === null ? '수평으로 돌아오지 못했어요'
        : `꼭대기에서 ${sc.transitionLoss.toFixed(1)}m 내려오며 ${(sc.transitionTime ?? 0).toFixed(1)}초 만에 수평`,
      hint: '꼭대기에서 빨리, 높이를 적게 잃고 수평이 될수록 좋아요. 무게중심과 엘리베이터로 맞춰요.',
    },
    {
      key: 'sink', label: '싱크레이트',
      score: sc.glideSink === null ? 0 : clamp(((1.2 - sc.glideSink) / 0.8) * 100),
      value: sc.glideSink === null ? '활공하지 못했어요'
        : `1초에 ${Math.max(0, sc.glideSink).toFixed(2)}m씩 내려와요${sc.minSink && sc.minSink < sc.glideSink - 0.01 ? ` (가장 잘 맞추면 ${sc.minSink.toFixed(2)}m)` : ''}`,
      hint: '활공할 때 천천히 내려올수록 오래 떠 있어요. 날개가 넓고 가벼울수록 좋아요.',
    },
    {
      key: 'strength', label: '강도',
      score: clamp(100 - ((bend.share - 0.05) / 0.45) * 100),
      value: bend.share > 1 ? '날개가 크게 휘어요 (모양이 망가질 수 있어요)'
        : `가장 센 순간 날개 끝이 ${(bend.tipDeflection * 1000).toFixed(1)}mm 휘어요 (무게의 ${flight.maxLoad.toFixed(1)}배 힘)`,
      hint: '세게 던질 때 날개가 버티는 정도예요. 날개 앞을 여러 번 말면 튼튼해져요.',
    },
  ];

  return {
    bulge: base.bulge, af, m, launch, flight, bend, vee, margin, flatWing, computedCg,
    balance, roll, yaw, strong, grades,
    kind: KIND_TEXT[flight.kind],
    loading: (af.mass.mass * 1000) / (af.wingArea * 100),
  };
}

/** Whether there is a wing to fly at all. */
export const canFly = (af: Airframe) => af.wingArea > 1e-6 && af.meanChord > 1e-6;

/**
 * 밸런스: the centre of gravity against the balance point, out of 100.
 *
 * Full marks for a static margin of 5 to 15% of the chord - steady, but not
 * so nose-heavy the elevator has to fight it - falling to nothing with the
 * weight behind the balance point (it tumbles) or far ahead of it (it dives).
 */
export function balanceGrade(margin: number): Grade {
  const score = margin < 0.05 ? Math.max(0, (margin + 0.05) / 0.1) * 100
    : margin <= 0.15 ? 100
      : Math.max(0, 1 - (margin - 0.15) / 0.2) * 100;
  const pct = Math.round(margin * 100);
  return {
    key: 'balance', label: '밸런스', score: Math.round(score),
    value: margin < 0 ? `무게중심이 균형점보다 뒤에 있어요 (${pct}%)`
      : margin > 0.15 ? `앞이 무거워요 (${pct}%)` : `무게중심이 알맞게 앞에 있어요 (${pct}%)`,
    hint: '무게중심이 균형점보다 조금 앞에 있으면 흔들려도 제자리로 돌아와요.',
  };
}
