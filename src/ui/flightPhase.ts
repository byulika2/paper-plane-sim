/**
 * The parts of a throw, as the wind tunnel names them.
 */

import type { Vec3 } from '../geometry/math.js';
import type { Flight, FlightPoint } from '../aero/flight.js';

export type Phase = 'climb' | 'transition' | 'turn' | 'glide';
export const PHASE_NAMES: Record<Phase, string> = {
  climb: '던짐 · 올라가기',
  transition: '꼭대기 · 트랜지션',
  turn: '선회',
  glide: '활공',
};
/** One colour per part, the same on the height line, the room's trail and the badge. */
export const PHASE_COLOURS: Record<Phase, string> = { climb: '#f59e0b', transition: '#ef4444', turn: '#a78bfa', glide: '#22c55e' };
export const PHASE_TIPS: Record<Phase, string> = {
  climb: '손을 떠난 빠른 속도로 옆으로 누워 올라가요. 공기 저항이 커서 속도가 빨리 줄어요.',
  transition: '가장 느린 순간이에요. 코가 숙여지고 V자 날개 덕분에 수평으로 돌아와요.',
  turn: '날개가 기울어 양력 일부가 방향을 틀어요. 원을 그리며 내려가요.',
  glide: '양력이 무게와 거의 같아요. 저항만큼 천천히 내려가요.',
};

/**
 * Which part of the flight a moment is in: before the top, the climb; from
 * the top until it has come level, the transition (the same moment the
 * transition score is taken at); after that, turning while it is banked more
 * than fifteen degrees, gliding while it is not.
 */
export function phaseAt(flight: Flight, p: FlightPoint): Phase {
  if (p.t <= flight.apexTime) return 'climb';
  if (flight.levelTime === null || p.t < flight.levelTime) return 'transition';
  // The bank is carried on round whole turns; read as it points now.
  const b = p.bank ?? 0;
  return Math.abs(Math.atan2(Math.sin(b), Math.cos(b))) > (15 * Math.PI) / 180 ? 'turn' : 'glide';
}

/** The recorded moment at or just before `t`. */
export function pointAt(path: readonly FlightPoint[], t: number): FlightPoint {
  let lo = 0;
  let hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid]!.t <= t) lo = mid; else hi = mid - 1;
  }
  // The two ends a flight is closed with carry no air data: take the nearest moment that does.
  for (let i = lo; i >= 0; i--) if (path[i]!.speed !== undefined) return path[i]!;
  for (let i = lo; i < path.length; i++) if (path[i]!.speed !== undefined) return path[i]!;
  return path[lo]!;
}

/** Two directions mixed and made unit again. */
function blend(x: Vec3 | undefined, y: Vec3 | undefined, u: number): Vec3 | undefined {
  if (!x || !y) return x;
  const w: Vec3 = [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u];
  const n = Math.hypot(w[0], w[1], w[2]);
  return n > 1e-9 ? [w[0] / n, w[1] / n, w[2] / n] : x;
}

/**
 * The moment at `t`, between the recorded ones: every figure run smoothly
 * from the moment before to the moment after, so a replay at sixty frames a
 * second does not step through the fifty-a-second record in jolts. The
 * heading goes the short way round.
 */
export function momentAt(path: readonly FlightPoint[], t: number): FlightPoint {
  const a = pointAt(path, t);
  const i = path.indexOf(a);
  let b: FlightPoint | undefined;
  for (let j = i + 1; j < path.length; j++) if (path[j]!.speed !== undefined) { b = path[j]; break; }
  if (!b || !(b.t > a.t)) return a;
  const u = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t)));
  const mix = (x: number | undefined, y: number | undefined) =>
    (x === undefined || y === undefined ? x : x + (y - x) * u);
  const turn = (x: number | undefined, y: number | undefined) => {
    if (x === undefined || y === undefined) return x;
    const d = Math.atan2(Math.sin(y - x), Math.cos(y - x));
    return x + d * u;
  };
  return {
    t, x: a.x + (b.x - a.x) * u, h: a.h + (b.h - a.h) * u, pitch: a.pitch + (b.pitch - a.pitch) * u,
    speed: mix(a.speed, b.speed), alpha: mix(a.alpha, b.alpha), gamma: turn(a.gamma, b.gamma), bank: mix(a.bank, b.bank),
    lift: mix(a.lift, b.lift), drag: mix(a.drag, b.drag), gx: mix(a.gx, b.gx), gy: mix(a.gy, b.gy), heading: turn(a.heading, b.heading),
    fwd: blend(a.fwd, b.fwd, u), up: blend(a.up, b.up, u), nose: blend(a.nose, b.nose, u), top: blend(a.top, b.top, u),
  };
}
