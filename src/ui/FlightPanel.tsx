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
import { ELEVATOR, ELEVATOR_STEPS, bendElevator, elevatorRiseMm } from './elevator.js';
import type { ElevatorTune } from './elevator.js';
import { KIND_TEXT, balanceGrade, canFly, flightBase, flightReport } from './flightReport.js';
import type { FlightSettings } from './flightReport.js';
import { RUDDER } from '../aero/flight.js';
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
  /** The elevator it flies with: flat until one is applied in the simulator. */
  elevatorTune?: ElevatorTune;
  /** The elevator worked out for this throw. */
  recommended?: ElevatorTune | null;
  /** A try of the pupil's own, never kept with the plane. */
  onElevatorTune?(patch: Partial<ElevatorTune>): void;
  /** "다시 계산" pressed: the recommendations are worked out again for the throw as it now is. */
  onRecompute?(): void;
  /** Of 70, 80 and 90 degrees, the throw angle it flies longest at; null until worked out. */
  recommendedAngle?: number | null;
  /** The plane's name, at the head of its results. */
  planeName?: string;
  /** The tuning it flies longest with (see bestTuning): what 추천 튜닝 sets. */
  bestTune?: { angle: number; elevator: number; vee: number } | null;
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
 * How high the hand lets go, m: overhand, behind the head and above it, at
 * 2.2/1.7 of the thrower's height. It was the same 2.2 m for a seven-year-old
 * as for a grown-up; a child's hand is half a metre lower, and half a second
 * of glide goes with it. The grown-up's stays at 2.2 m, the card's throw.
 */
const OVERHAND = 2.2 / 1.7;
function releaseHeight(speed: number): number {
  const who = THROWS.reduce((a, t) => (Math.abs(t.speed - speed) < Math.abs(a.speed - speed) ? t : a), THROWS[THROWS.length - 1]!);
  return Math.round(who.stature * OVERHAND * 100) / 100;
}

/*
 * The winglets' back edges, bent sideways by so many millimetres over their
 * last centimetre (RUDDER): left negative, right positive.
 */
const RUDDER_STEPS = [-2, -1, -0.5, 0, 0.5, 1, 2] as const;
const rudderDeg = (mm: number) => (Math.atan(mm / (RUDDER * 1000)) * 180) / Math.PI;
const rudderWord = (deg: number) => {
  const mm = Math.tan((deg * Math.PI) / 180) * RUDDER * 1000;
  return Math.abs(mm) < 0.05 ? '곧게' : `뒤끝 ${Math.abs(mm).toFixed(1)}mm ${mm > 0 ? '오른쪽' : '왼쪽'}`;
};

const turnWord = (deg: number) => (deg > 0 ? `올림 ${deg}°` : deg < 0 ? `내림 ${-deg}°` : '평평');

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

