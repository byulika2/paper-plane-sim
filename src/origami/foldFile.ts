/**
 * The FOLD file format.
 *
 * FOLD is the interchange format for origami (Demaine et al., 2016): a JSON
 * object holding vertices, edges, faces and a fold angle per edge. Our own
 * graph is already that shape, so writing one is mostly renaming - and being
 * able to write one matters more than it looks. It is how this engine's answer
 * can be checked against somebody else's: the same file opens in Origami
 * Simulator and in Oriedita, and if they fold it differently from us, we are
 * wrong. A test suite of one's own only ever proves self-consistency.
 *
 * Lengths are written in millimetres. FOLD has no unit field, and every tool
 * that reads one assumes the numbers are whatever the author meant; millimetres
 * are what the rest of this program quotes, so they are what goes in the file.
 */

import type { FoldedState } from './folding.js';
import type { EdgeAssignment, FoldGraph } from './graph.js';
import type { Vec2 } from '../geometry/math.js';

export interface FoldFile {
  file_spec: number;
  file_creator: string;
  file_classes: string[];
  frame_classes: string[];
  frame_attributes: string[];
  frame_unit: string;
  vertices_coords: number[][];
  edges_vertices: number[][];
  edges_assignment: string[];
  edges_foldAngle: number[];
  faces_vertices: number[][];
  faces_layer?: number[];
}

const MARK: Record<EdgeAssignment, string> = {
  mountain: 'M',
  valley: 'V',
  boundary: 'B',
  flat: 'F',
};

const UNMARK: Record<string, EdgeAssignment> = {
  M: 'mountain', V: 'valley', B: 'boundary', F: 'flat', U: 'flat',
};

const deg = (rad: number) => Number(((rad * 180) / Math.PI).toFixed(6));
const mm = (v: number) => Number((v * 1000).toFixed(6));

/**
 * The crease pattern: the flat sheet with every crease marked on it.
 *
 * This is the file to print, and the one to hand another simulator to ask
 * whether the pattern folds at all.
 */
export function creasePatternFile(graph: FoldGraph): FoldFile {
  return {
    file_spec: 1.1,
    file_creator: 'paper-plane-sim',
    file_classes: ['singleModel'],
    frame_classes: ['creasePattern'],
    frame_attributes: ['2D'],
    frame_unit: 'mm',
    vertices_coords: graph.vertices_coords.map((p) => [mm(p[0]), mm(p[1])]),
    edges_vertices: graph.edges_vertices.map(([u, v]) => [u, v]),
    edges_assignment: graph.edges_assignment.map((a) => MARK[a]),
    edges_foldAngle: graph.edges_foldAngle.map(deg),
    faces_vertices: graph.faces_vertices.map((f) => [...f]),
  };
}

/**
 * The folded state: where every face has been carried to, and in what order.
 *
 * FOLD writes a folded form as the same graph with the folded coordinates in
 * place of the flat ones, which is why the stacking order has to ride along -
 * without it a flat fold is a pile of coincident faces with nothing to say
 * which is on top.
 */
export function foldedStateFile(state: FoldedState): FoldFile {
  const file = creasePatternFile(state.graph);
  const layer = new Array<number>(state.graph.faces_vertices.length).fill(0);
  state.faces_order.forEach((face, i) => { layer[face] = i; });
  return {
    ...file,
    frame_classes: ['foldedForm'],
    vertices_coords: state.graph.vertices_coords.map((p) => [mm(p[0]), mm(p[1])]),
    faces_layer: layer,
  };
}

/**
 * Read a FOLD file back into a graph.
 *
 * What comes back is a crease pattern, not a script: the file records where the
 * creases are, never the order a pair of hands made them in. So an imported
 * pattern can be looked at and folded by the hinge walk, but it cannot be
 * stepped through or undone the way one built here can. Saying so plainly is
 * better than pretending the round trip is lossless.
 */
export function readFoldFile(text: string): FoldGraph {
  const raw = JSON.parse(text) as Partial<FoldFile>;
  const coords = raw.vertices_coords;
  const edges = raw.edges_vertices;
  if (!Array.isArray(coords) || !Array.isArray(edges)) {
    throw new Error('FOLD 파일에 vertices_coords 또는 edges_vertices가 없습니다.');
  }
  // A file's unit is its own: millimetres, centimetres or metres, and nothing else guessed at.
  const unit = String(raw.frame_unit ?? 'mm').toLowerCase();
  const scale = unit === 'mm' ? 0.001 : unit === 'cm' ? 0.01 : unit === 'm' || unit === 'unit' ? 1 : NaN;
  if (!Number.isFinite(scale)) throw new Error(`FOLD 파일의 단위(${unit})를 알 수 없어요. mm, cm, m만 읽을 수 있어요.`);
  const assignment = raw.edges_assignment ?? [];
  const angles = raw.edges_foldAngle ?? [];

  /*
   * Checked on the way in: an index past the end or a coordinate that is not
   * a number came through as undefined and blanked the screen mid-draw, far
   * from here and with nothing to say what was wrong with the file.
   */
  const vertices_coords = coords.map((p, i) => {
    const q: Vec2 = [Number(p?.[0]) * scale, Number(p?.[1]) * scale];
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) throw new Error(`FOLD 파일의 ${i + 1}번째 꼭짓점 좌표가 숫자가 아니에요.`);
    return q;
  });
  const vertex = (v: unknown, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= vertices_coords.length) throw new Error(`FOLD 파일의 ${what}이(가) 없는 꼭짓점을 가리켜요.`);
    return n;
  };
  const edges_vertices = edges.map(([u, v], i) => [vertex(u, `${i + 1}번째 선`), vertex(v, `${i + 1}번째 선`)] as const);
  const faces_vertices = (raw.faces_vertices ?? []).map((f, i) => {
    if (!Array.isArray(f) || f.length < 3) throw new Error(`FOLD 파일의 ${i + 1}번째 면이 올바르지 않아요.`);
    return f.map((v) => vertex(v, `${i + 1}번째 면`));
  });
  return {
    vertices_coords,
    edges_vertices,
    edges_assignment: edges.map((_, i) =>
      UNMARK[String(assignment[i] ?? 'U').toUpperCase()] ?? 'flat'),
    edges_foldAngle: edges.map((_, i) => ((Number(angles[i]) || 0) * Math.PI) / 180),
    faces_vertices,
  };
}
