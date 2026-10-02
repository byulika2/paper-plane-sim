/**
 * The wind tunnel, following a flight through.
 *
 * A throw is over in a few seconds and everything in it changes at once: it
 * leaves the hand at twenty metres a second, nose into the air and on its
 * side; it slows to a crawl at the top, where the nose has to come down and
 * the wings come level; it turns, and then it glides at a walking pace. The
 * air it meets is a different air in each. So the tunnel does not hold one
 * moment: it replays one real throw of the hundred - the one whose time is
 * nearest their average - and shows, at every moment of it, the aeroplane as
 * it meets the air (its angle to it, its bank, how it is climbing or sinking),
 * the air rushing or drifting past, the lift, drag and weight, and which part
 * of the flight it is in. It is the folded model itself, drawn from its
 * plies, with the elevator bent as it is on the folding screen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Tunnel3D } from './Tunnel3D.js';
import type { Airframe } from '../aero/airframe.js';
import { fly, forcesAt } from '../aero/flight.js';
import type { AeroModel, Launch } from '../aero/flight.js';
import { KIND_NAMES, throwsAround } from './flightStats.js';
import type { RenderFace } from '../origami/space.js';
import { PHASE_COLOURS, PHASE_NAMES, PHASE_TIPS, momentAt, phaseAt } from './flightPhase.js';
import { FlightScene3D } from './FlightScene3D.js';
import type { Phase } from './flightPhase.js';

interface Props {
  af: Airframe;
  m: AeroModel;
  /** The model as drawn, the elevator bent into it. */
  drawPlies: readonly RenderFace[];
  elevatorDeg: number;
  /** Wings set in a V, degrees, drawn on the front view. */
  vee: number;
  /** The throw as it is set now: each 재생 from the start throws it once more, into air a little different each time. */
  launch: Launch;
}

const G = 9.81;
const grams = (n: number) => (n / G) * 1000;
const deg = (r: number) => (r * 180) / Math.PI;

