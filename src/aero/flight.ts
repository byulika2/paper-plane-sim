/**
 * What happens when the folded aeroplane is thrown.
 *
 * Nobody can watch this app's aeroplanes fly, so it can only say what the
 * shape predicts. The lattice solver reads the airframe once for the handful
 * of numbers that decide a glide - how much lift an angle buys, where that
 * lift acts against the centre of gravity, and how much the bent-up trailing
 * edge (the elevator every paper aeroplane is tuned with) pitches the nose -
 * and a side-on flight is then stepped through time from the throw to the
 * floor, stall and all. Paper is a flat plate at a low Reynolds number: it
 * stalls early and gently, and its drag is mostly skin friction and edges.
 *
 * It answers the questions a flying day does - how far, how long, does it
 * climb, loop or dive - and one a flying day hides: how far the wing bends
 * under the load of a hard throw into the wind, from the paper stacked in it.
 *
 * Body axes are the airframe's: x forward, y right, z down, origin at the CG.
 */

import type { Airframe } from './airframe.js';
import { buildSystem, freestream, RHO, solve } from './vlm.js';
import type { LatticePanel } from './vlm.js';
import type { PaperProps } from '../paper/stock.js';
import { CELL } from './spec.js';
import type { PlaneSpec } from './spec.js';
import { unit } from '../geometry/math.js';
import type { Vec3 } from '../geometry/math.js';

const G = 9.81;
/** Kinematic viscosity of air, m^2/s. */
const NU = 1.5e-5;
/**
 * The two figures set against the guide rather than derived.
 *
 * The drag of paper's cut edges and a blunt folded nose, and how long the V
 * of the wings takes to roll a thrown aeroplane level, are not in the shape's
 * geometry in any way this model can read. They are chosen so that Birdman,
 * thrown overhand as the guide teaches, climbs about as high and stays up
 * about as long as the guide says it does: some 20m, and 15 to 20 seconds.
 */
const CD_FORM = 0.006;
/** A flat plate's normal-force coefficient broadside to the air (square plate, Hoerner: 1.17). */
const PLATE_NORMAL = 1.2;
/** Roll-out rate per radian of dihedral, 1/s, and the speed it fades above, m/s. */
const ROLL_LEVEL = 6;
const ROLL_SPEED = 4;

export interface Launch {
  /** Throw speed, m/s. */
  readonly speed: number;
  /** Throw angle above the horizon, degrees. */
  readonly angleDeg: number;
  /** Height of the hand, m. */
  readonly height: number;
  /** Wind toward the thrower, m/s (a tailwind is negative). */
  readonly headwind: number;
  /** Wind across the flight, m/s. */
  readonly crosswind: number;
  /** Trailing edge bent up, degrees; negative is bent down. */
  readonly elevatorDeg: number;
  /** Rising air, m/s: a thermal outdoors, none indoors. */
  readonly updraft?: number;
  /** How gusty the air is from one throw to the next: 1 indoors, more outside. */
  readonly gust?: number;
  /** Wings tilted at the throw, degrees: 90 is held on its side, overhand. */
  readonly bankDeg?: number;
}

export interface AeroModel {
  /** Lift slope per radian. */
  readonly cla: number;
  /** Pitch slope per radian, about the CG: negative is stable. */
  readonly cma: number;
  /** Lift and pitch per radian of elevator. */
  readonly cld: number;
  readonly cmd: number;
  /** Pitch damping per unit q c / 2V. */
  readonly cmq: number;
  readonly cd0: number;
  /** Drag of the edges and the blunt nose, and wetted area over wing area. */
  readonly cdForm: number;
  readonly wetShare: number;
  /** Induced drag factor, CD = cd0 + k CL^2. */
  readonly k: number;
  /** The part of it the wing's span alone makes, lift squared regardless of camber (inviscid, e 0.95). */
  readonly kInduced: number;
  /** Angle the flow leaves the paper, radians. */
  readonly stall: number;
  /** (neutral point behind the CG) / mean chord. */
  readonly staticMargin: number;
  /** Neutral point, metres from the nose. */
  readonly neutralFromNose: number;
  /**
   * Lift and nose-up pitch the shape makes at no angle at all, from the
   * rolled nose bulging to one side of the wing. Zero for a flat plate.
   */
  readonly cl0: number;
  readonly cm0: number;
  /**
   * The lift the side edges' vortices add, as Kv in Kv sin^2(a) cos(a):
   * large on a wing hardly longer than it is wide, nothing on a long one.
   */
  readonly kv?: number;
}

/** Flap depth: a bend at the trailing edge is about a centimetre deep. */
const FLAP = 0.01;

/**
 * The wing as a lattice: every station a strip, split chordwise with its last
 * centimetre a flap that can be bent up by `elevator` radians.
 */
/**
 * Where the elevator is: from `y0` to `y1` out from the middle on each wing,
 * `depth` in from the trailing edge, metres. Without one, the whole trailing
 * edge is taken as a centimetre-deep flap.
 */
export interface FlapRegion { readonly y0: number; readonly y1: number; readonly depth: number }

function lattice(af: Airframe, elevator: number, region?: FlapRegion): LatticePanel[] {
  const st = [...af.stations].sort((a, b) => a.y - b.y);
  if (st.length < 2) return [];
  const gaps = st.slice(1).map((s, i) => s.y - st[i]!.y).sort((a, b) => a - b);
  const step = gaps[0]!;
  const panels: LatticePanel[] = [];
  st.forEach((s, i) => {
    const prev = st[Math.max(0, i - 1)]!;
    const next = st[Math.min(st.length - 1, i + 1)]!;
    const slope = next.y > prev.y ? (next.z - prev.z) / (next.y - prev.y) : 0;
    const flap = Math.min(region ? region.depth : FLAP, s.chord * 0.3);
    // How much of this strip's width the bent stretch covers.
    const cover = region
      ? Math.max(0, Math.min(Math.abs(s.y) + step / 2, region.y1) - Math.max(Math.abs(s.y) - step / 2, region.y0)) / step
      : 1;
    const cuts = [s.leading];
    for (let k = 1; k <= 3; k++) cuts.push(s.leading - ((s.chord - flap) * k) / 3);
    cuts.push(s.trailing);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const front = cuts[k]!;
      const back = cuts[k + 1]!;
      const c = front - back;
      if (c < 1e-5) continue;
      const bound = front - c / 4;
      const control = front - (3 * c) / 4;
      const y0 = s.y - step / 2;
      const y1 = s.y + step / 2;
      const zAt = (y: number) => s.z + slope * (y - s.y);
      // Up is -z. The flap turned trailing edge up tips its normal forward.
      const isFlap = k === cuts.length - 2;
      const d = isFlap ? elevator * cover : 0;
      const n = unit([Math.sin(d), slope * Math.cos(d), -Math.cos(d)]);
      panels.push({
        a: [bound, y0, zAt(y0)], b: [bound, y1, zAt(y1)],
        control: [control, s.y, s.z], normal: n,
        area: c * step, chord: c, isFin: false,
      });
    }
  });
  return panels;
}

