/**
 * The controls used on every single fold, along the foot of the workspace.
 *
 * These are the things in hand while folding: which tool, how far the next fold
 * closes, whether it is mirrored, and the two moves that change nothing about
 * the script - turning the model over and opening a fold out again. They used
 * to sit in the side panel among the paper stock and the file buttons, which
 * meant the eye travelled the width of the screen between choosing an angle and
 * drawing the line it applies to. They belong under the model.
 *
 * Which way the fold goes is NOT here. It used to be, with the same four
 * buttons the fold chooser carries, and two buttons reading "앞으로" that do
 * different things depending on whether a line happens to be drawn is worse
 * than either of them alone. Direction is chosen at the moment it applies, in
 * the chooser.
 *
 * Undo and redo are not here either. They are not about the fold in hand -
 * they move through the history of every fold made - so they belong with the
 * step list, which is what that history looks like.
 */

import { useState } from 'react';
import type { Tool } from './useFoldTool.js';

const TOOLS: Array<{ id: Tool; name: string; key: string; mark: string; hint: string }> = [
  // Each named for the fold it makes, so a pupil can tell them apart by the name.
  { id: 'line', name: '선 긋고 접기', key: 'L', mark: '╱', hint: '두 점을 찍어 접는 선을 긋고, 그 선을 따라 접어요.' },
  { id: 'align', name: '맞춰 접기', key: 'A', mark: '⇥', hint: '모서리나 선을 다른 선에 맞춰 접어요. 맞출 것을 찍고, 붙일 곳을 찍어요.' },
  /*
   * 조각 접기 and 모아 접기 are no longer offered: a piece is chosen with the
   * ply picker, and a squash comes up by itself as a pocket when a fold needs
   * one. Steps they made still replay - the book's collapses among them.
   */
];
/* Tools that fold nothing: looking and measuring, kept apart from the folds. */
const LOOK: Array<{ id: Tool; name: string; key: string; mark: string; hint: string }> = [
  { id: 'select', name: '선택', key: 'V', mark: '⌖', hint: '접는 선이나 치수를 골라요. 종이를 끌어서 돌려 보는 것도 이 도구로 해요.' },
  { id: 'measure', name: '길이 재기', key: 'D', mark: '↔', hint: '두 점 사이 길이를 재고, 찍은 점을 표시로 남겨요.' },
];

interface Props {
  tool: Tool;
  onTool(t: Tool): void;
  /** What the align tool's last click aims at: a line, or a corner. */
  grab: 'point' | 'edge';
  onGrab(g: 'point' | 'edge'): void;
  onFlip(): void;
  onUnfold(): void;
  canUnfold: boolean;
  onRefold(): void;
  canRefold: boolean;
  symmetric: boolean;
  onSymmetric(v: boolean): void;
}

export function WorkBar({
  tool, onTool, grab, onGrab,
  onFlip, onUnfold, canUnfold, onRefold, canRefold,
  symmetric, onSymmetric,
}: Props) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="workbar">
      <div className="workbar-group tools">
        {LOOK.map((t) => (
          <button key={t.id} title={`${t.name} · ${t.hint} (${t.key})`}
            className={tool === t.id ? 'on' : ''} onClick={() => { setAsking(false); onTool(t.id); }}>
            <b>{t.mark}</b>{t.name}
          </button>
        ))}
      </div>
      <span className="workbar-sep" />
      <div className="workbar-group tools">
        {TOOLS.map((t) => (
          <span key={t.id} className="tool-slot">
            <button title={`${t.name} · ${t.hint} (${t.key})`}
              className={tool === t.id ? 'on' : ''}
              onClick={() => { onTool(t.id); setAsking(t.id === 'align'); }}>
              <b>{t.mark}</b>{t.name}{t.id === 'align' && tool === 'align' ? (grab === 'edge' ? ' · 선에' : ' · 점에') : ''}
            </button>
            {/*
              * What the align tool's last click aims at, asked the moment it
              * is picked: a corner and the lines that end at it sit in the same
              * place and build different creases, so it is a question, not a
              * guess.
              */}
            {t.id === 'align' && asking && tool === 'align' && (
              <div className="tool-pop" role="dialog">
                <p>어디에 맞춰 접을까요?</p>
                <button className={grab === 'edge' ? 'on' : ''} onClick={() => { onGrab('edge'); setAsking(false); }}
                  title="변이나 자국의 선에 눕힙니다. 각의 이등분선이 나옵니다.">╱ 선에 맞추기</button>
                <button className={grab === 'point' ? 'on' : ''} onClick={() => { onGrab('point'); setAsking(false); }}
                  title="모서리·기준점에 갖다 댑니다. 수직이등분선이 나옵니다.">⌾ 점에 맞추기</button>
              </div>
            )}
          </span>
        ))}
      </div>
      <span className="workbar-sep" />

      <div className="workbar-group">
        <button onClick={onFlip}
          title="종이를 뒤집습니다. 접기는 늘 앞으로 하고, 반대쪽을 접을 때 뒤집습니다.">
          ⇋ 뒤집기
        </button>
        <button onClick={onUnfold} disabled={!canUnfold}
          title="마지막으로 접은 것을 펼칩니다. 단계는 남고 자국만 남긴 상태가 됩니다.">
          ⌇ 펼치기
        </button>
        <button onClick={onRefold} disabled={!canRefold}
          title="펼쳐 둔 것을 그 자국대로 다시 접습니다.">
          ▽ 다시접기
        </button>
      </div>
      

      {/*
        * No fold angle here: it is asked with the fold, in the bar that comes
        * up once a line is drawn, where it means the fold being made.
        */}
      <span className="workbar-sep" />

      <label className="workbar-check" title="중심선 반대편에도 같은 접기를 함께 넣습니다.">
        <input type="checkbox" checked={symmetric}
          onChange={(e) => onSymmetric(e.target.checked)} />
        좌우 대칭
      </label>
    </div>
  );
}
