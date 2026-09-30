/**
 * The five ratings as a game's stat screen draws them.
 */

/** A score out of 100 as a letter: S, A, B, C, D or E. */
export function gradeLetter(score: number): 'S' | 'A' | 'B' | 'C' | 'D' | 'E' {
  return score >= 90 ? 'S' : score >= 75 ? 'A' : score >= 60 ? 'B' : score >= 45 ? 'C' : score >= 30 ? 'D' : 'E';
}

/*
 * The five ratings as a pentagon: each corner one of them, the filled shape
 * reaching out as far as the score. A plane strong at climbing and weak at
 * gliding looks it at a glance, and two cards compare side by side.
 */
export function Pentagon({ grades, height, letters = false, total }: {
  grades: readonly { key: string; label: string; score: number; value: string }[];
  height: number;
  /** Each corner's letter grade beside its score, as a game's stat screen has it. */
  letters?: boolean;
  /** The overall score and its letter, in the middle. */
  total?: number;
}) {
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
      {total !== undefined && (
        <g className="pentagon-total">
          <text x={cx} y={cy - 4} textAnchor="middle" className={`total-letter g-${gradeLetter(total)}`}>{gradeLetter(total)}</text>
          <text x={cx} y={cy + 13} textAnchor="middle" className="total-score">{Math.round(total)}점</text>
        </g>
      )}
      {g.map((x, i) => {
        const [lx, ly] = at(i, R + 14);
        return (
          <text key={x.key} x={lx} y={ly - 6} textAnchor={lx < cx - 5 ? 'end' : lx > cx + 5 ? 'start' : 'middle'}
            dominantBaseline="middle">
            <title>{x.value}</title>
            {/* Two lines at each corner: what it is, then its score out of ten. */}
            <tspan x={lx} dy="0">{names[x.key]}</tspan>
            <tspan x={lx} dy="12" className="score">
              {letters && <tspan className={`letter g-${gradeLetter(x.score)}`}>{gradeLetter(x.score)} </tspan>}
              {(x.score / 10).toFixed(1)}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}