/** Lift up and nose-up pitch, as coefficients, for a flow at unit speed. */
function coefficients(af: Airframe, elevator: number, alpha: number, q = 0, region?: FlapRegion) {
  const panels = lattice(af, elevator, region);
  const cg: Vec3 = [0, 0, 0];
  const sys = buildSystem(panels, freestream(alpha, 0));
  const r = solve(sys, { speed: 1, alpha, beta: 0, q }, cg);
  const qs = 0.5 * RHO * af.wingArea;
  // Lift is square to the air, which comes in at alpha.
  const lift = -r.force[2] * Math.cos(alpha) + r.force[0] * Math.sin(alpha);
  return { cl: lift / qs, cm: r.moment[1] / (qs * af.meanChord) };
}

/**
 * Span efficiency, for the drag that grows with lift.
 *
 * Flat aluminium plates in a tunnel at Re 7e4 to 1e5 measure 0.82 at an
 * aspect ratio of 0.5, 0.57 at 1 and 0.38 at 2 (Torres & Mueller, AIAA J.
 * 2004). Taken for paper, those made every aeroplane sink twice as fast as
 * paper aeroplanes are seen to: the best - Ken Blackburn's, Takuo Toda's -
 * come down at about 1.5 ft/s (0.46 m/s), and Birdman, which the guide times
 * at 15 to 20 s, stayed up 13. A folded sheet is not a bare plate - its
 * rolled leading edge and V give it a gentler flow - so the figure is taken
 * from paper aeroplanes themselves: 0.88, which puts Birdman thrown overhand
 * at 20 m/s in the guide's range (about 16 s over a hundred throws, 24 s for
 * one perfect 25 m/s throw) and a folded Sky King at about 0.75 m/s - slower
 * than a record plane tuned for the record, as it should be.
 */
export function spanEfficiency(ar: number): number {
  void ar;
  return 0.88;
}

export function aeroModel(af: Airframe, region?: FlapRegion): AeroModel {
  const a = 2 * Math.PI / 180;
  const zero = coefficients(af, 0, 0, 0, region);
  const tilted = coefficients(af, 0, a, 0, region);
  const bent = coefficients(af, a, 0, 0, region);
  const cla = (tilted.cl - zero.cl) / a;
  const cma = (tilted.cm - zero.cm) / a;
  // Pitch rate: q c / 2V of 0.05, flown straight.
  const qHat = 0.05;
  const turning = coefficients(af, 0, 0, (qHat * 2) / af.meanChord, region);
  const cmq = (turning.cm - zero.cm) / qHat;

  const re = Math.max(2e4, (6 * af.meanChord) / NU);
  const cf = 1.328 / Math.sqrt(re);
  // Both faces of what the air touches, plus the paper's cut edges and the
  // blunt folded nose, which a flat-plate formula knows nothing about.
  const wetShare = (2 * (af.wingArea + af.finArea)) / af.wingArea;
  const cdForm = CD_FORM;
  const cd0 = cf * wetShare + cdForm;
  const k = 1 / (Math.PI * spanEfficiency(af.aspectRatio) * Math.max(0.5, af.aspectRatio));
  const margin = cla > 1e-6 ? -cma / cla : 0;
  return {
    cla, cma, cmq,
    cld: (bent.cl - zero.cl) / a,
    cmd: (bent.cm - zero.cm) / a,
    cd0, k, kInduced: Math.min(k, 1 / (Math.PI * 0.95 * Math.max(0.5, af.aspectRatio))), cdForm, wetShare,
    // Low aspect ratio wings hold their flow longer.
    stall: (10 + 8 / Math.max(1, af.aspectRatio)) * Math.PI / 180,
    kv: sideEdgeVortex(af.aspectRatio),
    staticMargin: margin,
    neutralFromNose: af.cgFromNose + margin * af.meanChord,
    cl0: 0,
    cm0: 0,
  };
}

/*
 * A wing hardly longer than it is wide lifts more than its lattice says, and
 * further back. The vortices rolling off its side edges lie over the paper
 * and suck it up - Polhamus's leading-edge suction analogy, carried to the
 * side edges (Lamar) - a lift of Kv sin^2 a cos a on top of the linear one,
 * growing with the angle. Torres & Mueller (AIAA J. 42, 2004) measured it on
 * thin rectangular plates at the paper aeroplane's Reynolds numbers: plain
 * above ten degrees at aspect ratio 1, small by 2. Their pitch moments show
 * where it acts: the centre of pressure sits at the quarter chord at small
 * angles and moves back as the angle grows. The vortices run the whole chord,
 * so their push is taken at its middle - behind the neutral point, where it
 * pulls the nose down harder the more it is raised.
 *
 * Kv is read off their lift curves (at 20 degrees about 4 at aspect ratio 1,
 * about 1 at 2) and falls off in between; a square paper aeroplane's is about
 * 2.5. Without it such a plane, balanced near its quarter chord as they are,
 * had nothing to bring its nose down at the top of the climb: it hung there,
 * and every transition was scored nought.
 */
const VORTEX_AT = 0.5;
export function sideEdgeVortex(aspectRatio: number): number {
  return Math.min(4.5, 4.1 * Math.exp(-1.5 * (Math.max(0.5, aspectRatio) - 1)));
}

