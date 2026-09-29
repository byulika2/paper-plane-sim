/**
 * The wind tunnel: the aeroplane held still, the air coming at its nose.
 *
 * A throw is over in a few seconds and everything in it changes at once, so it
 * is a poor place to learn what one setting does. Here the pupil holds the
 * speed of the air and the angle of the wing, and sees the lift, the drag and
 * which way the nose is pushed - then changes the V of the wings or the
 * elevator in the panel beside it and watches the same numbers move. It is the folded model itself, drawn from its plies, with
 * the elevator bent as it is on the folding screen.
 */

import { useState } from 'react';
import { Tunnel3D } from './Tunnel3D.js';
import type { Airframe } from '../aero/airframe.js';
import { forcesAt, settleAngle, trim } from '../aero/flight.js';
import type { AeroModel } from '../aero/flight.js';
import type { RenderFace } from '../origami/space.js';

interface Props {
  af: Airframe;
  m: AeroModel;
  /** The model as drawn, the elevator bent into it. */
  drawPlies: readonly RenderFace[];
  elevatorDeg: number;
  /** Wings set in a V, degrees, drawn on the front view. */
  vee: number;
  throwSpeed: number;
}

const G = 9.81;
const grams = (n: number) => (n / G) * 1000;

export function WindTunnel({ af, m, drawPlies, elevatorDeg, vee, throwSpeed }: Props) {
  const de = (elevatorDeg * Math.PI) / 180;
  const weight = af.mass.mass * G;
  /*
   * Where it starts: the angle the nose settles at, and the speed at which
   * the wing then holds up exactly the aeroplane's weight - the glide, even
   * for an aeroplane balanced too finely to have a steady one of its own.
   */
  const glideAt = (() => {
    const t = trim(af, m, de);
    if (t) return { speed: t.speed, alpha: t.alpha };
    const st = settleAngle(af, m, de, 5);
    const a = st.alpha ?? 0.1;
    const cl = forcesAt(af, m, a, 5, de).cl;
    return cl > 0.02 ? { speed: Math.sqrt((2 * weight) / (1.225 * af.wingArea * cl)), alpha: a } : null;
  })();
  const settle = settleAngle(af, m, de, glideAt?.speed ?? 5);
  const [speed, setSpeed] = useState(() => Math.round((glideAt?.speed ?? 5) * 2) / 2);
  const [alphaDeg, setAlphaDeg] = useState(() =>
    Math.round(((settle.alpha ?? 0.07) * 180) / Math.PI));
  const alpha = (alphaDeg * Math.PI) / 180;
  const f = forcesAt(af, m, alpha, speed, de);
  const here = settleAngle(af, m, de, speed);
  const holdUp = f.cl > 0.02 ? Math.sqrt((2 * weight) / (1.225 * af.wingArea * f.cl)) : null;

  const pitchWord = Math.abs(f.cm) < 0.004 ? '거의 없어요'
    : `${f.cm > 0 ? '머리를 드는' : '머리를 숙이는'} 힘이 ${Math.abs(f.cm) < 0.02 ? '조금' : '세게'} 있어요`;

  return (
    <div className="tunnel">
      <div className="tunnel-controls">
        <label>
          바람 세기 <b>초속 {speed}m</b> <span>(시속 {Math.round(speed * 3.6)}km)</span>
          <input type="range" min={2} max={25} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} />
        </label>
        <div className="flight-choices">
          {glideAt && <button onClick={() => { setSpeed(Math.round(glideAt.speed * 2) / 2); setAlphaDeg(Math.round((glideAt.alpha * 180) / Math.PI)); }}>
            활공할 때 (초속 {glideAt.speed.toFixed(1)}m)</button>}
          <button onClick={() => setSpeed(Math.round(throwSpeed * 2) / 2)}>던질 때 (초속 {throwSpeed}m)</button>
        </div>
        <label>
          날개 각도 (받음각) <b>{alphaDeg}°</b>
          <input type="range" min={-5} max={20} step={1} value={alphaDeg} onChange={(e) => setAlphaDeg(Number(e.target.value))} />
        </label>
        {here.alpha !== null && (
          <button className="link" onClick={() => setAlphaDeg(Math.round((here.alpha! * 180) / Math.PI))}>
            코가 자리 잡는 각도로 ({((here.alpha * 180) / Math.PI).toFixed(1)}°)
          </button>
        )}
      </div>

      <Tunnel3D af={af} drawPlies={drawPlies} alpha={alpha} vee={vee} cl={f.cl} stalled={f.stalled}
        lift={Math.max(0, f.lift)} drag={f.drag} weight={weight} cm={f.cm}
        labels={{
          lift: `양력 ${grams(f.lift).toFixed(1)}g`,
          drag: `항력 ${grams(f.drag).toFixed(1)}g`,
          weight: `무게 ${grams(weight).toFixed(1)}g`,
        }} />

      <dl className="tunnel-facts">
        <dt>양력</dt>
        <dd>{grams(f.lift).toFixed(1)}g · 비행기 무게의 {(f.lift / weight).toFixed(1)}배
          {f.lift < weight * 0.95 ? ' (무게보다 작아서 내려가요)' : f.lift > weight * 1.05 ? ' (무게보다 커서 올라가요)' : ' (무게와 같아서 떠 있어요)'}</dd>
        <dt>항력 (공기 저항)</dt><dd>{grams(f.drag).toFixed(2)}g</dd>
        <dt>머리 움직임</dt><dd>{pitchWord}</dd>
        <dt>코가 자리 잡는 각도</dt>
        <dd>{here.alpha === null ? '자리 잡는 각도가 없어요'
          : `${((here.alpha * 180) / Math.PI).toFixed(1)}° · ${here.stable ? '흔들려도 돌아와요 (안정)' : '흔들리면 더 벌어져요 (불안정)'}`}</dd>
        <dt>실속</dt><dd>{f.stalled ? '날개 위 공기가 떨어져 나가요 (실속). 각도를 줄여요.' : '공기가 날개를 잘 따라 흘러요'}</dd>
        {holdUp && <><dt>이 각도로 떠 있으려면</dt><dd>바람 초속 {holdUp.toFixed(1)}m</dd></>}
      </dl>
    </div>
  );
}
