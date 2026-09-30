/**
 * The parts of a throw, as the wind tunnel names them.
 */

import type { Flight, FlightPoint } from '../aero/flight.js';

export type Phase = 'climb' | 'transition' | 'turn' | 'glide';
export const PHASE_NAMES: Record<Phase, string> = {
  climb: '던짐 · 올라가기',
  transition: '꼭대기 · 트랜지션',
  turn: '선회',
  glide: '활공',
};
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
  return Math.abs(p.bank ?? 0) > (15 * Math.PI) / 180 ? 'turn' : 'glide';
}