/** Lift and drag coefficients at any angle: the lattice below stall, a flat plate beyond. */
function polar(m: AeroModel, alpha: number, elevator: number, speed = 6, chord = 0.1) {
  const vortex = vortexLift(m, alpha);
  const attached = m.cla * alpha + m.cld * elevator + m.cl0 + vortex;
  /*
   * Past the stall the air pushes square to the plate (Ortiz, Rival & Wood,
   * Energies 2015: drag over lift follows tan alpha at aspect ratios 0.4 to 9),
   * a normal force of about 1.2 sin alpha - 1.17 broadside for a square plate.
   * Lift and drag are its two parts. Lift was 1.1 sin 2a, which is a normal
   * force of 2.2 set against a drag of 1.2: twice the lift the plate gives.
   */
  const plate = PLATE_NORMAL * Math.sin(alpha) * Math.cos(alpha);
  // 0 attached, 1 fully separated.
  const s = 1 / (1 + Math.exp(-(Math.abs(alpha) - m.stall) / (2 * Math.PI / 180)));
  const cl = (1 - s) * attached + s * plate;
  // Skin friction thins as the air speeds up: laminar, 1.328 / sqrt(Re).
  const re = Math.max(2e4, (speed * chord) / NU);
  const cd0 = m.cdForm + m.wetShare * (1.328 / Math.sqrt(re));
  /*
   * Drag due to lift, in two parts. The span's own share goes with lift
   * squared whatever the section. The rest - the flow thickening and parting
   * as the angle grows, which the flat plates the efficiency was measured on
   * (Torres & Mueller) keep lowest at no lift - is lowest for a cambered
   * section at the lift its camber gives (Pelletier & Mueller's cambered
   * plates): a rolled nose or a bent trailing edge glides cheaper than a
   * flat sheet at the same lift. Taken whole about zero lift, as it was, every
   * cambered aeroplane was charged a flat plate's drag and sank too fast.
   */
  const camber = m.cl0 + m.cld * elevator;
  const viscous = m.k - m.kInduced;
  // The vortices' suction is square to the plate: its drag is its lift times tan a.
  const linear = attached - vortex;
  const lifting = m.kInduced * linear * linear + viscous * (linear - camber) ** 2 + Math.abs(vortex * Math.tan(alpha));
  const cd = cd0 + lifting * (1 - s) + s * PLATE_NORMAL * Math.sin(alpha) ** 2;
  return { cl, cd, s };
}

/**
 * Nose-up pitch, as a coefficient, at any angle - without the damping.
 *
 * Below the stall the lattice's own slope holds: the air pushes at the
 * neutral point, and an aeroplane balanced behind it turns further nose-up.
 * Past the stall the wing is a flat plate, and a plate's push moves back from
 * its quarter chord towards its middle as it turns broadside (to half the
 * chord at 90 degrees). Kept on the slope, a tail-heavy model once pitched up
 * to a plate falling flat and stayed there, counted as flying; now the push
 * moving back swings the nose down again unless the balance is far behind -
 * the stall-and-drop a tail-heavy paper aeroplane really does.
 */
function vortexLift(m: AeroModel, alpha: number): number {
  const k = m.kv ?? 0;
  if (!(k > 0)) return 0;
  const sn = Math.sin(alpha);
  return k * sn * Math.abs(sn) * Math.cos(alpha);
}

function pitchCoefficient(m: AeroModel, alpha: number, elevator: number, s: number, cl: number, cd: number): number {
  // The side-edge vortices push at mid-chord: a quarter chord behind the neutral point.
  const attached = m.cm0 + m.cma * alpha + m.cmd * elevator
    - vortexLift(m, alpha) * (VORTEX_AT - 0.25 + m.staticMargin);
  // The push, square to the plate, and how far behind the balance it acts.
  const normal = cl * Math.cos(alpha) + cd * Math.sin(alpha);
  const behind = m.staticMargin + 0.25 * Math.abs(Math.sin(alpha));
  const plate = -normal * behind + m.cmd * elevator;
  return (1 - s) * attached + s * plate;
}

export interface FlightPoint {
  readonly t: number; readonly x: number; readonly h: number; readonly pitch: number;
  /**
   * The moment as the aeroplane meets it, for following a flight through:
   * airspeed (m/s), angle of attack, climb angle and bank (radians), lift
   * and drag (N). Left out of the two ends a flight is closed with.
   */
  readonly speed?: number;
  readonly alpha?: number;
  readonly gamma?: number;
  readonly bank?: number;
  readonly lift?: number;
  readonly drag?: number;
  /** Where it is over the floor, m - along the throw and to its side - and the way it is heading, radians. */
  readonly gx?: number;
  readonly gy?: number;
  readonly heading?: number;
}

export type FlightKind = 'transition' | 'glide' | 'stall' | 'loop' | 'dive' | 'short';

export interface Flight {
  readonly path: readonly FlightPoint[];
  readonly distance: number;
  readonly time: number;
  readonly maxHeight: number;
  /** Largest lift over weight, from the throw on. */
  readonly maxLoad: number;
  readonly maxAirspeed: number;
  readonly drift: number;
  readonly kind: FlightKind;
  /** Speed it glides at, left to itself, m/s. */
  readonly trimSpeed: number | null;
  readonly glideRatio: number | null;
  readonly score: FlightScore;
  /** When it reached the top of its climb, s, and when it then came level to glide (null if it never did). */
  readonly apexTime: number;
  readonly levelTime: number | null;
}

/**
 * How a long-flight aeroplane is judged, as the people who throw them judge
 * it: how much of the throw becomes height, how quickly and how cheaply it
 * comes level at the top, how slowly it then sinks, and whether the wing held
 * its shape. Hand-launch glider flyers find launch height dominates - a fifth
 * more of it outweighs any small gain in sink - so it is scored first.
 */
export interface FlightScore {
  /** Top of the climb, m above the hand. */
  readonly climb: number;
  /** Of the height the throw's speed could buy (v^2 / 2g), how much it got. */
  readonly climbShare: number;
  /** Turned over on the way up, before the top. */
  readonly loopedClimbing: boolean;
  /** Height lost from the top until flying level, m; null if it never did. */
  readonly transitionLoss: number | null;
  /** Seconds from the top until level. */
  readonly transitionTime: number | null;
  /** Average sink once gliding, m/s; null if it never glided. */
  readonly glideSink: number | null;
  /** The least sink the shape can manage at all, m/s, from its polar. */
  readonly minSink: number | null;
  /** Ground covered per metre of height in the glide - the distance event's figure. */
  readonly glideRatio: number | null;
}

/**
 * How firmly the aeroplane holds its glide, as a static margin: the pitch
 * slope over the lift slope at the angle it glides at. On the straight
 * lattice slope alone a square plane balanced near its quarter chord read as
 * tail-heavy, while the side-edge vortices it glides on hold it steady; so it
 * is measured where it flies. The lattice's own margin when it has no glide.
 */
export function glideMargin(af: Airframe, m: AeroModel, elevatorDeg: number): number {
  const de = (elevatorDeg * Math.PI) / 180;
  const t = trim(af, m, de);
  if (!t) return m.staticMargin;
  const h = 0.25 * Math.PI / 180;
  const cm = (a: number) => pitchCoefficient(m, a, de, 0, 0, 0);
  const cl = (a: number) => m.cla * a + m.cld * de + m.cl0 + vortexLift(m, a);
  const dcl = (cl(t.alpha + h) - cl(t.alpha - h)) / (2 * h);
  return dcl > 1e-6 ? -(cm(t.alpha + h) - cm(t.alpha - h)) / (2 * h) / dcl : m.staticMargin;
}

