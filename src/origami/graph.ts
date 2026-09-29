/**
 * The crease pattern, as a graph.
 *
 * This is the FOLD data model: the sheet is vertices, edges and faces, each
 * edge carrying how it folds and by how much. It replaces the stack of plies
 * the earlier engine used, and the difference matters for more than tidiness.
 *
 * Paper cannot tear, because the faces are joined through shared edges and
 * nothing can separate them. Creases are the model rather than a side effect of
 * folding. And a folded shape is read by walking from face to face across the
 * hinges, so the same structure serves a flat pattern, a partly folded one, and
 * a finished model.
 *
 * Field names follow the FOLD specification so that patterns can be read from
 * and written to other origami tools.
 */

import type { Vec2 } from '../geometry/math.js';

/** How an edge folds. FOLD calls these M, V, B and F. */
export type EdgeAssignment = 'mountain' | 'valley' | 'boundary' | 'flat';

export interface FoldGraph {
  /** Vertex positions on the unfolded sheet, metres. */
  readonly vertices_coords: readonly Vec2[];
  readonly edges_vertices: readonly (readonly [number, number])[];
  readonly edges_assignment: readonly EdgeAssignment[];
  /**
   * Signed fold angle per edge, radians: positive for a valley, negative for a
   * mountain, zero for flat or boundary. A full fold is +/- pi.
   */
  readonly edges_foldAngle: readonly number[];
  /** Faces as loops of vertex indices, anticlockwise on the unfolded sheet. */
  readonly faces_vertices: readonly (readonly number[])[];
}

const EPS = 1e-9;

const key = (p: Vec2): string => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

/** The blank: one rectangular face with four boundary edges. */
export function sheetGraph(width: number, height: number): FoldGraph {
  return {
    vertices_coords: [[0, 0], [width, 0], [width, height], [0, height]],
    edges_vertices: [[0, 1], [1, 2], [2, 3], [3, 0]],
    edges_assignment: ['boundary', 'boundary', 'boundary', 'boundary'],
    edges_foldAngle: [0, 0, 0, 0],
    faces_vertices: [[0, 1, 2, 3]],
  };
}

/** A line as the set of points where `normal . p = offset`. */
export interface CreaseLine {
  readonly normal: Vec2;
  readonly offset: number;
}

export function lineThroughPoints(a: Vec2, b: Vec2): CreaseLine {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) throw new Error('a crease needs two distinct points');
  const normal: Vec2 = [-dy / len, dx / len];
  return { normal, offset: normal[0] * a[0] + normal[1] * a[1] };
}

const side = (line: CreaseLine, p: Vec2): number =>
  line.normal[0] * p[0] + line.normal[1] * p[1] - line.offset;

