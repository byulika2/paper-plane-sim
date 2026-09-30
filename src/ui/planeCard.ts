/**
 * What a card on the plane list shows: the finished aeroplane, and how it flies.
 *
 * Both are worked out from the plane's one record - its steps and its
 * elevator - every time the list is shown, and kept only in memory for the
 * page's life. Nothing is written back: a picture or a flight time stored
 * beside a plane would be a second account of it that could fall out of step
 * with the first.
 */

import { measurePlane } from '../aero/spec.js';
import { renderFaces } from '../origami/space.js';
import { SHEET_SIZES, paperProps } from '../paper/stock.js';
import type { PaperProps } from '../paper/stock.js';
import { bendElevator } from './elevator.js';
import type { ElevatorTune } from './elevator.js';
import { foldEdges, replay, rollRetreat } from './foldSession.js';
import type { Step } from './foldSession.js';
import { DEFAULT_FLIGHT, balanceGrade, flightBase, flightReport, flyingVee, liftWings } from './flightReport.js';
import type { FlightSettings, Grade } from './flightReport.js';
import { runThrows, summarize, throwsAround } from './flightStats.js';
import { longest, recommendElevator, recommendElevatorTimed } from './recommend.js';
import { readSessionFile } from './sessionFile.js';

/** A plane's record, whichever shelf it came from. */
export interface PlaneRecord {
  readonly widthMm: number;
  readonly heightMm: number;
  readonly gsm: number;
  readonly steps: readonly Step[];
  readonly elevator?: ElevatorTune;
  /** The wings' V as set to fly, degrees from spread square to the body. */
  readonly vee?: number;
  /** The throw angle it is flown at, degrees up. */
  readonly throwAngle?: number;
}

export interface CardShape {
  readonly viewBox: string;
  /** Far to near; `edge` is the part of the outline that is a real edge of paper. */
  readonly faces: readonly { readonly d: string; readonly fill: string; readonly edge: string }[];
}

export interface CardFlight {
  /** Average time aloft over the throws, s. */
  readonly time: number;
  readonly glideRatio: number | null;
  /** Grams. */
  readonly weight: number;
  /** How high the throw takes it, on average, m above the ground. */
  readonly height: number;
  readonly grades: readonly Grade[];
  /** The elevator it was judged with: always the recommended one (see cardFlight). */
  readonly elevator: ElevatorTune;
  /** The throw angle it was judged at, degrees: the flying screen opens at it. */
  readonly angle: number;
  readonly recommended: boolean;
}

/*
 * The throw every card is judged by is the flying screen's own starting
 * throw, a hundred times over, with the plane's own elevator: one plane, one
 * set of numbers, whether it is read off the list or the flying screen.
 */
export const CARD_THROW = { label: '어른이 던지면', speed: DEFAULT_FLIGHT.speed } as const;
const CARD_THROWS = 100;

/*
 * Remembered answers, the oldest let go past a limit: kept for ever, every
 * elevator tried and every step edited left another model in memory.
 */
function keep<V>(map: Map<string, V>, key: string, value: V, limit = 24): V {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value!);
  return value;
}

// The folded model depends on the paper and the folds, not on how it is tuned.
const modelKeyOf = (r: PlaneRecord) => JSON.stringify([r.widthMm, r.heightMm, r.gsm, r.steps]);
const keyOf = (r: PlaneRecord) => JSON.stringify([r.widthMm, r.heightMm, r.gsm, r.steps, r.elevator ?? null, r.vee ?? null, r.throwAngle ?? null]);

function paperOf(r: PlaneRecord): PaperProps {
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const sheet = SHEET_SIZES.find((z) => near(z.widthMm, r.widthMm) && near(z.heightMm, r.heightMm))
    ?? { id: 'custom', name: '종이', widthMm: r.widthMm, heightMm: r.heightMm };
  return paperProps(sheet, r.gsm);
}

/** The folded model and its airframe: shared by the picture and the flight. */
const built = new Map<string, ReturnType<typeof build>>();
function build(r: PlaneRecord) {
  // Built exactly as the folding screen builds it - with the paper's own
  // thickness - so the card and the flying screen fly the same aeroplane.
  const paperNow = paperOf(r);
  const sess = replay(r.widthMm / 1000, r.heightMm / 1000, r.steps, paperNow.foldedPitch);
  const drawn = renderFaces(sess.state, -1, paperNow.foldedPitch);
  const roll = rollRetreat(r.steps, sess, paperNow.foldedPitch, drawn, paperNow);
  const plies = drawn;
  // Measured once; the flight is worked out on the measurements alone.
  const spec = measurePlane(plies, paperNow, paperNow.foldedPitch,
    foldEdges(r.steps, sess, paperNow.foldedPitch, drawn, paperNow), roll.retreat);
  return { paper: paperNow, plies, spec, af: spec?.af ?? null };
}
function modelOf(r: PlaneRecord) {
  const k = modelKeyOf(r);
  return built.get(k) ?? keep(built, k, build(r), 12);
}

