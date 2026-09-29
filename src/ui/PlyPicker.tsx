import { ALL_PLIES, plyCount } from '../geometry/fold.js';
import type { PlySelection } from '../geometry/fold.js';

interface Props {
  value: PlySelection;
  onChange: (v: PlySelection) => void;
  /** How many plies the stack has right now, for the labels and the ceiling. */
  layerCount: number;
}

/**
 * Which plies the next fold carries.
 *
 * Stored as "the top n" rather than as indices, so the choice survives an edit
 * to an earlier step that changes how many plies there are.
 */
export function PlyPicker({ value, onChange, layerCount }: Props) {
  const count = value.kind === 'top' || value.kind === 'bottom' ? value.count : layerCount;
  const max = Math.max(1, layerCount);
  const covered = plyCount(value, layerCount);

  const setKind = (kind: PlySelection['kind']) => {
    if (kind === 'all') onChange(ALL_PLIES);
    else if (kind === 'side') onChange({ kind, turned: false });
    // The point is filled in by the click that names the side; until then the
    // panel only says that a piece is what is wanted.
    else if (kind === 'piece') onChange({ kind: 'piece', at: [0, 0] });
    else if (kind === 'wing') onChange({ kind: 'wing', upper: true });
    else if (kind === 'half') onChange({ kind: 'half' });
    else onChange({ kind, count: Math.min(Math.max(1, count), max) });
  };

  return (
    <div className="ply-picker">
      <div className="ply-kinds">
        {([['all', '전체'], ['top', '위에서'], ['bottom', '아래에서'],
          ['half', '반쪽 (날개)'], ['piece', '누른 곳만']] as const).map(([k, name]) => (
          <button key={k} className={value.kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {name}
          </button>
        ))}
      </div>
      {(value.kind === 'top' || value.kind === 'bottom') && (
        <span className="ply-count">
          <input
            type="number" min={1} max={max} step={1} value={count}
            onChange={(e) => onChange({
              kind: value.kind,
              count: Math.min(max, Math.max(1, Math.round(Number(e.target.value) || 1))),
            })}
          />
          <em>겹 / 전체 {layerCount}겹</em>
        </span>
      )}
      {/*
        * One side of the packet, whichever plies happen to make it up.
        *
        * A wing is this: fold a model in half and the paper that travelled is
        * turned over while the paper that stayed is not, and those are the two
        * sides. Counting from the top names the same thing only while that
        * group is contiguous, and one wing fold is enough to break that.
        */}
      {value.kind === 'side' && (
        <div className="tool-toggle">
          <button className={!value.turned ? 'on' : ''}
            onClick={() => onChange({ kind: 'side', turned: false })}>
            이쪽 면
          </button>
          <button className={value.turned ? 'on' : ''}
            onClick={() => onChange({ kind: 'side', turned: true })}>
            저쪽 면
          </button>
        </div>
      )}
      {value.kind === 'all' && covered > 1 && (
        <p className="note">{layerCount}겹 전부가 함께 넘어갑니다.</p>
      )}
      {(value.kind === 'top' || value.kind === 'bottom') && (
        <p className="note">
          나머지 {Math.max(0, layerCount - covered)}겹은 제자리에 남습니다. 스쿼시
          폴드가 이렇게 동작합니다.
        </p>
      )}
      {value.kind === 'side' && (
        <p className="note">
          반으로 접었을 때 뒤집힌 종이와 그대로인 종이로 가릅니다. 예전 방식이라
          접은 게 많은 비행기에서는 맞지 않을 수 있습니다 — 날개는 반쪽을 쓰세요.
        </p>
      )}
      {value.kind === 'piece' && (
        <p className="note">
          선을 긋고 접을 곳을 누르면, 누른 그 부분만 접혀요. 날개 끝을 한쪽씩
          세울 때 쓰세요.
        </p>
      )}
      {value.kind === 'half' && (
        <p className="note">
          반으로 접은 뭉치에서, 넘길 쪽을 누른 그 반쪽이 전부 넘어갑니다. 날개가
          이렇게 접힙니다 — 코 쪽이 동체 띠로만 이어져 있어도 함께 갑니다. 반대쪽
          날개는 뒤집은 다음 같은 식으로 접습니다.
        </p>
      )}
    </div>
  );
}
