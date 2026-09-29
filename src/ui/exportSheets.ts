/**
 * The aeroplane on paper: the folded model, the pattern, and the throw.
 *
 * A pupil takes the aeroplane home, or hands it in, as pages rather than as a
 * data file - the finished shape, the sheet with every crease on it in the
 * book's line code, and what the flying screen predicted for the throw they
 * chose. Each page is drawn on a canvas the proportions of A4 lying down, so
 * the same picture is a PNG to keep or a page of one PDF to print.
 *
 * The PDF is written here, a few objects long: one page per picture, each
 * picture a JPEG the PDF can carry as it is. Nothing is installed for it.
 */

import type { Dimension, TaggedCrease } from '../geometry/crease.js';
import type { Step } from './foldSession.js';
import { isFold } from './foldSession.js';
import { LATEST_STYLE, LINE_ORDER, LINE_STYLES, lineKindOf } from './lineKinds.js';
import { edgeMarks, markLabel } from './edgeMarks.js';
import { KIND_TEXT } from './flightReport.js';
import type { FlightReport, FlightSettings, Rating } from './flightReport.js';
import { KIND_NAMES } from './flightStats.js';
import type { FlightStats } from './flightStats.js';

/** A4 lying down, at about 150 dots to the inch. */
export const PAGE_W = 1754;
export const PAGE_H = 1240;
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Pretendard', 'Apple SD Gothic Neo', sans-serif";
const INK = '#1b2330';
const DIM = '#5b6678';
const RULE = '#d9dee6';
const ACCENT = '#2f6fc4';
const TONE: Record<Rating['tone'], string> = { good: '#1f9d6b', warn: '#e08a1e', bad: '#d64545' };

function page(): { canvas: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, PAGE_W, PAGE_H);
  g.textBaseline = 'alphabetic';
  return { canvas, g };
}

const font = (g: CanvasRenderingContext2D, px: number, weight = 400) => {
  g.font = `${weight} ${px}px ${FONT}`;
};

