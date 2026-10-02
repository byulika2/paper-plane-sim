/**
 * The page's side of the flight worker: ask, and hear back later.
 *
 * A few workers, each taking one job at a time. What has been answered is
 * kept by record, so a card shown again - or the flying screen asking what the
 * card already knows - does not wait again.
 */

import type { CardFlight, PlaneRecord } from './planeCard.js';
import type { ElevatorTune } from './elevator.js';
import type { FlightSettings } from './flightReport.js';
import type { Job } from './flightJobs.worker.js';

type Answer = { id: number; ok: boolean; result?: unknown; error?: string };
type Ask = Job extends infer J ? (J extends { id: number } ? Omit<J, 'id'> : never) : never;

/*
 * Kept in the browser, too, so a page opened again does not fly every plane
 * again. What is kept is named by the whole question - the plane's full
 * record and the throw - and by the version of the sums: a plane folded or
 * tuned differently asks a different question, and when the flying or the
 * scoring changes, CALC_VERSION goes up and every old answer stops matching.
 * So a kept answer can be a stale copy of nothing; it is never read for a
 * plane it was not worked out for.
 */
const CALC_VERSION = 38;
const STORE_KEY = 'paper-plane.flight-answers.v1';
const STORE_MAX = 150;

// Read once: parsing the whole store on every question was the slow part.
let memo: Record<string, unknown> | null = null;
function stored(): Record<string, unknown> {
  if (memo) return memo;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as { v?: number; a?: Record<string, unknown> };
    memo = raw && raw.v === CALC_VERSION && raw.a && typeof raw.a === 'object' ? raw.a : {};
  } catch { memo = {}; }
  return memo;
}
function store(key: string, value: unknown): void {
  const a = stored();
  delete a[key];
  a[key] = value;
  const keys = Object.keys(a);
  for (const k of keys.slice(0, Math.max(0, keys.length - STORE_MAX))) delete a[k];
  /*
   * Full, the oldest half goes and it is tried again. A failed write used to
   * be let go with the store left as it was, so every later answer failed to
   * be kept as well and the list was worked out from scratch on each visit.
   */
  for (let tries = 0; tries < 4; tries++) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ v: CALC_VERSION, a }));
      return;
    } catch {
      const left = Object.keys(a);
      if (left.length <= 1) break;
      for (const k of left.slice(0, Math.ceil(left.length / 2))) if (k !== key) delete a[k];
    }
  }
}

/*
 * Several workers, so the list's cards are worked out side by side: each
 * takes ten seconds or more, and one worker taking them in turn kept the last
 * card saying "계산 중" for a minute or two whenever the sums had changed.
 * One core is left to the page.
 */
const POOL = Math.max(1, Math.min(4, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency ?? 2 : 2) - 1));
interface Hand { worker: Worker; waiting: Map<number, { resolve(v: unknown): void; reject(e: Error): void }> }
const hands: (Hand | null)[] = new Array(POOL).fill(null);
let seq = 0;
const answered = new Map<string, Promise<unknown>>();

function hand(i: number): Hand {
  const had = hands[i];
  if (had) return had;
  const worker = new Worker(new URL('./flightJobs.worker.ts', import.meta.url), { type: 'module' });
  const h: Hand = { worker, waiting: new Map() };
  worker.onmessage = (e: MessageEvent<Answer>) => {
    const w = h.waiting.get(e.data.id);
    if (!w) return;
    h.waiting.delete(e.data.id);
    if (e.data.ok) w.resolve(e.data.result); else w.reject(new Error(e.data.error));
  };
  /*
   * A worker that fails to load or dies leaves every question unanswered -
   * a card that says "계산 중" for ever. Everything waiting on it is turned
   * down, so it can be asked again, and the next question starts a new one.
   */
  const fail = () => {
    for (const w of h.waiting.values()) w.reject(new Error('계산을 하지 못했어요.'));
    h.waiting.clear();
    worker.terminate();
    if (hands[i] === h) hands[i] = null;
  };
  worker.onerror = fail;
  worker.onmessageerror = fail;
  hands[i] = h;
  return h;
}

function ask<T>(job: Ask): Promise<T> {
  const key = JSON.stringify(job);
  const hit = answered.get(key);
  if (hit) return hit as Promise<T>;
  const kept = stored();
  if (key in kept) {
    const p = Promise.resolve(kept[key]);
    answered.set(key, p);
    return p as Promise<T>;
  }
  // The least busy worker takes it.
  let pick = 0;
  for (let i = 1; i < POOL; i++) {
    if ((hands[i]?.waiting.size ?? 0) < (hands[pick]?.waiting.size ?? 0)) pick = i;
  }
  const h = hand(pick);
  const id = ++seq;
  const p = new Promise<unknown>((resolve, reject) => { h.waiting.set(id, { resolve, reject }); });
  h.worker.postMessage({ ...job, id });
  if (answered.size > 80) answered.clear();
  answered.set(key, p);
  // A failed answer is not kept: asking again tries again.
  p.then((v) => store(key, v), () => answered.delete(key));
  return p as Promise<T>;
}

// The card depends on the paper and the folds alone (see bestTuning): asked by those, so one plane is one answer.
export const cardFlightLater = (record: PlaneRecord) => ask<CardFlight | null>({
  kind: 'card', record: { widthMm: record.widthMm, heightMm: record.heightMm, gsm: record.gsm, steps: record.steps },
});
export const recommendLater = (record: PlaneRecord, settings?: FlightSettings) =>
  ask<ElevatorTune | null>({ kind: 'recommend', record, settings });
export const recommendThrowLater = (record: PlaneRecord, settings?: FlightSettings) =>
  ask<{ elevator: ElevatorTune; angle: number } | null>({ kind: 'throw', record, settings });
export const recommendAngleLater = (record: PlaneRecord, settings?: FlightSettings) =>
  ask<number | null>({ kind: 'angle', record, settings });
