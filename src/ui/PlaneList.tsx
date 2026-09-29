/**
 * The list screen: which aeroplane to fold.
 *
 * The folding screen had grown the list into its left panel, between the
 * paper settings and the preset folds, where it competed with everything else
 * on screen. Choosing a plane is the first thing anyone does and the thing a
 * pupil comes back to, so it has a screen of its own: the book's planes, each
 * with a walk-through from a blank sheet, the planes kept in this browser, and
 * a blank sheet to start from.
 */

import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { sameName } from './planeLibrary.js';
import type { SavedPlane } from './planeLibrary.js';
import {
  bookRecord, cardShape, whenIdle,
} from './planeCard.js';
import { cardFlightLater } from './flightJobs.js';
import type { CardFlight, CardShape, PlaneRecord } from './planeCard.js';

/*
 * The top of a card: the finished aeroplane as it flies, and what it does.
 * Worked out from the plane's record when the card is shown - the picture
 * first, which is quick, then a few throws - never stored.
 */
function PlaneFace({ record, file, scores = true, head, foot }: { record?: PlaneRecord; file?: string; scores?: boolean; head?: ReactNode; foot?: ReactNode }) {
  const [rec, setRec] = useState<PlaneRecord | null>(record ?? null);
  const [shape, setShape] = useState<CardShape | null | undefined>(undefined);
  const [flight, setFlight] = useState<CardFlight | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    if (record) setRec(record);
    else if (file) void bookRecord(file).then((r) => { if (live) setRec(r); }).catch(() => { if (live) setShape(null); });
    return () => { live = false; };
  }, [record, file]);
  useEffect(() => {
    if (!rec) return;
    let live = true;
    void whenIdle(() => cardShape(rec, scores)).then((sh) => { if (live) setShape(sh); }).catch(() => { if (live) setShape(null); });
    if (scores) void cardFlightLater(rec).then((f) => { if (live) setFlight(f); }).catch(() => { if (live) setFlight(null); });
    return () => { live = false; };
  }, [rec, scores]);
  return (
    <>
    <div className="list-card-top">
      {/* Left: the plane, its name and its buttons together; right: its pentagon. */}
      <div className="list-card-left">
      {/* The name over the picture, the paper under it where the name was. */}
      {head}
      <div className="list-card-picture">
        {shape ? (
          <svg viewBox={shape.viewBox} role="img" aria-label="접은 비행기 모양">
            {/* The paper's edges show; creases lying flat inside a face do not. */}
            {shape.faces.map((f, i) => (
              <g key={i}>
                <path d={f.d} fill={f.fill} stroke={f.fill} strokeWidth={1} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                {f.edge && <path d={f.edge} fill="none" stroke="#5b6b80" strokeWidth={0.6} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
              </g>
            ))}
          </svg>
        ) : <span>{shape === null ? '아직 모양이 없어요' : '그리는 중…'}</span>}
      </div>
      {/* Its line kept from the start, filled in when the record has come. */}
      <span className="list-card-paper">{rec ? `${rec.gsm}g/m² 종이` : '\u00a0'}</span>
      {foot}
      </div>
      {/* A plane still being folded is not judged yet. */}
      {scores ? <div className="list-card-flight">
        {flight === undefined ? <span className="dim">계산 중…</span>
          : flight === null ? <span className="dim">아직 날개가 없어요</span>
            : (
              <Pentagon grades={flight.grades} height={flight.height} />
            )}
      </div> : null}
    </div>
    </>
  );
}

/*
 * The five ratings as a pentagon: each corner one of them, the filled shape
 * reaching out as far as the score. A plane strong at climbing and weak at
 * gliding looks it at a glance, and two cards compare side by side.
 */