/** Korean breaks between any two letters; English at spaces. Returns the lines. */
function wrap(g: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of text) {
    const next = line + ch;
    if (g.measureText(next).width > width && line) {
      // Prefer to break at the last space when there is one close by.
      const cut = line.lastIndexOf(' ');
      if (cut > line.length * 0.6) {
        out.push(line.slice(0, cut));
        line = line.slice(cut + 1) + ch;
      } else {
        out.push(line);
        line = ch;
      }
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** Draws wrapped text and returns the y below it. */
function paragraph(g: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, lh: number) {
  for (const l of wrap(g, text, width)) { g.fillText(l, x, y); y += lh; }
  return y;
}

function header(g: CanvasRenderingContext2D, title: string, name: string, sub: string) {
  g.fillStyle = ACCENT;
  g.fillRect(0, 0, PAGE_W, 10);
  g.fillStyle = INK;
  font(g, 46, 750);
  g.fillText(title, 70, 92);
  const tw = g.measureText(title).width;
  font(g, 30, 500);
  g.fillStyle = DIM;
  g.fillText(name, 70 + tw + 26, 92);
  font(g, 22);
  g.textAlign = 'right';
  g.fillText(sub, PAGE_W - 70, 92);
  g.textAlign = 'left';
  g.strokeStyle = RULE;
  g.lineWidth = 2;
  g.beginPath(); g.moveTo(70, 118); g.lineTo(PAGE_W - 70, 118); g.stroke();
}

function footer(g: CanvasRenderingContext2D, text: string) {
  font(g, 18);
  g.fillStyle = DIM;
  g.fillText(text, 70, PAGE_H - 40);
  g.textAlign = 'right';
  g.fillText('종이비행기 시뮬레이터', PAGE_W - 70, PAGE_H - 40);
  g.textAlign = 'left';
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export interface ModelFacts {
  readonly name: string;
  /** e.g. "A4 · 90g/m²" */
  readonly paper: string;
  readonly steps: number;
  /** e.g. "17.4 × 12.3 × 2.5cm" */
  readonly size: string;
}

/** Page one: the folded model, as it stands on screen. */
export async function drawModelPage(snapshot: string | null, facts: ModelFacts): Promise<HTMLCanvasElement> {
  const { canvas, g } = page();
  header(g, '접은 모양', facts.name, today());
  const box = { x: 70, y: 150, w: PAGE_W - 140, h: PAGE_H - 290 };
  if (snapshot) {
    const img = await loadImage(snapshot);
    // The view keeps its own dark mat, framed like a photograph.
    const k = Math.min(box.w / img.width, box.h / img.height);
    const w = img.width * k;
    const h = img.height * k;
    const x = box.x + (box.w - w) / 2;
    const y = box.y + (box.h - h) / 2;
    g.save();
    g.beginPath();
    g.roundRect(x, y, w, h, 18);
    g.clip();
    g.drawImage(img, x, y, w, h);
    g.restore();
  } else {
    font(g, 28);
    g.fillStyle = DIM;
    g.fillText('모형 그림을 가져오지 못했어요.', box.x, box.y + 60);
  }
  font(g, 24, 500);
  g.fillStyle = INK;
  g.fillText(`${facts.paper}  ·  ${facts.steps}단계  ·  크기 ${facts.size}`, 70, PAGE_H - 88);
  footer(g, '화면에 보이던 그대로의 모양이에요.');
  return canvas;
}

export interface PatternView {
  /** The step just folded, whose new line is picked out; null for the finished pattern. */
  readonly current: number | null;
  /** Where edge distances are measured from, as on screen. */
  readonly dimRef: 'corner' | 'centre';
}

/**
 * The sheet opened out, every crease in the book's line code, measured in
 * centimetres, beside the steps. One page for the finished pattern, or one
 * per step with that step's new line picked out and measured - the whole
 * tutorial, a page at a time.
 */
export function drawPatternPage(
  sheetW: number, sheetH: number, creases: readonly TaggedCrease[], dimensions: readonly Dimension[],
  steps: readonly Step[], facts: ModelFacts, view: PatternView = { current: null, dimRef: 'corner' },
): HTMLCanvasElement {
  const { canvas, g } = page();
  const cur = view.current;
  header(g, cur === null ? '전개도 · 완성' : `전개도 · ${cur + 1}단계`, facts.name, today());
  // The sheet on the left, the key and the steps on the right.
  const area = { x: 70, y: 150, w: 980, h: PAGE_H - 250 };
  const s = Math.min(area.w / sheetW, area.h / sheetH);
  const ox = area.x + (area.w - sheetW * s) / 2;
  const oy = area.y + (area.h - sheetH * s) / 2;
  // Sheet coordinates run up; the page runs down.
  const at = (p: readonly [number, number]): [number, number] => [ox + p[0] * s, oy + (sheetH - p[1]) * s];

  // A centimetre grid, faint, so a crease can be checked with a ruler.
  g.strokeStyle = '#eef1f5';
  g.lineWidth = 1;
  for (let i = 0; i * 0.01 <= sheetW + 1e-9; i++) {
    const [x] = at([i * 0.01, 0]);
    g.beginPath(); g.moveTo(x, oy); g.lineTo(x, oy + sheetH * s); g.stroke();
  }
  for (let j = 0; j * 0.01 <= sheetH + 1e-9; j++) {
    const [, y] = at([0, j * 0.01]);
    g.beginPath(); g.moveTo(ox, y); g.lineTo(ox + sheetW * s, y); g.stroke();
  }
  g.fillStyle = '#fbfcfe';
  g.globalAlpha = 0.35;
  g.fillRect(ox, oy, sheetW * s, sheetH * s);
  g.globalAlpha = 1;
  g.strokeStyle = INK;
  g.lineWidth = 2.5;
  g.strokeRect(ox, oy, sheetW * s, sheetH * s);

  // The line code is drawn a size up from the screen's, to print.
  const up = 1.8;
  const kinds = new Set<ReturnType<typeof lineKindOf>>();
  // A crease broken into many pieces by the folds across it is still one
  // fold: its angle is written once, on its longest piece.
  const longest = new Map<number, TaggedCrease>();
  const len = (c: TaggedCrease) => Math.hypot(c.b[0] - c.a[0], c.b[1] - c.a[1]);
  for (const c of creases) {
    const was = longest.get(c.step);
    if (!was || len(c) > len(was)) longest.set(c.step, c);
  }
  for (const c of creases) {
    const step = steps[c.step];
    const kind = lineKindOf(step);
    kinds.add(kind);
    const st = LINE_STYLES[kind];
    const [ax, ay] = at(c.a);
    const [bx, by] = at(c.b);
    g.strokeStyle = st.css;
    g.lineWidth = 2.4 * st.weight;
    g.setLineDash(st.dash.map((d) => d * up));
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    g.setLineDash([]);
    const angle = step && isFold(step) ? step.angleDeg ?? 180 : 180;
    if (kind !== 'crease' && angle < 179.5 && longest.get(c.step) === c) {
      font(g, 18, 600);
      g.fillStyle = st.css;
      g.textAlign = 'center';
      g.fillText(`${angle}°`, (ax + bx) / 2, (ay + by) / 2 - 8);
      g.textAlign = 'left';
    }
  }
  for (const d of dimensions) {
    const [ax, ay] = at(d.a);
    const [bx, by] = at(d.b);
    g.strokeStyle = '#15803d';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    for (const [x, y] of [[ax, ay], [bx, by]] as const) {
      g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fillStyle = '#15803d'; g.fill();
    }
    font(g, 18, 650);
    g.textAlign = 'center';
    g.fillText(`${(Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * 100).toFixed(1)}cm`, (ax + bx) / 2, (ay + by) / 2 - 9);
    g.textAlign = 'left';
  }
  // The step just folded, over the top in the walk-through colour.
  if (cur !== null) {
    g.strokeStyle = LATEST_STYLE.css;
    g.lineWidth = 6;
    // A highlighter over the line: its own colour shows through.
    g.globalAlpha = 0.45;
    for (const c of creases.filter((k) => k.step === cur)) {
      const [ax, ay] = at(c.a);
      const [bx, by] = at(c.b);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
    }
    g.globalAlpha = 1;
  }

  // The sheet's own size along two edges.
  font(g, 20, 650);
  g.fillStyle = INK;
  g.textAlign = 'center';
  g.fillText(`${(sheetW * 100).toFixed(1)}cm`, ox + (sheetW * s) / 2, oy - 12);
  g.save();
  g.translate(ox - 14, oy + (sheetH * s) / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(`${(sheetH * 100).toFixed(1)}cm`, 0, 0);
  g.restore();
  g.textAlign = 'left';

  // Where the creases meet the edge, measured the way the screen measures:
  // on a step's page only its new line, so the number to fold by stands out.
  const measured = cur === null ? creases : creases.filter((c) => c.step === cur);
  const marks = edgeMarks(measured, sheetW, sheetH, view.dimRef);
  // Too many numbers on the finished pattern would be noise: keep it to a sheetful.
  if (cur !== null || marks.length <= 40) {
    font(g, 17, 650);
    for (const mk of marks) {
      const [x, y] = at(mk.p);
      const out = 22;
      const [tx, ty] = mk.side === 'top' ? [x, y - out] : mk.side === 'bottom' ? [x, y + out]
        : mk.side === 'left' ? [x - out, y] : [x + out, y];
      g.strokeStyle = cur === null ? DIM : LATEST_STYLE.css;
      g.fillStyle = g.strokeStyle;
      g.lineWidth = 1.5;
      g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.moveTo(x, y); g.lineTo(tx, ty); g.stroke();
      g.fillStyle = cur === null ? DIM : '#b45309';
      g.textAlign = mk.side === 'left' ? 'right' : mk.side === 'right' ? 'left' : 'center';
      const dy = mk.side === 'top' ? -5 : mk.side === 'bottom' ? 16 : 6;
      g.fillText(markLabel(mk, view.dimRef), tx + (mk.side === 'left' ? -4 : mk.side === 'right' ? 4 : 0), ty + dy);
    }
    g.textAlign = 'left';
  }

  font(g, 18);
  g.fillStyle = DIM;
  g.fillText(`한 칸 1cm · 치수는 ${view.dimRef === 'centre' ? '가장자리의 가운데' : '가까운 모서리'}에서 잰 거리`,
    ox, oy + sheetH * s + 34);

  // The key.
  let x = 1110;
  let y = 180;
  font(g, 26, 700);
  g.fillStyle = INK;
  g.fillText('선의 종류', x, y);
  y += 20;
  for (const kind of LINE_ORDER.filter((k) => kinds.has(k))) {
    const st = LINE_STYLES[kind];
    y += 36;
    g.strokeStyle = st.css;
    g.lineWidth = 3 * st.weight;
    g.setLineDash(st.dash.map((d) => d * up));
    g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 56, y - 7); g.stroke();
    g.setLineDash([]);
    font(g, 20, 650);
    g.fillStyle = INK;
    g.fillText(st.label, x + 70, y);
    const lw = g.measureText(st.label).width;
    font(g, 17);
    g.fillStyle = DIM;
    g.fillText(st.hint, x + 80 + lw, y);
  }

  if (cur !== null) {
    y += 36;
    g.strokeStyle = LATEST_STYLE.css;
    g.lineWidth = 6;
    g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x + 56, y - 7); g.stroke();
    font(g, 20, 650);
    g.fillStyle = INK;
    g.fillText(LATEST_STYLE.label, x + 70, y);
    const lw = g.measureText(LATEST_STYLE.label).width;
    font(g, 17);
    g.fillStyle = DIM;
    g.fillText('이 단계에서 새로 생긴 선', x + 80 + lw, y);
  }

  // The steps, in order: the page is the whole tutorial.
  y += 60;
  font(g, 26, 700);
  g.fillStyle = INK;
  g.fillText('접는 순서', x, y);
  y += 12;
  const labels = steps.map((st) => st.label);
  const room = PAGE_H - 90 - y;
  const lh = Math.max(20, Math.min(30, room / Math.max(1, labels.length)));
  font(g, Math.min(20, lh - 6));
  g.fillStyle = INK;
  const width = PAGE_W - 70 - x;
  const size = Math.min(20, lh - 6);
  labels.forEach((l, i) => {
    y += lh;
    // Done steps in ink, the one on this page picked out, the rest to come faint.
    const now = cur === i;
    if (now) {
      g.fillStyle = '#fdf1dc';
      g.fillRect(x - 8, y - lh + 6, width + 8, lh);
    }
    font(g, size, now ? 750 : 400);
    g.fillStyle = cur === null || i <= cur ? INK : '#a9b1bd';
    const line = wrap(g, `${i + 1}. ${l}`, width)[0] ?? '';
    g.fillText(line, x, y);
  });
  footer(g, cur === null
    ? `${creases.length}개 접는 선 · 순서대로 접으면 완성`
    : `${cur + 1}단계 · ${steps[cur]?.label ?? ''}`);
  return canvas;
}

/** The flight from the side, to scale, in a box. */
function pathChart(g: CanvasRenderingContext2D, r: FlightReport, height: number, box: { x: number; y: number; w: number; h: number }) {
  g.fillStyle = '#f5f7fa';
  g.beginPath(); g.roundRect(box.x, box.y, box.w, box.h, 14); g.fill();
  const pad = 40;
  const pts = r.flight.path;
  const xs = pts.map((p) => p.x);
  const minX = Math.min(0, ...xs);
  const maxX = Math.max(1, ...xs);
  const maxH = Math.max(height, r.flight.maxHeight, 1) * 1.15;
  const k = Math.min((box.w - 2 * pad) / (maxX - minX), (box.h - 2 * pad) / maxH);
  // Centred across, standing on the ground line.
  const spanW = (maxX - minX) * k;
  const left = box.x + (box.w - spanW) / 2;
  const px = (x: number) => left + (x - minX) * k;
  const py = (h: number) => box.y + box.h - pad - h * k;
  const grid = Math.max(1, Math.ceil((maxX - minX) / 10));
  font(g, 16);
  g.fillStyle = DIM;
  g.textAlign = 'center';
  g.strokeStyle = RULE;
  g.lineWidth = 1;
  for (let m = Math.ceil(minX / grid) * grid; m <= maxX; m += grid) {
    g.beginPath(); g.moveTo(px(m), box.y + 16); g.lineTo(px(m), py(0)); g.stroke();
    g.fillText(`${m}m`, px(m), box.y + box.h - 12);
  }
  // Heights up the side, every metre or five.
  const hs = maxH > 12 ? 5 : maxH > 5 ? 2 : 1;
  g.textAlign = 'right';
  for (let h = hs; h < maxH; h += hs) {
    g.beginPath(); g.moveTo(box.x + 56, py(h)); g.lineTo(box.x + box.w - 16, py(h)); g.stroke();
    g.fillText(`${h}m`, box.x + 50, py(h) + 5);
  }
  g.textAlign = 'left';
  g.strokeStyle = '#1f9d6b';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(box.x + 10, py(0)); g.lineTo(box.x + box.w - 10, py(0)); g.stroke();
  g.strokeStyle = DIM;
  g.lineWidth = 5;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(px(0), py(0)); g.lineTo(px(0), py(height)); g.stroke();
  g.strokeStyle = ACCENT;
  g.lineWidth = 3.5;
  g.lineJoin = 'round';
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(px(p.x), py(p.h)) : g.moveTo(px(p.x), py(p.h))));
  g.stroke();
  g.lineCap = 'butt';
  const end = pts[pts.length - 1]!;
  g.fillStyle = '#e08a1e';
  g.beginPath(); g.arc(px(end.x), py(0), 7, 0, Math.PI * 2); g.fill();
}

