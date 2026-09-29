import { useMemo, useRef } from 'react';
import type { TaggedCrease, Dimension } from '../geometry/crease.js';
import { cm, isFold } from './foldSession.js';
import { LATEST_STYLE, LINE_ORDER, LINE_STYLES, lineKindOf, sheetKind } from './lineKinds.js';
import type { FoldGraph } from '../origami/graph.js';
import { edgeMarks, markLabel } from './edgeMarks.js';
import type { LineKind } from './lineKinds.js';
import type { Step } from './foldSession.js';
import { PAD, VIEW, mapping, zoomViewport } from './viewport.js';
import type { Viewport } from './viewport.js';

interface Props {
  sheetWidth: number;
  sheetHeight: number;
  /** Creases in original sheet coordinates. */
  creases: readonly TaggedCrease[];
  dimensions: readonly Dimension[];
  steps: readonly Step[];
  selected: number | null;
  onSelect: (step: number | null) => void;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  /** Where crease positions are measured from. */
  dimRef: 'corner' | 'centre';
  showDims: boolean;
  /** The step being shown one at a time: its new line is picked out. */
  latestStep?: number | null;
  /** The folded sheet, to read how each piece of crease is folded. */
  graph?: FoldGraph;
}


/**
 * The unfolded pattern, the way a packaging drawing shows a dieline: the whole
 * sheet at once, every crease on it, coded by which way it folds. Fold along
 * these and the model comes out - which is exactly what the folded-state view
 * cannot show you, because it hides the paper as it stacks up.
 */
