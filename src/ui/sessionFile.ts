/**
 * The work itself, saved and reopened.
 *
 * A FOLD file records the crease pattern, not the hands: it says where the
 * lines are but not which one was pressed first, which half travelled, or
 * which of them were only reference marks. So a FOLD file cannot be picked up
 * and carried on with - that is why opening one is view-only.
 *
 * The step script has all of it, because the script IS the model: replaying it
 * reproduces the state exactly, every step still selectable and editable. So
 * that is what gets saved when the work is to be continued - here, in another
 * browser, or in the checks, which replay the same file with the same code.
 */

import type { ElevatorTune } from './elevator.js';
import type { Step } from './foldSession.js';
import type { Vec2 } from '../geometry/math.js';

export interface SessionFile {
  readonly kind: 'paper-plane-session';
  readonly version: 1;
  /** Sheet size in millimetres, so the script lands on the paper it was drawn on. */
  readonly sheet: { readonly widthMm: number; readonly heightMm: number };
  readonly gsm: number;
  readonly steps: readonly Step[];
  /** When it was written, for the person reading the file, not for the code. */
  readonly saved: string;
  /**
   * What this plane is called, when it has been given a name.
   *
   * Older files have none and open perfectly well without one - the script is
   * still the model. The name is for the shelf, so that a plane picked up
   * again is picked up by what it is rather than by a filename.
   */
  readonly name?: string;
  /**
   * The trailing edges' tuning, when it has been set. It is not a fold, so it
   * is not in the steps; without it an aeroplane saved after its elevator was
   * bent came back flat.
   */
  readonly elevator?: ElevatorTune;
  /** Finished (false while still being folded); absent means finished. */
  readonly done?: boolean;
  /**
   * The wings' V, degrees: 0 with the wings spread square to the body, rising
   * from there. Set before a flight like the elevator, so it is the plane's.
   */
  readonly vee?: number;
  /** The throw angle it is flown at, degrees up: tuned with the elevator, so it is the plane's too. */
  readonly throwAngle?: number;
}

