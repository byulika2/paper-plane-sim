/**
 * Throwing the aeroplane: pick how, see what the shape predicts.
 *
 * Nobody can watch these aeroplanes fly, so the page is a flying field in
 * numbers. The choices are the ones a flying day has - how hard, how steep,
 * from how high, into what wind, and the two fixes everyone reaches for, the
 * trailing edge bent up and a paper clip on the nose - and the answers are the
 * ones a flying day gives, plus the ones it hides: where the balance point
 * sits against the weight, and how far the wing bends under a hard throw.
 *
 * The words are for pupils. Every number says what it means in a sentence.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlaneSpec } from '../aero/spec.js';
import type { Flight } from '../aero/flight.js';
import type { RenderFace } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';
import { elevatorRiseMm } from './elevator.js';
import { THROW_ANGLES } from './planeCard.js';
import type { ElevatorTune } from './elevator.js';
import { KIND_TEXT, balanceGrade, canFly, flightBase, flightReport } from './flightReport.js';
import type { FlightSettings } from './flightReport.js';
import {
  KIND_NAMES, cachedStats, keepStats, runThrows, statsKey, summarize, throwsAround,
} from './flightStats.js';
import type { FlightStats, ThrowResult } from './flightStats.js';
import { WindTunnel } from './WindTunnel.js';

interface Props {
  /** The measured plane it flies (see `measurePlane`). */
  spec: PlaneSpec;
  /** The folded model, for drawing only. */
  plies: readonly RenderFace[];
  paper: PaperProps;
  /** The throw, kept by the app so it outlives the screen and reaches the download. */
  settings: FlightSettings;
  onSettings(next: FlightSettings): void;
  /** The model as the folding screen draws it, the elevator bent in. */
  shownPlies?: readonly RenderFace[];
  /** The elevator it flies with: always the recommended one. */
  elevatorTune?: ElevatorTune;
  /** The elevator worked out for this throw. */
  recommended?: ElevatorTune | null;
  /** True while the plane flies with an elevator tried by hand rather than the recommended one. */
  ownElevator?: boolean;
  /** A try of the pupil's own, never kept with the plane. */
  onElevatorTune?(patch: Partial<ElevatorTune>): void;
  onUseRecommended?(): void;
  /** "다시 계산" pressed: the recommendations are worked out again for the throw as it now is. */
  onRecompute?(): void;
  /** Of 70, 80 and 90 degrees, the throw angle it flies longest at; null until worked out. */
  recommendedAngle?: number | null;
}

/*
 * How hard, by who is throwing. Nobody has timed children throwing paper
 * aeroplanes, but their overarm ball throws have been measured year by year
 * (boys gain about 1.5 m/s a year to year 2, then 1.5 to 2.4 m/s a year to
 * year 7; girls less), and a paper aeroplane leaves the hand at about the
 * hand's speed. The fastest paper aeroplane ever thrown by hand left at
 * 25.8 m/s (Guinness, 2012), which is where a national-team thrower is.
 */
const THROWS = [
  // Standing height too, m (Korean growth charts, ages about 8, 11, 14 and grown): it sets how high the hand lets go.
  { label: '초등 1~3', speed: 10, stature: 1.28 },
  { label: '초등 4~6', speed: 14, stature: 1.46 },
  { label: '중학생', speed: 17, stature: 1.62 },
  { label: '고등학생·어른', speed: 20, stature: 1.70 },
] as const;

/*
 * Where it is thrown, not the wind speed: indoors the air only drifts a
 * little from throw to throw; outside a light breeze (about 2 m/s, into the
 * throw) blows and gusts. Rising air is left out - with a thermal anything
 * stays up, and that says nothing about the aeroplane.
 */
const PLACES = [
  { label: '실내 (바람 없음)', headwind: 0, gust: 1 },
  { label: '야외 (약한 바람)', headwind: 2, gust: 2.5 },
] as const;

/*
 * Always held on its side, as long-flight throwers hold it. Overhand lets go
 * behind the head, above it; underhand in front of the face, lower - and is
 * the one for a low ceiling, where the power is easier to hold back.
 */
