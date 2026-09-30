/**
 * The results as a game's stat screen: the plane's name and its three
 * records across the top; the pentagon with its overall letter on the left;
 * the five abilities as segmented bars with their letters on the right, and
 * under them what to work on - the weakest of the five.
 */

import type { ReactNode } from 'react';
import type { Grade } from './flightReport.js';
import { Pentagon, gradeLetter } from './Pentagon.js';

interface Props {
  name: string;
  grades: readonly Grade[];
  /** Average time aloft and its spread, s; highest and furthest, m. */
  time: { mean: number; low: number; high: number; best: number };
  height: number;
  distance: number;
  /** What kind of flight it mostly is, and how often. */
  kind: { title: string; tip: string };
  kinds: string;
  /** The plane's own facts, folded away underneath. */
  facts: ReactNode;
}

const SEGMENTS = 10;

export function StatSheet({ name, grades, time, height, distance, kind, kinds, facts }: Props) {
  const total = grades.reduce((a, g) => a + g.score, 0) / Math.max(1, grades.length);
  const weakest = [...grades].sort((a, b) => a.score - b.score)[0];
  return (
    <div className="stat-sheet">
      <header className="stat-head">
        <div className="stat-name">
          <span className={`stat-rank g-${gradeLetter(total)}`}>{gradeLetter(total)}</span>
          <b>{name || '내 비행기'}</b>
          <span className="stat-kind">{kind.title}</span>
        </div>
        <div className="stat-records">
          <div><span>⏱ 평균 비행</span><b>{time.mean.toFixed(1)}초</b><small>보통 {time.low.toFixed(1)}~{time.high.toFixed(1)}초 · 최고 {time.best.toFixed(1)}초</small></div>
          <div><span>⬆ 가장 높이</span><b>{height.toFixed(1)}m</b></div>
          <div><span>➡ 날아간 거리</span><b>{distance.toFixed(1)}m</b></div>
        </div>
      </header>

      {/* The plane itself first: what it is, then how it flies. */}
      <section className="stat-facts">
        <h4>비행기 정보</h4>
        {facts}
      </section>

      <div className="stat-body">
        <div className="stat-radar">
          <Pentagon grades={grades} height={260} letters total={total} />
          <p className="stat-total">종합 <b>{Math.round(total)}</b>점 · 등급 <b className={`g-${gradeLetter(total)}`}>{gradeLetter(total)}</b></p>
        </div>
        <ul className="stat-bars">
          {grades.map((g) => {
            const on = Math.round((g.score / 100) * SEGMENTS);
            const letter = gradeLetter(g.score);
            return (
              <li key={g.key} title={g.hint}>
                <span className="stat-label">{g.label}</span>
                <span className={`stat-letter g-${letter}`}>{letter}</span>
                <span className="stat-segs" aria-hidden>
                  {Array.from({ length: SEGMENTS }, (_, i) => <i key={i} className={i < on ? `on g-${letter}` : ''} />)}
                </span>
                <span className="stat-value">{(g.score / 10).toFixed(1)}</span>
                <small className="stat-say">{g.value}</small>
              </li>
            );
          })}
          {weakest && (
            <li className="stat-tip">
              <b>다음에 키울 능력치 · {weakest.label}</b>
              <span>{weakest.hint}</span>
            </li>
          )}
        </ul>
      </div>

      <p className="stat-kinds">{kinds} · {kind.tip}</p>

    </div>
  );
}