/** Signed area; positive when the loop runs anticlockwise. */
export function faceArea(graph: FoldGraph, face: readonly number[]): number {
  let a = 0;
  for (let i = 0; i < face.length; i++) {
    const p = graph.vertices_coords[face[i]!]!;
    const q = graph.vertices_coords[face[(i + 1) % face.length]!]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export const totalArea = (graph: FoldGraph): number =>
  graph.faces_vertices.reduce((t, f) => t + Math.abs(faceArea(graph, f)), 0);

/** Mutable working copy, so a crease can be built up in one pass. */
interface Builder {
  vertices: Vec2[];
  index: Map<string, number>;
  edges: [number, number][];
  assignment: EdgeAssignment[];
  angle: number[];
  faces: number[][];
}

function toBuilder(graph: FoldGraph): Builder {
  const vertices = graph.vertices_coords.map((v) => [...v] as Vec2);
  const index = new Map<string, number>();
  vertices.forEach((v, i) => index.set(key(v), i));
  return {
    vertices,
    index,
    edges: graph.edges_vertices.map((e) => [...e] as [number, number]),
    assignment: [...graph.edges_assignment],
    angle: [...graph.edges_foldAngle],
    faces: graph.faces_vertices.map((f) => [...f]),
  };
}

function vertexAt(b: Builder, p: Vec2): number {
  const k = key(p);
  const found = b.index.get(k);
  if (found !== undefined) return found;
  b.vertices.push(p);
  b.index.set(k, b.vertices.length - 1);
  return b.vertices.length - 1;
}

/**
 * Cut an existing edge at a vertex sitting on it.
 *
 * Splitting a face without splitting the edge it crossed leaves the neighbour
 * spanning the new vertex, and the two stop looking adjacent even though the
 * paper is continuous. The halves inherit how the original folded.
 */
function splitEdgeAt(b: Builder, u: number, v: number, at: number): void {
  if (at === u || at === v) return;
  const i = b.edges.findIndex(([x, y]) => (x === u && y === v) || (x === v && y === u));
  if (i < 0) return;
  const assignment = b.assignment[i]!;
  const angle = b.angle[i]!;
  b.edges[i] = [u, at];
  b.edges.push([at, v]);
  b.assignment.push(assignment);
  b.angle.push(angle);
}

/** The edge joining two vertices, or -1 if the graph does not hold one. */
function findEdge(b: Builder, u: number, v: number): number {
  return b.edges.findIndex(([x, y]) => (x === u && y === v) || (x === v && y === u));
}

function edgeBetween(b: Builder, u: number, v: number): number {
  const found = b.edges.findIndex(([x, y]) => (x === u && y === v) || (x === v && y === u));
  if (found >= 0) return found;
  b.edges.push([u, v]);
  b.assignment.push('flat');
  b.angle.push(0);
  return b.edges.length - 1;
}

/**
 * Press a crease across the whole pattern.
 *
 * Every face the line passes through is divided in two and the new edge
 * between them carries the fold. Faces the line misses are left alone, and
 * because the halves keep the vertices they shared, the sheet stays in one
 * piece: the paper is folded, never cut.
 */
export function addCrease(
  graph: FoldGraph,
  line: CreaseLine,
  assignment: Exclude<EdgeAssignment, 'boundary'>,
  angleDeg = 180,
): FoldGraph {
  return addCreases(graph, () => line, assignment, angleDeg).graph;
}

/** Which face each face of the result came from, and which side it fell. */
export interface CreaseResult {
  readonly graph: FoldGraph;
  /** For each new face: the face it came from, and whether it is on the moving side. */
  readonly faces_source: readonly number[];
  readonly faces_moving: readonly boolean[];
}

/**
 * Press a crease, allowing each face its own line.
 *
 * A fold made on a model that is already folded is one line to the eye but a
 * different line on each face, because the faces have been carried to different
 * places. Letting the caller give a line per face is what makes folding a
 * folded model the same operation as folding a flat one.
 *
 * A crease is named for what the hand does - valley, the fold coming toward
 * you - and the hand is looking at the top of the pile. A face further down may
 * have been turned over on the way, and then the same movement is a mountain in
 * that sheet of paper's own reckoning. `turnedOver` is how the caller says so;
 * without it every ply of one flap is creased the same way round and the flap
 * comes apart in space, each ply swinging off in its own direction.
 */
export function addCreases(
  graph: FoldGraph,
  lineFor: (face: number) => CreaseLine | null,
  assignment: Exclude<EdgeAssignment, 'boundary'>,
  angleDeg = 180,
  turnedOver: (face: number) => boolean = () => false,
): CreaseResult {
  const b = toBuilder(graph);
  const sign = assignment === 'mountain' ? -1 : 1;
  const magnitude = assignment === 'flat' ? 0 : (sign * angleDeg * Math.PI) / 180;
  const nextFaces: number[][] = [];
  const source: number[] = [];
  const moving: boolean[] = [];
  const original = b.faces;
  /*
   * A fold whose line lies along creases that are already there has no face to
   * divide - and that is exactly what folding a sheet in half does after the
   * centre line has been pressed, which is the ordinary way to fold anything.
   * The hinge is an edge the graph already holds, so it has to be picked up and
   * given the angle, or the paper simply never folds and every later step is
   * made on a sheet that is still flat.
   */
  const alongCrease: Array<{ u: number; v: number; over: boolean; face: number }> = [];
  /*
   * Which faces travel whole. An edge on the line whose faces BOTH travel is
   * not a hinge of this fold: it is a crease inside the stack being carried,
   * lying on the line only because the stack's folded edge happens to be
   * there - which is what every turn of a tight roll does, folding at the
   * edge of the band already rolled. Taken for a hinge, it was given this
   * fold's direction, and the rolled creases flipped from valley to mountain
   * one after another.
   */
  const travelsWhole: boolean[] = [];

  for (let fi = 0; fi < original.length; fi++) {
    const face = original[fi]!;
    const line = lineFor(fi);
    if (!line) { travelsWhole.push(false); nextFaces.push(face); source.push(fi); moving.push(false); continue; }
    const dist = face.map((v) => side(line, b.vertices[v]!));
    travelsWhole.push(dist.every((d) => d > -EPS) && dist.some((d) => d > EPS));
    const collectHinges = () => {
      for (let i = 0; i < face.length; i++) {
        const j = (i + 1) % face.length;
        if (Math.abs(dist[i]!) < EPS && Math.abs(dist[j]!) < EPS) {
          alongCrease.push({ u: face[i]!, v: face[j]!, over: turnedOver(fi), face: fi });
        }
      }
    };
    if (dist.every((d) => d > -EPS)) {
      collectHinges();
      nextFaces.push(face); source.push(fi); moving.push(true); continue;
    }
    if (dist.every((d) => d < EPS)) {
      nextFaces.push(face); source.push(fi); moving.push(false); continue;
    }

    // Walk the loop, dropping each vertex into the half it belongs to and
    // adding the crossing points to both.
    const positive: number[] = [];
    const negative: number[] = [];
    const onLine: number[] = [];
    for (let i = 0; i < face.length; i++) {
      const v = face[i]!;
      const d = dist[i]!;
      const nv = face[(i + 1) % face.length]!;
      const nd = dist[(i + 1) % face.length]!;

      if (d > EPS) positive.push(v);
      else if (d < -EPS) negative.push(v);
      else { positive.push(v); negative.push(v); onLine.push(v); }

      if ((d > EPS && nd < -EPS) || (d < -EPS && nd > EPS)) {
        const p = b.vertices[v]!;
        const q = b.vertices[nv]!;
        const t = d / (d - nd);
        const cut = vertexAt(b, [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        splitEdgeAt(b, v, nv, cut);
        positive.push(cut);
        negative.push(cut);
        onLine.push(cut);
      }
    }

    if (positive.length >= 3) { nextFaces.push(positive); source.push(fi); moving.push(true); }
    if (negative.length >= 3) { nextFaces.push(negative); source.push(fi); moving.push(false); }

    // The crease runs between the two points where it met this face's boundary.
    const ends = [...new Set(onLine)];
    if (ends.length >= 2) {
      const e = edgeBetween(b, ends[0]!, ends[ends.length - 1]!);
      const over = turnedOver(fi);
      b.assignment[e] = assignment === 'flat' ? 'flat'
        : over ? (assignment === 'mountain' ? 'valley' : 'mountain') : assignment;
      b.angle[e] = over ? -magnitude : magnitude;
    }
  }

  // The hinges the fold ran along, rather than across. Only the side that
  // travels names them, so the two faces sharing one cannot disagree.
  for (const { u, v, over, face } of alongCrease) {
    const e = findEdge(b, u, v);
    if (e < 0 || b.assignment[e] === 'boundary') continue;
    // Both sides of it travel: carried, not bent.
    const other = original.findIndex((g, gi) => gi !== face && g.some((x, k) =>
      (x === u && g[(k + 1) % g.length] === v) || (x === v && g[(k + 1) % g.length] === u)));
    if (other >= 0 && travelsWhole[other] && b.assignment[e] !== 'flat') continue;
    b.assignment[e] = assignment === 'flat' ? 'flat'
      : over ? (assignment === 'mountain' ? 'valley' : 'mountain') : assignment;
    b.angle[e] = over ? -magnitude : magnitude;
  }

  b.faces = nextFaces;
  return {
    graph: {
      vertices_coords: b.vertices,
      edges_vertices: b.edges,
      edges_assignment: b.assignment,
      edges_foldAngle: b.angle,
      faces_vertices: b.faces,
    },
    faces_source: source,
    faces_moving: moving,
  };
}

/** Faces sharing an edge, which is what a folded state is walked across. */
export function faceAdjacency(graph: FoldGraph): Map<number, Array<{ face: number; edge: number }>> {
  const byEdge = new Map<string, number[]>();
  graph.faces_vertices.forEach((face, fi) => {
    for (let i = 0; i < face.length; i++) {
      const u = face[i]!;
      const v = face[(i + 1) % face.length]!;
      const k = u < v ? `${u}-${v}` : `${v}-${u}`;
      const list = byEdge.get(k);
      if (list) list.push(fi); else byEdge.set(k, [fi]);
    }
  });

  const edgeIndex = new Map<string, number>();
  graph.edges_vertices.forEach(([u, v], i) => {
    edgeIndex.set(u < v ? `${u}-${v}` : `${v}-${u}`, i);
  });

  const out = new Map<number, Array<{ face: number; edge: number }>>();
  graph.faces_vertices.forEach((_, fi) => out.set(fi, []));
  for (const [k, faces] of byEdge) {
    if (faces.length !== 2) continue;
    const edge = edgeIndex.get(k);
    if (edge === undefined) continue;
    const [a, b2] = faces as [number, number];
    out.get(a)!.push({ face: b2, edge });
    out.get(b2)!.push({ face: a, edge });
  }
  return out;
}