/*
 * Seen as the folding screen's 비스듬히 sees it: nose toward the viewer and to
 * the left, a little from above. Body axes (x forward, y right, z down) are
 * turned into the scene's (x forward, y up, z right) and projected onto the
 * camera's plane; faces are painted far to near, lit by how squarely they
 * face a light over the viewer's shoulder.
 */
const CAMERA = normalize([0.62, 0.42, -0.72]);
const RIGHT = normalize(cross([-CAMERA[0], -CAMERA[1], -CAMERA[2]], [0, 1, 0]));
const UP = cross(RIGHT, [-CAMERA[0], -CAMERA[1], -CAMERA[2]]);
const LIGHT = normalize([0.4, 0.9, -0.3]);

function normalize(v: readonly number[]): [number, number, number] {
  const n = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / n, v[1]! / n, v[2]! / n];
}
function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

type Pt = readonly [number, number];
/*
 * The sides of a piece that are edges of the paper, as the eye sees them: its
 * folded edges, its cut edges, a layer ending on top of another. What is left
 * out is a crease lying flat - a side shared with a piece of the same flat
 * that carries on beyond it - which on real paper is at most a faint mark.
 */
function realEdges(f: { screen: readonly Pt[] }, flat: readonly { screen: readonly Pt[] }[]): [Pt, Pt][] {
  const tol = 0.0004;
  const near = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
  const centre = (g: { screen: readonly Pt[] }) => {
    const n = g.screen.length;
    return [g.screen.reduce((s, p) => s + p[0], 0) / n, g.screen.reduce((s, p) => s + p[1], 0) / n] as const;
  };
  const side = (a: Pt, b: Pt, p: Pt) => Math.sign((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
  const mine = centre(f);
  const out: [Pt, Pt][] = [];
  for (let i = 0; i < f.screen.length; i++) {
    const a = f.screen[i]!;
    const b = f.screen[(i + 1) % f.screen.length]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < tol) continue;
    const flatCrease = flat.some((g) => g !== f && g.screen.some((p, j) => {
      const q = g.screen[(j + 1) % g.screen.length]!;
      return ((near(p, a) && near(q, b)) || (near(p, b) && near(q, a))) && side(a, b, centre(g)) === -side(a, b, mine);
    }));
    if (!flatCrease) out.push([a, b]);
  }
  return out;
}

const shapes = new Map<string, CardShape | null>();
/** `flying`: a finished plane, drawn as it flies; one still being folded, as it lies. */
export function cardShape(r: PlaneRecord, flying = true): CardShape | null {
  const k = keyOf(r) + (flying ? '' : '|folded');
  if (shapes.has(k)) return shapes.get(k)!;
  const { plies, af } = modelOf(r);
  let out: CardShape | null = null;
  if (plies.length > 0) {
    // A plane with no depth yet is shown as it lies; one with an airframe, flying.
    // Drawn as it flies: its elevator bent and its wings in their V, by the
    // same rules the flying screen uses.
    const lift = af && flying ? liftWings(af, plies, flyingVee(af, r.vee)) : null;
    const toBody = af && lift ? (p: readonly [number, number, number]) => lift(af.frame.toBody(p)) : af ? af.frame.toBody : (p: readonly [number, number, number]) => [p[0], p[1], p[2]] as const;
    // Only a recommended elevator is ever flown, so only one is drawn.
  const drawn = af ? bendElevator(plies, af, r.elevator?.auto ? r.elevator : null) : plies;
    const scene = (p: readonly [number, number, number]) => {
      const q = toBody(p);
      return af ? [q[0], -q[2], q[1]] : [q[0], q[2], q[1]];
    };
    const faces = drawn.map((f) => {
      const pts = f.points.map((p) => scene(p));
      // Newell's normal of the projected-to-scene polygon.
      let n: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        n = [n[0] + (a[1]! - b[1]!) * (a[2]! + b[2]!), n[1] + (a[2]! - b[2]!) * (a[0]! + b[0]!), n[2] + (a[0]! - b[0]!) * (a[1]! + b[1]!)];
      }
      let nn = normalize(n);
      if (dot(nn, CAMERA) < 0) nn = [-nn[0], -nn[1], -nn[2]];
      // Nose toward the lower left. The aeroplane is its own mirror image, so
      // turning the picture round is the same view from its other side.
      const screen = pts.map((p) => [dot(p, RIGHT), -dot(p, UP)] as const);
      const depth = pts.reduce((s, p) => s + dot(p, CAMERA), 0) / pts.length;
      // How wide the piece is, in the paper: area over half its outline. A
      // roll's turn and a stack's paper-thick edge are only millimetres wide.
      const area = Math.hypot(n[0], n[1], n[2]) / 2;
      let rim = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i]!;
        const b = pts[(i + 1) % pts.length]!;
        rim += Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!);
      }
      const width = rim > 0 ? 2 * area / rim : 0;
      const offset = pts.reduce((s, p) => s + dot(p, nn), 0) / pts.length;
      return { screen, depth, nn, offset, width };
    });
    /*
     * No fold lines: the plies of one flat - the layers stacked a paper's
     * thickness apart, and the pieces a crease cuts a face into - are drawn as
     * one shape in one colour, so nothing marks where one ends and the next
     * begins. Only a real change of slope shows, as a change of shade.
     */
    const flats: { nn: [number, number, number]; offset: number; depth: number; parts: typeof faces }[] = [];
    // A piece seen edge-on - a roll's turn, a fold's paper-thick edge - is a
    // line on the picture, not a surface: left out.
    for (const f of faces.filter((x) => x.width > 0.0015)) {
      const same = flats.find((g) => dot(g.nn, f.nn) > 0.97 && Math.abs(g.offset - f.offset) < 0.008);
      if (same) { same.parts.push(f); same.depth = Math.max(same.depth, f.depth); } else flats.push({ nn: f.nn, offset: f.offset, depth: f.depth, parts: [f] });
    }
    const xs = faces.flatMap((f) => f.screen.map((p) => p[0]));
    const ys = faces.flatMap((f) => f.screen.map((p) => p[1]));
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = Math.max(...xs) - minX || 1;
    const h = Math.max(...ys) - minY || 1;
    const pad = Math.max(w, h) * 0.06;
    const k2 = 1000;
    out = {
      viewBox: `${((minX - pad) * k2).toFixed(1)} ${((minY - pad) * k2).toFixed(1)} ${((w + 2 * pad) * k2).toFixed(1)} ${((h + 2 * pad) * k2).toFixed(1)}`,
      // Each piece its own path - a piece seen edge-on can wind either way,
      // and one path would punch it out as a hole - but every piece of a flat
      // in the flat's one colour, edged in it, so the seams do not show.
      faces: flats.flatMap((g) => {
        const c = Math.round(232 * (0.62 + 0.38 * Math.abs(dot(g.nn, LIGHT))));
        const fill = `rgb(${c},${Math.round(c * 1.01)},${Math.min(255, Math.round(c * 1.05))})`;
        return g.parts.map((f) => ({ f, fill, edge: realEdges(f, g.parts) }));
      }).sort((a, b) => a.f.depth - b.f.depth).map(({ f, fill, edge }) => ({
        d: f.screen.map((p, i) => `${i ? 'L' : 'M'}${(p[0] * k2).toFixed(2)},${(p[1] * k2).toFixed(2)}`).join('') + 'Z',
        fill,
        edge: edge.map(([p, q]) => `M${(p[0] * k2).toFixed(2)},${(p[1] * k2).toFixed(2)}L${(q[0] * k2).toFixed(2)},${(q[1] * k2).toFixed(2)}`).join(''),
      })),
    };
  }
  keep(shapes, k, out, 48);
  return out;
}