/** The steady glide the elevator setting gives, if any. */
export function trim(af: Airframe, m: AeroModel, elevator: number) {
  /*
   * The angle where the pitch comes to nothing and a little more would bring
   * the nose back down: found along the curve, not off the straight slope,
   * since the side-edge vortices steepen it as the angle grows - a plane
   * balanced right on its neutral point still finds its glide.
   */
  const at = (a: number) => pitchCoefficient(m, a, elevator, 0, 0, 0);
  const step = 0.25 * Math.PI / 180;
  let alpha = -1;
  for (let a = step; a <= m.stall; a += step) {
    if (at(a - step) > 0 && at(a) <= 0) { alpha = a - step * at(a - step) / (at(a - step) - at(a) || 1); break; }
  }
  if (!(alpha > 0) || alpha > m.stall) return null;
  const { cl, cd } = polar(m, alpha, elevator, 5, af.meanChord);
  if (!(cl > 0)) return null;
  const speed = Math.sqrt((2 * af.mass.mass * G) / (RHO * af.wingArea * cl));
  return { alpha, speed, ratio: cl / cd };
}

/**
 * The elevator setting that keeps this throw up longest.
 *
 * Searched by flying it, not from the steady glide alone: an aeroplane
 * balanced right on its neutral point - a flying wing with a heavy rolled
 * nose, like Birdman - has no steady glide to find at all until the trailing
 * edge is bent, and what a pupil wants to know is the bend that goes farthest
 * from the throw they chose - and these are long-flight aeroplanes, so what
 * counts is the time aloft, not the distance.
 */
export function bestElevator(af: Airframe, m: AeroModel, launch?: Launch): number {
  // Coarse and quick first, then fine around the best: a click must not stall
  // the page for seconds on a long flight into the wind.
  const score = (d: number, dt: number) => {
    if (launch) return fly(af, m, { ...launch, elevatorDeg: d }, dt).time;
    const t = trim(af, m, (d * Math.PI) / 180);
    return t ? t.ratio : -Infinity;
  };
  let best = 0;
  let top = -Infinity;
  for (let d = -10; d <= 20; d += 1) {
    const s = score(d, 0.004);
    if (s > top + 1e-6) { top = s; best = d; }
  }
  const around = best;
  top = -Infinity;
  for (let d = around - 1; d <= around + 1 + 1e-9; d += 0.25) {
    const s = score(d, 0.001);
    if (s > top + 1e-6) { top = s; best = d; }
  }
  return best;
}

/**
 * The wings set in a V, the way the book has them tuned before a flight.
 *
 * Tilting each half up by the dihedral tilts its lift inward by as much, so
 * only the cosine squared of it still holds the aeroplane up - the price of
 * the roll stability it buys.
 */
export function withDihedral(af: Airframe, m: AeroModel, deg: number): { af: Airframe; m: AeroModel } {
  const g = (deg * Math.PI) / 180;
  const was = Math.cos(af.dihedral) ** 2;
  const k = Math.cos(g) ** 2 / Math.max(1e-6, was);
  return {
    af: { ...af, dihedral: g },
    m: { ...m, cla: m.cla * k, cma: m.cma * k, cld: m.cld * k, cmd: m.cmd * k, cl0: m.cl0 * k, cm0: m.cm0 * k },
  };
}

/*
 * Four-millisecond steps: the fourth-order steps give the same flights to a
 * hundredth of a second as a millisecond did, every book plane's kind of
 * flight the same, in a quarter of the time - which the list's cards, each a
 * few thousand throws, were spending as minutes.
 */