function meter(g: CanvasRenderingContext2D, title: string, r: Rating, x: number, y: number, w: number) {
  font(g, 20, 700);
  g.fillStyle = INK;
  g.fillText(title, x, y);
  g.fillStyle = '#e8ecf1';
  g.beginPath(); g.roundRect(x, y + 12, w, 12, 6); g.fill();
  g.fillStyle = TONE[r.tone];
  g.beginPath(); g.roundRect(x, y + 12, Math.max(12, w * Math.min(1, r.v)), 12, 6); g.fill();
  font(g, 18);
  g.fillStyle = DIM;
  return paragraph(g, r.text, x, y + 50, w, 24) + 10;
}

/** Page three: the throw chosen on the flying screen, and what the shape predicts. */
export function drawFlightPage(
  r: FlightReport | null, s: FlightSettings, facts: ModelFacts, stats?: FlightStats | null,
): HTMLCanvasElement {
  const { canvas, g } = page();
  header(g, '날려 보기 예측', facts.name, today());
  if (!r) {
    font(g, 30);
    g.fillStyle = DIM;
    g.fillText('아직 날개가 없어요. 비행기 모양으로 접은 다음 날려 보세요.', 70, 220);
    footer(g, '');
    return canvas;
  }
  const f = r.flight;
  // Left: how it was thrown.
  let y = 180;
  const lx = 70;
  font(g, 26, 700);
  g.fillStyle = INK;
  g.fillText('이렇게 던졌어요', lx, y);
  const rows: [string, string][] = [
    ['던지는 힘', `초속 ${s.speed}m (시속 ${Math.round(s.speed * 3.6)}km)`],
    ['던지는 각도', `위로 ${s.angle}°`],
    ['잡는 법', `옆으로 세워 ${(s.grip ?? 'over') === 'over' ? '오버핸드' : '언더핸드'}`],
    ['장소', (s.gust ?? 1) === 1 ? '실내 (바람 없음)' : `야외 (맞바람 초속 ${s.headwind}m, 바람 세기가 매번 달라요)`],
    ['엘리베이터', s.elevator > 0 ? `올림 ${s.elevator}°` : s.elevator < 0 ? `내림 ${-s.elevator}°` : '평평'],
    ['날개 V자', r.vee >= 0 ? `${r.vee}°` : `아래로 ${-r.vee}°`],
    ['무게중심', `코끝에서 ${r.computedCg}cm (계산)`],
    ...(stats ? [['던진 횟수', `${stats.n}번`] as [string, string]] : []),
  ];
  y += 16;
  for (const [k, v] of rows) {
    y += 38;
    font(g, 19);
    g.fillStyle = DIM;
    g.fillText(k, lx, y);
    font(g, 20, 600);
    g.fillStyle = INK;
    g.fillText(v, lx + 130, y);
  }
  y += 56;
  font(g, 26, 700);
  g.fillStyle = INK;
  g.fillText('비행기 정보', lx, y);
  const cmv = (v: number) => (v * 100).toFixed(1);
  const facts2: [string, string][] = [
    ['무게', `${(r.af.mass.mass * 1000).toFixed(1)}g`],
    ['무게중심', `코끝에서 ${cmv(r.af.cgFromNose)}cm`],
    ['균형점', `코끝에서 ${cmv(r.m.neutralFromNose)}cm`],
    ['날개 넓이', `${(r.af.wingArea * 1e4).toFixed(0)}cm² · 폭 ${cmv(r.af.span)}cm`],
    ['날개 하중', `100cm²마다 ${r.loading.toFixed(2)}g`],
  ];
  y += 16;
  for (const [k, v] of facts2) {
    y += 36;
    font(g, 19);
    g.fillStyle = DIM;
    g.fillText(k, lx, y);
    font(g, 20, 600);
    g.fillStyle = INK;
    g.fillText(v, lx + 130, y);
  }

  // Right: the flight.
  const rx = 560;
  const rw = PAGE_W - 70 - rx;
  pathChart(g, stats ? { ...r, flight: stats.typical } : r, s.height, { x: rx, y: 150, w: rw, h: 380 });
  // The three numbers, time first: these are long-flight aeroplanes. From the
  // whole batch when there is one.
  const big: [string, string, boolean][] = stats ? [
    stats.time.best >= 89.9
      ? [stats.time.low >= 89.9 ? '90초+' : `${stats.time.mean.toFixed(1)}초`, `${stats.n}번 중 ${stats.capped}번 90초 넘게 (상승 기류)`, true]
      : [`${stats.time.mean.toFixed(1)}초`, `${stats.n}번 평균 · 보통 ${stats.time.low.toFixed(1)}~${stats.time.high.toFixed(1)}초`, true],
    [`${stats.height.mean.toFixed(1)}m`, '평균 가장 높이', false],
    [`${stats.distance.mean.toFixed(1)}m`, '평균 떨어진 곳까지', false],
  ] : [
    [`${f.time.toFixed(1)}초`, '날아 있던 시간', true],
    [`${f.maxHeight.toFixed(1)}m`, '가장 높이 올라간 곳', false],
    [`${Math.abs(f.distance).toFixed(1)}m`, f.distance >= 0 ? '던진 곳에서 떨어진 곳까지'
      : r.launch.headwind > 0 ? '바람에 뒤로 밀렸어요' : '돌면서 던진 곳 뒤쪽에 떨어졌어요', false],
  ];
  const bw = (rw - 40) / 3;
  big.forEach(([v, label, lead], i) => {
    const bx = rx + i * (bw + 20);
    g.strokeStyle = lead ? ACCENT : RULE;
    g.lineWidth = lead ? 3 : 2;
    g.beginPath(); g.roundRect(bx, 555, bw, 110, 12); g.stroke();
    font(g, lead ? 46 : 38, 750);
    g.fillStyle = lead ? ACCENT : INK;
    g.fillText(v, bx + 22, 615);
    font(g, 18);
    g.fillStyle = DIM;
    g.fillText(label, bx + 22, 648);
  });
  g.fillStyle = '#eaf2fc';
  g.beginPath(); g.roundRect(rx, 685, rw, 86, 12); g.fill();
  font(g, 22, 700);
  g.fillStyle = INK;
  const kindTitle = stats
    ? KIND_TEXT[KIND_NAMES.map(([k]) => k).reduce((a, b) => (stats.kinds[b] > stats.kinds[a] ? b : a))].title
    : r.kind.title;
  g.fillText(kindTitle, rx + 22, 720);
  font(g, 18);
  g.fillStyle = DIM;
  g.fillText(stats
    ? `${stats.n}번 중 ${KIND_NAMES.filter(([k]) => stats.kinds[k] > 0).map(([k, name]) => `${name} ${stats.kinds[k]}번`).join(', ')}`
    : r.kind.tip, rx + 22, 752);

  // The long-flight scores, two columns; then the balance, the one thing
  // most worth fixing when they are low.
  const cw = (rw - 40) / 2;
  const asRating = (gr: FlightReport['grades'][number]): Rating => ({
    tone: gr.score >= 70 ? 'good' : gr.score >= 40 ? 'warn' : 'bad', v: gr.score / 100, text: gr.value,
  });
  const [g1, g2, g3, g4] = stats ? stats.grades : r.grades;
  let ya = 815;
  ya = meter(g, `${g1!.label} ${(g1!.score / 10).toFixed(1)} / 10`, asRating(g1!), rx, ya, cw);
  ya = meter(g, `${g3!.label} ${(g3!.score / 10).toFixed(1)} / 10`, asRating(g3!), rx, ya + 8, cw);
  let yb = 815;
  yb = meter(g, `${g2!.label} ${(g2!.score / 10).toFixed(1)} / 10`, asRating(g2!), rx + cw + 40, yb, cw);
  yb = meter(g, `${g4!.label} ${(g4!.score / 10).toFixed(1)} / 10`, asRating(g4!), rx + cw + 40, yb + 8, cw);
  meter(g, '앞뒤 균형', r.balance, rx, Math.max(ya, yb) + 8, rw);

  footer(g, '접은 모양으로 계산한 예측이에요. 실제로는 접는 솜씨, 종이가 휜 정도, 던지는 손에 따라 달라져요.');
  return canvas;
}

/** One PDF, a page a picture, each picture carried as a JPEG. */
export function pagesToPdf(pages: readonly HTMLCanvasElement[]): Blob {
  // A4 lying down, in points.
  const W = 841.89;
  const H = 595.28;
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (n: number, body: () => void) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%âãÏÓ\n');
  // 1 catalog, 2 page tree, then three objects a page: page, contents, image.
  const pageIds = pages.map((_, i) => 3 + i * 3);
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`));
  pages.forEach((canvas, i) => {
    const id = pageIds[i]!;
    const jpeg = dataUrlBytes(canvas.toDataURL('image/jpeg', 0.92));
    const draw = `q\n${W} 0 0 ${H} 0 0 cm\n/Im0 Do\nQ\n`;
    object(id, () => push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] `
      + `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    object(id + 1, () => {
      push(`<< /Length ${enc.encode(draw).length} >>\nstream\n`);
      push(draw);
      push('endstream');
    });
    object(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      push(jpeg);
      push('\nendstream');
    });
  });
  const count = 3 + pages.length * 3;
  const xref = length;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' });
}

function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