/** A slider with its start, middle and end written under it. */
function Slider({ value, min, max, step, onChange, marks }: {
  value: number; min: number; max: number; step: number; onChange(v: number): void;
  marks?: readonly [string, string, string];
}) {
  return (
    <div className="flight-slider">
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))} />
      {marks && <div className="flight-marks">{marks.map((m) => <span key={m}>{m}</span>)}</div>}
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
  onElevatorTune, onRecompute,
  recommendedAngle, planeName, bestTune,
}: Props) {
  const r = settings.region;
  const airframe = spec.af;
  const base = useMemo(() => flightBase(spec, r),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, r?.y0, r?.y1, r?.depth]);
  /*
   * The numbers are the throw as it is set: the screen opens at the plane's
   * best tuning (bestTuning), so they are the card's until the pupil changes
   * something and applies it.
   */
  const report = useMemo(
    () => flightReport(base, spec, paper, settings), [base, spec, paper, settings]);
  const {
    speed, angle, cgInput, elevator, clips,
  } = settings;
  const {
    af, m, launch, flight, vee,
    loading,
  } = report;
  const cm = (v: number) => (v * 100).toFixed(1);
  // Each wing's rise off the flat as the paper was folded, degrees.
  const measuredVee = (airframe.dihedral * 180) / Math.PI;
  /*
   * Everything on the simulator's side is set first and flown on '적용하기':
   * a throw is not worked out again for every step of a slider. The previews
   * follow the settings at once - they only draw the paper.
   */
  const applied = useMemo(() => ({
    speed, angle, gust: settings.gust ?? 1, headwind: settings.headwind, elevator,
    vee: Math.round(vee), rudder: settings.rudder ?? 0,
  }), [speed, angle, settings.gust, settings.headwind, elevator, vee, settings.rudder]);
  const [draft, setDraft] = useState(applied);
  const appliedKey = JSON.stringify(applied);
  // Follows what is applied - the screen settling a value as it opens, or an apply - but never over an edit not yet applied.
  const lastApplied = useRef(appliedKey);
  useEffect(() => {
    const was = lastApplied.current;
    lastApplied.current = appliedKey;
    setDraft((d) => (JSON.stringify(d) === was ? applied : d));
  }, [appliedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== appliedKey;
  const edit = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  // Its size is fixed (see ELEVATOR); only the angle is the pupil's.
  const draftTune: ElevatorTune = { ...ELEVATOR, angleDeg: draft.elevator };
  const draftPlies = useMemo(() => bendElevator(plies, spec.af, draftTune),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plies, spec.af, draft.elevator]);
  // The recommended tuning, as the draft would hold it; and whether it is what is flying now.
  const tuned: { elevator: number; angle?: number; vee?: number } | null = bestTune
    ? { elevator: bestTune.elevator, angle: bestTune.angle, vee: bestTune.vee }
    : recommended ? { elevator: recommended.angleDeg, ...(recommendedAngle ? { angle: recommendedAngle } : {}) } : null;
  const tunedNow = !!tuned && !dirty && draft.elevator === tuned.elevator && (tuned.angle === undefined || draft.angle === tuned.angle)
    && (tuned.vee === undefined || draft.vee === tuned.vee) && draft.rudder === 0;
  const applyDraft = (patch: Partial<typeof draft> = {}) => {
    const next = { ...draft, ...patch };
    if (Object.keys(patch).length) setDraft(next);
    if (elevatorTune && (elevatorTune.fromCm !== ELEVATOR.fromCm || elevatorTune.widthCm !== ELEVATOR.widthCm || elevatorTune.depthCm !== ELEVATOR.depthCm)) {
      onElevatorTune?.({ ...ELEVATOR });
    }
    onSettings({
      ...settings, speed: next.speed, height: releaseHeight(next.speed), angle: next.angle,
      headwind: next.headwind, crosswind: 0, updraft: 0, gust: next.gust, elevator: next.elevator, vee: next.vee,
      // Always thrown with the wings level.
      bank: 0, rudder: next.rudder,
    });
  };
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
          <h3>던지는 힘 <span className="flight-value">초속 {draft.speed}m</span></h3>
          <Choice items={THROWS} value={draft.speed} pick={(t) => edit({ speed: t.speed })}
            label={(t) => t.label} same={(t, v) => t.speed === v} />
          <Slider value={draft.speed} min={2} max={20} step={0.5} marks={['2m', '11m', '20m']} onChange={(v) => edit({ speed: v })} />

          <h3>던지는 각도 <span className="flight-value">{draft.angle}°{recommendedAngle === draft.angle ? ' (추천)' : ''}</span>
            {recommendedAngle && recommendedAngle !== draft.angle && (
              <button className="link" onClick={() => edit({ angle: recommendedAngle })}>추천 {recommendedAngle}°</button>
            )}
          </h3>
          <Slider value={draft.angle} min={30} max={90} step={10} marks={['30°', '60°', '90°']} onChange={(v) => edit({ angle: v })} />

          <h3>장소</h3>
          <div className="flight-choices">
            {PLACES.map((w) => (
              <button key={w.label} className={draft.gust === w.gust ? 'on' : ''}
                onClick={() => edit({ headwind: w.headwind, gust: w.gust })}>{w.label}</button>
            ))}
          </div>

          <h3>엘리베이터 <span className="flight-value">{turnWord(draft.elevator)}{draft.elevator !== 0 && ` · 뒤끝 ${Math.abs(elevatorRiseMm(draftTune)).toFixed(1)}mm`}</span>
            {recommended && recommended.angleDeg !== draft.elevator && (
              <button className="link" onClick={() => edit({ elevator: recommended.angleDeg })}>추천 {turnWord(recommended.angleDeg)}</button>
            )}
          </h3>
          <p className="flight-value">가운데 뒤끝에서 날개 쪽으로 {ELEVATOR.widthCm}cm · 앞쪽으로 {ELEVATOR.depthCm}cm</p>
          <PaperPreview3D af={spec.af} plies={draftPlies} vee={draft.vee} focus="elevator" region={draftTune}
            caption={turnWord(draft.elevator)} />
          {/* Picked, not slid: from the middle, flat, down to the left (−) and up to the right (+). */}
          <div className="flight-steps">
            {ELEVATOR_STEPS.map((d) => (
              <button key={d} className={draft.elevator === d ? 'on' : ''} onClick={() => edit({ elevator: d })}>
                {d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0'}
              </button>
            ))}
          </div>
          <div className="flight-marks"><span>− 내림</span><span>평평</span><span>올림 +</span></div>

          {/*
            * How the guide sets a plane circling: both winglets' back edges
            * bent the same way, a little - it turns the way they are bent.
            */}
          <h3>윙렛 꺾기 <span className="flight-value">{rudderWord(draft.rudder)}</span></h3>
          <div className="flight-steps">
            {RUDDER_STEPS.map((mm) => {
              const deg = rudderDeg(mm);
              return (
                <button key={mm} className={Math.abs(draft.rudder - deg) < 1e-6 ? 'on' : ''} onClick={() => edit({ rudder: deg })}>
                  {mm === 0 ? '0' : mm > 0 ? `+${mm}` : `−${-mm}`}
                </button>
              );
            })}
          </div>
          <div className="flight-marks"><span>− 왼쪽으로 (mm)</span><span>곧게</span><span>오른쪽으로 +</span></div>

          <h3>날개 각도 <span className="flight-value">수평에서 {Math.abs(draft.vee)}° {draft.vee >= 0 ? '위' : '아래'}</span>
            {Math.round(measuredVee) !== draft.vee && (
              <button className="link" onClick={() => edit({ vee: Math.round(measuredVee) })}>접은 그대로 {Math.round(measuredVee)}°</button>
            )}
          </h3>
          <PaperPreview3D af={spec.af} plies={draftPlies} vee={draft.vee} focus="wings"
            caption={`수평에서 ${Math.abs(draft.vee)}° ${draft.vee >= 0 ? '위' : '아래'}`} />
          <Slider value={draft.vee} min={-10} max={30} step={1} marks={['아래 10°', '위 10°', '위 30°']} onChange={(v) => edit({ vee: v })} />

          {/*
            * The tuning worked out for this throw - the elevator that keeps it
            * up longest, and the angle that goes with it - set and flown in one go.
            */}
          {tuned && (
            <button className="flight-apply-tuning" disabled={tunedNow} onClick={() => applyDraft({ ...tuned, rudder: 0 })}>
              {tunedNow ? '추천 튜닝 적용됨' : '추천 튜닝 적용하기'}
              <small>엘리베이터 {turnWord(tuned.elevator)}{tuned.angle !== undefined ? ` · 던지는 각도 ${tuned.angle}°` : ''}{tuned.vee !== undefined ? ` · 날개 ${tuned.vee}°` : ''}</small>
            </button>
          )}
          <button className="primary flight-apply-all" disabled={!dirty} onClick={() => applyDraft()}>
            {dirty ? '적용하기' : '적용됨'}
          </button>
        </section>}

        {view === 'tunnel' ? (
          <section className="flight-results flight-tunnel-view">
            <WindTunnel af={report.af} m={report.m} drawPlies={shownPlies ?? plies}
              elevatorDeg={elevator} vee={vee} launch={report.launch} />
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