export function fly(af: Airframe, m: AeroModel, launch: Launch, dt = 0.004): Flight {
  /*
   * Flown in the air's own axes: speed, climb angle, heading, angle of attack,
   * pitch rate and bank, with the ground position added up from them and the
   * wind carrying the whole air mass along.
   *
   * Bank is what a long-flight throw is about. Held by the keel and thrown
   * overhand, the aeroplane leaves the hand on its side, wings upright: its
   * lift then swings it round instead of over, so it climbs in a spiral where
   * a level throw that hard would loop at head height. The V of the wings
   * rolls it back level as it goes, and near the top, slow, it comes out into
   * the glide - the transition the guide describes.
   */
  const mass = af.mass.mass;
  const W = mass * G;
  const iyy = Math.max(1e-9, af.mass.inertia[1]);
  const S = af.wingArea;
  const c = af.meanChord;
  const de = (launch.elevatorDeg * Math.PI) / 180;
  const up = (launch.angleDeg * Math.PI) / 180;
  const bank0 = ((launch.bankDeg ?? 0) * Math.PI) / 180;
  /*
   * How fast the wings come level: faster with more V to them, and hardly at
   * all while the aeroplane is still going fast - the sideways lift of the
   * climb holds it on its side until it slows near the top. That is when it
   * rolls out, which is the transition the guide times with its tuning.
   */
  // Wings drooping (anhedral) roll it further over instead: the rate turns negative.
  const dih = af.dihedral >= 0 ? Math.max(0.05, af.dihedral) : af.dihedral;
  const levelling = (V: number) => (ROLL_LEVEL * dih) / (1 + (V / ROLL_SPEED) ** 2);
  // In the air: V, gamma (climb), psi (heading), alpha, q, phi (bank), and
  // x, y, h relative to the air.
  /*
   * The hand moves over the ground; the aeroplane flies in the air. Thrown
   * into a wind it leaves the hand that much faster through the air, and
   * climbs more steeply relative to it: the throw is the hand's velocity less
   * the air's (the wind blows toward the thrower, -x, and across, +y).
   */
  const ax = launch.speed * Math.cos(up) + launch.headwind;
  const ay = -launch.crosswind;
  const az = launch.speed * Math.sin(up);
  const airSpeed = Math.hypot(ax, ay, az);
  const airUp = Math.atan2(az, Math.hypot(ax, ay));
  let st = [airSpeed, airUp, Math.atan2(ay, ax), 0, 0, bank0, 0, 0, launch.height];
  let maxLoad = 0;
  let maxAir = 0;
  let stalled = false;
  let stalledTime = 0;
  let looped = false;
  let tumbled = false;
  let pitch = airUp;
  let apexT = 0;
  // Time spent flying near level after the top: the glide a transition is for.
  let levelTime = 0;
  let loopedClimbing = false;
  let levelAt: { t: number; h: number } | null = null;
  let levelRun = 0;
  /*
   * The scores are the aeroplane's, not the weather's: climb, transition and
   * sink are measured against the air it flies in. Measured against the
   * ground, a thermal lifting the air made the top of the climb keep moving
   * later, a transition end before it began, and a glide sink upwards.
   */
  let airTop = launch.height;
  let airApexT = 0;
  const airPath: { t: number; h: number }[] = [];
  const deriv = (s: number[]) => {
    const [V0, gamma, psi, alpha0, q, phi] = s as [number, number, number, number, number, number];
    const V = Math.max(0.3, V0);
    const alpha = Math.atan2(Math.sin(alpha0), Math.cos(alpha0));
    const { cl, cd, s: sep } = polar(m, alpha, de, V, c);
    const qbar = 0.5 * RHO * V * V;
    const L = qbar * S * cl;
    const D = qbar * S * cd;
    const cm = pitchCoefficient(m, alpha, de, sep, cl, cd) + m.cmq * ((q * c) / (2 * V));
    const cg = Math.cos(gamma);
    // Straight up, heading means nothing and the turn rate is capped.
    const turn = (L * Math.sin(phi)) / (mass * V * Math.max(0.2, Math.abs(cg)));
    return {
      d: [
        (-D - W * Math.sin(gamma)) / mass,
        (L * Math.cos(phi) - W * cg) / (mass * V),
        turn,
        q - (L - W * cg * Math.cos(phi)) / (mass * V),
        (qbar * S * c * cm) / iyy,
        // Past its side it is going over; held there rather than spun without end.
        Math.abs(phi) > Math.PI * 0.6 && levelling(V) < 0 ? 0 : -phi * levelling(V),
        V * cg * Math.cos(psi),
        V * cg * Math.sin(psi),
        V * Math.sin(gamma),
      ],
      L, D, V, alpha,
    };
  };

  const path: FlightPoint[] = [{ t: 0, x: 0, h: launch.height, pitch: up }];
  let t = 0;
  let maxH = launch.height;
  const every = Math.max(1, Math.round(0.02 / dt));
  const lift = launch.updraft ?? 0;
  const ground = (s: number[], time: number) => ({
    x: s[6]! - launch.headwind * time,
    y: s[7]! + launch.crosswind * time,
    h: s[8]! + lift * time,
  });
  let steps = 0;
  /*
   * A state that has come apart - a stiff light aeroplane stepped too
   * coarsely - never reaches the ground, and ran on to the ninety-second cap
   * as if it had flown that long: the longest "flight" of all, and picked as
   * the best elevator. It is a flight that failed, and is scored as one.
   */
  let diverged = !(dt > 0);
  while (t < 90 && !diverged) {
    const k1 = deriv(st);
    const at = (base: number[], k: number[], h: number) => base.map((v, i) => v + k[i]! * h);
    const k2 = deriv(at(st, k1.d, dt / 2));
    const k3 = deriv(at(st, k2.d, dt / 2));
    const k4 = deriv(at(st, k3.d, dt));
    st = st.map((v, i) => v + (dt / 6) * (k1.d[i]! + 2 * k2.d[i]! + 2 * k3.d[i]! + k4.d[i]!));
    t += dt;
    steps++;
    if (!st.every(Number.isFinite)) { diverged = true; break; }
    const g = ground(st, t);
    maxLoad = Math.max(maxLoad, Math.abs(k1.L) / W);
    maxAir = Math.max(maxAir, k1.V);
    if (g.h > maxH) apexT = t;
    if (st[8]! > airTop) { airTop = st[8]!; airApexT = t; }
    // Every transition stalls for a moment at the top; stalling again once
    // it should be gliding is the porpoising the tip is about.
    // A glide flown near the stall brushes past it; a second of it in all is the porpoising.
    if (Math.abs(k1.alpha) > m.stall && t > apexT + 1.5) stalledTime += dt;
    if (stalledTime > 1) stalled = true;
    // Nose angle above the horizon, as seen in the plane of the climb.
    pitch = st[1]! + st[3]! * Math.cos(st[5]!);
    // The climb angle as the eye reads it: a loop adds a whole turn to it, and
    // read raw, a plane gliding level after a loop was never level again.
    const climb = Math.atan2(Math.sin(st[1]!), Math.cos(st[1]!));
    // Over on its back nose up is a loop; nose down past the vertical, a tumble.
    if (pitch > Math.PI * 0.6) looped = true;
    if (pitch < -Math.PI * 0.6) tumbled = true;
    maxH = Math.max(maxH, g.h);
    if (t > apexT + 0.2 && Math.abs(climb) < 0.45) levelTime += dt;
    // Level for a third of a second after the top: the transition is over.
    if (steps % every === 0) airPath.push({ t, h: st[8]! });
    if (t > airApexT + 0.05 && st[8]! < airTop && Math.abs(climb) < 0.35) {
      levelRun += dt;
      if (!levelAt && levelRun > 0.3) levelAt = { t, h: st[8]! };
    } else if (!levelAt) levelRun = 0;
    if (pitch > Math.PI * 0.6 && st[8]! >= airTop - 1e-6) loopedClimbing = true;
    if (steps % every === 0) {
      path.push({
        t, x: Math.hypot(g.x, g.y) * Math.sign(g.x || 1), h: Math.max(0, g.h), pitch,
        speed: k1.V, alpha: k1.alpha, gamma: st[1]!, bank: st[5]!, lift: k1.L, drag: k1.D,
        gx: g.x, gy: g.y, heading: st[2]!,
      });
    }
    if (g.h <= 0) break;
  }
  const end = ground(st, t);
  const distance = Math.hypot(end.x, end.y) * Math.sign(end.x || 1);
  const last = path[path.length - 1]!;
  if (last.h > 0 || last.t < t - 1e-9) path.push({ t, x: distance, h: 0, pitch });
  const tr = trim(af, m, de);
  if (diverged) {
    return {
      path: [{ t: 0, x: 0, h: launch.height, pitch: up }, { t: 0, x: 0, h: 0, pitch: up }],
      distance: 0, time: 0, maxHeight: launch.height, maxLoad, maxAirspeed: maxAir, drift: 0, kind: 'short',
      apexTime: 0, levelTime: null,
      trimSpeed: tr ? tr.speed : null, glideRatio: tr ? tr.ratio : null,
      score: { climb: 0, climbShare: 0, loopedClimbing: false, transitionLoss: null, transitionTime: null,
        glideSink: null, minSink: minSink(af, m, de), glideRatio: null },
    };
  }
  const kind: FlightKind = looped ? 'loop'
    : tumbled ? 'dive'
    : t < 0.6 ? 'short'
    : stalled ? 'stall'
    : Math.atan2(Math.sin(st[1]!), Math.cos(st[1]!)) < -0.8 ? 'dive'
    : up > Math.PI / 4 && levelTime > 1 ? 'transition'
    : 'glide';
  // The glide: from a second after coming level to just before landing.
  let glideSink: number | null = null;
  if (levelAt) {
    const from = airPath.find((q) => q.t >= levelAt!.t + 1);
    const to = [...airPath].reverse().find((q) => q.t <= t - 0.3);
    if (from && to && to.t - from.t > 1) glideSink = (from.h - to.h) / (to.t - from.t);
  }
  // Glide ratio from the glide itself: airspeed over sink, since the circling
  // makes ground distance a poor measure of it.
  let flownRatio: number | null = null;
  if (glideSink && glideSink > 0.05 && tr) flownRatio = Math.sqrt(Math.max(0, tr.speed ** 2 - glideSink ** 2)) / glideSink;
  else if (glideSink && glideSink > 0.05) {
    const v = Math.sqrt((2 * af.mass.mass * G) / (RHO * af.wingArea * 0.5));
    flownRatio = Math.sqrt(Math.max(0, v * v - glideSink ** 2)) / glideSink;
  }
  return {
    path, distance, time: t, maxHeight: maxH, maxLoad, maxAirspeed: maxAir,
    drift: end.y, kind, apexTime: airApexT, levelTime: levelAt ? levelAt.t : null,
    trimSpeed: tr ? tr.speed : null, glideRatio: tr ? tr.ratio : null,
    score: {
      climb: Math.max(0, airTop - launch.height),
      climbShare: Math.max(0, airTop - launch.height) / Math.max(1e-6, (launch.speed * launch.speed) / (2 * G)),
      loopedClimbing,
      transitionLoss: levelAt ? Math.max(0, airTop - levelAt.h) : null,
      transitionTime: levelAt ? Math.max(0, levelAt.t - airApexT) : null,
      glideSink,
      minSink: minSink(af, m, de),
      glideRatio: flownRatio,
    },
  };
}

