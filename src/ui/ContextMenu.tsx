/**
 * A right-click menu on the model.
 *
 * What you want to do to a crease is nearly always one of four things, and
 * going to the panel on the far side of the window for each of them is the kind
 * of friction that makes people stop trying things. The menu opens where the
 * pointer already is.
 */

import { useEffect, useRef } from 'react';

export interface MenuItem {
  readonly label: string;
  readonly hint?: string;
  readonly danger?: boolean;
  readonly separator?: boolean;
  run(): void;
}

interface Props {
  at: { x: number; y: number };
  items: readonly MenuItem[];
  onClose(): void;
}

export function ContextMenu({ at, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // A tick's delay, or the click that opened the menu closes it again.
    const id = setTimeout(() => window.addEventListener('pointerdown', away), 0);
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  // Keep it on screen when the click was near an edge.
  const style: React.CSSProperties = {
    left: Math.min(at.x, window.innerWidth - 210),
    top: Math.min(at.y, window.innerHeight - items.length * 30 - 16),
  };

  return (
    <div className="context-menu" ref={ref} style={style}>
      {items.map((item, i) => (item.separator
        ? <hr key={i} />
        : (
          <button key={i} title={item.hint} className={item.danger ? 'danger' : ''}
            onClick={() => { item.run(); onClose(); }}>
            {item.label}
          </button>
        )))}
    </div>
  );
}
