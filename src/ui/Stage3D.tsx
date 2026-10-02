import { useEffect, useRef } from 'react';
import { foldBands } from './foldBands.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { affineApply, affineInverse, layerOutline, lineThrough, pointInPolygon } from '../geometry/fold.js';
import type { FoldModel, Line } from '../geometry/fold.js';
import { applyRigid } from '../geometry/math.js';
import { foldInSpace, lineInSpace, segmentInSpace } from '../origami/space.js';
import type { RenderFace } from '../origami/space.js';
import type { FoldedState } from '../origami/folding.js';
import { stackLevels } from '../origami/layers.js';
import { LATEST_STYLE, LINE_ORDER, LINE_STYLES } from './lineKinds.js';
import type { LineKind } from './lineKinds.js';
import { resolveSnap } from './foldSession.js';
import type { SnapPoint } from './foldSession.js';
import type { Vec2, Vec3 } from '../geometry/math.js';
import type { PaperProps } from '../paper/stock.js';

export type StageMode = 'folded' | 'stack';

/**
 * A reader from sheet coordinates to the folded view, by the face each point is on.
 *
 * Every point of the sheet belongs to exactly one face of the model, and that
 * face's placement is where the point has been carried. Looking a drawn ply up
 * by its number instead goes wrong whenever the plies drawn are not the
 * model's own - while a fold is being set up they include the new division.
 */
function sheetReader(state: FoldedState): (q: Vec2) => Vec2 {
  const faces = state.graph.faces_vertices.map((loop) => loop.map((v) => state.graph.vertices_coords[v]!));
  const centres = faces.map((poly) => poly.reduce<Vec2>(
    (a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]));
  return (q: Vec2): Vec2 => {
    for (let f = 0; f < faces.length; f++) {
      if (pointInPolygon(faces[f]!, q)) return affineApply(state.faces_matrix[f]!, q);
    }
    // On an edge between faces: either side puts it on the same line.
    let best = 0;
    let bestD = Infinity;
    centres.forEach((c, f) => {
      const d = Math.hypot(c[0] - q[0], c[1] - q[1]);
      if (d < bestD) { bestD = d; best = f; }
    });
    return affineApply(state.faces_matrix[best]!, q);
  };
}

/** The standard views, as directions the camera looks from. */
export const VIEWS: ReadonlyArray<readonly [string, readonly [number, number, number]]> = [
  ['위에서', [0, 1, 0.0008]],
  ['비스듬히', [0.55, 0.72, 0.85]],
  ['앞에서', [0, 0.08, 1]],
  ['옆에서', [1, 0.08, 0]],
];
export const OBLIQUE = VIEWS[1]![1];

/**
 * The model turned a number of quarter turns about the table's upright - the
 * paper's own normal, before it is stood in the scene - so the paper, its
 * lines and the points it snaps to all turn together, and the camera stays.
 */
function reshaped(stand: (p: Vec3) => Vec3, reshape: ((p: Vec3) => Vec3) | null | undefined): (p: Vec3) => Vec3 {
  return reshape ? (p) => stand(reshape(p)) : stand;
}

function turned(stand: (p: Vec3) => Vec3, turn: number): (p: Vec3) => Vec3 {
  const k = ((turn % 4) + 4) % 4;
  if (k === 0) return stand;
  return (p) => {
    const q = stand(p);
    return k === 1 ? [-q[1], q[0], q[2]] : k === 2 ? [-q[0], -q[1], q[2]] : [q[1], -q[0], q[2]];
  };
}

interface Props {
  /** The view buttons and 화면 맞춤 live in the screen's own menu instead. */
  hideViewControls?: boolean;
  model: FoldModel;
  plies: readonly RenderFace[];
  paper: PaperProps;
  mode: StageMode;
  /** Plies moved by this step are the ones about to fold; -1 when idle. */
  previewIndex: number;
  /**
   * Fold coordinates to body axes. Folding leaves the aeroplane lying on its
   * side - the plane of symmetry ends up flat on the table - so showing it the
   * way it flies means standing it back up on its own axes.
   */
  attitude?: (p: Vec3) => Vec3;
  /**
   * Real paper's shape, as a change to fold coordinates made before anything
   * else: the nose its rolls leave longer than the drawing (see
   * `noseStretch`). The plies, the lines and the points the pointer catches
   * all go through it, so they stay on each other.
   */
  reshape?: ((p: Vec3) => Vec3) | null;
  /**
   * The paper turned on the table, a quarter turn each: 0 to 3. Only how it
   * lies in front of you - the folds and the record are the same.
   */
  turn?: number;
  /** Shade paper darker where more plies are stacked. */
  shadeByPile?: boolean;
  /**
   * Bumped only when the view should be re-framed - a sample loaded, a reset,
   * a file opened. NOT on every fold.
   *
   * Re-framing after each step hides the very thing the step did: fold a sheet
   * in half and the camera pulls in by the same factor, so the paper is the
   * same size on screen and nothing appears to have happened. Leaving the
   * camera where it is means a fold looks like a fold.
   */
  fitKey: number;
  /**
   * Swing to a standard view once, when this changes.
   *
   * Opening a finished aeroplane from above shows its wings edge-on to
   * nothing in particular and it reads as a flat shape; the angled view is
   * the one that reads as an aeroplane. Folding still starts from above,
   * which is the view a flat sheet is worked in.
   */
  view?: { readonly key: number; readonly dir: readonly [number, number, number] };
  animating: boolean;
  /** Hands back a way to grab the rendered frame, for the instruction sheet. */
  onSnapshotReady?: (grab: () => string | null) => void;
  /** Hands back a way to re-frame the view, for menus and shortcuts. */
  onFitReady?: (fit: () => void) => void;
  /** Hands over a zoom by a factor about the middle of the view, for buttons. */
  onZoomReady?: (zoom: (factor: number) => void) => void;
  /**
   * Folding by pointing at the model.
   *
   * The paper is what the hand works on, so the stage hands back the point of
   * the PAPER that was clicked, not a point of the scene. Everything else -
   * which half travels, the sense, how many plies - is the same machinery the
   * flat view drives, and it never learns that a camera was involved.
   */
  state?: FoldedState;
  picking?: boolean;
  /**
   * A click on the paper. `perPixel` is how much paper one screen pixel covers
   * there, so anything that wants a reach measured on screen - picking an edge,
   * catching a corner - can size itself the same way at any zoom.
   */
  /**
   * A click on the model. `sheet` is the same point on the unfolded sheet when
   * the pointer was on paper - the one thing that tells apart two pieces the
   * layout draws in the same place.
   */
  onPick?: (p: Vec2, perPixel: number, kind: SnapPoint['kind'] | null, sheet: Vec2 | null) => void;
  onHover?: (p: Vec2 | null, kind: SnapPoint['kind'] | null, sheet: Vec2 | null) => void;
  /** What the pointer last settled onto, so the stage can say so. */
  onSnap?: (kind: SnapPoint['kind'] | null) => void;
  /** The fold being set up, in paper coordinates, drawn across the model. */
  guide?: { a: Vec2; b: Vec2 } | null;
  /**
   * The line being stretched out from the point already taken.
   *
   * Only the span between the two points, not the whole line it lies on: until
   * the second point is placed there is no fold yet, just a measurement being
   * drawn, and showing it running off to the edges of the paper would say
   * otherwise.
   */
  rubber?: { a: Vec2; b: Vec2 } | null;
  marks?: readonly Vec2[];
  /** Corners, midpoints, creases and marks a pick may settle onto. */
  snaps?: readonly SnapPoint[];
  /** Grid step in millimetres; 0 turns the grid off. */
  snapMm?: number;
  /** What to do next, shown on the stage so the eye never leaves the model. */
  prompt?: string;
  /**
   * Every crease on the paper, in paper coordinates.
   *
   * A fold that is pressed and opened again leaves nothing but a line, and if
   * the line is not drawn then pressing it appears to do nothing at all. These
   * are the marks the hand would see on the sheet.
   */
  creases?: readonly { a: Vec2; b: Vec2; kind: LineKind; latest?: boolean; sheetA?: Vec2; sheetB?: Vec2 }[];
  /**
   * Measured spans, drawn on the paper with their lengths.
   *
   * A dimension changes nothing about the shape; it is a note to yourself about
   * where the next fold goes. Recording one and then not drawing it is the same
   * as not recording it.
   */
  dimensions?: readonly { a: Vec2; b: Vec2; length: number; step?: number; sheetA?: Vec2; sheetB?: Vec2 }[];
  /** Creases to pick out on the model, in paper coordinates. */
  highlights?: readonly { a: Vec2; b: Vec2; strong?: boolean }[];
  /** A right-click on the model, with the paper point under it. */
  onContext?: (p: Vec2 | null, at: { x: number; y: number }) => void;
  /**
   * A drag across the paper, when the tool in hand draws by dragging.
   *
   * Which is the difference between a tool and a mode: with the line tool a
   * drag is a line, with the dimension tool it is a measurement, and with the
   * select tool it is the camera. Dragging off the paper always turns the
   * model, whatever tool is in hand, so the view is never trapped.
   */
  onDrag?: (a: Vec2, b: Vec2) => void;
  dragDraws?: boolean;
  /**
   * May a drag turn the model over?
   *
   * Only while nothing else is being done with the pointer. Every other tool
   * wants the drag for itself, and a stray one that spun the paper instead
   * left you looking at the model from somewhere new in the middle of placing
   * a line - which is the same complaint as the paper turning on its own, and
   * just as unwelcome when it is your own hand that did it.
   */
  orbit?: boolean;
  /**
   * Taking hold of something already on the paper and moving it.
   *
   * `onGrab` is asked whether there is anything at that point; if there is, the
   * drag belongs to it rather than to the camera, and every move is reported
   * from where it was taken hold of to where the pointer is now.
   */
  onGrab?: (p: Vec2) => boolean;
  onGrabMove?: (from: Vec2, to: Vec2) => void;
  onGrabEnd?: () => void;
}

