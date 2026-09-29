/**
 * A number you can drag.
 *
 * Typing is exact and dragging is fast, and a field that only does one of them
 * makes you choose the wrong one: you type four keystrokes to try 16mm when you
 * wanted to see what 14 through 18 looked like, or you nudge a slider forever
 * trying to land on 15.0. Dragging the label scrubs the value; clicking it puts
 * the caret in so it can be typed.
 */

import { useRef, useState } from 'react';

interface Props {
  value: number;
  onChange(v: number): void;
  /** How much one pixel of drag is worth. */
  step?: number;
  min?: number;
  max?: number;
  /** Decimal places shown when not being typed into. */
  places?: number;
  title?: string;
  className?: string;
}

/** A number as written, without the "-0.0" a hair below zero rounds to. */
const shown = (v: number, places: number): string => {
  const text = v.toFixed(places);
  return Number(text) === 0 ? (0).toFixed(places) : text;
};

export function ScrubNumber({
  value, onChange, step = 0.5, min, max, places = 1, title, className,
}: Props) {
  const [typing, setTyping] = useState<string | null>(null);
  const drag = useRef<{ x: number; from: number; moved: boolean } | null>(null);

  const clamp = (v: number) =>
    Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (typing !== null) return;
    drag.current = { x: e.clientX, from: value, moved: false };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    // A couple of pixels of slop, so a click to type is not read as a drag.
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    e.preventDefault();
    // Shift is the fine adjustment, the way it is everywhere else.
    onChange(clamp(d.from + dx * step * (e.shiftKey ? 0.1 : 1)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = drag.current;
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (d && !d.moved) {
      setTyping(String(Number(value.toFixed(places + 2))));
      (e.target as HTMLInputElement).select();
    }
  };

  const commit = () => {
    if (typing === null) return;
    const v = Number(typing);
    if (Number.isFinite(v)) onChange(clamp(v));
    setTyping(null);
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      title={title ?? '드래그하면 값이 바뀝니다 · 클릭하면 입력'}
      className={`scrub${typing !== null ? ' typing' : ''}${className ? ` ${className}` : ''}`}
      value={typing ?? shown(value, places)}
      readOnly={typing === null}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onChange={(e) => setTyping(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') { setTyping(null); (e.target as HTMLInputElement).blur(); }
        else if (typing === null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          e.preventDefault();
          onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1)));
        }
      }}
    />
  );
}