const flights = new Map<string, CardFlight | null>();

export function cardFlight(r: PlaneRecord): CardFlight | null {
  const k = keyOf(r);
  if (flights.has(k)) return flights.get(k)!;
  const { paper, spec, af } = modelOf(r);
  let out: CardFlight | null = null;
  if (spec && af && af.wingArea > 1e-6 && af.meanChord > 1e-6) {
    // Never tuned, it is judged at the elevator recommended for this throw.
    /*
     * Every plane is judged at the angle and elevator that suit it now: the
     * elevator is only ever the recommended one, and one worked out under
     * older sums, held to, turned good planes into zeros when the sums changed.
     */
    const best = recommendThrow({ ...r, elevator: undefined });
    const thrown = { ...DEFAULT_FLIGHT, angle: best?.angle ?? r.throwAngle ?? DEFAULT_FLIGHT.angle };
    const e = best?.elevator ?? recommendFor(r, thrown)!;
    const region = { y0: e.fromCm / 100, y1: (e.fromCm + e.widthCm) / 100, depth: e.depthCm / 100 };
    const base = flightBase(spec, region);
    const settings = { ...thrown, region, vee: r.vee ?? null };
    const elevator = e.angleDeg;
    const rep = flightReport(base, spec, paper, { ...settings, elevator });
    const results = runThrows(rep.af, rep.m, throwsAround(rep.launch, CARD_THROWS), 0, CARD_THROWS);
    const stats = summarize(results, spec, paper);
    out = { time: stats.time.mean, glideRatio: stats.glideRatio, weight: af.mass.mass * 1000, height: stats.height.mean, grades: [...stats.grades, balanceGrade(rep.margin)], elevator: e, angle: thrown.angle, recommended: true };
  }
  keep(flights, k, out, 48);
  return out;
}