/**
 * How much the paper's own thickness adds to the drag of the wing.
 *
 * A wing is not a sheet of nothing: where plies stack - a leading edge rolled
 * ten times, flaps folded over - it is as thick as the stack, and a thick
 * section is pushed out of the air's way as well as rubbed by it. The usual
 * allowance (Raymer, Aircraft Design, form factor for a wing) multiplies the
 * skin friction by 1 + 2 t/c + 60 (t/c)^4, t/c the thickest part of each
 * station over its chord, taken over the wing weighted by chord. One ply's
 * thickness is the paper's weight per area over its density (800 kg/m^3).
 * The steps where a flap ends are left out: a tenth of a millimetre under a
 * boundary layer some millimetres thick costs next to nothing.
 */
export function thicknessFormFactor(spec: PlaneSpec): { tc: number; ff: number } {
  const st = spec.sections.filter((s) => s.y > 0 && s.chord > 1e-4);
  if (st.length === 0) return { tc: 0, ff: 1 };
  let weighted = 0;
  let chords = 0;
  for (const s of st) {
    let most = 0;
    for (const n of s.plies) most = Math.max(most, n);
    weighted += most * spec.caliper;
    chords += s.chord;
  }
  const tc = chords > 0 ? weighted / chords : 0;
  return { tc, ff: 1 + 2 * tc + 60 * tc ** 4 };
}

export interface Bending {
  /** Tip rise under the heaviest load of the flight, m. */
  readonly tipDeflection: number;
  /** As a share of the half span. */
  readonly share: number;
  /** Plies stacked, on average, across the wing root. */
  readonly rootPlies: number;
}

/**
 * How far the wing tip bends up under the largest lift of the flight.
 *
 * Each half wing is a cantilever from the keel, carrying the load in
 * proportion to its chord. Its stiffness is the paper stacked across each
 * station: plies lying loose on one another add their stiffness, plies joined
 * along a spanwise fold bend as one sheet of their whole thickness (its cube)
 * - which is why a rolled leading edge holds its shape in a wind that folds a
 * single sheet.
 */
export function wingBending(spec: PlaneSpec, paper: PaperProps, load: number): Bending {
  const af = spec.af;
  const st = spec.sections.filter((s) => s.y > 0).sort((a, b) => a.y - b.y);
  if (st.length < 2 || af.wingArea <= 0) return { tipDeflection: 0, share: 0, rootPlies: 0 };
  const D = paper.bendingRigidity;
  // Each joined bundle as one sheet of its whole thickness; bundles side by side add (see the map).
  const stiff = st.map((s) => {
    let sum = 0;
    for (const k of s.stiffness) sum += k;
    return Math.max(D * sum * CELL, D * s.chord * 1e-3);
  });
  const rootPlies = st[0]!.plies.reduce((a, n) => a + n, 0) / Math.max(1, st[0]!.plies.length);
  // Load per metre of span, shared by chord, for one half wing.
  const half = (load * af.mass.mass * G) / 2;
  const chordSum = st.reduce((a, s) => a + s.chord, 0);
  const w = st.map((s) => (half * s.chord) / chordSum);
  // Bending moment at each station from the load outboard of it.
  const moment = st.map((s) => st.reduce((a, o, j) => (o.y > s.y ? a + w[j]! * (o.y - s.y) : a), 0));
  let slope = 0;
  let rise = 0;
  const root = Math.max(0, st[0]!.y - (st[1]!.y - st[0]!.y) / 2);
  for (let i = 0; i < st.length; i++) {
    const dy = st[i]!.y - (i === 0 ? root : st[i - 1]!.y);
    slope += (moment[i]! / stiff[i]!) * dy;
    rise += slope * dy;
  }
  const semi = st[st.length - 1]!.y - root;
  return { tipDeflection: rise, share: semi > 0 ? rise / semi : 0, rootPlies };
}

/**
 * A paper clip on the nose.
 *
 * The oldest fix there is for an aeroplane that noses up and falls: weight in
 * front. The clip sits at the nose, so it pulls the centre of gravity forward
 * by its share of the mass times the distance, and the neutral point - which
 * belongs to the wing's shape - stays where it was.
 */
export function withNoseWeight(af: Airframe, m: AeroModel, grams: number): { af: Airframe; m: AeroModel } {
  if (!(grams > 0)) return { af, m };
  const clip = grams / 1000;
  const total = af.mass.mass + clip;
  const nose = af.cgFromNose;
  const shift = (clip * nose) / total;
  const i = af.mass.inertia;
  // About the new CG: the paper sits `shift` behind it, the clip `nose - shift` ahead.
  const iyy = i[1] + af.mass.mass * shift * shift + clip * (nose - shift) ** 2;
  const moved: Airframe = {
    ...af,
    mass: {
      ...af.mass, mass: total,
      inertia: [i[0], iyy, i[2] + af.mass.mass * shift * shift + clip * (nose - shift) ** 2, i[3], i[4], i[5]],
    },
    cgFromNose: nose - shift,
  };
  const margin = m.staticMargin + shift / af.meanChord;
  return {
    af: moved,
    m: {
      ...m, staticMargin: margin, cma: -m.cla * margin,
      cmd: m.cmd - (m.cld * shift) / af.meanChord, cm0: m.cm0 - (m.cl0 * shift) / af.meanChord,
    },
  };
}