const GRIPS = [
  // Where the hand lets go, as a share of the thrower's height: above the head, or in front of the face.
  { label: '오버핸드', grip: 'over', share: 2.2 / 1.7 },
  { label: '언더핸드', grip: 'under', share: 1.5 / 1.7 },
] as const;

/*
 * How high the hand lets go, m. It was the same 2.2 m for a seven-year-old as
 * for a grown-up; a child's hand is half a metre lower, and half a second of
 * glide goes with it. The grown-up's overhand stays at 2.2 m, the card's throw.
 */
function releaseHeight(speed: number, grip: 'over' | 'under'): number {
  const who = THROWS.reduce((a, t) => (Math.abs(t.speed - speed) < Math.abs(a.speed - speed) ? t : a), THROWS[THROWS.length - 1]!);
  const g = GRIPS.find((x) => x.grip === grip) ?? GRIPS[0]!;
  return Math.round(who.stature * g.share * 100) / 100;
}

function Choice<T>({ items, value, pick, label, same }: {
  items: readonly T[]; value: number; pick(t: T): void;
  label(t: T): string; same(t: T, v: number): boolean;
}) {
  return (
    <div className="flight-choices">
      {items.map((t) => (
        <button key={label(t)} className={same(t, value) ? 'on' : ''} onClick={() => pick(t)}>
          {label(t)}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step, onChange }: {
  value: number; min: number; max: number; step: number; onChange(v: number): void;
}) {
  return (
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))} />
  );
}

/** The flight from the side, to scale, with the ground and a metre grid. */
function PathChart({ flight, height, others = [], grip = 'over' }: {
  flight: Flight; height: number; others?: readonly Flight['path'][]; grip?: 'over' | 'under';
}) {
  const W = 560;
  const H = 220;
  const pad = 26;
  const xs = flight.path.map((p) => p.x);
  const end = flight.path[flight.path.length - 1]!;
  // Which way it went: the one throwing faces that way, with room behind them.
  const dir = end.x < 0 ? -1 : 1;
  const minX = Math.min(dir > 0 ? -0.6 : -1, ...xs);
  const maxX = Math.max(dir > 0 ? 1 : 0.6, ...xs);
  const maxH = Math.max(height, flight.maxHeight, ...others.map((o) => Math.max(0, ...o.map((q) => q.h))), 1) * 1.15;
  // One scale for both, so a climb looks like a climb.
  const k = Math.min((W - 2 * pad) / (maxX - minX), (H - 2 * pad) / maxH);
  const px = (x: number) => pad + (x - minX) * k;
  const py = (h: number) => H - pad - h * k;
  const d = flight.path.map((p, i) => `${i ? 'L' : 'M'}${px(p.x).toFixed(1)},${py(p.h).toFixed(1)}`).join(' ');
  /*
   * Metre marks far enough apart to read. A tall climb shrinks the scale, and
   * a mark every metre then ran its labels into each other.
   */
  const grid = [1, 2, 5, 10, 20, 50].find((g) => g * k >= 34) ?? 100;
  const ticks: number[] = [];
  for (let m = Math.ceil(minX / grid) * grid; m <= maxX; m += grid) ticks.push(m);
  const before = flight.path[Math.max(0, flight.path.length - 4)]!;
  // The plane as it comes down: nose along its last stretch of path.
  const landAngle = (Math.atan2(-(py(end.h) - py(before.h)), px(end.x) - px(before.x)) * 180) / Math.PI;

  /*
   * The one throwing, to the same scale as the flight, facing the way it goes:
   * the hand that lets go is where the path begins - over the head for an
   * overhand throw, out in front of the face for an underhand one.
   */
  const P = (x: number, h: number) => `${px(x * dir).toFixed(1)},${py(h).toFixed(1)}`;
  const shoulder: [number, number] = [-0.12, 1.42];
  const elbow: [number, number] = grip === 'over' ? [-0.2, 1.8] : [0.05, 1.3];
  const person = (
    <g className="thrower">
      <circle cx={px(-0.12 * dir)} cy={py(1.6)} r={Math.max(2.5, 0.11 * k)} />
      <polyline points={`${P(-0.25, 0)} ${P(-0.12, 0.9)} ${P(0.05, 0)}`} />
      <line x1={px(-0.12 * dir)} y1={py(0.9)} x2={px(shoulder[0] * dir)} y2={py(shoulder[1])} />
      <polyline points={`${P(shoulder[0], shoulder[1])} ${P(elbow[0], elbow[1])} ${P(0, height)}`} />
      <polyline points={`${P(shoulder[0], shoulder[1])} ${P(-0.02, 1.1)} ${P(0.12, 1.2)}`} />
    </g>
  );
  return (
    <svg className="flight-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`옆에서 본 비행 경로, ${flight.distance.toFixed(1)}미터`}>
      {ticks.map((m) => (
        <g key={m}>
          <line x1={px(m)} x2={px(m)} y1={pad / 2} y2={H - pad} className="grid" />
          <text x={px(m)} y={H - 8} textAnchor="middle">{m}m</text>
        </g>
      ))}
      <line x1={0} x2={W} y1={py(0)} y2={py(0)} className="ground" />
      {person}
      {others.map((o, i) => (
        <path key={i} className="path faint"
          d={o.map((p, j) => `${j ? 'L' : 'M'}${px(Math.max(minX, Math.min(maxX, p.x))).toFixed(1)},${py(p.h).toFixed(1)}`).join(' ')} />
      ))}
      <path d={d} className="path" />
      {/* Where it came down: a paper plane, nose first. */}
      <g className="landing" transform={`translate(${px(end.x).toFixed(1)},${(py(0) - 5).toFixed(1)}) rotate(${(-landAngle).toFixed(1)})`}>
        <path d="M9,0 L-7,-6 L-3,0 L-7,6 Z" />
        <path d="M9,0 L-3,0" className="landing-fold" />
      </g>
    </svg>
  );
}