function Pentagon({ grades, height }: { grades: readonly { key: string; label: string; score: number; value: string }[]; height: number }) {
  const order = ['climb', 'transition', 'sink', 'strength', 'balance'];
  const names: Record<string, string> = { climb: '고도 확보', transition: '트랜지션', sink: '싱크레이트', strength: '강도', balance: '밸런스' };
  const g = order.map((k) => grades.find((x) => x.key === k)).filter(Boolean) as typeof grades[number][];
  const cx = 115; const cy = 90; const R = 66;
  const at = (i: number, r: number) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / g.length;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const ring = (f: number) => g.map((_, i) => at(i, R * f).join(',')).join(' ');
  const shape = g.map((x, i) => at(i, R * Math.max(0.04, x.score / 100)).join(',')).join(' ');
  return (
    <svg className="pentagon" viewBox="0 0 230 180" role="img"
      aria-label={g.map((x) => `${x.label} 10점 만점에 ${(x.score / 10).toFixed(1)}점`).join(', ')}>
      {[0.25, 0.5, 0.75, 1].map((f) => <polygon key={f} points={ring(f)} className="ring" />)}
      {g.map((_, i) => { const [x, y] = at(i, R); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="spoke" />; })}
      <polygon points={shape} className="fill" />
      {g.map((x, i) => {
        const [lx, ly] = at(i, R + 14);
        return (
          <text key={x.key} x={lx} y={ly - 6} textAnchor={lx < cx - 5 ? 'end' : lx > cx + 5 ? 'start' : 'middle'}
            dominantBaseline="middle">
            <title>{x.value}</title>
            {/* Two lines at each corner: what it is, then its score out of ten. */}
            <tspan x={lx} dy="0">{names[x.key]}</tspan>
            <tspan x={lx} dy="12" className="score">
              {(x.score / 10).toFixed(1)}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}


export interface BookPlane {
  readonly name: string;
  readonly file: string;
  readonly note: string;
}

interface Props {
  book: readonly BookPlane[];
  shelf: readonly SavedPlane[];
  /** Asked twice before a kept plane goes: the id waiting for the second press. */
  dropping: string | null;
  onTutorial(plane: BookPlane): void;
  onOpenBook(plane: BookPlane): void;
  onOpenShelf(plane: SavedPlane): void;
  onDropShelf(plane: SavedPlane): void;
  /** Take a book plane off the list (and the pupil's copy of it, if any). */
  onDropBook(plane: BookPlane): void;
  onNew(): void;
}

export function PlaneList({
  book, shelf, dropping, onTutorial, onOpenBook, onOpenShelf, onDropShelf, onDropBook, onNew,
}: Props) {
  /*
   * One shelf. The book's planes are the pupil's planes too: folded further,
   * one is kept under its own name and opens as the pupil left it - the last
   * fold is the record, with no second copy to go back to.
   */
  const bookNames = book.map((b) => b.name);
  const ownOnly = shelf.filter((p) => !bookNames.some((n) => sameName(n, p.name)));
  type Card = { key: string; done: boolean; node: JSX.Element };
  const cards: Card[] = [
    ...book.map((plane) => {
      const mine = shelf.find((p) => sameName(p.name, plane.name));
      const done = !mine || mine.done;
      return {
        key: plane.file, done,
        node: (
          <li key={plane.file} className={mine ? 'list-card has-mine' : 'list-card'}>
            <PlaneFace record={mine} file={mine ? undefined : plane.file} scores={done} head={(
              <div className="list-card-title">
                {plane.name}
                {!done && <span className="plane-status wip">접는 중</span>}
              </div>
            )} foot={(
            <div className="list-card-actions">
              <button className="primary" onClick={() => (mine ? onOpenShelf(mine) : onOpenBook(plane))}
                title={mine ? '내가 마지막으로 접은 모양을 열어요.' : '완성된 모양을 열어요.'}>
                {done ? '열기' : '이어 접기'}
              </button>
              <button onClick={() => onTutorial(plane)}>▶ 튜토리얼 보기</button>
              <button className={dropping === plane.file ? 'danger' : ''}
                onClick={() => onDropBook(plane)}
                title="한 번 더 누르면 목록에서 지워져요. 되돌릴 수 없어요.">
                {dropping === plane.file ? '정말 지울까요?' : '지우기'}
              </button>
            </div>
            )} />
          </li>
        ),
      };
    }),
    ...ownOnly.map((plane) => ({
      key: plane.id, done: plane.done,
      node: (
        <li key={plane.id} className="list-card has-mine">
          <PlaneFace record={plane} scores={plane.done} head={(
            <div className="list-card-title">
              {plane.name}
              {!plane.done && <span className="plane-status wip">접는 중</span>}
            </div>
          )} foot={(
          <div className="list-card-actions">
            <button className="primary" onClick={() => onOpenShelf(plane)}>{plane.done ? '열기' : '이어 접기'}</button>
            {/* A plane folded here has every step on record, so it can be followed like a book one. */}
            {plane.steps.length > 0 && (
              <button onClick={() => onTutorial({ name: plane.name, file: '', note: '' })}>▶ 튜토리얼 보기</button>
            )}
            <button className={dropping === plane.id ? 'danger' : ''}
              onClick={() => onDropShelf(plane)}
              title="한 번 더 누르면 지워져요. 되돌릴 수 없어요.">
              {dropping === plane.id ? '정말 지울까요?' : '지우기'}
            </button>
          </div>
          )} />
        </li>
      ),
    })),
  ];
  const wip = cards.filter((c) => !c.done);
  const done = cards.filter((c) => c.done);
  return (
    <div className="list-screen">
      <section className="list-section">
        <h2>완성</h2>
        <p className="list-hint">
          튜토리얼은 빈 종이부터 한 단계씩 따라 접어요. 점수는 모든 비행기를 어른이 던지는 힘(초속 20m)으로, 그 비행기에 맞춘 각도(70°·80°·90°)로 100번 던진 결과예요.
        </p>
        <ul className="list-cards">{done.map((c) => c.node)}</ul>
      </section>

      {/*
        * Everything still on the bench in one place: the planes being folded,
        * and a fresh sheet to start another - both are "folding now".
        */}
      <section className="list-section">
        <h2>접는 중</h2>
        <ul className="list-cards">
          {wip.map((c) => c.node)}
          <li className="list-card list-card-new">
            <button className="primary" onClick={onNew}>＋ 새 종이로 접기</button>
          </li>
        </ul>
      </section>
    </div>
  );
}