export interface NoseBulge {
  /** Which way the thick nose sits off the wing: 1 above, -1 below, 0 flat. */
  readonly side: -1 | 0 | 1;
  /** How far its middle stands off the thin wing, m. */
  readonly offset: number;
  /** Where it is, metres ahead of the CG. */
  readonly ahead: number;
  /**
   * The wing's mean surface as the stacked paper leaves it, chord to chord:
   * height above the thin skin (up positive) at points from leading edge (0)
   * to trailing edge (1), both as fractions of the chord. Averaged over the
   * wing, keel and tips left out.
   */
  readonly camber?: readonly (readonly [number, number])[];
}

/**
 * The rolled nose, and which face of the wing it bulges from.
 *
 * The guide this is read from puts it plainly: Birdman's nose is thick on top
 * and flat beneath, so the air over it runs faster, and the faster the
 * aeroplane flies the more the nose is lifted - it pitches up in the fast
 * climb and loops, and its trailing edge has to be bent down. A nose thick
 * underneath does the opposite and wants the trailing edge up. So the nose is
 * found where the paper stacks deepest near the leading edge, and its middle
 * measured against the thin wing behind it: above or below, and by how much.
 */
export function noseBulge(spec: PlaneSpec): NoseBulge {
  const flat: NoseBulge = { side: 0, offset: 0, ahead: 0 };
  const semi = spec.af.span / 2;
  let sum = 0;
  let weight = 0;
  let where = 0;
  const SAMPLES = 30;
  const camberSum = new Array<number>(SAMPLES).fill(0);
  const camberWeight = new Array<number>(SAMPLES).fill(0);
  for (const s of spec.sections) {
    const y = Math.abs(s.y);
    // The wing itself: clear of the keel, short of the tips.
    if (y < 0.15 * semi || y > 0.7 * semi || s.chord <= 0 || s.x.length < 4) continue;
    let thin = Infinity;
    for (const n of s.plies) thin = Math.min(thin, n);
    /*
     * The bare skin's own line along the chord, fitted where it is one layer
     * of stack thinner than anywhere else: a wing set at a slant in the
     * model's axes rises toward its nose by as much as the nose is thick,
     * and the ply riding up over a stack tilts the skin with it. Measured from
     * the skin's own line, the stack is on top or underneath by how the skin
     * runs on under it or over it.
     */
    let n0 = 0; let mx = 0; let mz = 0;
    for (let k = 0; k < s.x.length; k++) {
      if (s.plies[k] !== thin) continue;
      n0++; mx += s.x[k]!; mz += (s.top[k]! + s.bottom[k]!) / 2;
    }
    if (n0 < 2) continue;
    mx /= n0; mz /= n0;
    let sxx = 0; let sxz = 0;
    for (let k = 0; k < s.x.length; k++) {
      if (s.plies[k] !== thin) continue;
      sxx += (s.x[k]! - mx) ** 2; sxz += (s.x[k]! - mx) * ((s.top[k]! + s.bottom[k]!) / 2 - mz);
    }
    const tilt = sxx > 1e-12 ? sxz / sxx : 0;
    const skinAt = (x: number) => mz + tilt * (x - mx);
    for (let k = 0; k < s.x.length; k++) {
      const x = s.x[k]!;
      const mid = (s.top[k]! + s.bottom[k]!) / 2;
      const bin = Math.min(SAMPLES - 1, Math.max(0, Math.floor(((s.leading - x) / s.chord) * SAMPLES)));
      // Up is -z: a middle above the skin is a bulge on top.
      camberSum[bin]! += skinAt(x) - mid;
      camberWeight[bin]! += s.chord;
      if (s.plies[k]! < thin + 4) continue;
      const off = skinAt(x) - mid;
      sum += off * s.plies[k]!;
      weight += s.plies[k]!;
      where += x * s.plies[k]!;
    }
  }
  if (weight === 0) return flat;
  const offset = sum / weight;
  if (Math.abs(offset) < 5e-5) return flat;
  const camber: [number, number][] = [];
  for (let k = 0; k < SAMPLES; k++) {
    if (camberWeight[k]! > 0) camber.push([(k + 0.5) / SAMPLES, camberSum[k]! / camberWeight[k]!]);
  }
  /*
   * Measured from the thin wing's own line, fitted through the back half of
   * the chord where it is bare: a wing set at a slant in the model's axes is
   * the angle it meets the air at, which the lifting surface already has. The
   * stack rising off it is the camber.
   */
  const bare = camber.filter((p) => p[0] >= 0.5);
  if (bare.length >= 2) {
    const bx = bare.reduce((a, p) => a + p[0], 0) / bare.length;
    const bz = bare.reduce((a, p) => a + p[1], 0) / bare.length;
    const bxx = bare.reduce((a, p) => a + (p[0] - bx) ** 2, 0);
    const slope = bxx > 0 ? bare.reduce((a, p) => a + (p[0] - bx) * (p[1] - bz), 0) / bxx : 0;
    for (const p of camber) p[1] -= bz + slope * (p[0] - bx);
  }
  return { side: offset > 0 ? 1 : -1, offset: Math.abs(offset), ahead: where / weight, camber };
}

/**
 * Thin-aerofoil theory over a mean line given at points: the lift it makes at
 * no angle, and its pitch about the quarter chord, nose up positive.
 *
 * The slope between each pair of points is taken as constant and integrated
 * exactly in the angle variable (x = (1 - cos t) / 2), so the steps a stack of
 * plies makes at its edge count at their true place along the chord.
 */
