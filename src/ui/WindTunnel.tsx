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
import { forcesAt } from '../aero/flight.js';
import type { AeroModel, Flight } from '../aero/flight.js';
import type { RenderFace } from '../origami/space.js';
import { PHASE_COLOURS, PHASE_NAMES, PHASE_TIPS, phaseAt, pointAt } from './flightPhase.js';
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
  /** The throw to follow; null while the hundred are still being thrown. */
  flight: Flight | null;
}

const G = 9.81;
const grams = (n: number) => (n / G) * 1000;
const deg = (r: number) => (r * 180) / Math.PI;

export function WindTunnel({ af, m, drawPlies, elevatorDeg, vee, flight }: Props) {
  const de = (elevatorDeg * Math.PI) / 180;
  const weight = af.mass.mass * G;
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [slow, setSlow] = useState(false);
  const total = flight?.time ?? 0;

  // A new throw starts from the hand.
  useEffect(() => { setT(0); setPlaying(false); }, [flight]);

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
      if (next >= total) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, flight, total]);

  const moment = useMemo(() => (flight ? pointAt(flight.path, t) : null), [flight, t]);

  if (!flight || !moment) {
    return <div className="tunnel"><p className="flight-hint">100번 던지는 중이에요. 끝나면 평균에 가장 가까운 한 번을 따라가 볼 수 있어요.</p></div>;
  }

  const speed = moment.speed ?? 0;
  const alpha = moment.alpha ?? 0;
  const gamma = moment.gamma ?? 0;
  const bank = moment.bank ?? 0;
  const lift = moment.lift ?? 0;
  const drag = moment.drag ?? 0;
  const f = forcesAt(af, m, alpha, Math.max(0.3, speed), de);
  const phase = phaseAt(flight, moment);
  const pitchWord = Math.abs(f.cm) < 0.004 ? '거의 없어요'
    : `${f.cm > 0 ? '머리를 드는' : '머리를 숙이는'} 힘이 ${Math.abs(f.cm) < 0.02 ? '조금' : '세게'} 있어요`;

  /*
   * Height against time, the moment marked on it. Against distance, a throw
   * that climbs in a spiral and turns as it glides doubled back over itself
   * and could not be read.
   */
  const pts = flight.path;
  const maxH = Math.max(1, ...pts.map((p) => p.h));
  const W = 320; const H = 150; const pad = 8;
  const sx = (time: number) => pad + (time / (total || 1)) * (W - 2 * pad);
  const sy = (h: number) => H - pad - (h / maxH) * (H - 2 * pad);
  const colour = PHASE_COLOURS;
  const segments: { phase: Phase; d: string }[] = [];
  for (let i = 1; i < pts.length; i++) {
    const ph = phaseAt(flight, pts[i]!);
    const seg = `L${sx(pts[i]!.t).toFixed(1)},${sy(pts[i]!.h).toFixed(1)}`;
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg.phase === ph) lastSeg.d += seg;
    else segments.push({ phase: ph, d: `M${sx(pts[i - 1]!.t).toFixed(1)},${sy(pts[i - 1]!.h).toFixed(1)}${seg}` });
  }

  return (
    <div className="tunnel">
      <div className="tunnel-controls">
        <div className="tunnel-phase" style={{ borderColor: colour[phase] }}>
          <b style={{ color: colour[phase] }}>{PHASE_NAMES[phase]}</b>
          <span>{PHASE_TIPS[phase]}</span>
        </div>
        <div className="flight-choices">
          <button onClick={() => { if (t >= total) setT(0); setPlaying(!playing); }}>{playing ? '❚❚ 멈춤' : '▶ 재생'}</button>
          <button className={slow ? 'on' : ''} onClick={() => setSlow(!slow)}>느리게 (¼배)</button>
          <button onClick={() => { setPlaying(false); setT(0); }}>처음으로</button>
        </div>
        <label>
          시간 <b>{t.toFixed(1)}초</b> / {total.toFixed(1)}초
          <input type="range" min={0} max={total} step={0.02} value={t}
            onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} />
        </label>
        <svg className="tunnel-path" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="시간에 따른 높이">
          <line x1={0} y1={sy(0)} x2={W} y2={sy(0)} stroke="#334155" />
          {segments.map((s, i) => <path key={i} d={s.d} fill="none" stroke={colour[s.phase]} strokeWidth={2} />)}
          <circle cx={sx(t)} cy={sy(moment.h)} r={5} fill="#fff" stroke="#0f172a" strokeWidth={2} />
        </svg>
        <div className="tunnel-legend">
          {(Object.keys(PHASE_NAMES) as Phase[]).map((k) => (
            <span key={k}><i style={{ background: colour[k] }} />{PHASE_NAMES[k]}</span>
          ))}
        </div>
      </div>

      <FlightScene3D af={af} drawPlies={drawPlies} vee={vee} flight={flight} t={t} colours={PHASE_COLOURS} />

      <Tunnel3D af={af} drawPlies={drawPlies} alpha={alpha} bank={bank} gamma={gamma} airSpeed={speed}
        vee={vee} cl={f.cl} stalled={f.stalled}
        lift={Math.max(0, lift)} drag={drag} weight={weight} cm={f.cm}
        labels={{
          lift: `양력 ${grams(lift).toFixed(1)}g`,
          drag: `항력 ${grams(drag).toFixed(1)}g`,
          weight: `무게 ${grams(weight).toFixed(1)}g`,
        }} />

      <dl className="tunnel-facts">
        <dt>높이</dt><dd>{moment.h.toFixed(1)}m</dd>
        <dt>바람 (비행 속도)</dt><dd>초속 {speed.toFixed(1)}m · 시속 {Math.round(speed * 3.6)}km</dd>
        <dt>날개 각도 (받음각)</dt><dd>{deg(alpha).toFixed(1)}°</dd>
        <dt>{gamma >= 0 ? '올라가는 각도' : '내려가는 각도'}</dt><dd>{Math.abs(deg(gamma)).toFixed(0)}°</dd>
        <dt>옆으로 기운 각도</dt><dd>{Math.abs(deg(bank)).toFixed(0)}°{Math.abs(deg(bank)) > 60 ? ' (옆으로 누워 있어요)' : ''}</dd>
        <dt>양력</dt><dd>{grams(lift).toFixed(1)}g · 비행기 무게의 {(lift / weight).toFixed(1)}배</dd>
        <dt>항력 (공기 저항)</dt><dd>{grams(drag).toFixed(2)}g</dd>
        <dt>머리 움직임</dt><dd>{pitchWord}</dd>
        <dt>실속</dt><dd>{Math.abs(alpha) > m.stall ? '날개 위 공기가 떨어져 나가요 (실속)' : '공기가 날개를 잘 따라 흘러요'}</dd>
      </dl>
    </div>
  );
}
