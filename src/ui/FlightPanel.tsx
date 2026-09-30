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
import type { RenderFace } from '../origami/space.js';
import type { PaperProps } from '../paper/stock.js';
import { elevatorRiseMm } from './elevator.js';
import type { ElevatorTune } from './elevator.js';
import { KIND_TEXT, balanceGrade, canFly, flightBase, flightReport } from './flightReport.js';
import type { FlightSettings } from './flightReport.js';
import {
  KIND_NAMES, cachedStats, keepStats, runThrows, statsKey, summarize, throwsAround,
} from './flightStats.js';
import type { FlightStats, ThrowResult } from './flightStats.js';
import { WindTunnel } from './WindTunnel.js';
import { PaperPreview3D } from './PaperPreview3D.js';
import { StatSheet } from './StatSheet.js';

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
  /** The plane's name, at the head of its results. */
  planeName?: string;
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
  recommendedAngle, planeName,
}: Props) {
  const r = settings.region;
  const airframe = spec.af;
  const base = useMemo(() => flightBase(spec, r),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, r?.y0, r?.y1, r?.depth]);
  const report = useMemo(
    () => flightReport(base, spec, paper, settings), [base, spec, paper, settings]);
  const {
    speed, angle, cgInput, elevator, clips,
  } = settings;
  const grip = settings.grip ?? 'over';
  const set = (patch: Partial<FlightSettings>) => onSettings({ ...settings, ...patch });
  const setSpeed = (v: number) => set({ speed: v, height: releaseHeight(v, grip) });
  const setAngle = (v: number) => set({ angle: v });
  const setVee = (v: number) => set({ vee: v });
  const {
    bulge, af, m, launch, flight, vee, flatWing,
    loading,
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
          <button className={view === 'tunnel' ? 'on' : ''} onClick={() => setView('tunnel')}>시뮬레이터</button>
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
        {/* The throw and the tuning belong to the simulator; the results page is the stat screen alone. */}
        {view === 'tunnel' && <section className="flight-inputs">
          <h3>던지는 힘</h3>
          <Choice items={THROWS} value={speed} pick={(t) => setSpeed(t.speed)}
            label={(t) => t.label} same={(t, v) => t.speed === v} />
          <Slider value={speed} min={2} max={20} step={0.5} onChange={setSpeed} />
          <p className="flight-value">초속 {speed}m (시속 {Math.round(speed * 3.6)}km)</p>
          <p className="flight-hint">나이별 값은 공 던지기 연구로 어림한 거예요. 사람마다 달라요.</p>

          <h3>던지는 각도</h3>
          <Slider value={angle} min={30} max={90} step={10} onChange={setAngle} />
          <p className="flight-value">
            {angle}°{recommendedAngle === angle ? ' (추천)' : ''}
            {recommendedAngle && recommendedAngle !== angle && (
              <button className="link" onClick={() => setAngle(recommendedAngle)}>추천 {recommendedAngle}°로</button>
            )}
          </p>
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
          {recommended && (
            <div className="flight-recommend">
              <p>
                <b>추천 엘리베이터</b> · 가운데에서 {recommended.fromCm}cm · 가로 {recommended.widthCm}cm ·{' '}
                {recommended.angleDeg > 0 ? `올림 ${recommended.angleDeg}°` : recommended.angleDeg < 0 ? `내림 ${-recommended.angleDeg}°` : '평평'}
                {recommended.angleDeg !== 0 && ` (뒤끝 ${Math.abs(elevatorRiseMm(recommended)).toFixed(1)}mm)`}
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
          {/* The real paper's trailing edge, from behind, bent as it is set. */}
          <PaperPreview3D af={spec.af} plies={shownPlies ?? plies} vee={vee} focus="elevator" region={elevatorTune} />
          <Slider value={elevator} min={-30} max={30} step={0.5} onChange={(v) => set({ elevator: v })} />
          <p className="flight-value">
            {elevator > 0 ? `올림 ${elevator}°` : elevator < 0 ? `내림 ${-elevator}°` : '평평'}
            {elevatorTune && elevator !== 0 && ` · 뒤끝 ${Math.abs(elevatorRiseMm({ ...elevatorTune, angleDeg: elevator })).toFixed(1)}mm`}
          </p>
          <p className="flight-hint">날개 V자 각도: 두 날개를 평평하게 편 것을 0°로 보고, 양쪽 날개가 위로 올라간 각도를 더한 거예요.</p>
          {/* The whole aeroplane from behind, its wings in the V set. */}
          <PaperPreview3D af={spec.af} plies={shownPlies ?? plies} vee={vee} focus="wings" />
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
        </section>}

        {view === 'tunnel' ? (
          <section className="flight-results flight-tunnel-view">
            <WindTunnel af={af} m={m} drawPlies={shownPlies ?? plies}
              elevatorDeg={elevator} vee={vee} launch={launch} />
          </section>
        ) : (
        <section className="flight-results">
          <div className="flight-throws">
              {/* The flight itself is seen in the simulator; here only the numbers, and what is still being worked out. */}
              {((stale && done === null) || done !== null) && (
                <p className="flight-hint">
                  {stale && done === null && <b className="stale">값을 바꿨어요. 위의 ‘다시 계산’을 누르면 새 값으로 계산해요.</b>}
                  {done !== null && <b className="computing">{done}/{throwsN}번 던지는 중…</b>}
                </p>
              )}
              {shown ? (
                <StatSheet name={planeName ?? ''} grades={[...shown.grades, balanceGrade(report.margin)]}
                  time={shown.time} height={shown.height.mean} distance={shown.distance.mean}
                  kind={kindText}
                  kinds={`${shown.n}번 중 ${KIND_NAMES.filter(([k]) => shown.kinds[k] > 0).map(([k, name]) => `${name} ${shown.kinds[k]}번`).join(', ')}`}
                  facts={(
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
                  )} />
              ) : <p className="flight-hint">100번 던지는 중이에요. 끝나면 능력치를 보여 줘요.</p>}
              {shown && shown.height.high > 13 && (
                <p className="flight-hint">체육관 천장은 보통 15m쯤이에요. 실내라면 천장에 닿지 않게 조금 약하게 던져요.</p>
              )}
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