export function thinAerofoil(line: readonly (readonly [number, number])[]): { cl0: number; cmQuarter: number } {
  if (line.length < 2) return { cl0: 0, cmQuarter: 0 };
  // Flat to the edges beyond the first and last points.
  const pts: [number, number][] = [[0, line[0]![1]], ...line.map((p) => [p[0], p[1]] as [number, number]), [1, line[line.length - 1]![1]]];
  const t = (x: number) => Math.acos(Math.max(-1, Math.min(1, 1 - 2 * x)));
  let i0 = 0;
  let i1 = 0;
  let i2 = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [xa, za] = pts[k]!;
    const [xb, zb] = pts[k + 1]!;
    if (!(xb > xa)) continue;
    const slope = (zb - za) / (xb - xa);
    const ta = t(xa);
    const tb = t(xb);
    i0 += slope * (tb - ta);
    i1 += slope * (Math.sin(tb) - Math.sin(ta));
    i2 += slope * (Math.sin(2 * tb) - Math.sin(2 * ta)) / 2;
  }
  const a0 = -i0 / Math.PI;
  const a1 = (2 / Math.PI) * i1;
  const a2 = (2 / Math.PI) * i2;
  return { cl0: 2 * Math.PI * (a0 + a1 / 2), cmQuarter: -(Math.PI / 4) * (a1 - a2) };
}

/**
 * The bulge as aerodynamics: lift that is there at no angle, acting at the
 * nose, ahead of the CG - so a pitching moment that grows with the square of
 * the speed, which is exactly the fast-climb pitch-up the guide describes.
 * Taken as the camber of a thin arc, CL0 = 4 pi h / c.
 */
export function withNoseBulge(af: Airframe, m: AeroModel, bulge: NoseBulge): AeroModel {
  if (bulge.side === 0 || !(af.meanChord > 0) || !bulge.camber) return m;
  /*
   * The stack's own mean line, through thin-aerofoil theory, cut down to the
   * wing's aspect ratio as its lift slope is - and the lift acting where the
   * wing's lift acts, at its neutral point. Taken as a thin arc the whole
   * chord long, with its lift at the nose (CL0 = 4 pi h / c there), a nose
   * stacked a dozen plies deep near the leading edge made four times the lift
   * and two and a half times the pitch-up this gives: the Dropship, nose-heavy
   * enough that its book trims it with the elevator up, looped however far
   * the elevator was bent down.
   */
  const two = thinAerofoil(bulge.camber);
  const finite = m.cla / (2 * Math.PI);
  const cl0 = two.cl0 * finite;
  const cmAc = two.cmQuarter * finite;
  return { ...m, cl0, cm0: cmAc - cl0 * m.staticMargin };
}

/**
 * The centre of gravity where a pupil measured it, balancing the real
 * aeroplane on a fingertip.
 *
 * The folded model is placed exactly, but real paper is not: every turn of a
 * rolled nose takes a little more length round the paper already inside it,
 * so a real Birdman comes out a centimetre shorter than the drawing and its
 * weight sits further forward - 2.5cm from the nose in the guide, where the
 * drawing says 3.1. A millimetre here is the difference between a glide and a
 * loop, so the measured point, when there is one, is the one to fly.
 */
export function withCgAt(af: Airframe, m: AeroModel, fromNose: number): { af: Airframe; m: AeroModel } {
  const shift = af.cgFromNose - fromNose;
  if (!(Math.abs(shift) > 1e-6) || !(af.meanChord > 0)) return { af, m };
  const i = af.mass.inertia;
  const moved: Airframe = {
    ...af,
    mass: { ...af.mass, inertia: [i[0], i[1] + af.mass.mass * shift * shift, i[2] + af.mass.mass * shift * shift, i[3], i[4], i[5]] },
    cgFromNose: fromNose,
  };
  const margin = m.staticMargin + shift / af.meanChord;
  return {
    af: moved,
    m: {
      ...m, staticMargin: margin, cma: -m.cla * margin,
      cmd: m.cmd - (m.cld * shift) / af.meanChord, cm0: m.cm0 - (m.cl0 * shift) / af.meanChord,
    },
  };
}

/**
 * The least sink the shape can manage, m/s: over every angle short of the
 * stall, the steady glide w = sqrt(2W / rho S CL) * CD / CL.
 */
export function minSink(af: Airframe, m: AeroModel, elevator: number): number | null {
  const W = af.mass.mass * G;
  let best: number | null = null;
  for (let a = 0.5; a < (m.stall * 180) / Math.PI; a += 0.25) {
    const alpha = (a * Math.PI) / 180;
    const v0 = 5;
    const { cl, cd } = polar(m, alpha, elevator, v0, af.meanChord);
    if (!(cl > 0.05)) continue;
    const v = Math.sqrt((2 * W) / (RHO * af.wingArea * cl));
    const again = polar(m, alpha, elevator, v, af.meanChord);
    const w = v * (again.cd / again.cl);
    if (best === null || w < best) best = w;
    void cd;
  }
  return best;
}

export interface Forces {
  readonly cl: number;
  readonly cd: number;
  /** Nose-up pitch coefficient about the CG. */
  readonly cm: number;
  /** Newtons. */
  readonly lift: number;
  readonly drag: number;
  /** Nose-up pitching moment, N*m. */
  readonly moment: number;
  readonly stalled: boolean;
}

/**
 * The aeroplane held still in a wind: what the air does to it at one angle
 * and one speed. The same polar and pitching terms the flight uses, with no
 * rotation - a wind tunnel, where the pupil can turn the angle and see the
 * lift, the drag and which way the nose wants to go.
 */
export function forcesAt(af: Airframe, m: AeroModel, alpha: number, speed: number, elevator: number): Forces {
  const { cl, cd, s } = polar(m, alpha, elevator, speed, af.meanChord);
  const cm = pitchCoefficient(m, alpha, elevator, s, cl, cd);
  const q = 0.5 * RHO * speed * speed;
  return {
    cl, cd, cm,
    lift: q * af.wingArea * cl,
    drag: q * af.wingArea * cd,
    moment: q * af.wingArea * af.meanChord * cm,
    stalled: Math.abs(alpha) > m.stall,
  };
}

/**
 * The angle the nose settles at, where the pitching moment is zero, and
 * whether it comes back there when disturbed (the moment falls as the angle
 * rises). Scanned from a little nose-down to past the stall.
 */
export function settleAngle(af: Airframe, m: AeroModel, elevator: number, speed: number): { alpha: number | null; stable: boolean } {
  const lo = -8 * Math.PI / 180;
  const hi = m.stall + 10 * Math.PI / 180;
  const stepA = 0.1 * Math.PI / 180;
  let prev = forcesAt(af, m, lo, speed, elevator).cm;
  let unstable: number | null = null;
  for (let a = lo + stepA; a <= hi; a += stepA) {
    const cm = forcesAt(af, m, a, speed, elevator).cm;
    if (prev > 0 && cm <= 0) return { alpha: a - stepA * (cm / (cm - prev)), stable: true };
    if (prev < 0 && cm >= 0 && unstable === null) unstable = a - stepA * (cm / (cm - prev));
    prev = cm;
  }
  return { alpha: unstable, stable: false };
}