/** Where a face has been carried to in space; cached per state. */
let placeCache: { state: FoldedState; places: ReturnType<typeof foldInSpace> } | null = null;
function placeOf(state: FoldedState, face: number) {
  if (placeCache?.state !== state) placeCache = { state, places: foldInSpace(state) };
  return placeCache.places[face]?.transform ?? null;
}

/** The same fan, but over a polygon on the paper: x, y per vertex. */
function fanPairs(points: readonly Vec2[]): number[] {
  const out: number[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    out.push(...points[0]!, ...points[i]!, ...points[i + 1]!);
  }
  return out;
}

/**
 * Where a point of the folded view sits in space, if it is on this face.
 *
 * The same point of the view lies on every ply stacked there, so a mark shows
 * up once per ply - which is the truth about where the hand could touch it.
 */
function pointOnFace(state: FoldedState, face: number, p: Vec2, tol = 1e-6): Vec3 | null {
  const local = affineApply(affineInverse(state.faces_matrix[face]!), p);
  const loop = state.graph.faces_vertices[face]!;
  const poly = loop.map((v) => state.graph.vertices_coords[v]!);

  let inside = false;
  let nearest = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const u = poly[i]!;
    const v = poly[j]!;
    if ((u[1] > local[1]) !== (v[1] > local[1])) {
      const x = u[0] + ((local[1] - u[1]) / (v[1] - u[1])) * (v[0] - u[0]);
      if (local[0] < x) inside = !inside;
    }
    // How far the point is from this edge, for the boundary case below.
    const dx = v[0] - u[0];
    const dy = v[1] - u[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0
      ? Math.max(0, Math.min(1, ((local[0] - u[0]) * dx + (local[1] - u[1]) * dy) / len2))
      : 0;
    nearest = Math.min(nearest,
      Math.hypot(local[0] - (u[0] + t * dx), local[1] - (u[1] + t * dy)));
  }

  /*
   * A point exactly on the edge is on the paper.
   *
   * The crossing test answers "strictly inside", and says no to a point sitting
   * on the boundary - which is precisely where a pointer that has run off the
   * sheet gets put, and where every corner is. So the marker vanished at the
   * very places it was most wanted, and worst at the corners, where two edges
   * meet and the test fails twice over.
   */
  if (!inside && nearest > tol) return null;

  const place = placeOf(state, face);
  return place ? applyRigid(place, [local[0], local[1], 0]) : null;
}

/**
 * A ring that always faces the viewer, for the point under the pointer.
 *
 * A filled dot hides the very thing it is marking. A ring shows where the
 * pointer has settled and still lets you see the corner or the crease
 * underneath it, which is the whole reason for looking there.
 */
let ringTexture: THREE.Texture | null = null;
function ringSprite(color: string): THREE.Sprite {
  if (!ringTexture) {
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d')!;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    g.stroke();
    ringTexture = new THREE.CanvasTexture(canvas);
  }
  return new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTexture, color, depthTest: false, transparent: true,
  }));
}

/** Fan-triangulate a polygon into a flat position buffer. */
function fan(points: readonly (readonly number[])[]): Float32Array {
  const out: number[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    out.push(...points[0]!, ...points[i]!, ...points[i + 1]!);
  }
  return new Float32Array(out);
}