export function Dieline({
  sheetWidth, sheetHeight, creases, dimensions, steps, selected, onSelect,
  viewport, onViewport, dimRef, showDims, latestStep = null, graph,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  // The dieline always shows the whole blank, so it stays centred on the sheet.
  const { scale, toPx } = mapping(viewport, sheetWidth, sheetHeight);

  // Each piece coded the way the paper is creased there, as a crease pattern draws it.
  const lines = useMemo(() => {
    const labelled = new Set<string>();
    return creases.map((c) => {
      const step = steps[c.step];
      const onSheet = graph ? sheetKind(graph, c) : null;
      const angle = onSheet && onSheet.kind !== 'crease' ? Math.round(onSheet.angle)
        : step && isFold(step) ? step.angleDeg ?? 180 : 180;
      // A crease held part way is marked once, not on every piece the other lines cut it into.
      const key = `${c.step}:${angle}`;
      const label = angle < 179.5 && !labelled.has(key);
      if (label) labelled.add(key);
      return { c, kind: onSheet?.kind ?? lineKindOf(step), angle, step: c.step, label };
    });
  }, [creases, steps, graph]);

  /**
   * Where a crease meets the edge of the blank, and how far that is along the
   * edge from the chosen reference.
   *
   * This is the number you can actually measure with a ruler before folding,
   * and it is what handwritten instructions quote.
   */
  const marks = useMemo(() => {
    if (!showDims) return [];
    // Shown step by step, only the new line is measured: that is the one to fold.
    const which = latestStep === null ? creases : creases.filter((c) => c.step === latestStep);
    return edgeMarks(which, sheetWidth, sheetHeight, dimRef);
  }, [creases, showDims, dimRef, sheetWidth, sheetHeight, latestStep]);

  // The kinds this pattern has, in the book's code (see lineKinds).
  const legend = LINE_ORDER.filter((k) => lines.some((l) => l.kind === k));
  const lineStyle = (kind: LineKind) => ({
    stroke: LINE_STYLES[kind].css,
    strokeDasharray: LINE_STYLES[kind].dash.join(' ') || undefined,
  });

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      className="dieline"
      onClick={() => onSelect(null)}
      onWheel={(e) => onViewport(zoomViewport(viewport, e.deltaY < 0 ? 1.12 : 1 / 1.12))}
    >
      <rect x={0} y={0} width={VIEW} height={VIEW} className="mat-bg" />

      {/*
        * A cutting mat under the drawing.
        *
        * This is the surface the tutorials are photographed on, and it is what
        * makes a dimension checkable without a dialog: you can count squares.
        * The grid is drawn in the paper's own coordinates, so a square is a
        * real centimetre of paper at any zoom, and the numbers along the edges
        * are the same centimetres a steel rule would give.
        */}
      <g className="mat">
        {(() => {
          const marksOut: JSX.Element[] = [];
          const cm = 0.01;
          // Cover the whole panel, not just the sheet, so the mat reads as a
          // surface the paper is lying on rather than a texture on the paper.
          const lo = toPx([0, 0]);
          const from = (v: number, px: number) => Math.floor((v - px / scale) / cm) - 1;
          const to = (v: number, px: number) => Math.ceil((v + px / scale) / cm) + 1;
          const x0 = from(0, lo[0]);
          const x1 = to(sheetWidth, VIEW - lo[0]);
          const y0 = from(0, VIEW - lo[1]);
          const y1 = to(sheetHeight, lo[1]);

          for (let i = x0; i <= x1; i++) {
            const [x] = toPx([i * cm, 0]);
            if (x < -2 || x > VIEW + 2) continue;
            marksOut.push(<line key={`v${i}`} x1={x} y1={0} x2={x} y2={VIEW}
              className={i % 5 === 0 ? 'cm5' : 'cm1'} />);
          }
          for (let j = y0; j <= y1; j++) {
            const [, y] = toPx([0, j * cm]);
            if (y < -2 || y > VIEW + 2) continue;
            marksOut.push(<line key={`h${j}`} x1={0} y1={y} x2={VIEW} y2={y}
              className={j % 5 === 0 ? 'cm5' : 'cm1'} />);
          }
          // The little crosses a real mat carries at every intersection.
          if (scale * cm > 9) {
            for (let i = x0; i <= x1; i++) {
              for (let j = y0; j <= y1; j++) {
                const [x, y] = toPx([i * cm, j * cm]);
                if (x < 0 || x > VIEW || y < 0 || y > VIEW) continue;
                if (i % 5 === 0 || j % 5 === 0) continue;
                marksOut.push(<path key={`x${i}_${j}`} className="cross"
                  d={`M${x - 2.5} ${y}h5M${x} ${y - 2.5}v5`} />);
              }
            }
          }
          return marksOut;
        })()}
      </g>

      {/* Centimetre numbers along the top and left, as on the mat itself. */}
      <g className="mat-numbers">
        {(() => {
          const out: JSX.Element[] = [];
          const cm = 0.01;
          const step = scale * cm > 16 ? 1 : 5;
          for (let i = 0; i * cm <= sheetWidth + 1e-9; i += step) {
            const [x] = toPx([i * cm, sheetHeight]);
            if (x < PAD || x > VIEW - 4) continue;
            out.push(<text key={`nx${i}`} x={x} y={12} textAnchor="middle">{i}</text>);
          }
          for (let j = 0; j * cm <= sheetHeight + 1e-9; j += step) {
            const [, y] = toPx([0, j * cm]);
            if (y < 14 || y > VIEW - 4) continue;
            out.push(<text key={`ny${j}`} x={4} y={y + 3}>{j}</text>);
          }
          return out;
        })()}
      </g>

      {/* The outline of the blank. The paper is folded along the lines inside it,
          never cut. */}
      <rect
        x={toPx([0, sheetHeight])[0]} y={toPx([0, sheetHeight])[1]}
        width={sheetWidth * scale} height={sheetHeight * scale}
        className="cut-line"
      />

      {lines.map(({ c, kind, angle, step, label }, i) => {
        const [ax, ay] = toPx(c.a);
        const [bx, by] = toPx(c.b);
        const on = selected === step;
        return (
          <g key={i} className={`fold-line ${kind}${on ? ' selected' : ''}`}
            onClick={(e) => { e.stopPropagation(); onSelect(step); }}>
            <line x1={ax} y1={ay} x2={bx} y2={by} className="hit" />
            {latestStep === step && (
              <line x1={ax} y1={ay} x2={bx} y2={by} className="latest-line"
                style={{ stroke: LATEST_STYLE.css, strokeWidth: 5, opacity: 0.7 }} />
            )}
            <line x1={ax} y1={ay} x2={bx} y2={by} style={lineStyle(kind)} />
            {kind !== 'crease' && label && (
              <text x={(ax + bx) / 2} y={(ay + by) / 2 - 5} textAnchor="middle" className="fold-angle">
                {angle}°
              </text>
            )}
          </g>
        );
      })}

      {marks.map((m, i) => {
        const [x, y] = toPx(m.p);
        const out = 13;
        const at: [number, number] =
          m.side === 'top' ? [x, y - out] :
          m.side === 'bottom' ? [x, y + out + 4] :
          m.side === 'left' ? [x - out, y] : [x + out, y];
        return (
          <g key={`m${i}`} className="edge-mark">
            <circle cx={x} cy={y} r={2.2} />
            <line x1={x} y1={y} x2={at[0]} y2={at[1]} />
            <text x={at[0]} y={at[1] + (m.side === 'top' ? -3 : m.side === 'bottom' ? 8 : 3)}
              textAnchor={m.side === 'left' ? 'end' : m.side === 'right' ? 'start' : 'middle'}>
              {markLabel(m, dimRef)}
            </text>
          </g>
        );
      })}

      {dimensions.map((d, i) => {
        const [ax, ay] = toPx(d.a);
        const [bx, by] = toPx(d.b);
        const span = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
        return (
          <g key={`d${i}`} className="dim">
            <line x1={ax} y1={ay} x2={bx} y2={by}
              markerStart="url(#dlArrow)" markerEnd="url(#dlArrow)" />
            <circle cx={ax} cy={ay} r={2.4} className="dim-dot" />
            <circle cx={bx} cy={by} r={2.4} className="dim-dot" />
            <text x={(ax + bx) / 2} y={(ay + by) / 2 - 6} textAnchor="middle" className="dim-label">
              {cm(span)}
            </text>
          </g>
        );
      })}

      <defs>
        <marker id="dlArrow" viewBox="0 0 10 10" refX="9" refY="5"
          markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 1 L 10 5 L 0 9 z" />
        </marker>
      </defs>

      <g className="legend"
        transform={`translate(${PAD}, ${VIEW - 16 - (legend.length + (latestStep !== null ? 1 : 0)) * 15})`}>
        {legend.map((kind, i) => (
          <g key={kind} transform={`translate(0, ${i * 15})`}>
            <line x1={0} y1={0} x2={26} y2={0} className="fold-line" style={lineStyle(kind)} />
            <text x={33} y={3.5} className="legend-label">
              {LINE_STYLES[kind].label} · {LINE_STYLES[kind].hint}
            </text>
          </g>
        ))}
        {latestStep !== null && (
          <g transform={`translate(0, ${legend.length * 15})`}>
            <line x1={0} y1={0} x2={26} y2={0} style={{ stroke: LATEST_STYLE.css, strokeWidth: 3.2 }} />
            <text x={33} y={3.5} className="legend-label">{LATEST_STYLE.label} · 이 단계에서 새로 생긴 선</text>
          </g>
        )}
      </g>

      <text x={VIEW - 10} y={VIEW - 10} textAnchor="end" className="hud dim">
        {creases.length}개 접는 선 · 그대로 접으면 완성
      </text>
    </svg>
  );
}