/**
 * The elevator recommended for a record and a throw: the one a finished plane
 * is saved with, and the one an untuned plane is judged at meanwhile.
 */
export function recommendFor(r: PlaneRecord, settings: FlightSettings = DEFAULT_FLIGHT): ElevatorTune | null {
  const { paper, spec, af } = modelOf(r);
  if (!spec || !af || !(af.wingArea > 1e-6) || !(af.meanChord > 1e-6)) return null;
  const s = { ...settings, vee: settings.vee ?? r.vee ?? null };
  return recommendElevator(spec, paper, s, JSON.stringify([keyOf(r), s.speed, s.angle, s.height, s.bank, s.vee, s.headwind, s.gust ?? 1]), r.elevator);
}

/**
 * The throw angle and the elevator that go together best: at each of the
 * three angles the elevator that keeps it up longest, and of those three
 * pairs the longest - the plane's own pair kept on a tie. What a finished
 * plane is saved with.
 */
export function recommendThrow(r: PlaneRecord, settings: FlightSettings = DEFAULT_FLIGHT): { elevator: ElevatorTune; angle: number } | null {
  const { paper, spec, af } = modelOf(r);
  if (!spec || !af || !(af.wingArea > 1e-6) || !(af.meanChord > 1e-6)) return null;
  const own = r.throwAngle ?? DEFAULT_FLIGHT.angle;
  const angles = [own, ...THROW_ANGLES.filter((a) => a !== own)];
  const judged = angles.map((angle) => {
    const s = { ...settings, angle, vee: settings.vee ?? r.vee ?? null };
    return { angle, ...recommendElevatorTimed(spec, paper, s,
      JSON.stringify([keyOf(r), s.speed, s.angle, s.height, s.bank, s.vee, s.headwind, s.gust ?? 1]), r.elevator) };
  });
  const best = longest(judged);
  return { elevator: best.tune, angle: best.angle };
}

/** The throw angles a pupil picks from, degrees up. */
export const THROW_ANGLES = [70, 80, 90] as const;

/**
 * The throw angle, of the three, that keeps this plane up longest on average,
 * over the same hundred throws its score is taken from - flown with its own
 * elevator, or the one recommended for that angle when it has none.
 */
export function recommendAngle(r: PlaneRecord, settings: FlightSettings = DEFAULT_FLIGHT): number | null {
  const { paper, spec, af } = modelOf(r);
  if (!spec || !af || !(af.wingArea > 1e-6) || !(af.meanChord > 1e-6)) return null;
  let best: number | null = null;
  let top = -Infinity;
  for (const angle of THROW_ANGLES) {
    const s = { ...settings, angle, vee: settings.vee ?? r.vee ?? null };
    const e = r.elevator ?? recommendFor(r, s);
    if (!e) continue;
    const region = { y0: e.fromCm / 100, y1: (e.fromCm + e.widthCm) / 100, depth: e.depthCm / 100 };
    const rep = flightReport(flightBase(spec, region), spec, paper, { ...s, region, elevator: e.angleDeg });
    const results = runThrows(rep.af, rep.m, throwsAround(rep.launch, CARD_THROWS), 0, CARD_THROWS);
    const time = results.reduce((sum, x) => sum + x.time, 0) / Math.max(1, results.length);
    if (time > top + 1e-6) { top = time; best = angle; }
  }
  return best;
}

/** A book plane's record, read once per page from its file. */
const bookFiles = new Map<string, Promise<PlaneRecord>>();
export function bookRecord(file: string): Promise<PlaneRecord> {
  let p = bookFiles.get(file);
  if (!p) {
    p = fetch(file).then((res) => {
      if (!res.ok) throw new Error(`${res.status}`);
      return res.text();
    }).then((t) => readSessionFile(t));
    // A failed read is not kept: the next ask tries again.
    p.catch(() => bookFiles.delete(file));
    bookFiles.set(file, p);
  }
  return p;
}

/*
 * One card's work at a time, each after the page has had a turn, so the list
 * is on screen at once and fills in without the page stalling.
 */
let queue: Promise<void> = Promise.resolve();
export function whenIdle<T>(work: () => T): Promise<T> {
  const run = queue.then(() => new Promise<T>((resolve, reject) => {
    const go = () => { try { resolve(work()); } catch (e) { reject(e); } };
    const w = window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
    if (w.requestIdleCallback) w.requestIdleCallback(go, { timeout: 300 }); else setTimeout(go, 16);
  }));
  queue = run.then(() => undefined, () => undefined);
  return run;
}