function Meter({ value, label, tone }: { value: number; label: string; tone: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`flight-meter ${tone}`}>
      <div className="bar"><span style={{ width: `${Math.max(4, Math.min(100, value * 100))}%` }} /></div>
      <span>{label}</span>
    </div>
  );
}

/**
 * Nothing to fly until something is folded into a wing: a sheet still flat, or
 * folded so nothing lies level, has no wing area, and every figure below it
 * would be a division by nothing.
 */
export function FlightPanel(props: Props) {
  if (!canFly(props.spec.af)) {
    return (
      <div className="flight-overlay">
        <div className="stage-title">
          날려 보기 · 오래 날리기 예측
        </div>
        <p className="flight-hint">아직 날개가 없어요. 비행기 모양으로 접은 다음 날려 보세요.</p>
      </div>
    );
  }
  return <FlightField {...props} />;
}

function FlightField({
  spec, plies, paper, settings, onSettings, shownPlies, elevatorTune, recommended,
  ownElevator, onElevatorTune, onUseRecommended, onRecompute,
  recommendedAngle,
}: Props) {
  const r = settings.region;
  const airframe = spec.af;
  const base = useMemo(() => flightBase(spec, r),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, r?.y0, r?.y1, r?.depth]);
  const report = useMemo(
    () => flightReport(base, spec, paper, settings), [base, spec, paper, settings]);
  const {
    speed, angle, height, cgInput, elevator, clips,
  } = settings;
  const grip = settings.grip ?? 'over';
  const set = (patch: Partial<FlightSettings>) => onSettings({ ...settings, ...patch });
  const setSpeed = (v: number) => set({ speed: v, height: releaseHeight(v, grip) });
  const setAngle = (v: number) => set({ angle: v });
  const setVee = (v: number) => set({ vee: v });
  const {
    bulge, af, m, launch, flight, vee, flatWing,
    balance, loading,
  } = report;
  const cm = (v: number) => (v * 100).toFixed(1);
  // Each wing's rise off the flat as the paper was folded, degrees.
  const measuredVee = (airframe.dihedral * 180) / Math.PI;
  /*
   * Two views of one plane, each with what only it shows: the throws and how
   * they are judged, or the air on the wing held still. The settings on the
   * left belong to both.
   */
  const [view, setView] = useState<'results' | 'tunnel'>('results');
  // A hundred throws: enough for the average and the usual range to settle.
  const throwsN = 100;

  /*
   * The batch: the chosen throw into ten or a hundred slightly different
   * breaths of air. Kept per aeroplane and settings, worked a slice at a time
   * so a hundred throws never freeze the page, and started a moment after the
   * last change so dragging a slider does not start a hundred of them.
   */
  /*
   * Worked out when asked. A hundred throws take a moment, and a pupil
   * adjusting three things wants to set them all and then see - so the batch
   * runs once when the screen opens, and after that on the button, with the
   * old numbers left in view and marked as not yet matching.
   */
  const key = statsKey(launch, throwsN, [vee, cgInput, clips]);
  const [asked, setAsked] = useState(key);
  const [stats, setStats] = useState<{ key: string; out: FlightStats } | null>(() => {
    const hit = cachedStats(base.bare, key);
    return hit ? { key, out: hit } : null;
  });
  const [done, setDone] = useState<number | null>(null);
  const stale = stats !== null && stats.key !== key;
  // The screen fills in a setting or two just after it opens; the first
  // batch waits for that, so it does not open already out of date.
  const keyRef = useRef(key);
  keyRef.current = key;
  useEffect(() => {
    const t = window.setTimeout(() => setAsked(keyRef.current), 400);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    const runKey = asked;
    const hit = cachedStats(base.bare, runKey);
    if (hit) { setStats({ key: runKey, out: hit }); setDone(null); return; }
    let cancelled = false;
    let timer = 0;
    const launches = throwsAround(launch, throwsN);
    const results: ThrowResult[] = [];
    // Between slices the page gets a turn through a message, not a timer:
    // browsers slow chained timers to a crawl in a tab that is not in front.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => slice();
    const slice = () => {
      if (cancelled) return;
      // As many throws as fit in a few frames' time, then let the page breathe:
      // a fixed count per slice crawls when the browser slows timers down.
      const start = performance.now();
      do {
        results.push(...runThrows(af, m, launches, results.length, results.length + 1));
      } while (results.length < throwsN && performance.now() - start < 40);
      if (results.length < throwsN) {
        setDone(results.length);
        channel.port2.postMessage(null);
      } else {
        const out = summarize(results, spec, paper);
        keepStats(base.bare, runKey, out);
        setStats({ key: runKey, out });
        setDone(null);
      }
    };
    setDone(0);
    timer = window.setTimeout(slice, 30);
    return () => { cancelled = true; window.clearTimeout(timer); channel.port1.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, base.bare]);
  const shown = stats?.out ?? null;
  // What most of the throws did, in words.
  const common = shown
    ? KIND_NAMES.map(([k]) => k).reduce((a, b) => (shown.kinds[b] > shown.kinds[a] ? b : a))
    : report.flight.kind;
  const kindText = KIND_TEXT[common];

  return (
    <div className="flight-overlay">
      <div className="subbar">
        <span className="subbar-title">날려 보기</span>
        <div className="subbar-group">
          <em>보기</em>
          <button className={view === 'results' ? 'on' : ''} onClick={() => setView('results')}>결과</button>
          <button className={view === 'tunnel' ? 'on' : ''} onClick={() => setView('tunnel')}>바람 터널</button>
        </div>
        <div className="subbar-group">
          <em>100번 던지기</em>
          <button className={stale ? 'recompute on' : 'recompute'} disabled={done !== null || (!stale && stats !== null)}
            title="바꾼 값으로 100번 다시 던져서 평균을 새로 계산해요."
            onClick={() => { setAsked(key); onRecompute?.(); }}>
            {done !== null ? `${done}/100번 던지는 중…` : '↻ 조정한 값으로 다시 계산'}
          </button>
        </div>
      </div>
      <div className="flight-body">
        <section className="flight-inputs">
          <h3>던지는 힘</h3>
          <Choice items={THROWS} value={speed} pick={(t) => setSpeed(t.speed)}
            label={(t) => t.label} same={(t, v) => t.speed === v} />
          <Slider value={speed} min={2} max={20} step={0.5} onChange={setSpeed} />
          <p className="flight-value">초속 {speed}m (시속 {Math.round(speed * 3.6)}km)</p>
          <p className="flight-hint">나이별 값은 공 던지기 연구로 어림한 거예요. 사람마다 달라요.</p>

          <h3>던지는 각도</h3>
          <div className="flight-choices">
            {THROW_ANGLES.map((d) => (
              <button key={d} className={angle === d ? 'on' : ''} onClick={() => setAngle(d)}>
                {d}°{recommendedAngle === d ? ' (추천)' : ''}
              </button>
            ))}
          </div>
          <p className="flight-hint">
            {recommendedAngle
              ? `이 비행기는 ${recommendedAngle}°로 던질 때 가장 오래 날아요.`
              : '가장 오래 나는 각도를 찾는 중이에요…'}
          </p>

          <h3>던지기 자세</h3>
          <div className="flight-choices">
            {GRIPS.map((g) => (
              <button key={g.grip} className={grip === g.grip ? 'on' : ''}
                onClick={() => set({ grip: g.grip, bank: 90, height: releaseHeight(speed, g.grip) })}>{g.label}</button>
            ))}
          </div>
          <p className="flight-hint">
            비행기를 옆으로 세워 잡고 던져요. 올라가면서 옆으로 돌다가 꼭대기에서 수평이 돼요.
            {grip === 'over'
              ? ' 오버핸드는 머리 뒤를 지날 때 놓아요. 힘이 세서 밖에서 높이 올리기 좋아요.'
              : ' 언더핸드는 얼굴 앞을 지날 때 놓아요. 천장이 낮은 실내에서 힘 조절하기 쉬워요.'}
          </p>

          <h3>장소</h3>
          <div className="flight-choices">
            {PLACES.map((w) => (
              <button key={w.label} className={(settings.gust ?? 1) === w.gust ? 'on' : ''}
                onClick={() => set({ headwind: w.headwind, crosswind: 0, updraft: 0, gust: w.gust })}>{w.label}</button>
            ))}
          </div>
          <p className="flight-hint">
            {(settings.gust ?? 1) === 1
              ? '실내에서도 공기가 조금씩 움직여서, 던질 때마다 조금씩 달라요.'
              : '앞에서 초속 2m쯤 바람이 불고, 던질 때마다 바람 세기가 달라요. 바람을 정면이 아니라 45° 비껴서 던지면 좋아요.'}
          </p>

          <h3>엘리베이터</h3>
          {/*
            * Not a setting: the elevator is the one worked out for this throw,
            * shown so the pupil can bend the paper to match it.
            */}
          <p className="flight-hint">
            엘리베이터: 날개 뒤끝을 살짝 휘어 올리거나 내린 곳이에요. 접는 게 아니라 종이가 둥글게 휘어요.
          </p>
          {recommended && (
            <div className="flight-recommend">
              <p>
                <b>추천 엘리베이터</b> · 가운데에서 {recommended.fromCm}cm · 가로 {recommended.widthCm}cm ·{' '}
                {recommended.angleDeg > 0 ? `올림 ${recommended.angleDeg}°` : recommended.angleDeg < 0 ? `내림 ${-recommended.angleDeg}°` : '평평'}
                {recommended.angleDeg !== 0 && ` (뒤끝 ${Math.abs(elevatorRiseMm(recommended)).toFixed(1)}mm)`}
              </p>
              <p className="flight-hint">
                {ownElevator
                  ? '지금은 직접 바꾼 값으로 날려요. 바꾼 값은 비행기에 저장되지 않아요.'
                  : '가장 오래 나는 값이에요. 던지는 힘을 바꾸고 ‘다시 계산’을 누르면 추천도 다시 찾아요.'}
              </p>
              {ownElevator && onUseRecommended && (
                <button className="primary flight-recommend-use" onClick={onUseRecommended}>추천값으로 돌아가기</button>
              )}
            </div>
          )}
          {/*
            * Tried by hand: where on the trailing edge, how wide, how deep, and
            * how far it is bent - the wind tunnel shows it at once, the throws
            * when '다시 계산' is pressed.
            */}
          {elevatorTune && onElevatorTune && (
            <div className="flight-elevator">
              {([
                ['fromCm', '가운데에서', 0, 10], ['widthCm', '가로', 0.3, 8], ['depthCm', '세로', 0.2, 3],
              ] as const).map(([k, label, lo, hi]) => (
                <label key={k}>{label}
                  <input type="number" className="flight-cg" min={lo} max={hi} step={0.1}
                    value={elevatorTune[k]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) onElevatorTune({ [k]: Math.min(hi, Math.max(lo, v)) });
                    }} />cm
                </label>
              ))}
            </div>
          )}
          <Slider value={elevator} min={-30} max={30} step={0.5} onChange={(v) => set({ elevator: v })} />
          <p className="flight-value">
            {elevator > 0 ? `올림 ${elevator}°` : elevator < 0 ? `내림 ${-elevator}°` : '평평'}
            {elevatorTune && elevator !== 0 && ` · 뒤끝 ${Math.abs(elevatorRiseMm({ ...elevatorTune, angleDeg: elevator })).toFixed(1)}mm`}
          </p>
          <p className="flight-hint">날개 V자 각도: 두 날개를 평평하게 편 것을 0°로 보고, 양쪽 날개가 위로 올라간 각도를 더한 거예요.</p>
          <Slider value={vee * 2} min={-20} max={60} step={2} onChange={(v) => setVee(v / 2)} />
          <p className="flight-value">
            {vee >= 0 ? `날개 V자 ${vee * 2}°` : `날개가 아래로 ${-vee * 2}° 처짐`}
            {' · '}접은 모양 그대로는 {Math.round(measuredVee * 2)}°
          </p>
          {flatWing && (
            <p className="flight-hint">접은 모양은 날개가 평평해요. 날리기 전에 보통 날개를 V자로 30°쯤 올리니까 30°로 시작해요.</p>
          )}
          {bulge.side !== 0 && (
            <p className="flight-hint">
              {bulge.side > 0
                ? '코 윗부분이 볼록해요. 빠르게 올라갈 때 코가 들리기 쉬운데, 추천 엘리베이터가 그만큼 맞춰 줘요.'
                : '코 아랫부분이 볼록해요. 빠르게 올라갈 때 코가 숙여지기 쉬운데, 추천 엘리베이터가 그만큼 맞춰 줘요.'}
            </p>
          )}
        </section>

        {view === 'tunnel' ? (
          <section className="flight-results flight-tunnel-view">
            <WindTunnel af={af} m={m} drawPlies={shownPlies ?? plies}
              elevatorDeg={elevator} vee={vee} flight={shown?.nearMean ?? null} />
          </section>
        ) : (
        <section className="flight-results">
          <div className="flight-throws">
              <p className="flight-hint">
                {(settings.gust ?? 1) === 1 ? '실내' : '야외'}에서 {throwsN}번 던진 결과예요.
                {stale && done === null && <b className="stale"> · 값을 바꿨어요. 위의 ‘다시 계산’을 누르면 새 값으로 계산해요.</b>}
                {done !== null && <b className="computing"> · {done}/{throwsN}번 던지는 중…</b>}
              </p>
              <PathChart flight={shown?.typical ?? flight} height={height} others={shown?.others ?? []} grip={grip} />
              {shown ? (
                <>
                  <div className="flight-big">
                    <div className="lead">
                      <b>{shown.time.low >= 89.9 ? '90초 넘게' : `${shown.time.mean.toFixed(1)}초`}</b>
                      <span>{shown.time.best >= 89.9
                        ? `${shown.n}번 중 ${shown.capped}번은 90초 넘게 떠 있어요 (상승 기류를 탔어요)`
                        : `${shown.n}번 던진 평균 · 보통 ${shown.time.low.toFixed(1)}~${shown.time.high.toFixed(1)}초 · 가장 좋았던 ${shown.time.best.toFixed(1)}초`}</span>
                    </div>
                    <div><b>{shown.height.mean.toFixed(1)}m</b><span>평균 가장 높이 · 보통 {shown.height.low.toFixed(1)}~{shown.height.high.toFixed(1)}m</span></div>
                    <div><b>{shown.distance.mean.toFixed(1)}m</b><span>평균 던진 곳에서 떨어진 곳까지</span></div>
                  </div>
                  <div className="flight-kind">
                    <strong>{kindText.title}</strong>
                    <span>
                      {shown.n}번 중 {KIND_NAMES.filter(([k]) => shown.kinds[k] > 0)
                        .map(([k, name]) => `${name} ${shown.kinds[k]}번`).join(', ')}
                    </span>
                    <span>{kindText.tip}</span>
                  </div>
                  {shown.height.high > 13 && (
                    <p className="flight-hint">체육관 천장은 보통 15m쯤이에요. 실내라면 천장에 닿지 않게 조금 약하게 던져요.</p>
                  )}
                </>
              ) : <p className="flight-hint">던지는 중…</p>}
          </div>

          <h3>비행기 정보</h3>
          <dl className="flight-facts">
            <dt>무게</dt><dd>{(af.mass.mass * 1000).toFixed(1)}g</dd>
            <dt>무게중심</dt><dd>코끝에서 {cm(af.cgFromNose)}cm · 길이 {cm(af.length)}cm</dd>
            <dt>균형점</dt><dd>코끝에서 {cm(m.neutralFromNose)}cm</dd>
            <dt>날개 넓이</dt><dd>{(af.wingArea * 1e4).toFixed(0)}cm² · 폭 {cm(af.span)}cm</dd>
            <dt>날개가 버티는 무게</dt><dd>100cm²마다 {loading.toFixed(2)}g</dd>
            <dt>코 두께</dt><dd>{(spec.summary.noseThickness * 1000).toFixed(1)}mm{report.bulge.side > 0 ? ' · 날개 위로 볼록' : report.bulge.side < 0 ? ' · 날개 아래로 볼록' : ''}</dd>
            <dt>동체 깊이</dt><dd>{cm(spec.summary.keelDepth)}cm</dd>
            {spec.panels.length > 1 && <dt>날개 꺾임</dt>}
            {spec.panels.length > 1 && <dd>{spec.panels.map((p) => `${cm(p.from)}~${cm(p.to)}cm ${p.angleDeg}°`).join(' · ')}</dd>}
            {flight.trimSpeed && <dt>혼자 날 때 속도</dt>}
            {flight.trimSpeed && <dd>초속 {flight.trimSpeed.toFixed(1)}m · 1m 내려갈 때 {flight.glideRatio!.toFixed(1)}m 앞으로</dd>}
          </dl>

          <h3>비행 평가 (오래 날리기 · {shown ? `${shown.n}번 던진 결과` : '계산 중'})</h3>
          {/* Only the hundred throws' grades, the ones the card shows: one throw is scored another way. */}
          {!shown && <p className="flight-hint">100번 던지는 중이에요. 끝나면 점수를 보여 줘요.</p>}
          <div className="flight-grades">
            {(shown ? [...shown.grades, balanceGrade(report.margin)] : []).map((g) => (
              <div key={g.key} className={`grade ${g.score >= 70 ? 'good' : g.score >= 40 ? 'warn' : 'bad'}`} title={g.hint}>
                <div className="grade-head"><b>{g.label}</b><span>{(g.score / 10).toFixed(1)}<small>/10</small></span></div>
                <div className="bar"><span style={{ width: `${Math.max(3, g.score)}%` }} /></div>
                <p>{g.value}</p>
                <p className="grade-hint">{g.hint}</p>
              </div>
            ))}
          </div>
          <h3>안정성</h3>
          <div className="flight-stability">
            <div><h4>앞뒤 균형</h4>
              <Meter value={balance.tone === 'good' ? 0.85 : balance.tone === 'warn' ? 0.5 : 0.2}
                tone={balance.tone} label={balance.text} /></div>
          </div>

          <p className="flight-note">
            접은 모양으로 계산한 예측이에요. 실제로는 접는 솜씨, 종이가 휜 정도, 던지는 손에 따라 달라져요.
          </p>
        </section>
        )}
      </div>
    </div>
  );
}