export function Stage3D({
  model, plies, paper, mode, previewIndex, attitude, reshape, turn = 0, shadeByPile = false, fitKey, view, animating,
  onSnapshotReady,
  onFitReady,
  onZoomReady,
  state, picking = false, onPick, onHover, onSnap, guide, marks, snaps, snapMm = 0,
  prompt, creases, dimensions, highlights, rubber,
  onContext, onDrag, dragDraws = false, orbit = true, hideViewControls = false, onGrab, onGrabMove, onGrabEnd,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const overlayRef = useRef<THREE.Group | null>(null);
  // Length labels ride along in HTML: text that stays upright and readable at
  // any angle, which is what a drawing's dimensions do.
  const labelsRef = useRef<HTMLDivElement | null>(null);
  const tagsRef = useRef<Array<{ el: HTMLSpanElement; at: THREE.Vector3 }>>([]);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const viewRef = useRef<((dir: [number, number, number]) => void) | null>(null);
  const lastFitRef = useRef(-1);
  // The handlers are rebuilt on every pick; the listeners are not, so they go
  // through a box rather than being torn down and re-added sixty times a second.
  const pickRef = useRef<{
    picking: boolean;
    onPick?(p: Vec2, perPixel: number, kind: SnapPoint['kind'] | null, sheet: Vec2 | null): void;
    onHover?(p: Vec2 | null, kind: SnapPoint['kind'] | null, sheet: Vec2 | null): void;
    onSnap?(kind: SnapPoint['kind'] | null): void;
    /** Where each snap point sits in the scene, for catching it by eye. */
    spots: Array<{ p: Vec2; kind: SnapPoint['kind']; at: THREE.Vector3 }>;
    /** Each face's outline, in the scene and on the paper, for clamping. */
    rims: Array<Array<{ at: THREE.Vector3; p: Vec2 }>>;
    onContext?(p: Vec2 | null, at: { x: number; y: number }): void;
    onDrag?(a: Vec2, b: Vec2): void;
    dragDraws: boolean;
    orbit: boolean;
    onGrab?(p: Vec2): boolean;
    onGrabMove?(from: Vec2, to: Vec2): void;
    onGrabEnd?(): void;
    snaps: readonly SnapPoint[];
    snapMm: number;
  }>({ picking: false, snaps: [], snapMm: 0, spots: [], rims: [], orbit: true, dragDraws: false });
  pickRef.current = {
    ...pickRef.current,
    picking, onPick, onHover, onSnap, onContext, onDrag, dragDraws, orbit,
    onGrab, onGrabMove, onGrabEnd, snaps: snaps ?? [], snapMm,
  };

  // Scene, camera and renderer live for the lifetime of the component; only the
  // geometry group is rebuilt as the fold changes.
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1016);

    /*
     * Straight down on the paper to begin with.
     *
     * Folding starts on a flat sheet, and a flat sheet seen from a three
     * quarter angle is a parallelogram: the edges are not where they look, so
     * the first line is drawn by guesswork. Looking down at it, the sheet is a
     * rectangle and a corner is where it appears to be. Turning it over to see
     * what the fold did is a drag away.
     *
     * Not exactly overhead - a hair off the axis, or the orbit controls have no
     * idea which way is up and the view rolls as soon as it is touched.
     */
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 50);
    camera.position.set(0, 0.5, 0.0004);

    // Without this the drawing buffer is cleared after each frame and reading
    // the canvas back for the instruction sheet returns an empty image.
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0, 0);
    // Zooming is ours: the controls are switched off while a tool draws, and
    // the wheel has to work whatever the tool is.
    controls.enableZoom = false;

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, 0.9, 0.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fb4ff, 0.55);
    fill.position.set(-0.6, -0.2, -0.45);
    scene.add(fill);

    const grid = new THREE.GridHelper(0.72, 36, 0x2c3a58, 0x1b2436);
    grid.position.y = -0.1;
    scene.add(grid);

    const group = new THREE.Group();
    scene.add(group);
    contentRef.current = group;
    const overlay = new THREE.Group();
    scene.add(overlay);
    overlayRef.current = overlay;
    cameraRef.current = camera;
    canvasRef.current = renderer.domElement;

    /*
     * Pointing at the paper.
     *
     * A ray is cast at whatever is under the cursor; the triangle it lands on
     * carries, alongside its position in space, the same triangle in SHEET
     * coordinates. The hit point is written in barycentric terms of the one and
     * read back out of the other, which is exact - every step between the sheet
     * and the screen is affine, and barycentric weights do not care about that.
     */
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let lastPerPixel = 0.0002;
    // What the last pick settled onto, so the caller can tell a point that was
    // aimed at a feature from one that merely landed somewhere.
    let lastKind: SnapPoint['kind'] | null = null;
    // The sheet point under the pointer, when a ray found paper.
    let lastSheet: Vec2 | null = null;
    const ndcOf = new THREE.Vector3();

    /*
     * Catch a corner by eye, not by ray.
     *
     * A ray only finds paper where there is paper, so aiming at the very edge
     * of a sheet - which is exactly where a dimension starts and where a fold
     * is lined up - means missing it as often as hitting it. Corners, midpoints
     * and crease ends are the things worth aiming at, so they are also tested
     * in screen space: if one is within a few pixels of the pointer it wins,
     * whether or not the ray landed on anything.
     */
    const spotNearPointer = (px: number, py: number, rect: DOMRect) => {
      let best: { p: Vec2; kind: SnapPoint['kind'] } | null = null;
      let bestD = 14;
      for (const spot of pickRef.current.spots) {
        ndcOf.copy(spot.at).project(camera);
        if (ndcOf.z > 1) continue;
        const sx = ((ndcOf.x + 1) / 2) * rect.width;
        const sy = ((1 - ndcOf.y) / 2) * rect.height;
        const d = Math.hypot(sx - px, sy - py);
        // A corner beats a midpoint beats a crease end when they are together.
        const rank = spot.kind === 'corner' ? 0 : spot.kind === 'mark' ? 0.5 : 1;
        if (d + rank < bestD) { bestD = d + rank; best = { p: spot.p, kind: spot.kind }; }
      }
      return best;
    };

    /*
     * The nearest paper when the pointer has run off it.
     *
     * Aiming at the very end of an edge means putting the cursor where the
     * paper stops, and a pointer a hair past that used to catch nothing at
     * all - so the last millimetre of every edge, which is exactly where a
     * dimension starts and ends, was the hardest part of the sheet to hit.
     * Off the paper, the closest point of its outline is what is meant.
     */
    const rimNearPointer = (px: number, py: number, rect: DOMRect): Vec2 | null => {
      let best: Vec2 | null = null;
      let bestD = Infinity;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      for (const rim of pickRef.current.rims) {
        for (let i = 0; i < rim.length; i++) {
          const u = rim[i]!;
          const v = rim[(i + 1) % rim.length]!;
          a.copy(u.at).project(camera);
          b.copy(v.at).project(camera);
          if (a.z > 1 || b.z > 1) continue;
          const ax = ((a.x + 1) / 2) * rect.width;
          const ay = ((1 - a.y) / 2) * rect.height;
          const bx = ((b.x + 1) / 2) * rect.width;
          const by = ((1 - b.y) / 2) * rect.height;
          const dx = bx - ax;
          const dy = by - ay;
          const len2 = dx * dx + dy * dy;
          const t = len2 > 1e-9
            ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
            : 0;
          const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
          if (d < bestD) {
            bestD = d;
            best = [u.p[0] + t * (v.p[0] - u.p[0]), u.p[1] + t * (v.p[1] - u.p[1])];
          }
        }
      }
      return best;
    };

    const paperUnder = (e: PointerEvent): Vec2 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      lastSheet = null;
      const caught = spotNearPointer(px, py, rect);
      if (caught) {
        lastKind = caught.kind;
        pickRef.current.onSnap?.(caught.kind);
        return caught.p;
      }

      ray.setFromCamera(ndc, camera);
      for (const hit of ray.intersectObjects(group.children, false)) {
        const sheet = (hit.object.userData as { sheet?: Float32Array }).sheet;
        const toView = (hit.object.userData as { toView?: (p: Vec2) => Vec2 }).toView;
        if (!sheet || !toView || !hit.face) continue;
        const pos = (hit.object as THREE.Mesh).geometry.getAttribute('position');
        const corner = (i: number) =>
          new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))
            .applyMatrix4(hit.object.matrixWorld);
        const a = corner(hit.face.a);
        const b = corner(hit.face.b);
        const c = corner(hit.face.c);
        const w = new THREE.Vector3();
        THREE.Triangle.getBarycoord(hit.point, a, b, c, w);
        const at = (i: number): Vec2 => [sheet[i * 2]!, sheet[i * 2 + 1]!];
        const pa = at(hit.face.a);
        const pb = at(hit.face.b);
        const pc = at(hit.face.c);
        lastSheet = [
          pa[0] * w.x + pb[0] * w.y + pc[0] * w.z,
          pa[1] * w.x + pb[1] * w.y + pc[1] * w.z,
        ];
        const raw = toView(lastSheet);
        /*
         * Snap in the paper's own units, but with a reach measured on screen.
         *
         * Thirteen pixels is thirteen pixels however close the camera is; in
         * paper terms that is a wide net when zoomed out and a fine one when
         * zoomed in, which is the behaviour the flat view already has and the
         * only one that feels the same at every magnification.
         */
        const perPixel = (2 * hit.distance * Math.tan((camera.fov * Math.PI) / 360))
          / Math.max(1, rect.height);
        lastPerPixel = perPixel;
        const settled = resolveSnap(pickRef.current.snaps, raw, 13 * perPixel,
          pickRef.current.snapMm);
        lastKind = settled.snap?.kind ?? null;
        pickRef.current.onSnap?.(lastKind);
        return settled.p;
      }

      // Nothing under the pointer: the nearest edge of the paper is meant.
      const rim = rimNearPointer(px, py, rect);
      if (rim) {
        /*
         * A slightly wider net once the pointer is off the paper.
         *
         * Out here there is nothing to aim at but the sheet's own features, so
         * pointing past a corner means that corner - keeping the on-paper
         * reach would land a hair down the edge instead, and a diagonal
         * measured corner to corner would read 358 where the sheet is 364.
         *
         * Only slightly, though. It was four times the on-paper reach, which
         * was harmless while the sheet filled the view but became grabby as
         * soon as it was folded down narrow: most of the panel is then off the
         * paper, and a net that wide swallowed midpoints from half a sheet
         * away.
         */
        const settled = resolveSnap(pickRef.current.snaps, rim, 18 * lastPerPixel,
          pickRef.current.snapMm);
        lastKind = settled.snap?.kind ?? null;
        pickRef.current.onSnap?.(lastKind);
        return settled.p;
      }
      lastKind = null;
      pickRef.current.onSnap?.(null);
      return null;
    };

    let downAt: { x: number; y: number; paper: Vec2 | null } | null = null;
    let holding: Vec2 | null = null;
    const onDown = (e: PointerEvent) => {
      const paper = pickRef.current.picking ? paperUnder(e) : null;
      downAt = { x: e.clientX, y: e.clientY, paper };
      holding = null;
      // Nothing but the select tool turns the paper over.
      if (!pickRef.current.orbit) controls.enabled = false;
      if (!paper) return;
      // A drag that starts on the paper belongs to the tool, not the camera -
      // and if it started on something, to that thing.
      if (pickRef.current.dragDraws) { controls.enabled = false; return; }
      if (pickRef.current.onGrab?.(paper)) {
        holding = paper;
        controls.enabled = false;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pickRef.current.picking) return;
      if (holding) {
        const to = paperUnder(e);
        if (to) pickRef.current.onGrabMove?.(holding, to);
        return;
      }
      const p = paperUnder(e);
      if (!p) pickRef.current.onSnap?.(null);
      pickRef.current.onHover?.(p, p ? lastKind : null, p ? lastSheet : null);
    };
    const onUp = (e: PointerEvent) => {
      const from = downAt;
      const wasHolding = holding;
      downAt = null;
      holding = null;
      controls.enabled = pickRef.current.orbit;
      if (wasHolding) { pickRef.current.onGrabEnd?.(); return; }
      if (!from || !pickRef.current.picking) return;
      const moved = Math.hypot(e.clientX - from.x, e.clientY - from.y);

      // A drag that began on the paper, with a tool that draws: one gesture,
      // one line. Four pixels of slop so a click is never read as a drag.
      if (moved > 4) {
        if (from.paper && pickRef.current.dragDraws) {
          const to = paperUnder(e);
          if (to) pickRef.current.onDrag?.(from.paper, to);
        }
        return;
      }
      const p = paperUnder(e);
      if (p) pickRef.current.onPick?.(p, lastPerPixel, lastKind, lastSheet);
      else pickRef.current.onSnap?.(null);
    };
    const onMenu = (e: MouseEvent) => {
      if (!pickRef.current.onContext) return;
      e.preventDefault();
      const fake = { clientX: e.clientX, clientY: e.clientY } as PointerEvent;
      pickRef.current.onContext(paperUnder(fake), { x: e.clientX, y: e.clientY });
    };
    /*
     * Zoom, with the wheel or a trackpad pinch, towards the point under the
     * pointer: that point stays put and the paper grows or shrinks round it,
     * the way a map zooms, so what you zoom in on is what you get closer to.
     */
    const zoomAbout = (anchor: THREE.Vector3, factor: number) => {
      const away = camera.position.distanceTo(controls.target);
      const next = Math.min(3, Math.max(0.01, away * factor));
      const k = next / (away || 1);
      controls.target.sub(anchor).multiplyScalar(k).add(anchor);
      camera.position.sub(anchor).multiplyScalar(k).add(anchor);
      camera.near = Math.max(0.0002, next * 0.02);
      camera.far = next * 20 + 1;
      camera.updateProjectionMatrix();
      controls.update();
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A pinch arrives as a wheel with ctrl held, in much smaller steps.
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      // Where the pointer's ray meets the plane through the target, square to the view.
      const normal = camera.getWorldDirection(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, controls.target);
      const anchor = ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? controls.target.clone();
      zoomAbout(anchor, factor);
    };
    renderer.domElement.addEventListener('wheel', onWheel, { passive: false });
    onZoomReady?.((factor) => zoomAbout(controls.target.clone(), factor));
    renderer.domElement.addEventListener('contextmenu', onMenu);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerup', onUp);

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    // Folding a big flap over a diagonal throws paper well outside the original
    // sheet, so a fixed camera loses the model. Re-frame to whatever is there,
    // keeping the direction the user is looking from.
    fitRef.current = () => {
      const box = new THREE.Box3().setFromObject(group);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      if (sphere.radius < 1e-6) return;
      const dir = camera.position.clone().sub(controls.target).normalize();
      const fov = (camera.fov * Math.PI) / 180;
      const distance = (sphere.radius / Math.sin(fov / 2)) * 1.25;
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).addScaledVector(dir, distance);
      camera.near = Math.max(0.001, distance - sphere.radius * 3);
      camera.far = distance + sphere.radius * 6;
      camera.updateProjectionMatrix();
      controls.update();
    };

    /*
     * Standard views.
     *
     * Each one keeps the distance the fit chose and only swings the camera, so
     * changing your angle on the model never changes its size on screen.
     */
    viewRef.current = (dir: [number, number, number]) => {
      const box = new THREE.Box3().setFromObject(group);
      const centre = box.isEmpty()
        ? new THREE.Vector3()
        : box.getBoundingSphere(new THREE.Sphere()).center;
      const away = camera.position.distanceTo(controls.target) || 0.5;
      controls.target.copy(centre);
      camera.position.copy(centre)
        .addScaledVector(new THREE.Vector3(...dir).normalize(), away);
      camera.updateProjectionMatrix();
      controls.update();
      fitRef.current?.();
    };

    onFitReady?.(() => fitRef.current?.());

    onSnapshotReady?.(() => {
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    });

    let raf = 0;
    const spot = new THREE.Vector3();
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
      // Labels follow their point on the paper, projected fresh each frame.
      const rect = renderer.domElement.getBoundingClientRect();
      for (const tag of tagsRef.current) {
        spot.copy(tag.at).project(camera);
        const visible = spot.z <= 1;
        tag.el.style.display = visible ? 'block' : 'none';
        if (!visible) continue;
        tag.el.style.left = `${((spot.x + 1) / 2) * rect.width}px`;
        tag.el.style.top = `${((1 - spot.y) / 2) * rect.height}px`;
      }
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener('contextmenu', onMenu);
      renderer.domElement.removeEventListener('wheel', onWheel);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerup', onUp);
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  useEffect(() => {
    const group = contentRef.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material | undefined)?.dispose();
    }

    const cx = model.width / 2;
    const cy = model.height / 2;

    let order = 0;
    const makeMesh = (
      positions: Float32Array,
      tint: number,
      emissive = 0x000000,
      /* The same triangles in sheet coordinates, for reading a click back. */
      sheet?: Float32Array,
      toView?: (p: Vec2) => Vec2,
      face: THREE.Side = THREE.DoubleSide,
      /*
       * Drawn over paper in the same plane. The flap a fold is about to move
       * lies exactly on the ply beneath it while the fold is set up; with the
       * same hair's-breadth bias as everything else the two took turns in the
       * depth buffer, and a one-ply fold's flap showed as stripes and a half.
       */
      onTop = false,
    ) => {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.computeVertexNormals();
      // A flat fold leaves plies coplanar to within a sheet of paper, which is
      // far below depth-buffer resolution at this camera range. Nudging them
      // apart is not enough on its own; the depth bias is what stops the
      // speckling where two faces occupy the same pixel.
      const mat = new THREE.MeshStandardMaterial({
        color: tint,
        emissive,
        side: face,
        roughness: 0.86,
        metalness: 0,
        // Smooth shading lets a thick stack read as one curved body rather
        // than a pile of separate slices.
        flatShading: false,
        /*
         * Just enough bias to separate paper that is genuinely in the same
         * plane, and no more.
         *
         * It used to climb by one for every mesh drawn - past a hundred on a
         * real model - and a bias that large buries a tenth of a millimetre
         * completely. Depth stopped meaning anything and the draw order
         * decided everything, so paper that really was underneath could be
         * painted over the top of what covered it: two mirror-image quarters
         * of the same nose came out one white and one dark. The plies already
         * stand off each other by their own thickness, so this is a fixed
         * hair's breadth, only enough to settle a dead heat.
         */
        polygonOffset: true,
        polygonOffsetFactor: -0.5,
        polygonOffsetUnits: -0.5,
        // The flap about to move lands exactly on paper of its own height: over
        // everything instead, and a little see-through, so it neither stripes
        // nor hides what it will cover.
        ...(onTop ? { depthTest: false, transparent: true, opacity: 0.8 } : {}),
      });
      order++;
      const mesh = new THREE.Mesh(geom, mat);
      if (onTop) mesh.renderOrder = 2;
      if (sheet && toView) mesh.userData = { sheet, toView };
      group.add(mesh);
    };

    if (mode === 'stack') {
      // Exploded stack: each ply floats at its own height, so the layering that
      // decides the plane's mass distribution is directly visible.
      const gap = Math.max(paper.thickness, 0.00035) * 6;
      // Each ply one above what it actually lies on, not above everything
      // listed before it - see stackLevels.
      const outlines = model.layers.map((layer) => layerOutline(layer));
      const levels = stackLevels(outlines);
      const top = Math.max(1, ...levels);
      model.layers.forEach((_, i) => {
        const poly = outlines[i]!.map((p) => [p[0] - cx, levels[i]! * gap, -(p[1] - cy)]);
        if (poly.length < 3) return;
        const t = levels[i]! / top;
        makeMesh(fan(poly), new THREE.Color().setHSL(0.58 - 0.12 * t, 0.35, 0.55 + 0.2 * t).getHex());
      });
      return;
    }

    /*
     * Folded: the real shape, every fold held at the angle it was made at.
     *
     * The plies arrive already standing off one another by their own depth in
     * the pile - real paper thickness, a tenth of a millimetre a ply - so this
     * adds nothing. It used to push them a further six calipers apart each,
     * which on a sixteen-ply dart came to nine millimetres of daylight between
     * the top and bottom of a stack that is only 1.6mm thick, and the model
     * read as sliced paper rather than folded paper. Coincident faces are kept
     * apart by the depth bias below instead, which costs no geometry.
     */
    // Body axes are x forward, y right, z down; three.js wants y up.
    const stand = reshaped(turned(attitude ?? ((p: Vec3): Vec3 => [p[1] - cy, p[0] - cx, p[2]]), turn), reshape);
    /*
     * The model is not turned round to show its back; it IS turned over.
     *
     * Flipping used to happen twice - once in the paper, where the step
     * mirrors the layout and reverses the pile, and again in the camera, which
     * spun round to look from the other side. The two cancelled in one
     * direction and doubled in the other, so 뒤집기 left the model looking
     * much as it had, upside down. The paper's own turn is the real one: it
     * replays, it reorders the pile, and it is what a hand does.
     */
    const half = (q: [number, number, number]): [number, number, number] => q;
    /*
     * Which way a face is wound, made to mean what it should.
     *
     * A triangle's front is decided by the order of its corners, and the chain
     * that carries paper to the screen can reverse that order without asking:
     * the view map is itself a reflection, and a ply that has been turned over
     * carries another. Two reflections cancel and one does not, so half the
     * model came out showing the wrong face of the paper - a plane whose two
     * wings are mirror images of each other rendered with one white and one
     * dark, which no folded sheet ever looks like.
     *
     * Guessing the correction from `mirrored` only moved the problem to the
     * other half. So nothing is guessed: the corners are put in the order that
     * makes the triangle's own normal agree with the normal the fold gave the
     * face, and after that the front side IS the front of the paper.
     */
    const facing = (q: readonly [number, number, number][]): Vec3 => {
      const u: Vec3 = [q[1]![0] - q[0]![0], q[1]![1] - q[0]![1], q[1]![2] - q[0]![2]];
      const v: Vec3 = [q[2]![0] - q[0]![0], q[2]![1] - q[0]![1], q[2]![2] - q[0]![2]];
      return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    };

    /*
     * A point of the sheet, read back into the folded view by the face it is
     * actually on.
     *
     * The plies drawn are not always the model's own: while a fold is being
     * set up they come from the model with that fold appended, which divides
     * faces and renumbers them. Looking the view up by the drawn ply's number
     * then took some other face's placement, and a click on the wing landed
     * nineteen centimetres off the paper on the far side of the fold line - so
     * the fold moved the half that was not pointed at. The sheet itself is
     * never renumbered: every point of it is on exactly one face of the model,
     * and that face says where it has been carried.
     */
    const sheetToView = state ? sheetReader(state) : (q: Vec2) => q;

    plies.forEach((ply) => {
      if (ply.points.length < 3) return;
      const toScene3 = (p: Vec3): [number, number, number] => {
        const q = stand(p);
        return half([q[1], -q[2], -q[0]]);
      };
      const pts = ply.points.map(toScene3);
      // The face's own normal, carried to the scene the same way its corners
      // were - as a direction, so from a pair of points rather than one.
      const nose = toScene3([
        ply.points[0]![0] + ply.normal[0] * 0.01,
        ply.points[0]![1] + ply.normal[1] * 0.01,
        ply.points[0]![2] + ply.normal[2] * 0.01,
      ]);
      const want: Vec3 = [nose[0] - pts[0]![0], nose[1] - pts[0]![1], nose[2] - pts[0]![2]];
      const got = facing(pts as readonly [number, number, number][]);
      // The sheet copy is read back by the same triangle indices, so it has to
      // be turned around with the corners or a click lands on the wrong paper.
      const outline = [...ply.outline];
      if (got[0] * want[0] + got[1] * want[1] + got[2] * want[2] < 0) {
        pts.reverse();
        outline.reverse();
      }
      // The same fan over the face's own outline on the paper, so a click can
      // be read straight back into the coordinates the fold machinery speaks.
      const sheet = state ? new Float32Array(fanPairs(outline)) : undefined;
      const toView = state ? sheetToView : undefined;
      /*
       * The back of the paper is darker than the front.
       *
       * Which face of the sheet you are looking at is the single most useful
       * thing to know while folding - it is how you tell a flap that has come
       * over from one that has not - and a sheet shaded the same on both sides
       * tells you nothing. Two meshes rather than one, because a material can
       * only carry a single colour: the front side takes the light tone, the
       * back the dark one, and a ply that has been turned over has them the
       * other way round so the paper's own front stays light throughout.
       */
      const moving = previewIndex >= 0 && ply.movedBy === previewIndex;
      if (moving) {
        makeMesh(fan(pts), 0x6fb2ff, 0x12395f, sheet, toView, THREE.DoubleSide, true);
      } else {
        /*
         * The same two sides for every ply.
         *
         * Each face is placed in space by a rigid motion, which does not
         * reverse a triangle's winding - so one geometric side always faces
         * along the face's normal and the other always away, whatever the
         * paper has been through. A flap that has come over has turned its
         * normal round with it, and that alone is what shows its other face.
         *
         * Flipping this assignment by handedness as well, as it used to,
         * cancelled that out exactly: the flap came over and still looked
         * white, so a finished fold left no trace of itself.
         */
        // A face's own front is the side its normal points along, and that is
        // the side you are looking at on paper that has not been turned over -
        // so the white belongs to FrontSide. It was the other way round, which
        // showed the dark tone on the body and white on the flap that had just
        // come over: the trace was there but back to front.
        /*
         * The corners are now wound to agree with each face's own normal, so
         * which material is which is settled once, here, by one fact: paper +z
         * points away from a camera looking down at the table, so the side you
         * see from above is the triangle's back. Before the winding was forced
         * this could not be settled at all - it came out right for half the
         * model and wrong for the other half, whichever way round it was put.
         */
        const light = THREE.BackSide;
        const dark = THREE.FrontSide;
        /*
         * Both halves carry the way back to the paper.
         *
         * A one-sided material is only hit by a ray from the side it faces, so
         * whichever of the two is the one you are looking at is the one the
         * pointer will find - and leaving it without the sheet coordinates
         * meant every click on the paper missed and fell through to the edge.
         */
        // White on top, the shaded side underneath: office paper, seen from
        // above, with enough of a step between the two to tell at a glance
        // which face of the sheet a flap is showing.
        /*
         * Thicker is darker, when asked.
         *
         * Most of what you see of an aeroplane is one or two plies - the
         * wings - and the thick parts are few, so the steps have to be big
         * where the counts are small: two plies read clearly darker than one,
         * three darker again, and from about a dozen on it no longer changes.
         * Both sides of the paper are dimmed alike, so front and back still
         * tell apart.
         */
        const dim = shadeByPile ? 1 - 0.6 * (1 - 0.72 ** (Math.max(1, ply.pile) - 1)) : 1;
        const tone = (hex: number) => new THREE.Color(hex).multiplyScalar(dim).getHex();
        makeMesh(fan(pts), tone(0xffffff), 0x000000, sheet, toView, light);
        makeMesh(fan(pts), tone(0xd3dceb), 0x000000, sheet, toView, dark);
      }
    });

    // Where a fold is closed, the paper goes round (see foldBands).
    {
      const sceneOf = (p: Vec3): [number, number, number] => {
        const q = stand(p);
        return half([q[1], -q[2], -q[0]]);
      };
      // Paper on the move, or a lifted copy shown over the model, is not joined yet.
      const tris = foldBands(plies, (ply) => previewIndex >= 0 && ply.movedBy === previewIndex).flatMap(sceneOf);
      if (tris.length) makeMesh(new Float32Array(tris), 0xe8ecf2, 0x000000, undefined, undefined, THREE.DoubleSide);
    }
  }, [model, plies, paper.thickness, mode, previewIndex, attitude, reshape, turn, state, shadeByPile]);

  /*
   * The fold being set up, drawn on the model itself.
   *
   * It is one straight line on the paper but a run of segments on the shape,
   * bending at every crease it crosses - which is exactly the information that
   * was missing when the line could only be drawn on the flat view.
   */
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    for (const child of [...overlay.children]) {
      overlay.remove(child);
      const o = child as THREE.Mesh | THREE.Line;
      o.geometry?.dispose();
      (o.material as THREE.Material | undefined)?.dispose();
    }
    labelsRef.current?.replaceChildren();
    tagsRef.current = [];
    const liveTags: Array<{ el: HTMLSpanElement; at: THREE.Vector3 }> = [];
    if (!state || mode !== 'folded') return;

    const cx = model.width / 2;
    const cy = model.height / 2;
    const stand = reshaped(turned(attitude ?? ((p: Vec3): Vec3 => [p[1] - cy, p[0] - cx, p[2]]), turn), reshape);
    const toScene = (p: Vec3): [number, number, number] => {
      const q = stand(p);
      return [q[1], -q[2], -q[0]];
    };

    /*
     * Marks drawn as ribbons rather than lines.
     *
     * WebGL gives every line a width of one pixel whatever you ask for, and a
     * hairline on near-white paper is no line at all. Three ships a fat-line
     * helper for this, which renders nothing here, so the marks are narrow
     * quads instead - real geometry, guaranteed to draw.
     *
     * The width comes from the model's own size, so a crease keeps the same
     * weight relative to the paper at the zoom the model opens at, which is
     * where nearly all the looking happens.
     */
    /*
     * The model's longest side. It was the span of every coordinate at once -
     * the least of any x, y or z to the greatest - which stays near the whole
     * sheet's size however small the folded model gets: the screen zooms in on
     * the smaller model and every line and dimension thickened fold by fold.
     */
    const reach = (() => {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const ply of plies) {
        for (const q of ply.points) {
          for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, q[k]!); hi[k] = Math.max(hi[k]!, q[k]!); }
        }
      }
      const side = Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
      return side > 0 ? side : 0.3;
    })();
    const normalOf = new Map<number, Vec3>();
    /*
     * Marks ride on the paper, not on the surface it was cut from.
     *
     * The plies stand off one another by their own thickness, and the marks
     * are placed by the same walk but from the mathematical sheet, which has
     * none - so a crease pressed into the fourth ply of a stack sat four
     * calipers away from it, and on a folded model the guide lines came away
     * from the paper altogether.
     */
    const liftOf = new Map<number, Vec3>();
    // The paper's own: a see-through copy drawn over the model shares its face's number and is not that face.
    for (const ply of plies) {
      if (normalOf.has(ply.face)) continue;
      normalOf.set(ply.face, ply.normal);
      liftOf.set(ply.face, ply.lift);
    }

    /*
     * One line where the paper has one, not one per ply.
     *
     * A crease pressed through a pile, or a span measured across it, is
     * traced on every ply it passes through - right for knowing where it is,
     * but drawn that way it was a bundle of copies a hair apart, stacked by
     * the plies' own thickness, and read as a line drawn over and over. Where
     * copies lie on the same stretch of the sheet's surface only the one on
     * the ply nearest the eye is kept.
     */
    const onTopOnly = (segs: Array<{ a: Vec3; b: Vec3; face: number }>) => {
      const best = new Map<string, { a: Vec3; b: Vec3; face: number }>();
      const height = (face: number) => {
        const l = liftOf.get(face) ?? [0, 0, 0];
        return Math.hypot(l[0], l[1], l[2]);
      };
      for (const seg of segs) {
        const ends = [seg.a, seg.b].map((q) => q.map((v) => Math.round(v * 1e5)).join(',')).sort();
        const key = ends.join('|');
        const had = best.get(key);
        if (!had || height(seg.face) > height(had.face)) best.set(key, seg);
      }
      return [...best.values()];
    };

    const addRibbon = (
      segs: Array<{ a: Vec3; b: Vec3; face: number }>,
      out: number[],
      halfWidth: number,
    ) => {
      for (const seg of segs) {
        const n = normalOf.get(seg.face) ?? [0, 0, 1];
        const along: Vec3 = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1], seg.b[2] - seg.a[2]];
        // Across the mark, in the plane of the paper it sits on.
        const w: Vec3 = [
          n[1] * along[2] - n[2] * along[1],
          n[2] * along[0] - n[0] * along[2],
          n[0] * along[1] - n[1] * along[0],
        ];
        const len = Math.hypot(w[0], w[1], w[2]);
        if (len < 1e-12) continue;
        const off: Vec3 = [
          (w[0] / len) * halfWidth, (w[1] / len) * halfWidth, (w[2] / len) * halfWidth,
        ];
        const up = liftOf.get(seg.face) ?? [0, 0, 0];
        const shift = (q: Vec3, k: number): Vec3 =>
          [q[0] + off[0] * k + up[0], q[1] + off[1] * k + up[1], q[2] + off[2] * k + up[2]];
        const p1 = toScene(shift(seg.a, 1));
        const p2 = toScene(shift(seg.a, -1));
        const p3 = toScene(shift(seg.b, -1));
        const p4 = toScene(shift(seg.b, 1));
        out.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
      }
    };

    /*
     * `through`: drawn over everything at full strength, under flaps too -
     * the line being set up and the one just folded. The pressed creases and
     * the dimensions are drawn full where their paper can be seen and faint
     * where other paper lies over them, as a drawing shows a hidden line.
     */
    const addMesh = (pts: number[], color: number, opacity = 1, through = true, hiddenPts: number[] = pts) => {
      if (pts.length === 0) return;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
      if (!through) {
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
          color, side: THREE.DoubleSide, transparent: opacity < 1, opacity,
          // Just enough to sit on its own face; no more, or it shows through the ply a tenth of a millimetre above.
          polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        }));
        mesh.renderOrder = 2;
        overlay.add(mesh);
        if (hiddenPts.length === 0) return;
        // And faintly through the paper over it: the lines under a flap, as a hidden line is drawn.
        const hiddenGeom = hiddenPts === pts ? geom : new THREE.BufferGeometry();
        if (hiddenGeom !== geom) hiddenGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hiddenPts), 3));
        const hidden = new THREE.Mesh(hiddenGeom, new THREE.MeshBasicMaterial({
          color, side: THREE.DoubleSide, transparent: true, opacity: opacity * 0.3,
          depthTest: false, depthWrite: false,
        }));
        hidden.renderOrder = 3;
        overlay.add(hidden);
        return;
      }
      /*
       * Drawn last of all, over the see-through flap a fold is about to move
       * as well. Three.js draws everything opaque before anything see-through,
       * whatever the render order says - so an opaque line went down first and
       * the lit flap was laid over it, and the line being drawn vanished under
       * the paper. Marked see-through, the lines sort after the flap.
       */
      const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        color, side: THREE.DoubleSide, transparent: true, opacity,
        depthTest: false, depthWrite: false,
      }));
      mesh.renderOrder = 3;
      overlay.add(mesh);
    };

    /*
     * Every crease, drawn on the paper it was pressed into.
     *
     * Over the paper rather than nudged off its surface: nudging along the face
     * normal only works when that normal happens to point at the camera, and
     * half of them never do - which is exactly why a pressed crease was
     * invisible from the view the model opens in. Letting the marks through the
     * depth test also shows the ones under a flap, which is what you want to
     * know before deciding where the next fold goes.
     */
    /*
     * Each kind of line in the code the books use: dashed toward you, dash-dot
     * away, and so on (see lineKinds). The pattern runs on along a crease as it
     * crosses from face to face, so a line bent over a fold keeps its rhythm.
     */
    const unit = reach * 0.0022;
    const dashed = (segs: Array<{ a: Vec3; b: Vec3; face: number }>, pattern: readonly number[]) => {
      if (pattern.length === 0) return segs;
      const out: Array<{ a: Vec3; b: Vec3; face: number }> = [];
      let slot = 0;
      let left = pattern[0]! * unit;
      for (const seg of segs) {
        const d: Vec3 = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1], seg.b[2] - seg.a[2]];
        const len = Math.hypot(d[0], d[1], d[2]);
        let at = 0;
        while (at < len - 1e-12) {
          const step = Math.min(left, len - at);
          if (slot % 2 === 0) {
            const p = (t: number): Vec3 => [seg.a[0] + d[0] * t, seg.a[1] + d[1] * t, seg.a[2] + d[2] * t];
            out.push({ a: p(at / len), b: p((at + step) / len), face: seg.face });
          }
          at += step;
          left -= step;
          if (left <= 1e-12) {
            slot = (slot + 1) % pattern.length;
            left = pattern[slot]! * unit;
          }
        }
      }
      return out;
    };
    /*
     * A crease folded shut is the edge of the paper now, and the round band
     * drawn there is the fold: a ribbon along it as well, on every ply of a
     * nose rolled twenty deep, made the edge a solid stripe. A crease lying
     * on the face's own edge, where the paper beyond it is turned back over
     * (its normal facing the other way), is left to the band.
     */
    const sheetFaces = state.graph.faces_vertices.map((loop) => loop.map((v) => state.graph.vertices_coords[v]!));
    const onEdge = (poly: readonly Vec2[], p: Vec2, q: Vec2): [Vec2, Vec2] | null => {
      for (let i = 0; i < poly.length; i++) {
        const u = poly[i]!; const v = poly[(i + 1) % poly.length]!;
        const dx = v[0] - u[0]; const dy = v[1] - u[1];
        const L = Math.hypot(dx, dy) || 1;
        const off = (r: Vec2) => Math.abs((r[0] - u[0]) * dy - (r[1] - u[1]) * dx) / L;
        // On the edge itself, not just on the line it runs along: a crease carries on across faces folded far away.
        const along = (r: Vec2) => ((r[0] - u[0]) * dx + (r[1] - u[1]) * dy) / (L * L);
        const within = (r: Vec2) => along(r) > -1e-6 && along(r) < 1 + 1e-6;
        if (off(p) < 1e-6 && off(q) < 1e-6 && within(p) && within(q)) return [u, v];
      }
      return null;
    };
    const closedEdge = (face: number, p: Vec2, q: Vec2): boolean => {
      const edge = onEdge(sheetFaces[face]!, p, q);
      if (!edge) return false;
      const n = normalOf.get(face);
      if (!n) return false;
      const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      for (let other = 0; other < sheetFaces.length; other++) {
        if (other === face || !onEdge(sheetFaces[other]!, mid, mid)) continue;
        const m = normalOf.get(other);
        if (m && n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < -0.5) return true;
      }
      return false;
    };
    const byKind = new Map<LineKind, number[]>();
    const latest: number[] = [];
    /*
     * Seen through the paper, one line where the eye sees one: a crease
     * pressed through a pile, every ply of it a hair from the next, showed
     * through as a line drawn over and over and thickened with every fold.
     * Lines lying within a millimetre of each other, the same way, are shown
     * through once.
     */
    const hiddenByKind = new Map<LineKind, number[]>();
    const seenThrough = new Set<string>();
    const throughKey = (a: Vec2, b: Vec2) => {
      const ang = ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 180) % 180;
      return `${Math.round(((a[0] + b[0]) / 2) * 1000)},${Math.round(((a[1] + b[1]) / 2) * 1000)},${Math.round(ang / 3) % 60}`;
    };
    for (const c of creases ?? []) {
      const style = LINE_STYLES[c.kind];
      // On the paper it was pressed into, where the sheet says it is.
      const segs = c.sheetA && c.sheetB
        ? segmentInSpace(state, c.sheetA, c.sheetB, true).filter((g) => !closedEdge(g.face, g.sa, g.sb))
        : onTopOnly(segmentInSpace(state, c.a, c.b));
      if (c.latest) addRibbon(segs, latest, reach * 0.0026);
      const list = byKind.get(c.kind) ?? [];
      const ribbon = dashed(segs, style.dash);
      addRibbon(ribbon, list, reach * 0.0011 * style.weight);
      byKind.set(c.kind, list);
      const key = `${c.kind}:${throughKey(c.a, c.b)}`;
      if (!seenThrough.has(key)) {
        seenThrough.add(key);
        const hidden = hiddenByKind.get(c.kind) ?? [];
        addRibbon(ribbon, hidden, reach * 0.0011 * style.weight);
        hiddenByKind.set(c.kind, hidden);
      }
    }
    // Under the line itself, so the dashes still read on top of the glow.
    if (latest.length > 0) addMesh(latest, LATEST_STYLE.tint, 0.55);
    for (const [kind, pts] of byKind) {
      addMesh(pts, LINE_STYLES[kind].tint, kind === 'crease' ? 0.85 : 1, false, hiddenByKind.get(kind) ?? []);
    }

    /*
     * The cut edges of the paper, drawn as a crease pattern draws its border.
     *
     * A flap folded back over the paper shows where it ends by its edge - on
     * real paper there is a shadow along it. Shaded only, a pocket squashed
     * flat came out as a dark wedge with no outline, and what had been folded
     * where could not be read. Hidden where paper lies over them: only the
     * edges you would see.
     */
    {
      const W = model.width;
      const H = model.height;
      const tol = 1e-6;
      const onBorder = (p: Vec2, q: Vec2) =>
        (Math.abs(p[0]) < tol && Math.abs(q[0]) < tol) || (Math.abs(p[0] - W) < tol && Math.abs(q[0] - W) < tol)
        || (Math.abs(p[1]) < tol && Math.abs(q[1]) < tol) || (Math.abs(p[1] - H) < tol && Math.abs(q[1] - H) < tol);
      const pts: number[] = [];
      const halfWidth = reach * 0.0008;
      for (const ply of plies) {
        const n = ply.normal;
        const k = ply.outline.length;
        for (let i = 0; i < k; i++) {
          const a2 = ply.outline[i]!;
          const b2 = ply.outline[(i + 1) % k]!;
          if (!onBorder(a2, b2)) continue;
          const pa = ply.points[i]!;
          const pb = ply.points[(i + 1) % k]!;
          const along: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
          const w: Vec3 = [n[1] * along[2] - n[2] * along[1], n[2] * along[0] - n[0] * along[2], n[0] * along[1] - n[1] * along[0]];
          const len = Math.hypot(w[0], w[1], w[2]);
          if (len < 1e-12) continue;
          // Stood a hair off both faces of the paper, so it shows from either side.
          const lift = reach * 0.0015;
          for (const side of [1, -1]) {
            const off = (q: Vec3, t: number): Vec3 => [
              q[0] + (w[0] / len) * halfWidth * t + n[0] * lift * side,
              q[1] + (w[1] / len) * halfWidth * t + n[1] * lift * side,
              q[2] + (w[2] / len) * halfWidth * t + n[2] * lift * side,
            ];
            const p1 = toScene(off(pa, 1));
            const p2 = toScene(off(pa, -1));
            const p3 = toScene(off(pb, -1));
            const p4 = toScene(off(pb, 1));
            pts.push(...p1, ...p2, ...p3, ...p1, ...p3, ...p4);
          }
        }
      }
      if (pts.length > 0) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
          color: 0x1f2937, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        }));
        mesh.renderOrder = 1;
        overlay.add(mesh);
      }
    }

    /*
     * The fold being set up, drawn on the model itself.
     *
     * It is one straight line on the paper but a run of segments on the shape,
     * bending at every crease it crosses - which is exactly the information
     * that was missing when the line could only be drawn on a flat view.
     */
    if (guide) {
      let line: Line;
      try {
        line = lineThrough(guide.a, guide.b);
      } catch {
        line = { normal: [1, 0], offset: 0 };
      }
      const pts: number[] = [];
      addRibbon(lineInSpace(state, line), pts, reach * 0.0015);
      addMesh(pts, 0x6fb2ff);
    }

    if (rubber) {
      const segs = onTopOnly(segmentInSpace(state, rubber.a, rubber.b));
      const pts: number[] = [];
      addRibbon(segs, pts, reach * 0.0013);
      addMesh(pts, 0x1d6fd4, 0.95);
      // The length rides on the line itself, in centimetres, where the eye
      // already is - rather than in a corner of the screen.
      const seg = segs[0];
      if (seg && labelsRef.current) {
        const cm = Math.hypot(rubber.b[0] - rubber.a[0], rubber.b[1] - rubber.a[1]) * 100;
        const at = new THREE.Vector3(...toScene([
          (seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, (seg.a[2] + seg.b[2]) / 2,
        ]));
        const el = document.createElement('span');
        el.className = 'dim-tag live';
        el.textContent = `${cm.toFixed(1)}cm`;
        labelsRef.current.appendChild(el);
        liveTags.push({ el, at });
      }
    }

    /*
     * Creases picked out on the model.
     *
     * A crease is a piece of a line, not the whole of one, and it exists once
     * per ply it was pressed through - so it is clipped to each face it crosses
     * and drawn wherever it actually is.
     */
    for (const h of highlights ?? []) {
      const pts: number[] = [];
      addRibbon(onTopOnly(segmentInSpace(state, h.a, h.b)), pts, reach * (h.strong ? 0.0021 : 0.0017));
      /*
       * Thin lines have to earn their contrast.
       *
       * These used to be pale - a light amber and a light blue - which worked
       * when they were twice as wide. Halved, they washed out against paper
       * that is nearly white. Weight and contrast trade off against each
       * other, so taking one away means putting the other back.
       */
      addMesh(pts, h.strong ? 0xc2410c : 0x1d6fd4);
    }

    /*
     * Measured spans, with their lengths beside them.
     *
     * Drawn on every ply the span lies on, like a crease, because the point of
     * a dimension is to line the next fold up against the paper it is on.
     */
    const tags: Array<{ el: HTMLSpanElement; at: THREE.Vector3 }> = [...liveTags];
    const labels = labelsRef.current;
    /*
     * One label per measurement. A span is traced through every ply under it,
     * the way a pencil line would be, so once the pile is folded apart each ply
     * carries its own copy - and a tag on every copy scatters "7.0cm" all over
     * the model. The line stays on every ply; the number goes on the topmost.
     */
    const labelled = new Map<number, number>();
    (dimensions ?? []).forEach((d, i) => {
      if (d.step !== undefined) labelled.set(d.step, i);
    });
    for (const [i, d] of (dimensions ?? []).entries()) {
      const sheet = d.sheetA && d.sheetB ? { a: d.sheetA, b: d.sheetB } : null;
      const onPaper = (a: Vec2, b: Vec2) => (sheet ? segmentInSpace(state, a, b, true) : onTopOnly(segmentInSpace(state, a, b)));
      const segs = sheet ? onPaper(sheet.a, sheet.b) : onPaper(d.a, d.b);
      const pts: number[] = [];
      addRibbon(segs, pts, reach * 0.0013);

      /*
       * A tick across each end, the way a drawing closes a dimension off.
       *
       * Without them a span is a line lying on the paper with no telling where
       * it begins or ends, which is no use at all when the next fold is being
       * lined up against it - and lining the next thing up is the only reason
       * to measure something in the first place.
       */
      const ea = sheet ? sheet.a : d.a;
      const eb = sheet ? sheet.b : d.b;
      const dx = eb[0] - ea[0];
      const dy = eb[1] - ea[1];
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        const tick = 0.004;
        const px = (-dy / len) * tick;
        const py = (dx / len) * tick;
        for (const end of [ea, eb]) {
          addRibbon(onPaper([end[0] - px, end[1] - py], [end[0] + px, end[1] + py]), pts, reach * 0.0013);
        }
      }
      // A span measured on paper since rolled into a pile is shown where it can be seen, not through every turn of the roll.
      addMesh(pts, 0x0f7a57, 1, false, []);
      const mid = segs[0];
      if (!mid || !labels) continue;
      if (d.step !== undefined && labelled.get(d.step) !== i) continue;
      const at = new THREE.Vector3(...toScene([
        (mid.a[0] + mid.b[0]) / 2, (mid.a[1] + mid.b[1]) / 2, (mid.a[2] + mid.b[2]) / 2,
      ]));
      const el = document.createElement('span');
      el.className = 'dim-tag';
      el.textContent = `${(d.length * 100).toFixed(1)}cm`;
      labels.appendChild(el);
      tags.push({ el, at });
    }
    tagsRef.current = tags;

    for (const mark of marks ?? []) {
      const seen = new Set<string>();
      for (const face of state.graph.faces_vertices.map((_, i) => i)) {
        const spot = pointOnFace(state, face, mark);
        if (!spot) continue;
        const key = spot.map((v) => v.toFixed(5)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const dot = ringSprite('#1d6fd4');
        dot.scale.setScalar(reach * 0.026);
        dot.position.set(...toScene(spot));
        dot.renderOrder = 4;
        overlay.add(dot);
      }
    }
  }, [state, guide, rubber, marks, creases, dimensions, highlights, plies, model,
    attitude, reshape, turn, mode]);

  /*
   * Where each snap point actually is in space.
   *
   * The same point of the paper can be reachable on several plies at once, and
   * every one of them is a place the hand could touch, so each gets its own
   * spot. Rebuilt with the model rather than every frame: it only moves when
   * the paper does.
   */
  useEffect(() => {
    if (!state) { pickRef.current.spots = []; return; }
    const cx = model.width / 2;
    const cy = model.height / 2;
    const stand = reshaped(turned(attitude ?? ((p: Vec3): Vec3 => [p[1] - cy, p[0] - cx, p[2]]), turn), reshape);
    const out: Array<{ p: Vec2; kind: SnapPoint['kind']; at: THREE.Vector3 }> = [];
    for (const snap of snaps ?? []) {
      if (snap.kind === 'grid') continue;
      const seen = new Set<string>();
      for (let face = 0; face < state.graph.faces_vertices.length; face++) {
        const spot = pointOnFace(state, face, snap.p);
        if (!spot) continue;
        const key = spot.map((v) => v.toFixed(5)).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        const q = stand(spot);
        out.push({ p: snap.p, kind: snap.kind,
          at: new THREE.Vector3(...[q[1], -q[2], -q[0]]) });
      }
    }
    pickRef.current.spots = out;

    // The outline of every face, for clamping a pointer that has run off.
    const rims: Array<Array<{ at: THREE.Vector3; p: Vec2 }>> = [];
    const readView = sheetReader(state);
    for (const ply of plies) {
      if (ply.points.length < 3) continue;
      rims.push(ply.points.map((q, i) => {
        const w = stand(q);
        return {
          at: new THREE.Vector3(...[w[1], -w[2], -w[0]]),
          p: readView(ply.outline[i] ?? ply.outline[0]!),
        };
      }));
    }
    pickRef.current.rims = rims;
  }, [state, snaps, plies, model, attitude, reshape, turn]);

  // Re-frame once the motion has finished, so the camera does not chase the
  // flap through its swing.
  useEffect(() => {
    if (animating || lastFitRef.current === fitKey) return;
    lastFitRef.current = fitKey;
    fitRef.current?.();
  }, [fitKey, animating, mode, plies, turn]);

  /*
   * The views are named for the aeroplane, not the screen.
   *
   * 앞에서 is looking at the nose, and 비스듬히 has the nose toward you and to
   * the left. Stood up in its flight attitude the nose points into the screen
   * rather than out of it, so the same camera directions showed the tail from
   * 앞에서 and the nose running away from 비스듬히. Turned half round about
   * the vertical, they name the same sides of the aeroplane in both poses.
   */
  const aimed = (d: readonly [number, number, number]): [number, number, number] =>
    (attitude ? [-d[0], d[1], -d[2]] : [d[0], d[1], d[2]]);

  // A requested view, applied once the model it is for has been built.
  const lastViewRef = useRef<number>(-1);
  useEffect(() => {
    if (!view || animating || lastViewRef.current === view.key) return;
    lastViewRef.current = view.key;
    viewRef.current?.(aimed(view.dir));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, animating, plies]);

  return (
    <div className={`stage3d${picking ? ' picking' : ''}`} ref={mountRef}>
      {picking && prompt && <span className="stage-hud">{prompt}</span>}
      <div className="dim-labels" ref={labelsRef} />
      {!hideViewControls && <div className="view-cube">
        {VIEWS.map(([name, dir]) => (
          <button key={name}
            onClick={() => viewRef.current?.(aimed(dir))}>{name}</button>
        ))}
      </div>}
      {/*
        * What the lines mean, for the kinds this model has - a pupil reads the
        * code off the model the way they read it off the book.
        */}
      {creases && creases.length > 0 && (
        <div className="line-legend">
          {LINE_ORDER.filter((k) => creases.some((c) => c.kind === k)).map((k) => (
            <div key={k} title={LINE_STYLES[k].hint}>
              <svg width="28" height="8"><line x1="1" y1="4" x2="27" y2="4"
                stroke={LINE_STYLES[k].css} strokeWidth={2 * LINE_STYLES[k].weight}
                strokeDasharray={LINE_STYLES[k].dash.join(' ') || undefined} /></svg>
              <span>{LINE_STYLES[k].label}</span>
            </div>
          ))}
          {creases.some((c) => c.latest) && (
            <div>
              <svg width="28" height="8"><line x1="1" y1="4" x2="27" y2="4"
                stroke={LATEST_STYLE.css} strokeWidth="5" strokeOpacity="0.6" /></svg>
              <span>{LATEST_STYLE.label}</span>
            </div>
          )}
        </div>
      )}
      {!hideViewControls && <button className="fit-btn" onClick={() => fitRef.current?.()}>화면 맞춤</button>}
    </div>
  );
}
