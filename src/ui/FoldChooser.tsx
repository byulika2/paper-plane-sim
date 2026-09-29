/**
 * What to do with the line that has just been drawn.
 *
 * Not which way to fold it - paper only folds forward, so pointing at the half
 * that travels says everything, and that click is the fold. What is left here
 * are the things that are genuinely different operations rather than
 * directions: press the crease and open it again, or pleat; and the numbers,
 * so the line can be placed exactly before any of them is chosen.
 */

import { ALL_PLIES } from '../geometry/fold.js';
import type { PlySelection } from '../geometry/fold.js';
import { ScrubNumber } from './ScrubNumber.js';
import type { FoldTool } from './useFoldTool.js';

interface Props {
  fold: FoldTool;
  angleDeg: number;
  onAngleChange(deg: number): void;
  /** Which plies the fold takes, and how many there are to take. */
  ply?: PlySelection;
  onPly?(v: PlySelection): void;
  layers?: number;
}

export function FoldChooser({ fold, angleDeg, onAngleChange, ply, onPly, layers = 1 }: Props) {
  const { pending } = fold;
  const commit = fold.commitFold();
  if (pending?.t !== 'side') return null;
  const counts = Array.from({ length: Math.max(0, layers - 1) }, (_, i) => i + 1);
  return (
    <div className="fold-chooser">
      <span className="chooser-note">{pending.note}</span>
      {/*
        * Paper lying on paper: the top sheet alone and the whole stack fold
        * differently, so the fold asks - right where it is being made - rather
        * than leaving it to a setting at the far side of the window.
        */}
      {ply && onPly && layers > 1 && (
        <span className="chooser-plies" role="group" aria-label="접을 겹">
          <em>몇 겹 ({layers}겹 중)</em>
          {counts.map((n) => (
            <button key={n} className={ply.kind === 'stack' && ply.count === n ? 'on' : ''}
              onClick={() => onPly({ kind: 'stack', count: n })}
              title={`위에서부터 ${n}겹만 접어요.`}>{n}겹</button>
          ))}
          <button className={ply.kind === 'all' ? 'on' : ''} onClick={() => onPly(ALL_PLIES)}
            title="겹쳐 있는 종이를 모두 함께 접어요.">전체</button>
        </span>
      )}
      {/*
        * When the construction already said which half travels, there is
        * nothing left to point at - so it is a button, not a place on the
        * paper you have to guess at.
        */}
      {commit && (
        <button className="on" onClick={commit} title="작도가 정한 그대로 접습니다.">
          ▽ 접기
        </button>
      )}
      {/* Neither of these moves paper over, so neither can tuck it in. */}
      <button onClick={fold.commitCrease} disabled={fold.tuck || !!fold.reverse}
        title={fold.tuck || fold.reverse ? '넣기·뒤집기를 끄면 쓸 수 있어요.' : '접었다가 다시 펴서 자국만 남겨요.'}>⌇ 접었다 펴기</button>
      <button onClick={fold.commitPleat} disabled={fold.tuck || !!fold.reverse}
        title={fold.tuck || fold.reverse ? '넣기·뒤집기를 끄면 쓸 수 있어요.' : '접고 정해진 거리만큼 되접습니다.'}>
        ⊐ 계단 접기
      </button>
      {/*
        * A lock: the paper that folds goes in between the layers instead of
        * over the top. Switched on for one fold, then off again, since it is
        * the exception - nearly every fold lays its paper over the top.
        */}
      <button className={fold.tuck ? 'on' : ''} onClick={() => fold.setTuck(!fold.tuck)}
        title="접히는 종이를 겹 사이로 밀어 넣어요. 코끝을 잠글 때 써요. (한 번 접으면 꺼져요)">
        ↳ 안으로 넣기
      </button>
      {/*
        * Reverse folds, for a flap already folded in half - a tail, a nose.
        * Both halves turn together about the line, in between or round.
        */}
      <button className={fold.reverse === 'inside' ? 'on' : ''}
        onClick={() => fold.setReverse(fold.reverse === 'inside' ? null : 'inside')}
        title="반 접힌 끝(꼬리·코)을 두 겹 사이로 뒤집어 넣어요. (한 번 접으면 꺼져요)">
        ⤵ 안으로 뒤집기
      </button>
      <button className={fold.reverse === 'outside' ? 'on' : ''}
        onClick={() => fold.setReverse(fold.reverse === 'outside' ? null : 'outside')}
        title="반 접힌 끝을 바깥으로 뒤집어 감싸요. (한 번 접으면 꺼져요)">
        ⤴ 밖으로 뒤집기
      </button>
      {fold.reading && (
        /*
         * Snapping gets the line onto the paper's own features; this is for the
         * times when the answer is a number rather than a feature, and landing
         * on 14.7 where 15.0 was meant is the whole of the problem.
         *
         * A fold is usually parallel to something already on the sheet, and
         * then its distance from that is the number worth typing. When it is
         * parallel to nothing, its bearing is.
         */
        <span className="chooser-measure">
          {fold.reading.from ? (
            <>
              <em>{fold.reading.from}에서</em>
              <ScrubNumber
                value={fold.reading.cm} onChange={(v) => fold.moveTo(v)}
                step={0.025} places={1} title="기준선에서의 거리 (cm) · 드래그로 조절"
              />
              <em>cm</em>
            </>
          ) : (
            <>
              <em>각도</em>
              <ScrubNumber
                value={fold.reading.bearingDeg} onChange={(v) => fold.rotateTo(v)}
                step={0.25} min={0} max={180} places={1}
                title="선의 방향 (도) · 드래그로 조절"
              />
              <em>°</em>
            </>
          )}
          <em className="dim">길이 {fold.reading.lengthCm.toFixed(1)}cm</em>
          {fold.reading.from && fold.reading.offAngle && (
            <button className="link" title="기준선과 딱 나란하게 다시 놓아요."
              onClick={() => fold.moveTo(fold.reading!.cm)}>
              곧게 맞추기
            </button>
          )}
        </span>
      )}
      <span className="chooser-angle">
        <input type="range" min={0} max={180} step={5}
          value={angleDeg} onChange={(e) => onAngleChange(Number(e.target.value))} />
        <ScrubNumber value={angleDeg} onChange={onAngleChange}
          step={0.5} min={0} max={180} places={0} title="접는 각도 · 드래그로 조절" />
        <em>°</em>
      </span>
      <button onClick={fold.cancel}>취소</button>
    </div>
  );
}