export function sessionFile(
  widthMm: number, heightMm: number, gsm: number, steps: readonly Step[],
  name?: string,
  elevator?: ElevatorTune | null,
  done?: boolean,
  vee?: number | null,
  throwAngle?: number | null,
): SessionFile {
  return {
    kind: 'paper-plane-session',
    version: 1,
    sheet: { widthMm, heightMm },
    gsm,
    steps,
    saved: new Date().toISOString(),
    ...(name && name.trim() ? { name: name.trim() } : {}),
    ...(elevator ? { elevator } : {}),
    ...(done === false ? { done: false } : {}),
    ...(typeof vee === 'number' ? { vee } : {}),
    ...(typeof throwAngle === 'number' ? { throwAngle } : {}),
  };
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${what}: 숫자가 아닙니다`);
  return v;
};

const point = (v: unknown, what: string): Vec2 => {
  if (!Array.isArray(v) || v.length < 2) throw new Error(`${what}: 점이 아닙니다`);
  return [num(v[0], what), num(v[1], what)];
};

/**
 * Read a saved session back.
 *
 * Every field is checked rather than trusted, because a file that is nearly
 * right is worse than one that is plainly wrong: it replays into a shape that
 * looks plausible and is not the one that was saved.
 */
export function readSessionFile(text: string): {
  widthMm: number; heightMm: number; gsm: number; steps: Step[]; name: string; elevator?: ElevatorTune; done: boolean; vee?: number;
  throwAngle?: number;
} {
  const raw = JSON.parse(text) as Partial<SessionFile>;
  if (raw?.kind !== 'paper-plane-session') {
    throw new Error('이 시뮬레이터의 작업 파일이 아닙니다.');
  }
  if (raw.version !== 1) throw new Error(`모르는 버전입니다: ${String(raw.version)}`);
  const sheet = raw.sheet;
  if (!sheet) throw new Error('종이 크기가 없습니다.');
  const widthMm = num(sheet.widthMm, '종이 너비');
  const heightMm = num(sheet.heightMm, '종이 높이');
  const gsm = num(raw.gsm, '평량');
  if (!Array.isArray(raw.steps)) throw new Error('단계 목록이 없습니다.');

  const steps: Step[] = raw.steps.map((s, i) => {
    const at = `${i + 1}단계`;
    const label = typeof s?.label === 'string' ? s.label : at;
    if (s?.kind === 'flip') return { kind: 'flip', label, group: s.group };
    if (s?.kind === 'collapse') {
      const open = Array.isArray(s.open)
        ? s.open.map((p: unknown, k: number) => point(p, `${at} 열어둘 선 ${k + 1}`))
        : undefined;
      const lines = Array.isArray(s.lines)
        ? s.lines.map((l: { a?: unknown; b?: unknown; kind?: unknown }, k: number) => {
          if (l?.kind !== 'mountain' && l?.kind !== 'valley' && l?.kind !== 'open') {
            throw new Error(`${at} 선 ${k + 1}: 접는 방향이 mountain/valley/open이 아닙니다`);
          }
          return { a: point(l.a, `${at} 선 ${k + 1}`), b: point(l.b, `${at} 선 ${k + 1}`), kind: l.kind };
        })
        : undefined;
      return { kind: 'collapse', at: point(s.at, at), label, group: s.group,
        ...(open ? { open } : {}), ...(lines ? { lines } : {}) };
    }
    if (s?.kind === 'dimension') {
      return { kind: 'dimension', a: point(s.a, at), b: point(s.b, at), label, group: s.group };
    }
    if (s?.kind !== 'fold') throw new Error(`${at}: 모르는 종류입니다 (${String(s?.kind)})`);
    if (s.sense !== 'valley' && s.sense !== 'mountain') {
      throw new Error(`${at}: 접는 방향이 valley/mountain이 아닙니다`);
    }
    return {
      kind: 'fold',
      a: point(s.a, at),
      b: point(s.b, at),
      movingSide: point(s.movingSide, at),
      sense: s.sense,
      creaseOnly: s.creaseOnly === true,
      label,
      angleDeg: s.angleDeg === undefined ? undefined : num(s.angleDeg, at),
      plies: legacyWing(label, s.plies),
      tuck: s.tuck === true ? true : undefined,
      reverse: s.reverse === 'inside' || s.reverse === 'outside' ? s.reverse : undefined,
      pleat: s.pleat === true ? true : undefined,
      symmetric: s.symmetric === true ? true : undefined,
      group: s.group,
      unfolded: s.unfolded === true ? true : undefined,
      unfoldedAt: typeof s.unfoldedAt === 'number' && Number.isFinite(s.unfoldedAt) ? s.unfoldedAt : undefined,
      pinned: Array.isArray(s.pinned)
        ? (s.pinned as { a?: unknown; b?: unknown }[]).map((seg, k: number) => ({
          a: point(seg?.a, `${at} 고정 선 ${k + 1}`), b: point(seg?.b, `${at} 고정 선 ${k + 1}`),
        }))
        : undefined,
    };
  });
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const e = raw.elevator;
  const elevator = e && [e.fromCm, e.widthCm, e.depthCm, e.angleDeg].every((v) => typeof v === 'number' && Number.isFinite(v))
    ? { fromCm: e.fromCm, widthCm: e.widthCm, depthCm: e.depthCm, angleDeg: e.angleDeg, ...(e.auto === true ? { auto: true } : {}) } : undefined;
  const vee = typeof raw.vee === 'number' && Number.isFinite(raw.vee) ? raw.vee : undefined;
  const throwAngle = typeof raw.throwAngle === 'number' && Number.isFinite(raw.throwAngle) ? raw.throwAngle : undefined;
  return {
    widthMm, heightMm, gsm, steps, name, done: raw.done !== false, ...(elevator ? { elevator } : {}), ...(vee !== undefined ? { vee } : {}),
    ...(throwAngle !== undefined ? { throwAngle } : {}),
  };
}

/*
 * A wing saved by "동체 + 날개 접기" before wings were named as wings.
 *
 * It was stored as "the top n plies" or "the bottom n", n counted when the
 * button was pressed - and an earlier step changed later changed the count,
 * so the wing took paper from the other wing or the fold would not go. Read
 * back, it is the upper or the lower wing, which is what the button meant.
 */
function legacyWing(label: string, plies: any): any {
  const p = plies as { kind?: string } | undefined;
  if (!/^(앞쪽|뒤쪽) 날개 · V자/.test(label)) return plies;
  if (p?.kind === 'top') return { kind: 'wing', upper: true };
  if (p?.kind === 'bottom') return { kind: 'wing', upper: false };
  return plies;
}