export function WindTunnel({ af, m, drawPlies, elevatorDeg, vee, launch }: Props) {
  const de = (elevatorDeg * Math.PI) / 180;
  const weight = af.mass.mass * G;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slow, setSlow] = useState(false);
  /*
   * One throw, flown here and now with the throw as it is set: change the
   * angle and the next throw leaves at it. A new seed is new air - the same
   * little gusts and lifts the hundred are thrown into, drawn afresh - so
   * every throw goes its own way.
   */
  const [seed, setSeed] = useState(1);
  const flight = useMemo(() => fly(af, m, throwsAround(launch, 1, seed)[0]!, 0.004), [af, m, launch, seed]);
  const total = flight.time;
  /*
   * The throws made here so far, each counted once it has been watched to the
   * ground: how many, the average and the best. A new setting starts afresh.
   */
  const [log, setLog] = useState<{ key: Launch; times: number[] }>({ key: launch, times: [] });
  const times = log.key === launch ? log.times : [];
  const counted = useRef<unknown>(null);
  const playNext = useRef(false);
  const throwAgain = () => { playNext.current = true; setSeed((x) => (x * 7919 + 104729) % 2147483647 || 1); };

  // A new throw starts from the hand, flying if it was thrown to be watched.
  useEffect(() => { setT(0); setPlaying(playNext.current); playNext.current = false; }, [flight]);

  // Playing: time runs on at the flight's own pace, or a quarter of it.
  const rate = useRef(1);
  rate.current = slow ? 0.25 : 1;
  const clock = useRef(0);
  clock.current = t;
  useEffect(() => {
    if (!playing || !flight) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
      last = now;
      const next = Math.min(total, clock.current + dt * rate.current);
      setT(next);
      if (next >= total) {
        setPlaying(false);
        if (counted.current !== flight) {
          counted.current = flight;
          setLog((l) => ({ key: launch, times: [...(l.key === launch ? l.times : []), total] }));
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, flight, total, launch]);

  const moment = useMemo(() => (flight ? momentAt(flight.path, t) : null), [flight, t]);

  if (!flight || !moment) {
    return <div className="tunnel"><p className="flight-hint">100번 던지는 중이에요. 끝나면 평균에 가장 가까운 한 번을 따라가 볼 수 있어요.</p></div>;
  }

  const speed = moment.speed ?? 0;
  const alpha = moment.alpha ?? 0;
  // The path's angle runs on round a loop (360° and more); shown as it points now.
  const gamma = Math.atan2(Math.sin(moment.gamma ?? 0), Math.cos(moment.gamma ?? 0));
  const bank = Math.atan2(Math.sin(moment.bank ?? 0), Math.cos(moment.bank ?? 0));
  const lift = moment.lift ?? 0;
  const drag = moment.drag ?? 0;
  const f = forcesAt(af, m, alpha, Math.max(0.3, speed), de);
  const phase = phaseAt(flight, moment);
  const pitchWord = Math.abs(f.cm) < 0.004 ? '거의 없어요'
    : `${f.cm > 0 ? '머리를 드는' : '머리를 숙이는'} 힘이 ${Math.abs(f.cm) < 0.02 ? '조금' : '세게'} 있어요`;

  return (
    <div className="tunnel">

      {/* The room fills the screen; the aeroplane close up sits in its corner, the numbers above it. */}
      <div className="sim-stage">
        <FlightScene3D af={af} drawPlies={drawPlies} vee={vee} flight={flight} t={t} colours={PHASE_COLOURS} />

        <div className="sim-inset">
        {/*
          * The model in a tunnel, seen level: the air straight at it, the model
          * turning on its centre of gravity to its angle of attack as the lift
          * comes and goes. Where it is heading and how it is banked are the
          * room's to show.
          */}
        <Tunnel3D views={false} af={af} drawPlies={drawPlies} alpha={alpha} bank={0} gamma={0} airSpeed={speed}
          vee={vee} cl={f.cl} stalled={f.stalled}
          lift={Math.max(0, lift)} drag={drag} weight={weight} cm={f.cm}
          labels={{
            lift: `양력 ${grams(lift).toFixed(1)}g`,
            drag: `항력 ${grams(drag).toFixed(1)}g`,
            weight: `무게 ${grams(weight).toFixed(1)}g`,
          }} />
        </div>

        <div className="sim-facts">
        <dl className="tunnel-facts sim-record">
          <dt>이번 비행</dt><dd>{KIND_NAMES.find(([k]) => k === flight.kind)?.[1] ?? ''}</dd>
          <dt>체공 시간</dt><dd>{total.toFixed(1)}초</dd>
          <dt>가장 높이</dt><dd>{flight.maxHeight.toFixed(1)}m</dd>
          <dt>날아간 거리</dt><dd>{Math.abs(flight.distance).toFixed(1)}m{flight.distance < 0 ? " (돌아서 뒤쪽)" : ""}</dd>
          {times.length > 0 && <dt>던진 기록</dt>}
          {times.length > 0 && (
            <dd>{times.length}번 · 평균 {(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1)}초 · 최고 {Math.max(...times).toFixed(1)}초</dd>
          )}
        </dl>
        <dl className="tunnel-facts">
          <dt>높이</dt><dd>{moment.h.toFixed(1)}m</dd>
          <dt>바람 (비행 속도)</dt><dd>초속 {speed.toFixed(1)}m · 시속 {Math.round(speed * 3.6)}km</dd>
          <dt>날개 각도 (받음각)</dt><dd>{deg(alpha).toFixed(1)}°</dd>
          <dt>{gamma >= 0 ? '올라가는 각도' : '내려가는 각도'}</dt><dd>{Math.abs(deg(gamma)).toFixed(0)}°{Math.abs(deg(gamma)) > 90 ? ' (뒤집혀 돌아요 · 루프)' : ''}</dd>
          <dt>옆으로 기운 각도</dt><dd>{Math.abs(deg(bank)).toFixed(0)}°{Math.abs(deg(bank)) > 60 ? ' (옆으로 누워 있어요)' : ''}</dd>
          {/* Banked and turning, the circle it flies: 2 V^2 / (g tan bank). */}
          <dt>도는 원 지름</dt><dd>{Math.abs(bank) > 0.03 && Math.abs(bank) < 1.4 && speed > 0.5 ? `${((2 * speed * speed) / (G * Math.tan(Math.abs(bank)))).toFixed(0)}m · ${bank > 0 ? '왼쪽' : '오른쪽'}으로` : '곧게 날아요'}</dd>
          <dt>양력</dt><dd>{grams(lift).toFixed(1)}g · 비행기 무게의 {(lift / weight).toFixed(1)}배</dd>
          <dt>항력 (공기 저항)</dt><dd>{grams(drag).toFixed(2)}g</dd>
          <dt>머리 움직임</dt><dd>{pitchWord}</dd>
          <dt>실속</dt><dd>{Math.abs(alpha) > m.stall ? '날개 위 공기가 떨어져 나가요 (실속)' : '공기가 날개를 잘 따라 흘러요'}</dd>
        </dl>
        </div>
      </div>

      <div className="tunnel-controls">
        <div className="tunnel-legend">
          {(Object.keys(PHASE_NAMES) as Phase[]).map((k) => (
            <span key={k} className={k === phase ? 'now' : ''} title={PHASE_TIPS[k]}><i style={{ background: PHASE_COLOURS[k] }} />{PHASE_NAMES[k]}</span>
          ))}
        </div>
        <div className="tunnel-player">
          <div className="flight-choices">
            <button onClick={() => {
              if (playing) { setPlaying(false); return; }
              // From the start, or run out: throw it again. Paused part way: go on.
              if (t <= 0 || t >= total) throwAgain(); else setPlaying(true);
            }}>{playing ? '❚❚ 멈춤' : t > 0 && t < total ? '▶ 이어서' : '✈ 던지기'}</button>
            <button onClick={throwAgain}>↻ 새로 던지기</button>
            <button className={slow ? 'on' : ''} onClick={() => setSlow(!slow)}>느리게 (¼배)</button>
            <button onClick={() => { setPlaying(false); setT(0); }}>처음으로</button>
          </div>
          <span className="tunnel-time"><b>{t.toFixed(1)}초</b> / {total.toFixed(1)}초</span>
          <input type="range" min={0} max={total} step={0.02} value={t} aria-label="시간"
            onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
        </div>
      </div>
    </div>
  );
}
