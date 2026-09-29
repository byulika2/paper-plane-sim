import { ALL_PLIES } from '../geometry/fold.js';
import { isFold } from './foldSession.js';
import type { FoldStep, Step } from './foldSession.js';
import { PlyPicker } from './PlyPicker.js';
import { SENSES } from './senses.js';
import { ScrubNumber } from './ScrubNumber.js';

interface Props {
  index: number;
  step: Step;
  /** Plies in the stack just before this step ran. */
  layerCount: number;
  onUpdate: (index: number, patch: Partial<FoldStep>) => void;
  /** Move a measured span's far end so it reads the given length, in millimetres. */
  onResize: (index: number, mm: number) => void;
  /** Add this fold's mirror image about the centre line, when it has one. */
  onMirror?: () => void;
  onDelete: (index: number) => void;
  onClose: () => void;
}

/**
 * Properties of one step, editable after the fact.
 *
 * The whole session is a replayable script, so changing a fold's angle is just
 * rewriting that entry and replaying - no undo-and-redo dance to adjust a wing.
 */
export function StepInspector({
  index, step, layerCount, onUpdate, onResize, onMirror, onDelete, onClose,
}: Props) {
  const fold = isFold(step) ? step : null;
  const angle = fold?.angleDeg ?? 180;
  const spanCm = step.kind === 'dimension'
    ? Math.hypot(step.b[0] - step.a[0], step.b[1] - step.a[1]) * 100
    : 0;

  return (
    <section className="inspector">
      <h2>
        {index + 1}단계 · {step.kind === 'dimension' ? '치수' : fold?.creaseOnly ? '기준선' : '접기'}
        <button className="ghost" onClick={onClose}>닫기</button>
      </h2>
      <p className="step-label">{step.label}</p>

      {step.kind === 'dimension' && (
        /*
         * A measured span, after the fact.
         *
         * Changing the number moves the far end along the line it was drawn on,
         * keeping where it started and which way it points. That is what you
         * want when the measurement was the plan - "make this 4cm" - rather
         * than a record of something already there.
         */
        <>
          <label>
            길이
            <span className="with-unit">
              <ScrubNumber value={spanCm} places={1} step={0.025} min={0.1} max={100}
                onChange={(v) => onResize(index, v * 10)}
                title="치수 길이 · 드래그로 조절" />
              <em>cm</em>
            </span>
          </label>
          <p className="note">
            끝점이 그은 방향 그대로 움직입니다. 시작점과 방향은 그대로입니다.
            양 끝점은 접을 때 기준점으로 쓰입니다.
          </p>
        </>
      )}

      {fold && onMirror && (
        <button className="crease-btn" onClick={onMirror}
          title="중심선 기준 거울상을 새 단계로 추가합니다.">
          ⇔ 반대쪽도 접기
        </button>
      )}

      {fold && !fold.creaseOnly && (
        <>
          <label>
            접는 각도
            <ScrubNumber value={angle} places={0} step={0.5} min={0} max={180}
              onChange={(v) => onUpdate(index, { angleDeg: v })}
              title="접는 각도 · 드래그로 조절" />
            <input
              type="range" min={0} max={180} step={5} value={angle}
              onChange={(e) => onUpdate(index, { angleDeg: Number(e.target.value) })}
            />
          </label>
          <div className="presets">
            {[180, 135, 90, 45].map((d) => (
              <button key={d} className={angle === d ? 'on' : ''}
                onClick={() => onUpdate(index, { angleDeg: d })}>
                {d}°
              </button>
            ))}
          </div>
          <div className="sense-toggle">
            {SENSES.map((e) => (
              <button key={e.id} title={e.hint} className={fold.sense === e.id ? 'on' : ''}
                onClick={() => onUpdate(index, { sense: e.id })}>
                {e.mark} {e.name}
              </button>
            ))}
          </div>
          <label>겹 선택</label>
          <PlyPicker
            value={fold.plies ?? ALL_PLIES}
            onChange={(v) => onUpdate(index, { plies: v.kind === 'all' ? undefined : v })}
            layerCount={layerCount}
          />
          <label className="row-check">
            <input
              type="checkbox" checked={fold.symmetric ?? false}
              onChange={(e) => onUpdate(index, { symmetric: e.target.checked || undefined })}
            />
            좌우 대칭으로 접기
          </label>
          <label className="row-check">
            <input
              type="checkbox" checked={fold.creaseOnly}
              onChange={(e) => onUpdate(index, { creaseOnly: e.target.checked })}
            />
            접지 않고 자국만 남기기
          </label>
        </>
      )}

      {fold?.creaseOnly && (
        <label className="row-check">
          <input
            type="checkbox" checked
            onChange={() => onUpdate(index, { creaseOnly: false })}
          />
          접지 않고 자국만 남기기
        </label>
      )}

      <button className="danger" onClick={() => onDelete(index)}>이 단계 삭제</button>
      <p className="note">
        뒤 단계는 이 결과 위에 다시 계산됩니다. 각도만 바꾸면 그 뒤는 그대로
        따라옵니다.
      </p>
    </section>
  );
}
