/**
 * How to squash the pocket a fold of some sheets opened.
 *
 * Asked at the moment it arises - the fold was drawn, the sheets chosen, the
 * side clicked - with each way shown as it would come out, so the pupil picks
 * by looking, the way they would at the paper in their hands.
 */

import { useState } from 'react';
import { faceOutline } from '../origami/folding.js';
import { affineApply } from '../geometry/fold.js';
import type { Vec2 } from '../geometry/math.js';
import type { PocketOption } from '../origami/pocket.js';

type Seg = readonly [Vec2, Vec2];

/** Where a point of the sheet lies once this way is folded. */
function landed(s: PocketOption['state'], q: Vec2): Vec2 | null {
  const g = s.graph;
  for (let f = 0; f < g.faces_vertices.length; f++) {
    const poly = g.faces_vertices[f]!.map((v) => g.vertices_coords[v]!);
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!; const b = poly[j]!;
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < a[0] + ((q[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
    }
    if (inside) return affineApply(s.faces_matrix[f]!, q);
  }
  return null;
}

function Preview({ option, picked }: { option: PocketOption; picked?: { moved: Seg; target: Seg } }) {
  const s = option.state;
  const outlines = s.faces_order.map((f) => faceOutline(s, f));
  const xs = outlines.flatMap((o) => o.map((p) => p[0]));
  const ys = outlines.flatMap((o) => o.map((p) => p[1]));
  const minX = Math.min(...xs); const maxX = Math.max(...xs);
  const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const pad = Math.max(maxX - minX, maxY - minY) * 0.05;
  return (
    <svg viewBox={`${minX - pad} ${minY - pad} ${maxX - minX + 2 * pad} ${maxY - minY + 2 * pad}`} className="pocket-preview">
      {outlines.map((o, i) => (
        <path key={i} d={o.map((p, k) => `${k ? 'L' : 'M'}${p[0]},${p[1]}`).join('') + 'Z'}
          fill="rgba(226,230,240,0.92)" stroke="#5b6b80" strokeWidth={0.8} vectorEffect="non-scaling-stroke" />
      ))}
      {/* The lines picked: where the moved edge (orange) ends up, and the line it was to meet (blue). */}
      {picked && (
        <line x1={picked.target[0][0]} y1={picked.target[0][1]} x2={picked.target[1][0]} y2={picked.target[1][1]}
          stroke="#2563eb" strokeWidth={3} vectorEffect="non-scaling-stroke" />
      )}
      {picked && (() => {
        const a = landed(s, picked.moved[0]); const b = landed(s, picked.moved[1]);
        return a && b ? <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#f97316" strokeWidth={3} vectorEffect="non-scaling-stroke" /> : null;
      })()}
    </svg>
  );
}

export function PocketChooser({ options, onPick, onCancel, note, picking, onAlong, onNarrow, onShowAll, picked }: {
  options: readonly PocketOption[];
  picked?: { moved: Seg; target: Seg };
  onPick(o: PocketOption): void;
  onCancel(): void;
  note?: string;
  /** While the pupil points at the lines, the list steps aside. */
  picking: 'align' | 'line' | null;
  /** 선대로 접기: squash along a line on the paper. */
  onAlong(): void;
  /** 맞춰 접기: squash so one line lands on another. */
  onNarrow(): void;
  onShowAll(): void;
}) {
  /*
   * The two ways a pupil already folds, asked first. The shapes found without
   * being told are there too, behind a button: to look at, not to start from.
   */
  const [looking, setLooking] = useState(false);
  if (picking) {
    return (
      <div className="pocket-chooser pocket-picking" role="dialog" aria-label="접을 선 고르기">
        <p className="pocket-title">
          {picking === 'line' ? '선대로 접기: 나머지를 눌러 접을 선을 누르세요. 빨간 ✕(주머니 꼭짓점)을 지나는 선이에요.'
            : '맞춰 접기: 평소처럼 움직일 선의 두 끝을 찍고, 붙일 선을 누르세요.'}
        </p>
        <button onClick={onShowAll}>그만 고르기</button>
      </div>
    );
  }
  const showList = looking || !!note;
  return (
    <div className="pocket-chooser" role="dialog" aria-label="주머니 접기">
      <p className="pocket-title">주머니가 생겨요. 나머지를 어떻게 접을까요?</p>
      <p className="pocket-note">
        {note ?? '종이에 있는 선으로 누르려면 "선대로 접기", 선을 어디에 붙일지 정하려면 "맞춰 접기"를 고르세요.'}
      </p>
      <div className="macro-actions">
        <button className="primary" onClick={onAlong}>선대로 접기</button>
        <button className="primary" onClick={onNarrow}>⇥ 맞춰 접기</button>
      </div>
      {showList && (
        <div className="pocket-options">
          {options.map((o) => (
            <button key={o.label} className="pocket-option" onClick={() => onPick(o)} title={o.detail}>
              <Preview option={o} picked={picked} />
              <b>{o.label}</b>
              <small>{o.detail}</small>
            </button>
          ))}
        </div>
      )}
      <div className="macro-actions">
        {!showList && options.length > 0 && <button onClick={() => setLooking(true)}>모양 보고 고르기</button>}
        {note && <button onClick={() => { setLooking(true); onShowAll(); }}>모두 보기</button>}
        <button onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}
