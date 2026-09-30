import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SHEET_SIZES, paperProps } from '../paper/stock.js';
import { ALL_PLIES, affineApply, affineIdentity, affineInverse, layerOutline, pointInPolygon } from '../geometry/fold.js';
import type { PlySelection } from '../geometry/fold.js';
import type { Vec2, Vec3 } from '../geometry/math.js';
import { Dieline } from './Dieline.js';
import { OBLIQUE, Stage3D, VIEWS } from './Stage3D.js';
import type { StageMode } from './Stage3D.js';
import { PlyPicker } from './PlyPicker.js';
import { StepInspector } from './StepInspector.js';
import { FoldChooser } from './FoldChooser.js';
import { ScrubNumber } from './ScrubNumber.js';
import { WorkBar } from './WorkBar.js';
import { ContextMenu } from './ContextMenu.js';
import type { MenuItem } from './ContextMenu.js';
import { alignFold } from '../geometry/constructions.js';
import { senseMark } from './senses.js';
import { bodyAndWings, cm, foldStats, isFold, keelLines, foldEdges, pickAt, rollRetreat, PRESETS, replay, snapPoints } from './foldSession.js';
import type { FoldStep, PatternLine, SnapPoint, Step } from './foldSession.js';

/** What each kind of snap is called, for the line that says what it caught. */
const SNAP_NAMES: Record<SnapPoint['kind'], string> = {
  corner: '모서리',
  mark: '기준점',
  midpoint: '중점',
  crease: '자국',
  grid: '격자',
};
import { useFoldTool } from './useFoldTool.js';
import type { PaperPoint, Tool } from './useFoldTool.js';
import { useAnimatedPlies } from './useAnimatedPlies.js';
import { renderFaces, turnedFromViewerAt } from '../origami/space.js';
import { faceUnder } from '../origami/folding.js';
import { collapsePattern } from '../origami/collapse.js';
import { buildAirframe, noseStretch } from '../aero/airframe.js';
import { measurePlane } from '../aero/spec.js';
import { noseBulge } from '../aero/flight.js';
import { bendElevator, defaultElevator } from './elevator.js';
import { cardFlightLater, recommendAngleLater, recommendLater, recommendThrowLater } from './flightJobs.js';
import { pliesAtLine, pliesUnderLine, pocketHinges, pocketOptions } from '../origami/pocket.js';
import type { PocketOption } from '../origami/pocket.js';
import type { FoldedState } from '../origami/folding.js';
import { faceOutline } from '../origami/folding.js';
import { PocketChooser } from './PocketChooser.js';
import type { ElevatorTune } from './elevator.js';
import { FlightPanel } from './FlightPanel.js';
import { statsKey, statsNow } from './flightStats.js';
import { DEFAULT_FLIGHT, canFly, flightBase, flightReport, flyingVee, liftWings } from './flightReport.js';
import type { FlightSettings } from './flightReport.js';
import { drawFlightPage, drawModelPage, drawPatternPage, pagesToPdf } from './exportSheets.js';
import { dihedralSteps, wingletSteps } from './winglets.js';
import type { DihedralBreak } from './winglets.js';
import { identityViewport, zoomViewport } from './viewport.js';
import type { Viewport } from './viewport.js';
import { openText, saveDataUrl, saveText, stamped } from './saveImage.js';
import { creasePatternFile, readFoldFile } from '../origami/foldFile.js';
import { readSessionFile, sessionFile } from './sessionFile.js';
import { dropPlane, hiddenBook, hideBook, readShelf, sameName, shelvePlane } from './planeLibrary.js';
import { BOOK_PLANES } from './bookPlanes.js';
import { bookRecord } from './planeCard.js';
import { PlaneList } from './PlaneList.js';
import { lineKindOf } from './lineKinds.js';
import type { BookPlane } from './PlaneList.js';
import type { SavedPlane } from './planeLibrary.js';
import type { FoldGraph } from '../origami/graph.js';


/*
 * Each screen has an address, and so does the plane on it: the list, and the
 * folded model, the pattern and the flying screen of a named plane. A reload
 * or a link lands on the same screen of the same plane, read from that
 * plane's one record - nothing else is kept.
 */
const ROUTES: Record<string, string> = {
  'list:model': '#/', 'fold:model': '#/fold', 'fold:dieline': '#/pattern', 'fold:flight': '#/fly',
};
const parseHash = (hash: string): { place: string; plane: string | null } | null => {
  const m = /^#\/(fold|pattern|fly)?(?:\/(.+))?$/.exec(hash || '#/');
  if (!m) return hash === '' ? { place: 'list:model', plane: null } : null;
  const place = m[1] === 'fold' ? 'fold:model' : m[1] === 'pattern' ? 'fold:dieline' : m[1] === 'fly' ? 'fold:flight' : 'list:model';
  let plane: string | null = null;
  try { plane = m[2] ? decodeURIComponent(m[2]) : null; } catch { plane = null; }
  return { place, plane };
};
const placeOfHash = (hash: string): string | null => parseHash(hash)?.place ?? null;
// Read once, as the page opens - before anything rewrites the address.
const START_ROUTE = parseHash(window.location.hash);
const startPlace = (): string =>
  new URLSearchParams(window.location.search).get('open') ? 'fold:model'
    : placeOfHash(window.location.hash) ?? 'list:model';


/**
 * How far the paper under a line, as it lies now, ends up from another line
 * once folded to `after` - the nearest of the plies the line is drawn over,
 * metres. Infinity when none of it can be followed.
 */
function laysOn(before: FoldedState, after: FoldedState, line: readonly [Vec2, Vec2], onto: readonly [Vec2, Vec2]): number {
  const at = (t: number): Vec2 => [line[0][0] + (line[1][0] - line[0][0]) * t, line[0][1] + (line[1][1] - line[0][1]) * t];
  const probes = [at(0.15), at(0.85)];
  const [o0, o1] = onto;
  const ox = o1[0] - o0[0]; const oy = o1[1] - o0[1]; const on = Math.hypot(ox, oy) || 1;
  const off = (q: Vec2) => Math.abs((q[0] - o0[0]) * oy - (q[1] - o0[1]) * ox) / on;
  const landed = (q: Vec2): Vec2 | null => {
    const g = after.graph;
    const f = g.faces_vertices.findIndex((loop) => pointInPolygon(loop.map((v) => g.vertices_coords[v]!), q));
    return f < 0 ? null : affineApply(after.faces_matrix[f]!, q);
  };
  const faces = (q: Vec2) => before.faces_order.filter((f) => pointInPolygon(faceOutline(before, f), q));
  return Math.min(Infinity, ...faces(probes[0]!).map((f) => {
    const inv = affineInverse(before.faces_matrix[f]!);
    return Math.max(...probes.map((q) => {
      const l = landed(affineApply(inv, q));
      return l ? off(l) : Infinity;
    }));
  }));
}


/*
 * How many plies a fold takes off the top, when it takes some and not all -
 * the plies that can open a pocket where they are joined to the paper under
 * them. Counted at the line (the fold bar's 1겹) or off the top of the pile
 * (겹 선택's 위에서): either way the top plies go, and either way a pocket
 * they open is asked about. Null for any other fold.
 */
function pocketCount(plies: PlySelection | undefined): number | null {
  return plies && (plies.kind === 'stack' || plies.kind === 'top') ? plies.count : null;
}

export function App() {
  const [sizeId, setSizeId] = useState('a4');
  // 90 g/m2 is the stock these are folded from here.
  const [gsm, setGsm] = useState(90);
  const [steps, setSteps] = useState<Step[]>([]);
  /*
   * History as snapshots of the whole script.
   *
   * It used to be a tail: undo took the last step off and redo put it back,
   * which meant that changing a fold's angle or deleting one from the middle
   * could not be undone at all. A snapshot before every edit costs a few
   * kilobytes and makes every edit reversible, including the ones made from
   * the right-click menu and the step list.
   */
  const [past, setPast] = useState<Step[][]>([]);
  const [future, setFuture] = useState<Step[][]>([]);
  /** Steps picked out in the list, the way a layers panel works. */
  const [marked, setMarked] = useState<ReadonlySet<number>>(new Set());
  // Bumped when the whole model is replaced, which is when re-framing helps.
  const [fitToken, setFitToken] = useState(0);
  // The paper turned on the table, quarter turns: how it lies, not how it is folded.
  const [paperTurn, setPaperTurn] = useState(0);
  const reframe = useCallback(() => setFitToken((v) => v + 1), []);
  // A view to swing to once: opening a plane to fold shows it from above, the
  // way paper lies on the table to be folded - the list's cards show it at an angle.
  const [view, setView] = useState<{ key: number; dir: readonly [number, number, number] }>();
  const showAsPlane = useCallback(
    () => setView((v) => ({ key: (v?.key ?? 0) + 1, dir: OBLIQUE })), []);
  const anchorRef = useRef<number | null>(null);
  // Pointing at what is there is the safe first thing; drawing is a choice.
  const [tool, setTool] = useState<Tool>('select');
  const [snapMm, setSnapMm] = useState(5);
  /*
   * How far a pleat folds back, millimetres.
   *
   * It used to be typed into a "그 밖의 기준선" box that also drove a guide-crease
   * macro. The macro is gone - the keel does that job with two numbers instead
   * of one - and a pleat is rare enough not to earn a permanent field, so the
   * distance is fixed here until one is asked for.
   */
  const PLEAT_SPACING_MM = 15;
  // The fuselage, in centimetres as the tutorials quote it.
  const [keelFrontCm, setKeelFrontCm] = useState(1.5);
  const [keelBackCm, setKeelBackCm] = useState(1.5);
  // How far the wings come down from the fuselage, degrees.
  const [wingDeg, setWingDeg] = useState(80);
  const [wingletCm, setWingletCm] = useState(1);
  // Which fold's measurements are open under its button, if any.
  const [macroAt, setMacroAt] = useState({ top: 140, left: 280 });
  const [macroOpen, setMacroOpen] = useState<'keelLines' | 'bodyWings' | 'winglet' | 'dihedral' | null>(null);
  // Two- or three-stage dihedral: breaks measured in from each wing tip.
  const [dihStage, setDihStage] = useState<2 | 3>(2);
  const [dihBreaks, setDihBreaks] = useState<DihedralBreak[]>([{ fromTipCm: 4, angleDeg: 15 }, { fromTipCm: 7, angleDeg: 10 }]);
  // The elevator: a tuning beside the fold script, drawn as a bend.
  const [elevOn, setElevOn] = useState(false);
  // The recommended elevator the plane was saved with, until it is worked out afresh.
  const [savedAuto, setSavedAuto] = useState<ElevatorTune | null>(null);
  const [elevEdit, setElevEdit] = useState<Partial<ElevatorTune>>({});
  const [mode, setMode] = useState<StageMode>('folded');
  const [showDieline, setShowDieline] = useState(() => startPlace() === 'fold:dieline');
  const [showFlight, setShowFlight] = useState(() => startPlace() === 'fold:flight');
  // The throw chosen on the flying screen, kept here so it survives the
  // screen closing and goes into the download.
  const [flightSettings, setFlightSettings] = useState<FlightSettings>(DEFAULT_FLIGHT);
  const [downloadOpen, setDownloadOpen] = useState(false);
  // The pattern shown one step at a time: how many steps are in it, or all.
  const [patternAt, setPatternAt] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  // What the last press of 저장 kept, so the pupil sees the whole aeroplane
  // went onto the shelf and not just its name.
  const [shelved, setShelved] = useState<{ name: string; count: number } | null>(null);
  // A finished plane is covered in the marks of everything it has been.
  const [showCreases, setShowCreases] = useState(true);
  // Paper shaded darker where more plies are stacked.
  const [shadePile, setShadePile] = useState(true);
  /*
   * Two screens: choosing a plane, and folding one. A link that opens a plane
   * goes straight to folding it; otherwise the app starts on the list.
   */
  const [screen, setScreen] = useState<'list' | 'fold'>(() => (startPlace().startsWith('fold') ? 'fold' : 'list'));

  /*
   * The browser's back and forward buttons, between the app's screens.
   *
   * The screens are the app's own state, not pages, so the browser knew of
   * none of them: 뒤로 on the folding screen left the app altogether. Every
   * change of screen now leaves an entry in the history, and going back
   * through one puts the screen it names back. The folds themselves have
   * their own undo and are not in it.
   */
  const place = `${screen}:${showDieline ? 'dieline' : showFlight ? 'flight' : 'model'}`;
  const fromHistory = useRef(false);
  const historyStarted = useRef(false);
  const placeRef = useRef(place);
  placeRef.current = place;
  // Filled in once the plane's name is known, below; read when the address is written.
  const planeNameRef = useRef('');
  const openPlaneRef = useRef<(name: string) => boolean>(() => false);
  useEffect(() => {
    const was = (window.history.state as { place?: string } | null)?.place;
    if (fromHistory.current) { fromHistory.current = false; return; }
    // The first screen of a visit replaces the entry: a reload keeps the old
    // entry's state, and pushing on top of it stacked one more each reload.
    const named = screen === 'fold' && planeNameRef.current.trim() ? `/${encodeURIComponent(planeNameRef.current.trim())}` : '';
    const url = `${window.location.pathname}${window.location.search}${ROUTES[place] ?? '#/'}${named}`;
    if (!was || !historyStarted.current) {
      historyStarted.current = true;
      window.history.replaceState({ place }, '', url);
    }
    else if (was !== place) window.history.pushState({ place }, '', url);
  }, [place]);
  useEffect(() => {
    const back = (e: PopStateEvent) => {
      // An address typed or edited by hand has no state: read its route.
      const to = (e.state as { place?: string } | null)?.place ?? placeOfHash(window.location.hash);
      if (!to) return;
      // Back to another plane's address: that plane, from its record.
      const named = parseHash(window.location.hash)?.plane;
      if (named && named.trim() !== planeNameRef.current.trim()) openPlaneRef.current(named);
      const [scr, view] = to.split(':');
      // Only a real move is skipped by the effect; otherwise the flag lingers.
      fromHistory.current = to !== placeRef.current;
      setScreen(scr === 'fold' ? 'fold' : 'list');
      setShowDieline(view === 'dieline');
      setShowFlight(view === 'flight');
    };
    window.addEventListener('popstate', back);
    return () => window.removeEventListener('popstate', back);
  }, []);
  /*
   * A book plane shown one step at a time, from a blank sheet: the step list
   * IS the tutorial. `at` is how many of its steps are folded on screen.
   */
  const [tutorial, setTutorial] = useState<{ name: string; steps: Step[]; at: number } | null>(null);
  /*
   * A finished aeroplane is looked at, not folded: it opens with the tools
   * put away, and 수정하기 takes it back to the bench. A plane still being
   * folded opens ready to fold.
   */
  const [editing, setEditing] = useState(false);
  const readOnly = !!tutorial || !editing;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // A pattern read from a FOLD file: shape only, with no script behind it.
  const [imported, setImported] = useState<{ name: string; graph: FoldGraph } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  /*
   * The shelf of saved planes, and what the one on the bench is called.
   *
   * Read once on the way in rather than on every render: it is the browser's
   * own storage, it does not change behind our back, and every call that
   * changes it hands the new list straight back.
   */
  const [hidden, setHidden] = useState<string[]>(() => { try { return hiddenBook(localStorage); } catch { return []; } });
  const [shelf, setShelf] = useState<SavedPlane[]>(
    () => (typeof localStorage === 'undefined' ? [] : readShelf(localStorage)));
  const [planeName, setPlaneName] = useState('');
  /*
   * What a button just did to the work, with the way back.
   *
   * The panel's shortcuts add whole steps at a click, and a stray click on a
   * finished model added one silently: an aeroplane opened for a look came
   * back as a sheet folded in half again, eighty-six plies, with nothing to
   * say why. A confirmation on every shortcut would slow the folding it is
   * there to speed up, so it does the thing and says so, and one press takes
   * it back.
   */
  const [notice, setNotice] = useState<{ key: number; text: string; restore?: (() => void) | null } | null>(null);
  /*
   * A distance typed in, and the way it is measured.
   *
   * The books say where to fold by a number - "a mark seven centimetres from
   * the point" - and a pointer lands on 6.8 or 7.3. So once the first point is
   * down, the distance is typed and the mark goes exactly there, along the
   * crease or edge the pointer is lying on if it is lying on one.
   */
  const [measureCm, setMeasureCm] = useState('');
  const [measureAim, setMeasureAim] = useState<{ dir: Vec2; along: boolean } | null>(null);
  // `restore` null: a notice with nothing to take back, like a save.
  const announce = useCallback((text: string, restore?: (() => void) | null) =>
    setNotice({ key: Date.now(), text, restore }), []);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice((n) => (n?.key === notice.key ? null : n)), 10000);
    return () => clearTimeout(t);
  }, [notice]);
  const [dropping, setDropping] = useState<string | null>(null);
  // Why the last attempt to gather creases could not be made.
  const [collapseNote, setCollapseNote] = useState<string | null>(null);
  /*
   * What the align tool aims its LAST click at: a line, or a point.
   *
   * The first two clicks are always points - they say which piece of paper is
   * being brought over, and the ends are what the snapping can catch exactly.
   * Only the target is picked off the paper, and there a corner and the lines
   * ending at it sit in the same place while building different creases. So
   * that one click says beforehand what it is aiming at.
   */
  const [grab, setGrab] = useState<'point' | 'edge'>('edge');
  const [foldAngle, setFoldAngle] = useState(180);
  const [plySelection, setPlySelection] = useState<PlySelection>(ALL_PLIES);
  const [symmetric, setSymmetric] = useState(true);
  const [useThickness, setUseThickness] = useState(true);
  /*
   * Looking straight down at the paper, the way it lies on the table.
   *
   * The other setting stands the model up in its own body frame, which is
   * worth seeing once the plane exists - but that frame is derived from how
   * the mass ended up distributed, so it swings to a new angle after every
   * single fold. The paper appeared to spin on the table each time a crease
   * was made, and a left-right pair that is mirror-exact in the pattern came
   * out looking crooked on screen. It is a view, so it waits to be asked for.
   */
  const [standUp, setStandUp] = useState(false);
  const [dimRef, setDimRef] = useState<'corner' | 'centre'>('centre');
  const [showDims, setShowDims] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const [viewport, setViewport] = useState<Viewport>(identityViewport);
  const snapshotRef = useRef<(() => string | null) | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const zoomRef = useRef<((factor: number) => void) | null>(null);

  const sheet = SHEET_SIZES.find((s) => s.id === sizeId)!;
  const paper = useMemo(() => paperProps(sheet, gsm), [sheet, gsm]);
  const width = sheet.widthMm / 1000;
  const height = sheet.heightMm / 1000;

  const session = useMemo(
    () => replay(width, height, steps, useThickness ? paper.foldedPitch : 0),
    [width, height, steps, useThickness, paper.foldedPitch],
  );
  const stats = useMemo(() => foldStats(session, paper), [session, paper]);
  // The same corners, midpoints and creases the flat view aims at, so a fold
  // made by pointing at the model lands where it would have landed on paper.
  const snaps = useMemo(
    () => snapPoints(session.model, session.viewCreases, session.viewDimensions),
    [session],
  );

  /*
   * Take a snapshot, then change the script. Everything goes through here.
   *
   * The script is held in a ref as well as in state, because several edits can
   * land in one tick - a pleat is two folds, a symmetric fold is two more - and
   * each has to see what the one before it did. Reading it from state would
   * give every one of them the same stale starting point and all but the last
   * would be lost, which is exactly what a pleat coming out as a single crease
   * turned out to be.
   */
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const edit = useCallback((change: (prev: Step[]) => Step[]) => {
    const prev = stepsRef.current;
    const next = change(prev);
    if (next === prev) return;
    stepsRef.current = next;
    setPast((h) => [...h.slice(-60), prev]);
    setFuture([]);
    setSteps(next);
  }, []);

  const pushSteps = useCallback((added: Step[]) => {
    if (added.length === 0) return;
    edit((prev) => [...prev, ...added]);
    setSelected(null);
  }, [edit]);
  const pushStep = useCallback((step: Step) => pushSteps([step]), [pushSteps]);

  /*
   * A fold of some of the sheets, caught before it is made: where the sheets
   * taken are joined to the ones left behind, the corner opens into a pocket
   * and the pupil is asked how to squash it.
   */
  const [pocket, setPocket] = useState<{
    step: Step; options: PocketOption[]; all: PocketOption[]; note?: string;
    /** Where the pocket opens, on screen: the point a squash line must pass through. */
    corners?: Vec2[];
    /** Lines picked to narrow the ways: the line that moves, on the sheet, and the line it goes onto, on screen. */
    picked?: { moved: [Vec2, Vec2]; target: [Vec2, Vec2] };
  } | null>(null);
  /*
   * Narrowing the pocket's ways by what the pupil means: "this line of the
   * pocket goes onto that line". Two clicks on the model as it lies now.
   */
  /*
   * Saying how a pocket goes along a line already on the paper (선대로 접기):
   * one click on that line.
   */
  const [pocketPick, setPocketPick] = useState<null | { stage: 'line' }>(null);
  // The edge the pointer is over while lines are being picked for a pocket, on screen.
  const [pocketHover, setPocketHover] = useState<[Vec2, Vec2] | null>(null);
  useEffect(() => { if (!pocketPick) setPocketHover(null); }, [pocketPick]);
  // The edge of paper under the pointer: on the sheet, and where it lies on screen.
  const edgeOnModel = useCallback((p: Vec2, reach: number): { sheet: [Vec2, Vec2]; view: [Vec2, Vec2] } | null => {
    const st = session.state;
    for (const f of [...st.faces_order].reverse()) {
      const o = faceOutline(st, f);
      for (let i = 0; i < o.length; i++) {
        const a = o[i]!; const b = o[(i + 1) % o.length]!;
        const vx = b[0] - a[0]; const vy = b[1] - a[1];
        const len2 = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2));
        if (Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy) > reach) continue;
        const inv = affineInverse(st.faces_matrix[f]!);
        // Nudged a hair into the face, so the point is on this paper and no other.
        const c = o.reduce((m, q) => [m[0] + q[0] / o.length, m[1] + q[1] / o.length], [0, 0] as Vec2);
        const nudge = (q: Vec2): Vec2 => [q[0] + (c[0] - q[0]) * 0.02, q[1] + (c[1] - q[1]) * 0.02];
        return { sheet: [affineApply(inv, nudge(a)), affineApply(inv, nudge(b))], view: [a, b] };
      }
    }
    return null;
  }, [session.state]);
  /*
   * The locks the book's aeroplanes make, as their crease patterns. A pocket
   * a hand squashes into a lock - Highest's nose, eight creases round one
   * point with angles read off the photographs - is more than a search finds
   * from one click. So where a fold opens a pocket right where a book lock
   * has its point, that lock is offered too, if the paper takes it flat.
   */
  const [knownLocks, setKnownLocks] = useState<{ name: string; lines: PatternLine[] }[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all(BOOK_PLANES.map((b) => bookRecord(b.file).then((r) => r.steps
      .filter((x): x is Extract<Step, { kind: 'collapse' }> => x.kind === 'collapse' && !!x.lines && x.lines.length > 0)
      .map((x) => ({ name: `${b.name} ${x.label}`, lines: [...x.lines!] }))).catch(() => [])))
      .then((all) => { if (live) setKnownLocks(all.flat()); });
    return () => { live = false; };
  }, []);
  const foldStep = useCallback((step: Step) => {
    if (step.kind === 'fold' && pocketCount(step.plies) !== null && !step.creaseOnly) {
      const st = session.state;
      const taken = pliesAtLine(st, step.a, step.b, step.movingSide, pocketCount(step.plies)!);
      const found = pocketOptions(st, step.a, step.b, step.movingSide, taken, step.symmetric ? width / 2 : undefined);
      const hinges = pocketHinges(st, step.a, step.b, taken);
      const near = (l: PatternLine) => hinges.some((h) => [l.a, l.b].some((q) => Math.hypot(q[0] - h.P[0], q[1] - h.P[1]) < 0.015));
      const locks = hinges.length === 0 ? [] : knownLocks.filter((k) => k.lines.some(near)).flatMap((k) => {
        const r = collapsePattern(st, k.lines);
        return r.conflict || r.violations.length > 0 ? []
          : [{ label: '', detail: `책의 잠그기 · ${k.name}`, lines: k.lines, state: r.state }];
      });
      const options = [...locks, ...found].map((o, i) => ({ ...o, label: `방법 ${i + 1}` }));
      const corners = hinges.map((h) => affineApply(st.faces_matrix[h.A]!, h.P));
      if (step.symmetric) for (const c of [...corners]) corners.push([width - c[0], c[1]]);
      if (options.length > 0) { setPocket({ step, options, all: options, corners }); return; }
      /*
       * Joined, and no way found to squash the pocket flat: folding the plies
       * anyway pulled them off the paper they are joined to - a fold only
       * scissors could make. Say so, and fold nothing.
       */
      if (hinges.length > 0) {
        setCollapseNote(step.symmetric
          ? '이 겹은 아래 종이와 붙어 있어서 혼자 접을 수 없어요. 좌우 대칭을 끄고 한쪽씩 접거나, ‘전체’로 접어 보세요.'
          : '이 겹은 아래 종이와 붙어 있어서 혼자 접을 수 없어요. ‘전체’로 접거나, 붙은 모서리에서 시작하는 선으로 접어 보세요.');
        return;
      }
    }
    pushStep(step);
  }, [session.state, pushStep, width, knownLocks]);
  /*
   * Saying how a pocket goes with 맞춰 접기 itself: the tool the pupil already
   * knows, its snapping, its preview and its readout, lent for a moment. The
   * fold line it arrives at is not folded - it is handed to the pocket as the
   * crease the squash must use - and the tool that was in hand comes back.
   */
  const [pocketAlign, setPocketAlign] = useState<{ tool: Tool; grab: 'point' | 'edge' } | null>(null);
  const fold = useFoldTool({ tool, alignMode: grab, angleDeg: foldAngle, plies: plySelection, symmetric,
    pleatSpacing: PLEAT_SPACING_MM / 1000, model: session.model, onStep: foldStep,
    sheetWidth: width, sheetHeight: height });
  useEffect(() => {
    if (!pocketAlign || !pocket || fold.pending?.t !== 'side') return;
    const wanted: [Vec2, Vec2] = [fold.pending.a, fold.pending.b];
    const laid = fold.pending.moved && fold.pending.onto ? { moved: fold.pending.moved, onto: fold.pending.onto } : null;
    fold.cancel();
    setTool(pocketAlign.tool);
    setGrab(pocketAlign.grab);
    setPocketAlign(null);
    const fs = pocket.step.kind === 'fold' ? pocket.step : null;
    if (!fs || pocketCount(fs.plies) === null) return;
    const st0 = session.state;
    const found = pocketOptions(st0, fs.a, fs.b, fs.movingSide, pliesAtLine(st0, fs.a, fs.b, fs.movingSide, pocketCount(fs.plies)!),
      fs.symmetric ? width / 2 : undefined, [{ a: wanted[0], b: wanted[1], how: 'align' }]);
    /*
     * The ways that fold along the line 맞춰 접기 gave, and of those the ones
     * where the line picked really comes to lie on the line named - either
     * way round, since which of the two moves is the pocket's business.
     */
    const gap = (o: PocketOption) => (laid
      ? Math.min(laysOn(st0, o.state, laid.moved, laid.onto), laysOn(st0, o.state, laid.onto, laid.moved)) : 0);
    const gaps = found.map(gap);
    const best = Math.min(Infinity, ...gaps);
    /*
     * Paper that squashes flat cannot always lay the line exactly on the other
     * - the corner's creases are fixed by the flat-folding rule - so the ways
     * that come nearest are kept, within a centimetre, and the pupil told how
     * near.
     */
    const near = best < 0.01 ? found.filter((_, i) => gaps[i]! <= Math.max(0.0015, best + 0.0005)) : [];
    const along = laid ? near : found;
    const nearNote = laid && best > 0.0015 && near.length > 0
      ? ` 선이 딱 맞게 붙지는 않고, ${(best * 1000).toFixed(0)}mm쯤 떨어져 가장 가깝게 놓여요.` : '';
    // One way that lays it exactly: that is the fold asked for. Near but not exact, the pupil looks first.
    if (along.length === 1 && !nearNote) {
      pushStep({ kind: 'collapse', at: fs.movingSide, label: `${fs.label} · 맞춰 접기`, lines: along[0]!.lines });
      setPocket(null);
      return;
    }
    setPocket({ ...pocket, options: (along.length ? along : pocket.all).map((o, i) => ({ ...o, label: `방법 ${i + 1}` })),
      note: along.length ? `맞춰 접기로 접히는 방법 ${along.length}가지예요.${nearNote}` : '고른 선을 그 선에 붙이면서 납작하게 접을 수는 없어요. 전체를 다시 보여 줄게요.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fold.pending, pocketAlign]);
  /*
   * A pocket is asked about the paper as it was when the fold was drawn.
   * Undone, redone, another plane opened, or the screen left, that paper is
   * gone: the question closes, and the tool lent to it goes back.
   */
  const pocketOpen = useRef<{ open: boolean; lent: typeof pocketAlign }>({ open: false, lent: null });
  pocketOpen.current = { open: !!pocket, lent: pocketAlign };
  useEffect(() => {
    const { open, lent } = pocketOpen.current;
    if (!open) return;
    setPocket(null);
    setPocketPick(null);
    if (lent) { fold.cancel(); setTool(lent.tool); setGrab(lent.grab); setPocketAlign(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, screen]);
  // A new first point has no direction yet - it comes from where the pointer goes next.
  const anchorKey = fold.pending?.t === 'anchor' ? fold.pending.a.join(',') : '';
  useEffect(() => { setMeasureAim(null); }, [anchorKey]);

  /*
   * Picking a crease off the model.
   *
   * The script is what the model is made of, so clicking a crease does not edit
   * the crease - it selects the STEP that pressed it, and the step inspector
   * then changes its angle, its sense or its plies and the whole model is
   * replayed. That is how a fold made twenty steps ago can be adjusted without
   * anything downstream coming loose.
   */
  const creaseAt = useCallback((p: Vec2, reach = 0.006): number | null => {
    let best: number | null = null;
    let bestD = reach;
    const near = (a: Vec2, b: Vec2, step: number) => {
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2))
        : 0;
      const d = Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
      if (d < bestD) { bestD = d; best = step; }
    };
    // A measured span is a thing you can point at too, and it sits on top of
    // the creases, so it answers first when they are together.
    for (const d of session.viewDimensions) near(d.a, d.b, d.step);
    for (const c of session.viewCreases) {
      const vx = c.b[0] - c.a[0];
      const vy = c.b[1] - c.a[1];
      const len2 = vx * vx + vy * vy;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((p[0] - c.a[0]) * vx + (p[1] - c.a[1]) * vy) / len2))
        : 0;
      const d = Math.hypot(p[0] - (c.a[0] + t * vx), p[1] - (c.a[1] + t * vy));
      if (d < bestD) { bestD = d; best = c.step; }
    }
    return best;
  }, [session.viewCreases, session.viewDimensions]);

  const [hoverStep, setHoverStep] = useState<number | null>(null);
  // What the pointer last latched onto, so the stage can say which it was.
  const [snapKind, setSnapKind] = useState<SnapPoint['kind'] | null>(null);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; step: number | null } | null>(null);

  /** Every crease as it sits on the paper now, tagged with how it folds. */
  // Each crease coded by the kind of fold that made it (see lineKinds), and
  // the last fold's lines picked out so a walk-through shows where it folded.
  const stageCreases = useMemo(() => {
    let last = -1;
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i]!;
      if (isFold(st)) { last = i; break; }
    }
    return session.viewCreases.map((c) => ({
      a: c.a, b: c.b, kind: lineKindOf(steps[c.step]), latest: c.step === last,
    }));
  }, [session.viewCreases, steps]);

  const highlights = useMemo(() => {
    const out: { a: Vec2; b: Vec2; strong?: boolean }[] = [];
    // Put away, the creases stay away: the pointer passing over one does not light it.
    if (showCreases) for (const c of session.viewCreases) {
      if (c.step === selected) out.push({ a: c.a, b: c.b, strong: true });
      else if (c.step === hoverStep) out.push({ a: c.a, b: c.b });
    }
    if (showDims) for (const d of session.viewDimensions) {
      if (d.step === selected) out.push({ a: d.a, b: d.b, strong: true });
      else if (d.step === hoverStep) out.push({ a: d.a, b: d.b });
    }
    // Picking lines for a pocket: the line already chosen bold, the one under the pointer light.
    // The pocket's corner, as a small cross, while the pupil says how to squash it.
    if (pocket && (pocketPick || pocketAlign)) {
      const r = 0.004;
      for (const c of pocket.corners ?? []) {
        out.push({ a: [c[0] - r, c[1] - r], b: [c[0] + r, c[1] + r], strong: true });
        out.push({ a: [c[0] - r, c[1] + r], b: [c[0] + r, c[1] - r], strong: true });
      }
    }
    if (pocketHover) out.push({ a: pocketHover[0], b: pocketHover[1] });
    return out;
  }, [session.viewCreases, session.viewDimensions, selected, hoverStep, showCreases, showDims,
    pocket, pocketPick, pocketAlign, pocketHover]);

  // What to show on the model while a fold is being set up: the point already
  // taken, and where the pointer would land if it were taken now.
  /*
   * The line at the top of the stage.
   *
   * What to do next, what the pointer has caught, and - while a line is being
   * drawn - how long it is and which way it points, live. The flat view used to
   * carry that last part in its corner; without it you are placing the second
   * point blind.
   */
  const stagePrompt = useMemo(() => {
    const bits = [fold.prompt];
    if (tool !== 'select' && snapKind) bits.push(`${SNAP_NAMES[snapKind]}에 붙음`);
    const from = fold.pending?.t === 'anchor' || fold.pending?.t === 'alignFrom'
      ? fold.pending.a : null;
    if (from && fold.hoverSide) {
      const dx = fold.hoverSide[0] - from[0];
      const dy = fold.hoverSide[1] - from[1];
      const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 180;
      bits.push(`${cm(Math.hypot(dx, dy))} · ${deg.toFixed(1)}°`);
    }
    return bits.join(' · ');
  }, [fold.prompt, fold.pending, fold.hoverSide, tool, snapKind]);

  /*
   * A span drawn by hand comes out in half centimetres.
   *
   * Applies to the line tool as much as the ruler: both are placing something
   * by eye, and 11.2cm is not a number anybody chose. The far end slides along
   * the line to the nearest half centimetre.
   *
   * Unless it caught something. A span drawn corner to corner is 36.4cm
   * because that is what the corners are, and rounding it would be a lie -
   * that one is being OBSERVED, not decided.
   *
   * Returns null when the point should be left exactly where it is.
   */
  /*
   * Where the piece will land, drawn on the line being aimed at.
   *
   * Two points said which piece of paper is coming over, so its length is
   * settled - and the crease the construction gives sends it to exactly one
   * place on the target. Drawing that place is the difference between
   * choosing a line and choosing where the paper ends up: the same line can be
   * aimed at from either end, and the landing is what tells them apart.
   */
  const landing = useMemo((): { a: Vec2; b: Vec2 } | null => {
    const at = fold.pending;
    if (at?.t !== 'align' || !fold.hoverSide) return null;
    const target = pickAt(session.model, session.viewCreases, snaps,
      fold.hoverSide, 0.006, grab) ?? { kind: 'point' as const, p: fold.hoverSide };
    const built = alignFold(at.first, target);
    if (!built) return null;
    const { a, b } = built.line;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-18) return null;
    const over = (p: Vec2): Vec2 => {
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
      const fx = a[0] + t * dx;
      const fy = a[1] + t * dy;
      return [2 * fx - p[0], 2 * fy - p[1]];
    };
    const src = at.first;
    return src.kind === 'point'
      ? { a: over(src.p), b: over(src.p) }
      : { a: over(src.s.a), b: over(src.s.b) };
  }, [fold.pending, fold.hoverSide, session.model, session.viewCreases, snaps, grab]);

  /*
   * Which way a measurement runs from its first point.
   *
   * Along a crease or an edge that passes through that point, when the pointer
   * is lying close to one - a nose is measured down its middle line, and a
   * hand that wobbles a degree should not put the mark off it. Anywhere else,
   * straight towards the pointer.
   */
  const aimFrom = useCallback((from: Vec2, p: Vec2): { dir: Vec2; along: boolean } => {
    const len = Math.hypot(p[0] - from[0], p[1] - from[1]);
    const toward: Vec2 = len < 1e-12 ? [1, 0] : [(p[0] - from[0]) / len, (p[1] - from[1]) / len];
    const segments: Array<[Vec2, Vec2]> = session.viewCreases.map((c) => [c.a, c.b]);
    for (const layer of session.model.layers) {
      const poly = layerOutline(layer);
      poly.forEach((q, i) => segments.push([q, poly[(i + 1) % poly.length]!]));
    }
    let best: Vec2 | null = null;
    let bestCos = Math.cos((8 * Math.PI) / 180);
    for (const [a, b] of segments) {
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-9) continue;
      const d: Vec2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      // The line has to pass through the first point, not merely run near it.
      if (Math.abs((from[0] - a[0]) * d[1] - (from[1] - a[1]) * d[0]) > 1e-5) continue;
      const cos = d[0] * toward[0] + d[1] * toward[1];
      if (Math.abs(cos) > bestCos) { bestCos = Math.abs(cos); best = cos < 0 ? [-d[0], -d[1]] : d; }
    }
    /*
     * Straight across and straight along the sheet, too. A line drawn from a
     * mark in the open middle of the paper has no crease through its first
     * point to follow, and a hand that means "level" comes out a degree or two
     * off - the 11.5cm mark's cross line went in at 1.8°. Only when no line
     * through the point is closer: a crease is what the pupil is aiming at.
     */
    if (!best) {
      for (const d of [[1, 0], [0, 1]] as Vec2[]) {
        const cos = d[0] * toward[0] + d[1] * toward[1];
        if (Math.abs(cos) > bestCos) { bestCos = Math.abs(cos); best = cos < 0 ? [-d[0], -d[1]] : d; }
      }
    }
    return best ? { dir: best, along: true } : { dir: toward, along: false };
  }, [session.viewCreases, session.model]);

  const roundedSpan = useCallback((p: Vec2, kind: SnapPoint['kind'] | null): Vec2 | null => {
    if (tool !== 'measure' && tool !== 'line') return null;
    if (fold.pending?.t !== 'anchor') return null;
    if (kind !== null && kind !== 'grid') return null;
    const from = fold.pending.a;
    const len = Math.hypot(p[0] - from[0], p[1] - from[1]);
    if (len < 1e-9) return null;
    const [dx, dy] = aimFrom(from, p).dir;
    const step = 0.005;
    const at = (d: number): Vec2 => [from[0] + dx * d, from[1] + dy * d];

    /*
     * Rounded up to the nearest half centimetre, but never off the paper.
     *
     * Rounding moves the far end along the line, and a point that was on the
     * sheet a moment ago can be a few millimetres past its edge afterwards -
     * so the line ran off the paper and the length claimed ground that was not
     * there. Step back until it is on the sheet again.
     */
    let want = Math.max(step, Math.round(len / step) * step);
    // A micron of slack, so a point that lands exactly on the edge counts as
    // being on the paper rather than a hair outside it.
    while (want > step && faceUnder(session.state, at(want), 1e-6) === null) want -= step;
    return at(want);
  }, [tool, fold.pending, session.state, aimFrom]);

  const stageMarks = useMemo(() => {
    const out: Vec2[] = [];
    if (fold.pending?.t === 'anchor') out.push(fold.pending.a);
    if (fold.pending?.t === 'alignFrom') out.push(fold.pending.a);
    if (fold.pending?.t === 'align' && fold.pending.first.kind === 'edge') {
      out.push(fold.pending.first.s.a, fold.pending.first.s.b);
    }
    if (fold.pending?.t === 'align' && fold.pending.first.kind === 'point') {
      out.push(fold.pending.first.p);
    }
    if (fold.hoverSide) out.push(fold.hoverSide);
    return out;
  }, [fold.pending, fold.hoverSide]);
  /*
   * A pattern read from a file, shown instead of the one being folded.
   *
   * There is no script behind it, so there is nothing to step through: the
   * hinge walk turns the recorded fold angles into a shape and that is all it
   * can honestly offer. It is here to check this engine against another one.
   */
  const importedState = useMemo(() => (imported
    ? {
      graph: imported.graph,
      faces_matrix: imported.graph.faces_vertices.map(() => affineIdentity),
      faces_order: imported.graph.faces_vertices.map((_, i) => i),
    }
    : null), [imported]);
  const importedPlies = useMemo(
    () => (importedState ? renderFaces(importedState) : null), [importedState]);

  /*
   * A fold of some plies that opens a pocket cannot be shown folding on its
   * own: the plies are joined to the paper under them, and how the pocket
   * squashes is asked next. Folded anyway, the preview tore the joined ply
   * off one side and lit only the mirror's. So the plies that will go are lit
   * where they lie, on both sides of a mirrored fold.
   */
  const pocketLit = useMemo(() => {
    const p = fold.preview;
    if (!p || p.creaseOnly || pocketCount(p.plies) === null) return null;
    const st = session.state;
    const count = pocketCount(p.plies)!;
    const lit = new Set<number>();
    let joined = false;
    const sides: Array<[Vec2, Vec2, Vec2]> = [[p.a, p.b, p.movingSide]];
    if (p.symmetric) sides.push([[width - p.a[0], p.a[1]], [width - p.b[0], p.b[1]], [width - p.movingSide[0], p.movingSide[1]]]);
    for (const [a, b, m] of sides) {
      const taken = pliesAtLine(st, a, b, m, count);
      if (pocketHinges(st, a, b, taken).length > 0) joined = true;
      const sideOf = (q: Vec2) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      const toward = Math.sign(sideOf(m));
      for (const f of taken) {
        const o = faceOutline(st, f);
        const c = o.reduce((acc, q) => [acc[0] + q[0] / o.length, acc[1] + q[1] / o.length], [0, 0] as Vec2);
        if (Math.sign(sideOf(c)) === toward) lit.add(f);
      }
    }
    return joined ? lit : null;
  }, [fold.preview, session.state, width]);
  /*
   * While the pupil says how a pocket squashes, the plies of the first fold
   * are shown lifted on their line, as a hand lifts them to open the pocket:
   * a see-through copy stood up at eighty degrees over the paper as it lies.
   * The second fold - which line goes onto which - is found by looking at the
   * pocket open, and in the paper lying flat it could only be imagined.
   */
  const pocketLift = useMemo(() => {
    const fs = pocket && pocket.step.kind === 'fold' ? pocket.step : null;
    if (!fs || pocketCount(fs.plies) === null) return null;
    const st = session.state;
    const sides: Array<[Vec2, Vec2, Vec2]> = [[fs.a, fs.b, fs.movingSide]];
    if (fs.symmetric) sides.push([[width - fs.a[0], fs.a[1]], [width - fs.b[0], fs.b[1]], [width - fs.movingSide[0], fs.movingSide[1]]]);
    const faceSide = new Map<number, [Vec2, Vec2, Vec2]>();
    for (const [a, b, m] of sides) {
      const sideOf = (q: Vec2) => (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      const toward = Math.sign(sideOf(m));
      for (const f of pliesAtLine(st, a, b, m, pocketCount(fs.plies)!)) {
        const o = faceOutline(st, f);
        const c = o.reduce((acc, q) => [acc[0] + q[0] / o.length, acc[1] + q[1] / o.length], [0, 0] as Vec2);
        if (Math.sign(sideOf(c)) === toward) faceSide.set(f, [a, b, m]);
      }
    }
    return faceSide.size ? faceSide : null;
  }, [pocket, session.state, width]);
  const animated = useAnimatedPlies(
    width, height, steps, pocketLit ? null : fold.preview, useThickness ? paper.foldedPitch : 0, session.state);
  const { animating } = animated;
  // Lit as the fold's moving part is: under a step index no step has.
  const plies = useMemo(() => (pocketLit
    ? animated.plies.map((f) => (pocketLit.has(f.face) ? { ...f, movedBy: steps.length } : f))
    : animated.plies), [animated.plies, pocketLit, steps.length]);
  // Drawn only, over the model: nothing weighs them, stands the plane up by them or folds them.
  const pocketGhosts = useMemo(() => {
    if (!pocketLift) return null;
    // Turned about their fold line, toward the viewer (-z), by eighty degrees.
    const LIFT = (80 * Math.PI) / 180;
    const turnAbout = (a: Vec2, b: Vec2, t: number) => {
      const ux = b[0] - a[0]; const uy = b[1] - a[1]; const ul = Math.hypot(ux, uy) || 1;
      const k: [number, number, number] = [ux / ul, uy / ul, 0];
      const c = Math.cos(t); const sn = Math.sin(t);
      return (p: readonly [number, number, number]): [number, number, number] => {
        const v: [number, number, number] = [p[0] - a[0], p[1] - a[1], p[2]];
        const kv = k[0] * v[0] + k[1] * v[1];
        const x: [number, number, number] = [k[1] * v[2], -k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
        return [a[0] + v[0] * c + x[0] * sn + k[0] * kv * (1 - c), a[1] + v[1] * c + x[1] * sn + k[1] * kv * (1 - c), v[2] * c + x[2] * sn];
      };
    };
    return animated.plies.filter((f) => pocketLift.has(f.face)).map((f) => {
      const [a, b, m] = pocketLift.get(f.face)!;
      // Whichever way round takes the moving side up toward the viewer.
      const plus = turnAbout(a, b, LIFT)([m[0], m[1], 0]);
      const turn = turnAbout(a, b, plus[2] < 0 ? LIFT : -LIFT);
      const o = turn([0, 0, 0]);
      const n = turn(f.normal as [number, number, number]);
      return {
        ...f, points: f.points.map((q) => turn(q as [number, number, number])),
        normal: [n[0] - o[0], n[1] - o[1], n[2] - o[2]] as [number, number, number], movedBy: steps.length,
      };
    });
  }, [animated.plies, pocketLift, steps.length]);
  const previewIndex = pocketLit || pocketLift ? steps.length : animated.previewIndex;

  // The aeroplane's own axes, so the 3D view can stand it up the way it flies.
  const airframe = useMemo(
    () => (plies.length > 1 ? buildAirframe(plies, paper) : null),
    [plies, paper],
  );
  /*
   * The aeroplane that flies is the finished model, as the plane list builds
   * it - not the frame the fold animation happens to be drawing. Flown from
   * the animation, a screen opened mid-fold (or in a tab whose frames never
   * come) flew a wing a degree off its real V, and its numbers were another
   * plane's.
   */
  /*
   * The aeroplane that flies has its folded thickness whatever the view is
   * set to show - turning the drawing's thickness off must not change how it
   * flies, or the flying screen and the list's card fly different planes.
   */
  // The rolls' real paper, as the list's card counts it: one plane, one set of numbers.
  // Measured once, as the list's card measures it: the flight is worked out on the measurements.
  const { restPlies, restSpec } = useMemo(() => {
    const drawn = renderFaces(session.state, -1, paper.foldedPitch);
    const roll = rollRetreat(steps, session, paper.foldedPitch, drawn, paper);
    const spec = measurePlane(drawn, paper, paper.foldedPitch, foldEdges(steps, session, paper.foldedPitch, drawn, paper), roll.retreat);
    return { restPlies: drawn, restSpec: spec };
  }, [steps, session, paper]);
  const restAirframe = restSpec?.af ?? null;

  // Which face of the wing the rolled nose bulges from, for the elevator's
  // starting angle; and the elevator itself, bent into the drawn model.
  // Read off the aeroplane that flies, not the one drawn: drawn without its
  // thickness, or mid-fold, no nose stands off the wing, and the flying
  // screen started from a flat elevator where the list's card did not.
  const bulge = useMemo(() => (restSpec ? noseBulge(restSpec) : { side: 0 as const, offset: 0, ahead: 0 }),
    [restSpec]);
  const elevShown: ElevatorTune = { ...defaultElevator(bulge.side), ...elevEdit };
  const elevator = elevOn ? elevShown : null;
  /*
   * Until the pupil tunes it, the plane flies with the elevator recommended
   * for the throw - worked out from the finished model, a moment after the
   * flying screen opens, and again when the throw changes, since a harder
   * throw wants a different bend. It is never saved: the record keeps only
   * what the pupil set, and the recommendation follows from the record.
   */
  /*
   * Worked out for the throw as it stood when "다시 계산" was last pressed -
   * or when the flying screen opened - not on every change: moving a value
   * only marks the numbers out of date, the way the hundred throws are.
   */
  const [recAsk, setRecAsk] = useState<FlightSettings | null>(null);
  const [judgedAngle, setJudgedAngle] = useState<{ key: string; angle: number } | null>(null);
  /*
   * One judgement of the plane, not two. The list's card throws it at the
   * angle and elevator that go together best (recommendThrow); the flying
   * screen opened at the angle the record happened to hold, so the same plane
   * scored one thing on its card and another here. It opens at the card's
   * angle now, and the recommendation and the hundred throws follow from the
   * same sums, so the numbers agree. What the pupil then changes is a try.
   */
  const flightNow = useRef(flightSettings);
  flightNow.current = flightSettings;
  const judging = useRef(false);
  useEffect(() => {
    if (!showFlight) { setRecAsk(null); return; }
    if (recAsk || judging.current || steps.length === 0) return;
    judging.current = true;
    /*
     * The very record the list's card was judged from, when the plane on the
     * bench is still that one - so the answer is the card's own, already
     * worked out, not a second judgement that could come out otherwise.
     */
    const onShelf = shelf.find((p) => sameName(p.name, planeName));
    const same = onShelf && JSON.stringify(onShelf.steps) === JSON.stringify(steps);
    const record = same ? onShelf : { widthMm: sheet.widthMm, heightMm: sheet.heightMm, gsm, steps,
      vee: savedFlight.vee ?? undefined, throwAngle: savedFlight.angle };
    // Answered after another plane was opened, or the screen closed, it is not this one's.
    const askedFor = JSON.stringify(steps);
    let live = true;
    void cardFlightLater(record)
      .then((card) => {
        if (!live || JSON.stringify(stepsRef.current) !== askedFor) return;
        const now = flightNow.current;
        const next = card ? { ...now, angle: card.angle } : now;
        // Thrown as the card is thrown, the card's elevator is the recommendation.
        const asCard = now.speed === DEFAULT_FLIGHT.speed && now.height === DEFAULT_FLIGHT.height
          && now.bank === DEFAULT_FLIGHT.bank && (now.gust ?? 1) === (DEFAULT_FLIGHT.gust ?? 1)
          && now.headwind === DEFAULT_FLIGHT.headwind;
        if (card && asCard) {
          setRecommended({ key: recKeyOf(next), tune: card.elevator });
          setJudgedAngle({ key: recKeyOf(next), angle: card.angle });
        }
        setFlightSettings(next);
        setRecAsk(next);
      })
      .catch(() => { if (live) setRecAsk(flightNow.current); })
      .finally(() => { judging.current = false; });
    return () => { live = false; judging.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFlight, recAsk, steps]);
  const asked = recAsk ?? flightSettings;
  const recKeyOf = (a: FlightSettings) => JSON.stringify([
    sheet.widthMm, sheet.heightMm, gsm, steps, a.speed, a.angle, a.height, a.bank, a.vee, a.headwind, a.gust ?? 1,
  ]);
  const recKey = restAirframe && showFlight && recAsk ? recKeyOf(asked) : null;
  const [recommended, setRecommended] = useState<{ key: string; tune: ElevatorTune } | null>(null);
  useEffect(() => {
    if (!recKey || recommended?.key === recKey) return;
    let live = true;
    void recommendLater({ widthMm: sheet.widthMm, heightMm: sheet.heightMm, gsm, steps }, { ...asked, elevator: 0 })
      // None found, the plane flies with the elevator as it is rather than waiting for ever.
      .then((tune) => { if (live) setRecommended({ key: recKey, tune: tune ?? elevShown }); })
      .catch(() => { if (live) setRecommended({ key: recKey, tune: elevShown }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recKey]);
  /*
   * While a new one is worked out the last one stands: dropped at once, the
   * flying screen closed and opened again on every '다시 계산', losing its tab
   * and the wind tunnel's settings.
   */
  const rec = recommended && (recommended.key === recKey || showFlight) ? recommended.tune : null;
  /*
   * The elevator it flies with: one tried by hand on the flying screen, or
   * the recommended one. The one tried by hand is the pupil's experiment and
   * is never written into the plane - the plane keeps the recommendation.
   */
  const [flyElev, setFlyElev] = useState<ElevatorTune | null>(null);
  const elevUsed: ElevatorTune | null = flyElev ?? rec ?? (elevOn && elevEdit.auto ? elevShown : savedAuto);
  // Of the three throw angles, the one this plane flies longest at, with the elevator it flies with.
  const angleKey = recKey && elevUsed ? JSON.stringify([recKey, elevUsed]) : null;
  const [bestAngle, setBestAngle] = useState<{ key: string; angle: number } | null>(null);
  // The card's own angle, while the throw is the card's and the elevator the recommended one.
  const cardsAngle = !flyElev && judgedAngle && judgedAngle.key === recKey ? judgedAngle.angle : null;
  useEffect(() => {
    if (!angleKey || !elevUsed || bestAngle?.key === angleKey || cardsAngle !== null) return;
    let live = true;
    const t = window.setTimeout(() => {
      /*
       * Recommended by the same judgement as the card's (recommendThrow) while
       * the elevator is the recommended one; with one tried by hand, the angle
       * that flies longest with that one.
       */
      const ask = flyElev
        ? recommendAngleLater({ widthMm: sheet.widthMm, heightMm: sheet.heightMm, gsm, steps, elevator: elevUsed }, { ...asked, elevator: 0 })
        : recommendThrowLater({ widthMm: sheet.widthMm, heightMm: sheet.heightMm, gsm, steps,
          vee: savedFlight.vee ?? undefined, throwAngle: savedFlight.angle }, { ...asked, elevator: 0 }).then((b) => b?.angle ?? null);
      void ask
        .then((angle) => { if (live && angle !== null) setBestAngle({ key: angleKey, angle }); })
        .catch(() => { /* no recommendation: the three angles are still there to try */ });
    }, 600);
    return () => { live = false; window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [angleKey]);
  /*
   * The flight reads the elevator off the model: where it is and how far it
   * is bent. Turning it on the flying screen bends the model the same way, so
   * there is one elevator, not a model's and a flight's that can disagree.
   */
  const flapTune = elevUsed ?? elevShown;
  const flapRegion = useMemo(() => ({
    y0: flapTune.fromCm / 100, y1: (flapTune.fromCm + flapTune.widthCm) / 100, depth: flapTune.depthCm / 100,
  }), [flapTune.fromCm, flapTune.widthCm, flapTune.depthCm]);
  const flightView = useMemo(() => ({
    ...flightSettings, elevator: elevUsed ? elevUsed.angleDeg : 0, region: flapRegion,
  }), [flightSettings, elevUsed?.angleDeg, flapRegion]);
  // The elevator's angle moved on the flying screen is a try of the pupil's own.
  const onFlightSettings = useCallback((next: FlightSettings) => {
    if (next.elevator !== flightView.elevator) {
      const from = elevUsed ?? elevShown;
      setFlyElev({ ...from, angleDeg: next.elevator, auto: undefined });
    }
    setFlightSettings(next);
  }, [flightView.elevator, elevUsed, elevShown]);
  /*
   * Turning it on pins the angle it shows. Until then the starting angle
   * follows the nose - and folding can move which way the nose bulges, which
   * would flip a bent elevator the other way under the pupil's fingers.
   */
  const toggleElevator = useCallback(() => {
    if (!elevOn) setElevEdit((e) => ({ angleDeg: elevShown.angleDeg, ...e }));
    setElevOn(!elevOn);
  }, [elevOn, elevShown.angleDeg]);
  /*
   * Kept as it is folded.
   *
   * Every fold adds a step, so every fold is a change worth keeping, and
   * pressing 저장 after each one is the kind of chore that gets forgotten
   * until the one time it mattered. Once the aeroplane differs from what was
   * opened, it goes onto the shelf by itself - under its name, or a new one.
   */
  // A new plane's name: the lowest number not already on the shelf, so an
  // unnamed plane never lands on - and replaces - one that is kept there.
  const freeName = useCallback(() => {
    const taken = new Set(shelf.map((p) => p.name.trim()));
    let n = 1;
    while (taken.has(`내 비행기 ${n}`)) n++;
    return `내 비행기 ${n}`;
  }, [shelf]);
  // The plane as it would be saved, worked out once per change rather than on
  // every render - the pointer moving over the model re-renders constantly.
  /*
   * The wings' V and the throw angle as the plane was last saved. What the
   * flying screen changes is a try until 저장 is pressed: it is not kept by
   * the saving that follows folding, and it does not by itself count as a
   * change to keep.
   */
  const [savedFlight, setSavedFlight] = useState<{ vee: number | null; angle: number }>({ vee: null, angle: DEFAULT_FLIGHT.angle });
  const saveKey = useMemo(() => JSON.stringify([steps, elevator, editing, savedFlight.vee, savedFlight.angle]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [steps, elevOn, elevShown.fromCm, elevShown.widthCm, elevShown.depthCm, elevShown.angleDeg, editing, savedFlight]);
  const savedKey = useRef<string>(JSON.stringify([[], null]));
  // The plane as opened, folds and tuning only: a status change alone does not
  // put an untouched book plane on the shelf as a copy of itself.
  const openedContent = useRef<string>(JSON.stringify([[], null]));
  const [autoSaved, setAutoSaved] = useState<string | null>(null);
  // Enter pressed mid-syllable in the name box: leave it once the syllable is done.
  const nameEnter = useRef(false);
  // The screen as rendered last, for a cleanup that has to know it is being left.
  const screenNow = useRef(screen);
  screenNow.current = screen;
  useEffect(() => {
    if (screen !== 'fold' || tutorial || imported || steps.length === 0) return;
    const key = saveKey;
    if (key === savedKey.current) return;
    const untouched = JSON.stringify([steps, elevator, savedFlight.vee, savedFlight.angle]) === openedContent.current;
    if (untouched && !shelf.some((p) => sameName(p.name, planeName))) return;
    let done = false;
    const save = () => {
      done = true;
      const name = planeName.trim() || freeName();
      if (!planeName.trim()) setPlaneName(name);
      const text = JSON.stringify(sessionFile(sheet.widthMm, sheet.heightMm, gsm, steps, name, elevator, !editing, savedFlight.vee, savedFlight.angle), null, 1);
      try {
        setShelf(shelvePlane(localStorage, name, text));
        savedKey.current = key;
        setAutoSaved(name);
      } catch { /* storage full or blocked: the 저장 button still reports it */ }
    };
    const t = setTimeout(save, 700);
    return () => {
      clearTimeout(t);
      /*
       * Leaving the folding screen before the wait was over used to drop the
       * last fold: the timer was cleared and nothing set it again. Left, it is
       * kept at once - but not when a newer change is only replacing this one.
       */
      if (!done && screenNow.current !== 'fold') save();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveKey, screen, tutorial, imported]);

  /*
   * Stood up to be looked at, a finished plane is shown as it flies - wings in
   * their V, by the rule the flying screen and the list use. While folding it
   * stays as folded, so what is picked is where the paper really lies.
   */
  const flyingAttitude = useMemo(() => {
    if (!airframe) return undefined;
    if (!readOnly) return airframe.frame.toBody;
    const lift = liftWings(airframe, plies, flyingVee(airframe, flightSettings.vee));
    return (p: Vec3): Vec3 => lift(airframe.frame.toBody(p));
  }, [airframe, plies, readOnly, flightSettings.vee]);

  // Bent only where it is flown. While folding, the trailing edge lies as it was folded.
  const bentIn = showFlight ? elevUsed : null;
  const shownPlies = useMemo(() => bendElevator(plies, airframe, bentIn),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plies, airframe, bentIn?.fromCm, bentIn?.widthCm, bentIn?.depthCm, bentIn?.angleDeg]);
  /*
   * Shown as real paper folds it: the nose as much shorter than the drawing as
   * the flight counts it (see `noseStretch`). Only how it looks - the lines
   * are folded on and measured on the drawing, where a 1.9cm roll is 1.9cm.
   */
  const rollNow = useMemo(() => rollRetreat(steps, session, paper.foldedPitch, plies, paper),
    [steps, session, paper, plies]);
  const reshape = useMemo(
    () => (useThickness ? noseStretch(plies, paper, rollNow.retreat, rollNow.band) : null),
    [useThickness, plies, paper, rollNow],
  );
  // What the flying screen flies: the measured plane, or the one on the stage when there is no record behind it.
  const flySpec = useMemo(
    () => restSpec ?? (plies.length > 1 ? measurePlane(plies, paper, paper.foldedPitch) : null),
    [restSpec, plies, paper],
  );
  const reshapedPlies = useMemo(
    () => (reshape ? shownPlies.map((f) => ({ ...f, points: f.points.map(reshape) })) : shownPlies),
    [reshape, shownPlies],
  );

  // The paper under the pointer in 3D, for the fold tool: which sheet point,
  // and whether a fold toward you is the layout's mountain there.
  const paperAt = useCallback((sheet: Vec2 | null): PaperPoint | null => {
    if (!sheet) return null;
    // Stood up in its flight attitude, "toward you" is the aeroplane's up.
    let toward: Vec3 = [0, 0, -1];
    if (standUp && airframe) {
      const f = airframe.frame.toBody;
      const o = f([0, 0, 0]);
      const down = (e: Vec3) => f(e)[2] - o[2];
      toward = [-down([1, 0, 0]), -down([0, 1, 0]), -down([0, 0, 1])];
    }
    return { sheet, turned: turnedFromViewerAt(session.state, sheet, toward) };
  }, [session.state, standUp, airframe]);

  /** Rewriting one entry and replaying is all an edit needs to be. */
  const updateStep = useCallback((index: number, patch: Partial<FoldStep>) => {
    edit((prev) => prev.map((s, i) => (i === index && isFold(s) ? { ...s, ...patch } : s)));
  }, [edit]);
  /*
   * Taking hold of a measured span and moving it.
   *
   * One snapshot when it is picked up, none while it travels: a drag is one
   * edit, not sixty, and undo should put it back where it started rather than
   * walk it home a pixel at a time.
   *
   * Both ends look for something to land on as they go - a corner, a crease, a
   * point already marked, the end of another span - and whichever is closer
   * takes the whole span with it, so two dimensions meet exactly rather than
   * nearly.
   */
  const grabbed = useRef<{ step: number; a: Vec2; b: Vec2 } | null>(null);

  const grabDimension = useCallback((p: Vec2): boolean => {
    if (tool !== 'select') return false;
    const at = creaseAt(p, 0.008);
    if (at === null) return false;
    const step = stepsRef.current[at];
    if (!step || step.kind !== 'dimension') return false;
    grabbed.current = { step: at, a: step.a, b: step.b };
    setPast((h) => [...h.slice(-60), stepsRef.current]);
    setFuture([]);
    setSelected(at);
    return true;
  }, [tool, creaseAt]);

  const moveGrabbed = useCallback((from: Vec2, to: Vec2) => {
    const held = grabbed.current;
    if (!held) return;
    let tx = to[0] - from[0];
    let ty = to[1] - from[1];

    // Look for something for either end to land on, and take the nearer.
    const mine = new Set([held.a, held.b].map((q) => `${q[0].toFixed(6)},${q[1].toFixed(6)}`));
    let bestD = 0.004;
    let caught = false;
    for (const end of [held.a, held.b]) {
      const at: Vec2 = [end[0] + tx, end[1] + ty];
      for (const sp of snaps) {
        if (mine.has(`${sp.p[0].toFixed(6)},${sp.p[1].toFixed(6)}`)) continue;
        const d = Math.hypot(sp.p[0] - at[0], sp.p[1] - at[1]);
        if (d < bestD) {
          bestD = d;
          caught = true;
          tx += sp.p[0] - at[0];
          ty += sp.p[1] - at[1];
        }
      }
    }

    /*
     * Half a centimetre at a time, unless it has caught on something.
     *
     * A span dragged freely lands on 3.7cm from the edge, which is a number
     * nobody chose. Stepping it keeps the reading round while it is being
     * moved by eye - and landing on a corner or another span's end is a
     * deliberate choice, so that still wins outright.
     */
    if (!caught) {
      const step = 0.005;
      tx = Math.round(tx / step) * step;
      ty = Math.round(ty / step) * step;
    }

    const a: Vec2 = [held.a[0] + tx, held.a[1] + ty];
    const b: Vec2 = [held.b[0] + tx, held.b[1] + ty];
    const next = stepsRef.current.map((s, i) => (i === held.step && s.kind === 'dimension'
      ? { ...s, a, b } : s));
    stepsRef.current = next;
    setSteps(next);
  }, [snaps]);

  const dropGrabbed = useCallback(() => { grabbed.current = null; }, []);

  /*
   * Turning the model over.
   *
   * It goes in the script like anything else, so it can be undone, moved past,
   * or taken out - and so that replaying the script produces the same model,
   * which it would not if the turn lived only in the camera.
   */
  const flipOverStep = useCallback(() => {
    pushSteps([{ kind: 'flip', label: '뒤집기' }]);
  }, [pushSteps]);

  /*
   * The same fold on the other side.
   *
   * Symmetry can be asked for in advance, but it is just as natural to fold
   * one side, look at it, and then want the same on the other - so this takes
   * a fold already made and adds its mirror image about the centre line as a
   * new step. It goes on the end rather than beside the original, because that
   * is the order the hands would do it in, and the layer audit checks it like
   * any other fold.
   */
  const mirrorStep = useCallback((index: number) => {
    const at = stepsRef.current[index];
    if (!at || !isFold(at)) return;
    const axis = width / 2;
    const flip = (p: Vec2): Vec2 => [2 * axis - p[0], p[1]];
    if (Math.abs(at.a[0] - axis) < 1e-9 && Math.abs(at.b[0] - axis) < 1e-9) return;
    edit((prev) => [...prev, {
      ...at,
      a: flip(at.a),
      b: flip(at.b),
      movingSide: flip(at.movingSide),
      symmetric: undefined,
      group: undefined,
      label: `${at.label} (반대쪽)`,
    }]);
  }, [edit, width]);

  /** Whether a step has a mirror image distinct from itself. */
  const canMirror = useCallback((index: number) => {
    const at = stepsRef.current[index];
    if (!at || !isFold(at)) return false;
    const axis = width / 2;
    return !(Math.abs(at.a[0] - axis) < 1e-9 && Math.abs(at.b[0] - axis) < 1e-9);
  }, [width]);

  /** Another span exactly like this one, a little clear of it. */
  const duplicateStep = useCallback((index: number) => {
    const at = stepsRef.current[index];
    if (!at || at.kind !== 'dimension') return;
    const off = 0.008;
    edit((prev) => [...prev, {
      ...at,
      a: [at.a[0] + off, at.a[1] - off] as Vec2,
      b: [at.b[0] + off, at.b[1] - off] as Vec2,
    }]);
  }, [edit]);

  /** Stretch a measured span to a length, keeping where it began. */
  const resizeDimension = useCallback((index: number, mm: number) => {
    edit((prev) => prev.map((s, i) => {
      if (i !== index || s.kind !== 'dimension') return s;
      const dx = s.b[0] - s.a[0];
      const dy = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) return s;
      const k = mm / 1000 / len;
      const b: Vec2 = [s.a[0] + dx * k, s.a[1] + dy * k];
      return { ...s, b, label: `치수 ${cm(mm / 1000)}` };
    }));
  }, [edit]);

  const deleteStep = useCallback((index: number) => {
    edit((prev) => prev.filter((_, i) => i !== index));
    setSelected(null);
  }, [edit]);

  const undo = useCallback(() => {
    setPast((h) => {
      if (h.length === 0) return h;
      const now = stepsRef.current;
      const back = h[h.length - 1]!;
      stepsRef.current = back;
      setFuture((f) => [now, ...f]);
      setSteps(back);
      return h.slice(0, -1);
    });
    setSelected(null);
    setMarked(new Set());
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const now = stepsRef.current;
      const forward = f[0]!;
      stepsRef.current = forward;
      setPast((h) => [...h, now]);
      setSteps(forward);
      return f.slice(1);
    });
    setSelected(null);
    setMarked(new Set());
  }, []);
  /*
   * What the right button offers.
   *
   * On a crease it is the handful of things anyone actually wants: change the
   * angle, turn it inside out, make it a reference line, take it away. On bare
   * paper it is the view. Each of them goes through the same script edit the
   * panel uses, so undo works on them exactly as it does on everything else.
   */
  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    // A finished plane, or a walk-through: ways of looking, and the way in to fold.
    if (readOnly) {
      return [
        { label: '화면 맞춤', run: () => fitRef.current?.() },
        { label: '전개도 보기', run: () => { setShowFlight(false); setShowDieline(true); } },
        ...(airframe ? [{ label: '✈ 날려 보기', run: () => { setShowDieline(false); setShowFlight(true); } }] : []),
        { separator: true, label: '', run: () => {} },
        tutorial
          ? { label: '여기서부터 직접 접기', run: () => foldFromHere() }
          : { label: '✎ 수정하기', hint: '다시 고쳐 접을 수 있게 접는 도구를 꺼내요.', run: () => setEditing(true) },
      ];
    }
    const step = menu.step;
    /*
     * On the paper, not on a line: what folding a book aeroplane keeps asking
     * for, in the order it asks. Undo first, since a right click is so often
     * "that was wrong"; then the two moves every book begins and ends with -
     * the centre crease and turning the model over; then the finishing folds;
     * then the other ways of looking at it.
     */
    if (step === null) {
      const wing = () => {
        const built = wingletSteps(width, height, steps, wingletCm * 10, paper, Date.now());
        if (typeof built === 'string') {
          setCollapseNote(built === 'too-wide'
            ? '윙렛 폭이 날개보다 넓어요. 폭을 줄여 보세요.'
            : '아직 날개가 없어요. 날개를 먼저 접은 다음 윙렛을 접어요.');
          return;
        }
        pushSteps(built);
        announce(`양쪽 윙렛을 접었습니다 (+${built.length})`);
      };
      return [
        { label: '되돌리기', hint: 'Cmd Z', run: () => undo() },
        { label: '다시 하기', hint: 'Cmd Shift Z', run: () => redo() },
        { separator: true, label: '', run: () => {} },
        { label: '뒤집기', hint: '종이를 뒤집어 반대쪽을 접을 수 있게 해요.', run: () => flipOverStep() },
        { label: '세로로 반 접었다 펴기', hint: '가운데 기준선을 만들어요.', run: () => applyPreset('crease-v') },
        { label: '세로로 반 접기', run: () => applyPreset('half-v') },
        { separator: true, label: '', run: () => {} },
        { label: `양쪽 윙렛 접기 (${wingletCm}cm)`, hint: '왼쪽 ‘윙렛 접기’의 폭으로 접어요.', run: wing },
        { separator: true, label: '', run: () => {} },
        { label: '화면 맞춤', run: () => fitRef.current?.() },
        { label: '전개도 보기', run: () => { setShowFlight(false); setShowDieline(true); } },
        ...(airframe ? [{ label: '✈ 날려 보기', run: () => { setShowDieline(false); setShowFlight(true); } }] : []),
      ];
    }
    const at = steps[step];
    if (at && at.kind === 'dimension') {
      return [
        { label: `${step + 1}단계 선택`, run: () => setSelected(step) },
        { label: '복제', hint: '같은 길이의 치수를 하나 더 놓습니다.',
          run: () => duplicateStep(step) },
        { separator: true, label: '', run: () => {} },
        { label: '이 치수 삭제', danger: true, run: () => deleteStep(step) },
      ];
    }
    const fold = at && isFold(at) ? at : null;
    const now = fold?.angleDeg ?? 180;
    return [
      { label: `${step + 1}단계 선택`, run: () => setSelected(step) },
      ...(canMirror(step) ? [{
        label: '반대쪽도 접기',
        hint: '중심선 기준 거울상을 새 단계로 추가합니다.',
        run: () => mirrorStep(step),
      }] : []),
      { separator: true, label: '', run: () => {} },
      {
        label: fold?.sense === 'mountain' ? '골 접기로 바꾸기' : '산 접기로 바꾸기',
        hint: '접는 방향을 뒤집습니다.',
        run: () => updateStep(step, {
          sense: fold?.sense === 'mountain' ? 'valley' : 'mountain',
        }),
      },
      // The two a book aeroplane uses: flat, and the wings stood at a right angle.
      ...[180, 90].map((d) => ({
        label: `${d === 180 ? '끝까지' : '직각으로'} 접기 (${d}°)${now === d ? ' ✓' : ''}`,
        run: () => updateStep(step, { angleDeg: d }),
      })),
      {
        label: fold?.creaseOnly ? '접힌 상태로 되돌리기' : '자국만 남기기',
        hint: '접었다 펴서 기준선으로만 씁니다.',
        run: () => updateStep(step, { creaseOnly: !fold?.creaseOnly }),
      },
      { separator: true, label: '', run: () => {} },
      ...(step < steps.length - 1 ? [{
        label: '이 단계까지만 남기기',
        hint: '이 뒤에 접은 단계를 모두 지워요. 되돌리기로 다시 살릴 수 있어요.',
        run: () => edit((prev) => prev.slice(0, step + 1)),
      }] : []),
      { label: '이 단계 삭제', danger: true, run: () => deleteStep(step) },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, steps, updateStep, deleteStep, duplicateStep, mirrorStep, canMirror, undo, redo, wingletCm, elevOn, airframe, toggleElevator, readOnly, tutorial]);

  /*
   * The step list, worked like a layers panel.
   *
   * Shift takes a run, Cmd picks them out one at a time - the same two keys
   * every list in every editor uses. Several steps at once matters here because
   * a macro lays down two or three of them and taking one away on its own
   * leaves the rest dangling.
   */

  const pickStep = useCallback((i: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchorRef.current !== null) {
      const lo = Math.min(anchorRef.current, i);
      const hi = Math.max(anchorRef.current, i);
      const run = new Set<number>();
      for (let k = lo; k <= hi; k++) run.add(k);
      setMarked(run);
      setSelected(i);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setMarked((prev) => {
        const next = new Set(prev);
        if (next.has(i)) next.delete(i); else next.add(i);
        return next;
      });
      anchorRef.current = i;
      setSelected(i);
      return;
    }
    anchorRef.current = i;
    const same = selected === i && marked.size <= 1;
    setMarked(same ? new Set() : new Set([i]));
    setSelected(same ? null : i);
  }, [selected, marked]);

  const deleteMarked = useCallback(() => {
    const doomed = marked;
    edit((prev) => prev.filter((_, i) => !doomed.has(i)));
    setMarked(new Set());
    setSelected(null);
    anchorRef.current = null;
  }, [marked, edit]);

  /*
   * Opening a fold without undoing it.
   *
   * Undo removes the step; unfolding keeps it and opens the paper, leaving the
   * crease behind - which is what a pair of hands does all the time, and what
   * half of origami is built on. In the script it is the same step with its
   * "crease only" flag turned on, so everything after it replays over the
   * opened sheet.
   */
  /*
   * The creases pressed after it stay where they are on the paper. They were
   * made through the fold now being opened, and are recorded as lines in the
   * view of the folded paper; replayed over the opened sheet they would land
   * somewhere else. So each is pinned first, to the pieces the paper has now.
   */
  const unfoldLast = useCallback(() => {
    const now = stepsRef.current;
    for (let i = now.length - 1; i >= 0; i--) {
      const at = now[i]!;
      if (!isFold(at) || at.creaseOnly) continue;
      const pieces = replay(width, height, now, useThickness ? paper.foldedPitch : 0).stepCreases;
      const order = Math.max(0, ...now.map((s) => (isFold(s) ? s.unfoldedAt ?? 0 : 0))) + 1;
      edit((prev) => prev.map((s, j) => {
        if (j === i && isFold(s)) return { ...s, creaseOnly: true, unfolded: true, unfoldedAt: order };
        if (j > i && isFold(s) && s.creaseOnly && !s.pinned) return { ...s, pinned: pieces[j] ?? [] };
        return s;
      }));
      return;
    }
  }, [edit, width, height, useThickness, paper.foldedPitch]);

  /* The fold opened last closes first, the way hands undo their own opening. */
  const refoldLast = useCallback(() => {
    const now = stepsRef.current;
    let pick = -1;
    for (let i = now.length - 1; i >= 0; i--) {
      const at = now[i]!;
      if (!isFold(at) || !at.creaseOnly || !at.unfolded) continue;
      const best = pick >= 0 ? now[pick]! : null;
      if (pick < 0 || (isFold(at) && best && isFold(best) && (at.unfoldedAt ?? 0) > (best.unfoldedAt ?? 0))) pick = i;
    }
    if (pick >= 0) updateStep(pick, { creaseOnly: false, unfolded: undefined, unfoldedAt: undefined, pinned: undefined });
  }, [updateStep]);

  const canUnfold = steps.some((s) => isFold(s) && !s.creaseOnly);
  const canRefold = steps.some((s) => isFold(s) && s.creaseOnly && s.unfolded);

  /*
   * One way in for a session, whoever opened it.
   *
   * A link, a file and the shelf all hand over the same thing - a script, a
   * sheet size, a weight and a name - and all three used to unpack it
   * separately. They drifted: opening a file forgot to clear an imported FOLD
   * pattern, opening a link forgot the error from last time. Written once,
   * what "open" means is the same from every direction.
   */
  const adoptSession = useCallback((loaded: {
    widthMm: number; heightMm: number; gsm: number; steps: Step[]; name: string; elevator?: ElevatorTune; done?: boolean; vee?: number;
    throwAngle?: number;
  }) => {
    // Its wings' V, as the plane was set to fly.
    // Its wings' V and its throw angle, as the plane was set to fly.
    setFlightSettings((f) => ({ ...f, vee: loaded.vee ?? null, angle: loaded.throwAngle ?? DEFAULT_FLIGHT.angle }));
    setEditing(loaded.done === false);
    // The elevator is only ever recommended: one set by hand before is let go,
    // and the one it was finished with stands in until it is worked out again.
    setElevOn(false);
    setElevEdit({});
    setSavedAuto(loaded.elevator?.auto ? loaded.elevator : null);
    setFlyElev(null);
    // The throw it is recommended for is this plane's, once its settings are in.
    setRecAsk(null);
    setRecommended(null);
    setSavedFlight({ vee: loaded.vee ?? null, angle: loaded.throwAngle ?? DEFAULT_FLIGHT.angle });
    // Opening a plane is not folding it: nothing to keep until it changes.
    savedKey.current = JSON.stringify([loaded.steps, null, loaded.done === false, loaded.vee ?? null, loaded.throwAngle ?? DEFAULT_FLIGHT.angle]);
    openedContent.current = JSON.stringify([loaded.steps, null, loaded.vee ?? null, loaded.throwAngle ?? DEFAULT_FLIGHT.angle]);
    setAutoSaved(null);
    const replacing = stepsRef.current.length;
    // Everything the opened plane replaces, so the notice can give it all back.
    const was = { sizeId, gsm, name: planeName, standUp, editing };
    const before = stepsRef.current;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const size = SHEET_SIZES.find(
      (z) => near(z.widthMm, loaded.widthMm) && near(z.heightMm, loaded.heightMm));
    if (!size) throw new Error(`${loaded.widthMm}×${loaded.heightMm}mm 종이는 목록에 없습니다.`);
    setSizeId(size.id);
    setGsm(loaded.gsm);
    /*
     * Opened as if it had been folded here, one step at a time.
     *
     * The history kept whole scripts, so opening a plane was one entry and
     * the first 뒤로 threw the whole plane away - where anyone stepping back
     * through a book's model expects to see it one fold less. What was on the
     * table before stays at the bottom of the history, and the notice below
     * gives it straight back.
     */
    // Only this plane's own folds: 뒤로 never walks back into the plane that
    // was on the table before - the notice below is how that comes back.
    stepsRef.current = loaded.steps;
    setPast(loaded.steps.map((_, k) => loaded.steps.slice(0, k)).slice(-60));
    setFuture([]);
    setSteps(loaded.steps);
    setSelected(null);
    setMarked(new Set());
    setImported(null);
    setSessionError(null);
    setPlaneName(loaded.name);
    reframe();
    // Something already folded reads as an aeroplane from an angle; a blank
    // sheet, or one only just begun, is worked on from above.
    if (loaded.steps.some((st) => st.kind === 'fold' && !st.creaseOnly)) showAsPlane();
    /*
     * A plane with its wings held out opens standing up. The drawing keeps
     * the body still while folding, so a finished aeroplane is otherwise shown
     * lying on its side - true to the folding, but not what anyone opening
     * one wants to see first.
     */
    // A finished one opens stood up whatever it is; one being folded, when its wings are out.
    if (loaded.done !== false || loaded.steps.some((st) => st.kind === 'fold' && !st.creaseOnly
      && (st.angleDeg ?? 180) < 179.5)) setStandUp(true);
    if (replacing > 0) {
      announce(`${loaded.name ? `「${loaded.name}」을` : '작업을'} 열었습니다 — 하던 것은 ${replacing}단계`,
        () => {
          setSizeId(was.sizeId);
          setGsm(was.gsm);
          setPlaneName(was.name);
          setStandUp(was.standUp);
          setEditing(was.editing);
          // Back as its own plane, with its own folds to step back through.
          stepsRef.current = before;
          setSteps(before);
          setPast(before.map((_, k) => before.slice(0, k)).slice(-60));
          setFuture([]);
          reframe();
        });
    }
  }, [edit, reframe, showAsPlane, announce, sizeId, gsm, planeName, standUp, editing]);

  /*
   * Opening a saved plane from the address bar.
   *
   * `?open=<url>` loads a session file the same way the button does. A folded
   * plane is a script, so a link to one is a link to the plane - which is how
   * a design gets handed to someone else, and the only way the whole thing can
   * be checked in a browser without a hand on the file dialog.
   */
  /** Open a session file by its address - a link, or one of the book's planes. */
  const openFromUrl = useCallback(async (url: string) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      adoptSession(readSessionFile(await res.text()));
      /*
       * Frame it after it exists, not before.
       *
       * The script is applied by a state change, so at this point the stage
       * is still showing the blank sheet and framing it frames nothing -
       * which is why a plane opened from a link sat half off the side of the
       * screen. The second one catches the model once it is there.
       */
      setTimeout(reframe, 0);
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : '불러올 수 없습니다.');
    }
  }, [adoptSession, reframe]);

  /*
   * What is on the table survives a reload.
   *
   * A plane opened by link kept its link in the address, so reloading opened
   * the book's plane afresh and threw away everything folded since - the
   * winglets added to 오르막길 gone. The link is used once and taken out of
   * the address; after that the work in progress is kept in the browser at
   * every change and put back, on the same screen, when the page comes back.
   */
  // A plane by its name: the pupil's record of it if there is one, else the book's.
  // The address follows the plane's name as it is given or changed.
  useEffect(() => {
    planeNameRef.current = planeName;
    if (screen !== 'fold') return;
    const named = planeName.trim() ? `/${encodeURIComponent(planeName.trim())}` : '';
    const want = `${ROUTES[place] ?? '#/'}${named}`;
    if (window.location.hash !== want) {
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${want}`);
    }
  }, [planeName, place, screen]);

  const openPlaneByName = useCallback((name: string): boolean => {
    const mine = readShelf(localStorage).find((p) => sameName(p.name, name));
    if (mine) {
      adoptSession(mine);
      setPlaneName(mine.name);
      setNotice(null);
      return true;
    }
    const book = BOOK_PLANES.find((b) => sameName(b.name, name));
    if (book) { void openFromUrl(book.file); return true; }
    return false;
  }, [adoptSession, openFromUrl]);
  openPlaneRef.current = openPlaneByName;

  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (openedRef.current !== null) return;
    const url = new URLSearchParams(window.location.search).get('open');
    openedRef.current = url ?? '';
    if (url) {
      // A link to a book plane opens that plane - as the pupil left it, if
      // they have folded it further. Then the link leaves the address.
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${ROUTES['fold:model']}`);
      const book = BOOK_PLANES.find((b) => b.file === url.replace(/^\//, ''));
      if (!(book && openPlaneByName(book.name))) void openFromUrl(url);
      return;
    }
    if (START_ROUTE?.plane) openPlaneByName(START_ROUTE.plane);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFromUrl]);

  /*
   * Step through a tutorial. The steps shown are the first `at` of the book's,
   * set directly rather than as edits: stepping back and forth through a
   * walk-through is not something to undo.
   */
  const tutorialTo = useCallback((t: { name: string; steps: Step[]; at: number }, at: number) => {
    const next = Math.max(0, Math.min(t.steps.length, at));
    const shown = t.steps.slice(0, next);
    stepsRef.current = shown;
    setSteps(shown);
    setPast([]);
    setFuture([]);
    setSelected(null);
    setMarked(new Set());
    setTutorial({ ...t, at: next });
    // Stood up to fly once it is finished; lying as it is folded until then.
    setStandUp(next === t.steps.length
      && t.steps.some((st) => st.kind === 'fold' && !st.creaseOnly && (st.angleDeg ?? 180) < 179.5));
  }, []);

  /*
   * One plane, one script. A book plane the pupil has folded further IS that
   * plane now: its walk-through is the pupil's steps - winglets and all - not
   * the book's, which come back only through 원래대로 되돌리기.
   */
  const startTutorial = useCallback(async (plane: BookPlane) => {
    try {
      const mine = shelf.find((p) => sameName(p.name, plane.name));
      const loaded = mine
        ? { widthMm: mine.widthMm, heightMm: mine.heightMm, gsm: mine.gsm, steps: [...mine.steps], name: mine.name, elevator: mine.elevator }
        : await (async () => {
          const res = await fetch(plane.file);
          if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
          return readSessionFile(await res.text());
        })();
      setElevOn(false);
      setElevEdit({});
      setSavedAuto(loaded.elevator?.auto ? loaded.elevator : null);
      setFlyElev(null);
      setRecAsk(null);
      setRecommended(null);
      const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
      const size = SHEET_SIZES.find(
        (z) => near(z.widthMm, loaded.widthMm) && near(z.heightMm, loaded.heightMm));
      if (size) setSizeId(size.id);
      setGsm(loaded.gsm);
      setPlaneName(loaded.name || plane.name);
      setImported(null);
      setMode('folded');
      fold.cancel();
      tutorialTo({ name: loaded.name || plane.name, steps: loaded.steps, at: 0 }, 0);
      setScreen('fold');
      showAsPlane();
      setTimeout(reframe, 0);
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : '불러올 수 없습니다.');
    }
  }, [tutorialTo, showAsPlane, reframe, fold, shelf]);

  /*
   * Leave the walk-through and fold from here: what is on screen becomes the
   * work, with its history filled in so 뒤로 steps back through it.
   */
  const foldFromHere = useCallback(() => {
    const now = stepsRef.current;
    setPast(now.map((_, k) => now.slice(0, k)).slice(-60));
    setFuture([]);
    setTutorial(null);
    // Folding on from a walk-through is folding: the bench, not the shelf.
    setEditing(true);
  }, []);

  const reset = () => {
    if (steps.length > 0) announce(`처음부터 — ${steps.length}단계를 비웠습니다`);
    edit(() => []);
    setSelected(null);
    setMarked(new Set());
    reframe();
  };

  const applyPreset = (id: string) => {
    const preset = PRESETS.find((p) => p.id === id);
    const built = preset?.build(session.model);
    if (!preset || !built || built.length === 0) return;
    pushSteps(built.map((b) => ({ ...b, kind: 'fold' as const, sense: 'valley' as const })));
    announce(`「${preset.name}」 단계를 붙였습니다 (+${built.length})`);
  };

  /*
   * How many sheets lie where the fold is being made: on the side that moves,
   * when that is known, else the more crowded side of the line. The fold asks
   * "위 종이만 / 전체" only when there is more than one.
   */
  // A choice made at the fold is for that fold: the next one asks again.
  const askedPly = useRef(false);
  useEffect(() => {
    if (!askedPly.current) return;
    askedPly.current = false;
    setPlySelection(ALL_PLIES);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);
  // Sheets under the line, counted there as a hand counts them (joined paper is one sheet).
  const pliesUnderFold = useMemo(() => {
    const p = fold.pending;
    if (p?.t !== 'side') return 0;
    const dx = p.b[0] - p.a[0];
    const dy = p.b[1] - p.a[1];
    const len = Math.hypot(dx, dy) || 1;
    const mid: Vec2 = [(p.a[0] + p.b[0]) / 2, (p.a[1] + p.b[1]) / 2];
    const sideA: Vec2 = [mid[0] - (dy / len) * 0.01, mid[1] + (dx / len) * 0.01];
    const sideB: Vec2 = [mid[0] + (dy / len) * 0.01, mid[1] - (dx / len) * 0.01];
    if (p.movingSide) return pliesUnderLine(session.state, p.a, p.b, p.movingSide);
    return Math.max(pliesUnderLine(session.state, p.a, p.b, sideA), pliesUnderLine(session.state, p.a, p.b, sideB));
  }, [fold.pending, session.state]);

  const selectedStep = selected !== null ? steps[selected] : undefined;
  // The inspector needs the stack as it stood just before that step ran.
  const layersBeforeSelected = useMemo(
    () => (selected === null ? 0 : replay(width, height, steps.slice(0, selected)).model.layers.length),
    [selected, steps, width, height],
  );

  // Figma habits: Delete removes what is selected, Escape lets it go, and
  // Cmd-Z steps back through the fold script.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (readOnlyRef.current) return;
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (selected === null) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (marked.size > 1) deleteMarked();
        else deleteStep(selected);
      } else if (e.key === 'Escape') {
        setSelected(null);
        setMarked(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, deleteStep, deleteMarked, marked, undo, redo]);

  const shownAt = patternAt === null || steps.length === 0 ? null : Math.min(patternAt, steps.length);
  const patternSession = useMemo(
    () => (shownAt === null ? session : replay(width, height, steps.slice(0, shownAt))),
    [shownAt, session, width, height, steps],
  );

  /**
   * The three pages of the aeroplane: the model as it stands on screen, the
   * pattern with every crease, and the throw from the flying screen.
   */
  const downloadPages = async (as: 'png' | 'pdf') => {
    setDownloading(true);
    try {
      const name = planeName.trim() || '이름 없는 비행기';
      const facts = {
        name,
        paper: `${sheet.name} · ${gsm}g/m²`,
        steps: steps.length,
        size: `${(stats.spanMm / 10).toFixed(1)} × ${(stats.lengthMm / 10).toFixed(1)}`
          + `${stats.standMm >= 0.5 ? ` × ${(stats.standMm / 10).toFixed(1)}` : ''}cm`,
      };
      const model = await drawModelPage(snapshotRef.current?.() ?? null, facts);
      // The pattern a step at a time - each page the sheet as it stood after
      // that fold, its new line picked out and measured - then finished.
      // Turning the paper over leaves no line, so it has no page of its own.
      const patterns: [HTMLCanvasElement, string][] = [];
      for (let i = 0; i < steps.length; i++) {
        if (steps[i]!.kind === 'flip') continue;
        // Let the button say it is working between pages.
        await new Promise((r) => setTimeout(r, 0));
        const at = replay(width, height, steps.slice(0, i + 1));
        patterns.push([drawPatternPage(width, height, at.creases, at.dimensions, steps, facts,
          { current: i, dimRef }), `2-전개도-${String(i + 1).padStart(2, '0')}단계`]);
      }
      patterns.push([drawPatternPage(width, height, session.creases, session.dimensions, steps, facts,
        { current: null, dimRef }), '2-전개도-완성']);
      const fbase = restSpec && !imported && canFly(restSpec.af) ? flightBase(restSpec, flapRegion) : null;
      const report = fbase && restSpec ? flightReport(fbase, restSpec, paper, flightView) : null;
      // The page shows the same batch the flying screen does: seeded, so the
      // same settings give the same numbers.
      const throwsN = 100;
      const batch = report && fbase ? statsNow(fbase.bare,
        statsKey(report.launch, throwsN, [report.vee, flightView.cgInput, flightView.clips]),
        report.af, report.m, report.launch, throwsN, restSpec!, paper) : null;
      const flight = drawFlightPage(report, flightView, facts, batch);
      const base = planeName.trim() || 'paperplane';
      if (as === 'pdf') {
        const url = URL.createObjectURL(pagesToPdf([model, ...patterns.map(([c]) => c), flight]));
        saveDataUrl(url, stamped(base, 'pdf'));
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      } else {
        const parts: [HTMLCanvasElement, string][] = [
          [model, '1-접은모양'], ...patterns, [flight, '3-날려보기'],
        ];
        for (const [canvas, tag] of parts) {
          saveDataUrl(canvas.toDataURL('image/png'), stamped(`${base}-${tag}`));
          // Browsers let a burst of downloads through more readily when spaced.
          await new Promise((r) => setTimeout(r, 350));
        }
      }
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        {screen === 'fold' && (
          <button className="topbar-back" onClick={() => {
            fold.cancel();
            if (tutorial) foldFromHere();
            setShowDieline(false);
            setShowFlight(false);
            setDownloadOpen(false);
            setFlightSettings(DEFAULT_FLIGHT);
            setScreen('list');
          }}>← 목록</button>
        )}
        <h1>종이비행기 시뮬레이터</h1>
        {/*
          * The three ways of looking at the one aeroplane, as a menu that
          * stays put: whichever screen is open, the way to the others is in
          * the same place. They used to be buttons among the display toggles,
          * and each screen had to be closed to reach the next.
          */}
        {screen === 'fold' && (
          <nav className="view-menu" aria-label="화면">
            {([
              ['model', '접은 모양', '접은 비행기를 입체로 봐요.'],
              ['dieline', '전개도', '종이를 다시 펼쳐서, 지금까지 접은 선을 한눈에 봐요.'],
              ['flight', '✈ 날려 보기', '던지는 힘·각도·바람을 골라서, 얼마나 오래 나는지 예측해요.'],
            ] as const).map(([k, label, hint]) => {
              const on = k === 'model' ? !showDieline && !showFlight
                : k === 'dieline' ? showDieline : showFlight;
              const off = k === 'flight' && (!airframe || !!imported);
              return (
                <button key={k} className={on ? 'on' : ''} disabled={off} title={hint}
                  aria-current={on ? 'page' : undefined}
                  onClick={() => { setShowDieline(k === 'dieline'); setShowFlight(k === 'flight'); }}>
                  {label}
                </button>
              );
            })}
          </nav>
        )}
        {/*
          * The aeroplane on paper: its three screens as pictures, or as the
          * pages of one PDF. Up here with the screens themselves, since it
          * takes all three at once.
          */}
        {/*
          * Keeping the aeroplane. It used to take a name typed in the left
          * panel and a small button beside it, and "작업 저장" there downloaded
          * a file - so a pupil who added winglets and pressed save got a file,
          * not a plane on the shelf. Saving is one press, up with the menu.
          */}
        {screen === 'fold' && (
          <button className="topbar-save" disabled={steps.length === 0}
            title="지금 접은 비행기를 목록의 ‘내 비행기’에 저장해요. 같은 이름이 있으면 덮어써요."
            onClick={() => {
              const name = planeName.trim() || freeName();
              if (!planeName.trim()) setPlaneName(name);
              const text = JSON.stringify(
                sessionFile(sheet.widthMm, sheet.heightMm, gsm, steps, name, elevator, !editing, flightSettings.vee, flightSettings.angle), null, 1);
              try {
                setShelf(shelvePlane(localStorage, name, text));
              } catch {
                announce('저장하지 못했어요. 브라우저 저장 공간이 가득 찼거나 막혀 있어요. ‘내려받기’로 파일을 받아 두세요.', null);
                return;
              }
              setDropping(null);
              setShelved({ name, count: steps.length });
              // Pressed, the flying screen's V and angle are the plane's now.
              setSavedFlight({ vee: flightSettings.vee ?? null, angle: flightSettings.angle });
              savedKey.current = JSON.stringify([steps, elevator, editing, flightSettings.vee ?? null, flightSettings.angle]);
              announce(`‘${name}’을(를) 내 비행기에 저장했어요. 목록에서 다시 열 수 있어요.`, null);
            }}>
            💾 저장
          </button>
        )}
        {screen === 'fold' && !tutorial && !imported && steps.length > 0 && (
          editing
            ? <button className="topbar-mode" onClick={() => {
              setEditing(false); fold.cancel();
              // Finished: shown as an aeroplane - stood up, from an angle.
              setStandUp(true); showAsPlane();
              /*
               * Finished, it is tuned for the grown-up's throw it is judged by,
               * and saved so: the elevator that keeps it up longest.
               */
              {
                // Answered after another plane was opened, it is not that plane's.
                const askedFor = JSON.stringify(steps);
                void recommendThrowLater({ widthMm: sheet.widthMm, heightMm: sheet.heightMm, gsm, steps, vee: flightSettings.vee ?? undefined }, DEFAULT_FLIGHT)
                  .then((best) => {
                    if (!best || JSON.stringify(stepsRef.current) !== askedFor) return;
                    setElevEdit({ ...best.elevator, auto: true }); setElevOn(true);
                    setFlightSettings((f) => ({ ...f, angle: best.angle }));
                    setSavedFlight((f) => ({ ...f, angle: best.angle }));
                  })
                  .catch(() => { /* left flat: it can still be tuned by hand */ });
              }
            }}
              title="다 접었어요. 완성된 비행기로 표시하고 보기 모드로 돌아가요.">✓ 다 접었어요</button>
            : <button className="topbar-mode" onClick={() => setEditing(true)}
              title="완성된 비행기를 다시 고쳐 접어요. 접는 도구가 나타나요.">✎ 수정하기</button>
        )}
        {screen === 'fold' && !tutorial && !imported && steps.length > 0 && (
          <span className={`plane-status ${editing ? 'wip' : 'done'}`}>{editing ? '접는 중' : '완성'}</span>
        )}
        {screen === 'fold' && autoSaved && !tutorial && (
          <span className="autosaved" title="접을 때마다 ‘내 비행기’에 저절로 저장돼요.">✓ 자동 저장됨</span>
        )}
        {screen === 'fold' && (
          <div className="download-menu">
            <button className={downloadOpen ? 'on' : ''} disabled={steps.length === 0 || downloading}
              aria-expanded={downloadOpen}
              title="접은 모양 · 전개도 · 날려 보기를 그림이나 PDF로 내려받아요."
              onClick={() => setDownloadOpen((o) => !o)}>
              {downloading ? '만드는 중…' : '⤓ 내려받기'}
            </button>
            {downloadOpen && (
              <div className="download-pop" role="menu">
                <button role="menuitem" onClick={() => { setDownloadOpen(false); void downloadPages('png'); }}>
                  그림으로 (PNG 여러 장)
                  <span>접은 모양 · 단계별 전개도 · 날려 보기</span>
                </button>
                <button role="menuitem" onClick={() => { setDownloadOpen(false); void downloadPages('pdf'); }}>
                  PDF 한 파일로
                  <span>모든 쪽을 한 번에 인쇄하기 좋아요</span>
                </button>
              </div>
            )}
          </div>
        )}
        <span className="topbar-hint">
          {screen === 'list'
            ? '접어 볼 비행기를 고르세요'
            : tutorial
              ? `${tutorial.name} 튜토리얼 · 다음을 눌러 한 단계씩 따라 접어요`
              : '가운데에서 직접 접고 · 오른쪽에서 단계를 봐요'}
        </span>
      </header>

      {screen === 'list' && (
        <PlaneList
          book={BOOK_PLANES.filter((b) => !hidden.includes(b.name.trim()))}
          shelf={shelf}
          dropping={dropping}
          onTutorial={(plane) => { void startTutorial(plane); }}
          onOpenBook={(plane) => {
            setTutorial(null);
            setScreen('fold');
            void openFromUrl(plane.file);
          }}
          onOpenShelf={(plane) => {
            try {
              setTutorial(null);
              adoptSession(plane);
              setPlaneName(plane.name);
              setScreen('fold');
              setTimeout(reframe, 0);
            } catch (e) {
              setSessionError(e instanceof Error ? e.message : '열 수 없습니다.');
            }
          }}
          onFlyBook={(plane) => {
            setTutorial(null);
            setScreen('fold');
            setShowDieline(false);
            void openFromUrl(plane.file).then(() => setShowFlight(true));
          }}
          onFlyShelf={(plane) => {
            try {
              setTutorial(null);
              adoptSession(plane);
              setPlaneName(plane.name);
              setScreen('fold');
              setShowDieline(false);
              setShowFlight(true);
            } catch (e) {
              setSessionError(e instanceof Error ? e.message : '열 수 없습니다.');
            }
          }}
          onDropBook={(plane) => {
            if (dropping !== plane.file) { setDropping(plane.file); return; }
            const copy = shelf.find((p) => sameName(p.name, plane.name));
            if (copy) setShelf(dropPlane(localStorage, copy.id));
            setHidden(hideBook(localStorage, plane.name));
            setDropping(null);
          }}
          onDropShelf={(plane) => {
            if (dropping !== plane.id) { setDropping(plane.id); return; }
            setShelf(dropPlane(localStorage, plane.id));
            setDropping(null);
          }}
          onNew={() => {
            setTutorial(null);
            setPlaneName('');
            setStandUp(false);
            // A new sheet has flat trailing edges and nothing saved yet.
            setElevOn(false);
            setElevEdit({});
            setAutoSaved(null);
            setShelved(null);
            savedKey.current = JSON.stringify([[], null, true]);
            setEditing(true);
            reset();
            setScreen('fold');
          }}
        />
      )}

      <div className={`layout${readOnly ? ' tutorial' : ''}`}
        style={screen !== 'fold' ? { display: 'none' } : undefined}>
        {/*
          * Left: the shortcuts. Things that lay down a whole fold in one press,
          * plus the stock they are made on and the files they come from. The
          * folding itself happens in the middle, on the model.
          */}
        {!readOnly && <aside className="panel left">
          {/*
            * The shelf: planes kept by name, in this browser.
            *
            * The file save below is what leaves the machine. This is what you
            * come back to - a plane you are still working on wants a name and
            * a list, not a folder full of dated downloads.
            */}
          <section>
            <h2>비행기</h2>
            <input
              type="text"
              className="plane-name"
              value={planeName}
              placeholder="이름 (예: 드롭십)"
              maxLength={40}
              onChange={(e) => setPlaneName(e.target.value)}
              /*
               * Enter pressed while a Korean syllable is still being composed
               * commits that syllable; leaving the box at the same moment
               * committed it a second time, so the name ended in its last
               * letter twice. Done after the syllable is, instead.
               */
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                if (e.nativeEvent.isComposing || e.keyCode === 229) { nameEnter.current = true; return; }
                e.currentTarget.blur();
              }}
              onCompositionEnd={(e) => {
                if (!nameEnter.current) return;
                nameEnter.current = false;
                const box = e.currentTarget;
                window.setTimeout(() => box.blur(), 0);
              }}
            />
            {shelved && (
              <p className="note saved-note" role="status">
                ✓ ‘{shelved.name}’ {shelved.count}단계를 저장했어요.
              </p>
            )}
            <p className="note">
              접을 때마다 이 이름으로 ‘내 비행기’에 저절로 저장돼요. 저장한 비행기는 위의 ‘← 목록’에서 골라요.
            </p>
          </section>
          {/* Set once, before the first fold: folded away until wanted. */}
          <details className="panel-fold">
            <summary>
              <h2>종이</h2>
              <span>{sheet.name} · {gsm}g/m²</span>
            </summary>
            <label>
              규격
              <select value={sizeId} onChange={(e) => { setSizeId(e.target.value); reset(); }}>
                {SHEET_SIZES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {(s.widthMm / 10).toFixed(1)}×{(s.heightMm / 10).toFixed(1)}cm
                  </option>
                ))}
              </select>
            </label>
            <label>
              평량 <output>{gsm} g/m² · {(paper.mass * 1000).toFixed(2)} g</output>
              <input type="range" min={60} max={120} step={5}
                value={gsm} onChange={(e) => setGsm(Number(e.target.value))} />
            </label>
            {/* Where a point snaps to on the paper; typed in, since it is set once. */}
            <label>
              격자 (점이 붙는 간격)
              <span className="with-unit">
                <input type="number" className="flight-cg" min={0} max={5} step={0.1}
                  value={snapMm / 10}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v) && v >= 0) setSnapMm(Math.round(v * 10 * 10) / 10);
                  }} />
                <em>cm (0이면 꺼짐)</em>
              </span>
            </label>
            <label className="row-check">
              <input type="checkbox" checked={useThickness}
                onChange={(e) => setUseThickness(e.target.checked)} />
              종이 두께 반영 ({(paper.thickness * 1000).toFixed(3)}mm/겹, 접으면 {(paper.foldedPitch * 1000).toFixed(3)}mm)
            </label>
            <p className="note">
              여러 겹을 한 번에 접으면 바깥 겹이 더 먼 길을 돌아야 해서 끝이
              못 미칩니다. A4를 네 번 접으면(16겹) 80g지는 1.4mm, 100g지는
              1.8mm 짧아집니다.
            </p>
          </details>

          {/*
            * In the order an aeroplane is folded: the centre creases, the body
            * and wings, the tips, and last the tuning before it is thrown.
            */}
          <section>
            {/*
              * Lines first, folds after: a crease pressed and opened again is a
              * guide for what comes next, a different act from folding.
              */}
            <h2>① 선 만들기</h2>
            <p className="note">접었다 펴서 자국만 남겨요. 다음에 접을 때 기준선이 돼요.</p>
            <div className="presets">
              {PRESETS.filter((p) => p.creaseOnly).map((p) => (
                <button key={p.id} title={p.hint} className="crease-btn" onClick={() => applyPreset(p.id)}>
                  ⌇ {p.name}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>② 기본 접기</h2>
            <div className="presets">
              {PRESETS.filter((p) => !p.creaseOnly).map((p) => (
                <button key={p.id} title={p.hint} onClick={() => applyPreset(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h2>③ 몸통과 날개</h2>
            {/*
              * Buttons first; the measurements only when one is pressed. The
              * panel stays short enough to read at a glance, and each fold
              * asks for exactly what it needs at the moment it is made.
              */}
            <div className="presets">
              <button className={macroOpen === 'keelLines' ? 'crease-btn on' : 'crease-btn'}
                onClick={(e) => { { const r = e.currentTarget.closest('section')!.getBoundingClientRect(); const b = e.currentTarget.getBoundingClientRect(); setMacroAt({ top: b.top, left: r.right + 10 }); } setMacroOpen(macroOpen === 'keelLines' ? null : 'keelLines'); }}>⌇ 동체선 그리기</button>
              <button className={macroOpen === 'bodyWings' ? 'on' : ''}
                onClick={(e) => { { const r = e.currentTarget.closest('section')!.getBoundingClientRect(); const b = e.currentTarget.getBoundingClientRect(); setMacroAt({ top: b.top, left: r.right + 10 }); } setMacroOpen(macroOpen === 'bodyWings' ? null : 'bodyWings'); }}>✈ 동체 + 날개 접기</button>
            </div>
            {(macroOpen === 'keelLines' || macroOpen === 'bodyWings') && (
              <div className="macro macro-pop" role="dialog" style={{ top: Math.min(macroAt.top, window.innerHeight - 340), left: macroAt.left }}>
                <p className="note">세로 중심선에서 앞(코)·뒤(꼬리)로 잰 동체 폭이에요. 두 값이 같으면 나란한 띠가 돼요.</p>
                <div className="macro-pair">
                  <label className="macro-input">
                    앞 (코)
                    <span className="with-unit">
                      <ScrubNumber value={keelFrontCm} onChange={setKeelFrontCm}
                        step={0.05} min={0} max={10} places={2} title="코 쪽 동체 폭 · 드래그로 조절" />
                      <em>cm</em>
                    </span>
                  </label>
                  <label className="macro-input">
                    뒤 (꼬리)
                    <span className="with-unit">
                      <ScrubNumber value={keelBackCm} onChange={setKeelBackCm}
                        step={0.05} min={0} max={10} places={2} title="꼬리 쪽 동체 폭 · 드래그로 조절" />
                      <em>cm</em>
                    </span>
                  </label>
                </div>
                {macroOpen === 'bodyWings' && (
                  <label className="macro-input">
                    날개 V자 각도
                    <span className="with-unit">
                      {/* Shown as the V the two wings make, flat being 0°; folded, each wing turns 90° less half of it. */}
                      <ScrubNumber value={2 * (90 - wingDeg)} onChange={(v) => setWingDeg(90 - v / 2)}
                        step={2} min={-40} max={80} places={0} title="두 날개를 평평하게 편 것을 0°로 본 V자 각도 · 드래그로 조절" />
                      <em>°</em>
                    </span>
                  </label>
                )}
                <div className="macro-actions">
                  <button className="primary" onClick={() => {
                    if (macroOpen === 'keelLines') {
                      const built = keelLines(session.model, keelFrontCm * 10, keelBackCm * 10, Date.now());
                      pushSteps(built.map((b) => ({ ...b, kind: 'fold' as const, sense: 'valley' as const })));
                      if (built.length > 0) announce(`동체 선을 그렸습니다 (+${built.length})`);
                    } else {
                      const built = bodyAndWings(width, height, steps, keelFrontCm * 10, keelBackCm * 10, wingDeg, Date.now());
                      if (built.length === 0) {
                        setCollapseNote('여기서는 동체를 접을 수 없습니다 — 동체 폭이 지금 종이보다 넓거나, 반으로 접을 것이 없습니다.');
                        return;
                      }
                      setCollapseNote(null);
                      pushSteps(built);
                      announce(`동체와 날개를 접었습니다 (+${built.length})`);
                    }
                    setMacroOpen(null);
                  }}>{macroOpen === 'keelLines' ? '선 그리기' : '접기'}</button>
                  <button onClick={() => setMacroOpen(null)}>취소</button>
                </div>
              </div>
            )}
          </section>
          <section>
            <h2>④ 날개 끝</h2>
            <div className="presets">
              <button className={macroOpen === 'winglet' ? 'on' : ''}
                onClick={(e) => { { const r = e.currentTarget.closest('section')!.getBoundingClientRect(); const b = e.currentTarget.getBoundingClientRect(); setMacroAt({ top: b.top, left: r.right + 10 }); } setMacroOpen(macroOpen === 'winglet' ? null : 'winglet'); }}>⤒ 윙렛 접기</button>
              <button className={macroOpen === 'dihedral' ? 'on' : ''}
                onClick={(e) => { { const r = e.currentTarget.closest('section')!.getBoundingClientRect(); const b = e.currentTarget.getBoundingClientRect(); setMacroAt({ top: b.top, left: r.right + 10 }); } setMacroOpen(macroOpen === 'dihedral' ? null : 'dihedral'); }}>⤴ 2단·3단 상반각</button>
            </div>
            {macroOpen === 'winglet' && (
              <div className="macro macro-pop" role="dialog" style={{ top: Math.min(macroAt.top, window.innerHeight - 340), left: macroAt.left }}>
                <p className="note">날개 끝에서 안쪽으로 잰 폭이에요. 양쪽 날개 끝이 함께 위로 세워져요.</p>
                <label className="macro-input">
                  윙렛 폭
                  <span className="with-unit">
                    <ScrubNumber value={wingletCm} onChange={setWingletCm}
                      step={0.1} min={0.3} max={4} places={1} title="날개 끝에서 접는 선까지의 폭 · 드래그로 조절" />
                    <em>cm</em>
                  </span>
                </label>
                <div className="macro-actions">
                  <button className="primary" onClick={() => {
                    const built = wingletSteps(width, height, steps, wingletCm * 10, paper, Date.now());
                    if (typeof built === 'string') {
                      setCollapseNote(built === 'too-wide'
                        ? '윙렛 폭이 날개보다 넓어요. 폭을 줄여 보세요.'
                        : '아직 날개가 없어요. 날개를 먼저 접은 다음 윙렛을 접어요.');
                      return;
                    }
                    setCollapseNote(null);
                    pushSteps(built);
                    announce(`양쪽 윙렛을 접었습니다 (+${built.length})`);
                    setMacroOpen(null);
                  }}>접기</button>
                  <button onClick={() => setMacroOpen(null)}>취소</button>
                </div>
              </div>
            )}
            {macroOpen === 'dihedral' && (
              <div className="macro macro-pop" role="dialog" style={{ top: Math.min(macroAt.top, window.innerHeight - 340), left: macroAt.left }}>
                <p className="note">날개 끝에서 안쪽으로 잰 곳을 접어 날개를 계단처럼 올려요. 각도는 접었을 때 올라간 각도예요.</p>
                <div className="flight-choices">
                  {([2, 3] as const).map((n) => (
                    <button key={n} className={dihStage === n ? 'on' : ''} onClick={() => setDihStage(n)}>{n}단</button>
                  ))}
                </div>
                {dihBreaks.slice(0, dihStage - 1).map((br, i) => (
                  <div className="macro-pair" key={i}>
                    <label className="macro-input">
                      {dihStage === 3 ? (i === 0 ? '바깥 선' : '안쪽 선') : '접는 선'} · 끝에서
                      <span className="with-unit">
                        <ScrubNumber value={br.fromTipCm}
                          onChange={(v) => setDihBreaks((b) => b.map((x, k) => (k === i ? { ...x, fromTipCm: v } : x)))}
                          step={0.1} min={0.5} max={10} places={1} title="날개 끝에서 접는 선까지 · 드래그로 조절" />
                        <em>cm</em>
                      </span>
                    </label>
                    <label className="macro-input">
                      각도
                      <span className="with-unit">
                        <ScrubNumber value={br.angleDeg}
                          onChange={(v) => setDihBreaks((b) => b.map((x, k) => (k === i ? { ...x, angleDeg: v } : x)))}
                          step={1} min={1} max={60} places={0} title="접었을 때 올라간 각도 · 드래그로 조절" />
                        <em>°</em>
                      </span>
                    </label>
                  </div>
                ))}
                <div className="macro-actions">
                  <button className="primary" onClick={() => {
                    const built = dihedralSteps(width, height, steps, dihBreaks.slice(0, dihStage - 1), paper, Date.now());
                    if (typeof built === 'string') {
                      setCollapseNote(built === 'too-wide'
                        ? '접는 선이 날개보다 안쪽이에요. 끝에서 잰 길이를 줄여 보세요.'
                        : '아직 날개가 없어요. 날개를 먼저 접은 다음 상반각을 접어요.');
                      return;
                    }
                    setCollapseNote(null);
                    pushSteps(built);
                    announce(`${dihStage}단 상반각을 접었습니다 (+${built.length})`);
                    setMacroOpen(null);
                  }}>접기</button>
                  <button onClick={() => setMacroOpen(null)}>취소</button>
                </div>
              </div>
            )}


          </section>


          {/*
            * Saving the work, as opposed to saving a picture of it.
            *
            * The script is the model, so this is the file that can be picked
            * up again - by this app, by another browser, or by the checks,
            * which replay it with the same code the app runs.
            */}
          <details className="panel-fold">
            <summary><h2>파일로 옮기기</h2><span>다른 컴퓨터 · FOLD</span></summary>
          <section>
            <div className="presets">
              <button
                disabled={steps.length === 0}
                title="접은 단계를 파일(.json)로 내려받아요. 다른 컴퓨터로 옮기거나 친구에게 줄 때 써요."
                onClick={() => saveText(
                  JSON.stringify(
                    sessionFile(sheet.widthMm, sheet.heightMm, gsm, steps, planeName, elevator, !editing, flightSettings.vee, flightSettings.angle),
                    null, 1),
                  stamped(planeName.trim() || 'session', 'json'),
                )}
              >
                파일로 내려받기
              </button>
              <button
                title="저장한 작업을 불러와 그 상태에서 이어 접습니다."
                onClick={async () => {
                  const file = await openText('.json,application/json');
                  if (!file) return;
                  try {
                    adoptSession(readSessionFile(file.text));
                  } catch (e) {
                    setSessionError(e instanceof Error ? e.message : '읽을 수 없는 파일입니다.');
                  }
                }}
              >
                파일 열기
              </button>
            </div>
            {sessionError && <p className="note warn">{sessionError}</p>}
            <p className="note">
              파일로 내려받아 두면 다른 컴퓨터에서도 ‘파일 열기’로 불러와 이어서 접을 수 있어요.
              접은 단계가 모두 들어 있어요.
            </p>
          </section>

          <section>
            <h2>FOLD 파일</h2>
            <div className="presets">
              <button
                disabled={steps.length === 0}
                title="펼친 크리스 패턴을 FOLD로 저장합니다. Origami Simulator나 Oriedita에서 열어 대조할 수 있습니다."
                onClick={() => saveText(
                  JSON.stringify(creasePatternFile(session.state.graph), null, 1),
                  stamped('pattern', 'fold'),
                )}
              >
                FOLD로 내보내기 (전개도)
              </button>
            </div>
            <button
              className="crease-btn"
              title="다른 도구에서 만든 FOLD 패턴을 읽어 형상만 확인합니다."
              onClick={async () => {
                const file = await openText('.fold,application/json');
                if (!file) return;
                try {
                  setImported({ name: file.name, graph: readFoldFile(file.text) });
                  reframe();
                } catch (e) {
                  setImportError(e instanceof Error ? e.message : '읽을 수 없는 파일입니다.');
                }
              }}
            >
              ⌇ FOLD 열기 (보기 전용)
            </button>
            {importError && <p className="note warn">{importError}</p>}
            <p className="note">
              FOLD는 크리스 패턴을 기록하지, 손이 접은 순서를 기록하지 않습니다.
              그래서 불러온 패턴은 형상만 볼 수 있고 단계별로 되돌릴 수는 없습니다.
              내보내기는 다른 시뮬레이터에 같은 파일을 넣어 우리 결과를
              대조하는 용도입니다.
            </p>
          </section>
          </details>
        </aside>}


        {/*
          * The flat pattern, on call.
          *
          * Folding happens on the model now, so the pattern is no longer a
          * drawing surface - it is what the fold script produces: the sheet to
          * print and cut. It opens over the work rather than sitting beside it,
          * which gives the model the whole window.
          */}
        {showFlight && airframe && flySpec && (rec || imported) && (
          <FlightPanel spec={flySpec} planeName={planeName} plies={restSpec ? restPlies : plies} paper={paper}
            settings={flightView} onSettings={onFlightSettings} shownPlies={reshapedPlies}
            elevatorTune={elevUsed ?? elevShown} recommended={rec}
            ownElevator={!!flyElev}
            onElevatorTune={(patch) => setFlyElev((e) => ({ ...(e ?? elevUsed ?? elevShown), ...patch, auto: undefined }))}
            onUseRecommended={() => setFlyElev(null)}
            onRecompute={() => setRecAsk(flightSettings)}
            recommendedAngle={cardsAngle ?? (bestAngle && bestAngle.key === angleKey ? bestAngle.angle : null)} />
        )}
        {showFlight && airframe && !rec && !imported && (
          <div className="flight-overlay"><p className="flight-hint">이 비행기에 맞는 엘리베이터를 찾는 중이에요…</p></div>
        )}
        {showDieline && (
          <div className="dieline-overlay">
            {/* The screen's own menu: the same row, in the same place, on every screen. */}
            <div className="subbar">
              <span className="subbar-title">전개도</span>
              <div className="subbar-group">
                <em>단계</em>
                <button className={shownAt !== null ? 'on' : ''} disabled={steps.length === 0}
                  onClick={() => setPatternAt(shownAt === null ? 1 : null)}>
                  {shownAt === null ? '단계별로 보기' : '전체 보기'}
                </button>
                {shownAt !== null && (
                  <>
                    <button onClick={() => setPatternAt(Math.max(1, shownAt - 1))} disabled={shownAt <= 1}>◀</button>
                    <span className="pattern-step-label">
                      <b>{shownAt} / {steps.length}</b> {steps[shownAt - 1]?.label}
                    </span>
                    <button onClick={() => setPatternAt(Math.min(steps.length, shownAt + 1))}
                      disabled={shownAt >= steps.length}>▶</button>
                  </>
                )}
              </div>
              <div className="subbar-group">
                <em>치수</em>
                <button className={showDims ? 'on' : ''} onClick={() => setShowDims(!showDims)}>
                  치수 표시
                </button>
                {([['centre', '중심선 기준'], ['corner', '모서리 기준']] as const).map(([k, n]) => (
                  <button key={k} className={dimRef === k ? 'on' : ''}
                    disabled={!showDims} onClick={() => setDimRef(k)}>
                    {n}
                  </button>
                ))}
              </div>
              <div className="subbar-group">
                <em>크기</em>
                <button onClick={() => setViewport((v) => zoomViewport(v, 1 / 1.25))}>−</button>
                <button onClick={() => setViewport(identityViewport)}>{Math.round(viewport.zoom * 100)}%</button>
                <button onClick={() => setViewport((v) => zoomViewport(v, 1.25))}>+</button>
              </div>
            </div>
            <div className="canvas-wrap">
              <Dieline
                sheetWidth={width}
                sheetHeight={height}
                creases={patternSession.creases}
                graph={patternSession.state.graph}
                dimensions={patternSession.dimensions}
                steps={steps}
                selected={selected}
                onSelect={setSelected}
                viewport={viewport}
                onViewport={setViewport}
                dimRef={dimRef}
                showDims={showDims}
                latestStep={shownAt === null ? null : shownAt - 1}
              />

            </div>
          </div>
        )}

        <main className="stage solid">
          {tutorial && (
            <div className="tutorial-bar">
              <span className="tutorial-count">
                {tutorial.at} / {tutorial.steps.length}
              </span>
              <span className="tutorial-step">
                {tutorial.at === 0
                  ? '종이를 준비해요. ‘다음’을 눌러 시작해요.'
                  : tutorial.steps[tutorial.at - 1]!.label}
                {tutorial.at === tutorial.steps.length && ' — 완성!'}
              </span>
              <span className="tutorial-actions">
                <button onClick={() => tutorialTo(tutorial, tutorial.at - 1)}
                  disabled={tutorial.at === 0}>◀ 이전</button>
                <button className="primary" onClick={() => tutorialTo(tutorial, tutorial.at + 1)}
                  disabled={tutorial.at === tutorial.steps.length}>다음 ▶</button>
                <button onClick={() => tutorialTo(tutorial, 0)} disabled={tutorial.at === 0}>
                  처음부터
                </button>
                <button onClick={foldFromHere}
                  title="튜토리얼을 멈추고, 지금 모양에서 도구로 직접 이어 접어요.">
                  여기서부터 직접 접기
                </button>
              </span>
            </div>
          )}
          <div className="subbar">
            <span className="subbar-title">{imported ? `불러온 패턴 · ${imported.name}` : '접은 모양'}</span>
            <div className="subbar-group">
              <em>보는 방향</em>
              {VIEWS.map(([name, dir]) => (
                <button key={name} onClick={() => setView((v) => ({ key: (v?.key ?? 0) + 1, dir }))}>{name}</button>
              ))}
              <button title="크게 보기 (마우스 휠·두 손가락으로도 돼요)" onClick={() => zoomRef.current?.(0.8)}>＋</button>
              <button title="작게 보기" onClick={() => zoomRef.current?.(1.25)}>－</button>
              <button onClick={() => fitRef.current?.()}>화면 맞춤</button>
              <button title="종이를 탁자 위에서 90°씩 돌려요. 접은 것은 그대로예요."
                onClick={() => { setPaperTurn((t) => (t + 1) % 4); reframe(); }}>↻ 종이 돌리기</button>
            </div>
            {/*
              * What is shown, not what the paper is: each an on/off switch,
              * lit while on, so its label never has to say which state it is in.
              */}
            <div className="subbar-group">
              <em>보이기</em>
              <button className={showCreases ? 'on' : ''} onClick={() => setShowCreases(!showCreases)}
                title="접은 자국을 보여 주거나 감춰요. 모양만 보고 싶을 때 꺼요.">접은 선</button>
              <button className={showDims ? 'on' : ''} onClick={() => setShowDims(!showDims)}
                title="길이를 잰 치수선을 보여 주거나 감춰요.">치수선</button>
              <button className={shadePile ? 'on' : ''} onClick={() => setShadePile(!shadePile)}
                title="종이가 여러 겹 쌓인 곳일수록 진하게 칠해요.">겹 색칠</button>
              <button className={standUp ? 'on' : ''} onClick={() => setStandUp(!standUp)}
                title="비행기가 날 때처럼 똑바로 세워서 보여 줘요.">비행기 세우기</button>
            </div>
            {imported && (
              <div className="subbar-group">
                <button onClick={() => { setImported(null); setImportError(null); reframe(); }}>
                  불러온 패턴 닫기
                </button>
              </div>
            )}
          </div>
          {notice && (
            <div className="notice" role="status" key={notice.key}>
              <span>{notice.text}</span>
              {notice.restore !== null && (
                <button onClick={() => { (notice.restore ?? undo)(); setNotice(null); }}>되돌리기</button>
              )}
              <button className="notice-close" aria-label="닫기"
                onClick={() => setNotice(null)}>×</button>
            </div>
          )}
          <Stage3D
            model={session.model}
            plies={importedPlies ?? (pocketGhosts ? [...shownPlies, ...pocketGhosts] : shownPlies)}
            reshape={importedPlies ? null : reshape}
            paper={paper}
            mode={mode}
            previewIndex={previewIndex}
            attitude={!imported && standUp && airframe ? flyingAttitude : undefined}
            turn={paperTurn}
            shadeByPile={shadePile}
            fitKey={fitToken}
            view={view}
            hideViewControls
            animating={animating}
            onSnapshotReady={(grab) => { snapshotRef.current = grab; }}
            onFitReady={(fit) => { fitRef.current = fit; }}
            onZoomReady={(zoom) => { zoomRef.current = zoom; }}
            /*
             * Folding on the model itself.
             *
             * `useFoldTool` has always taken points in paper coordinates and
             * never asked which view they came from, so the 3D stage feeds it
             * the same way the flat view does - and the sense, angle, ply and
             * symmetry controls keep working without knowing anything changed.
             */
            state={importedState ?? session.state}
            picking={mode === 'folded' && !imported && !readOnly}
            onPick={(p, perPixel, kind, sheet) => {
              // Sixteen pixels of reach, whatever the zoom - the same rule the
              // snapping uses, so what you can catch matches what you can see.
              const reach = Math.max(0.0008, 16 * perPixel);
              if (pocketPick && pocket) {
                // 선대로 접기: the line the squash goes along, one of the lines on the paper.
                const onto = pickAt(session.model, session.viewCreases, snaps, p, reach * 2, 'edge');
                const line: [Vec2, Vec2] | null = onto && onto.kind === 'edge' ? [onto.s.a, onto.s.b] : edgeOnModel(p, reach * 2)?.view ?? null;
                if (!line) return;
                const fs = pocket.step.kind === 'fold' ? pocket.step : null;
                if (!fs || pocketCount(fs.plies) === null) return;
                const st0 = session.state;
                const count = pocketCount(fs.plies)!;
                const along = (l: [Vec2, Vec2]) => pocketOptions(st0, fs.a, fs.b, fs.movingSide,
                  pliesAtLine(st0, fs.a, fs.b, fs.movingSide, count),
                  fs.symmetric ? width / 2 : undefined, [{ a: l[0], b: l[1], how: 'along' }]);
                // A mirrored fold squashes both pockets alike: a line picked at the
                // mirror's corner means its twin at the fold's own.
                let found = along(line);
                if (found.length === 0 && fs.symmetric) found = along([[width - line[0][0], line[0][1]], [width - line[1][0], line[1][1]]]);
                setPocketPick(null);
                if (found.length === 1) {
                  pushStep({ kind: 'collapse', at: fs.movingSide, label: `${fs.label} · 선대로 접기`, lines: found[0]!.lines });
                  setPocket(null);
                  return;
                }
                setPocket({ ...pocket, options: found.length ? found : pocket.all,
                  note: found.length ? `고른 선으로 접히는 방법이 ${found.length}가지예요. 모양을 보고 골라 주세요.`
                    : '그 선으로는 납작하게 접히지 않아요. 빨간 점(주머니 꼭짓점)을 지나는 선을 골라 보세요.' });
                return;
              }
              const stepped = roundedSpan(p, kind);
              if (stepped) { fold.tap(stepped, null); return; }
              // Selecting is forgiving: a line is a thin thing to hit, and
              // catching the wrong one is undone by clicking the right one,
              // whereas missing leaves nothing to correct.
              if (tool === 'select') { setSelected(creaseAt(p, reach * 2.5)); return; }
              // The align tool needs to know whether a corner or an edge was
              // hit; everything else only needs the point.
              /*
               * Only the click that names the DESTINATION picks something off
               * the paper. Aligning a point, that is the second click and it
               * may land on either a corner or a line; aligning a line, it is
               * the third and it means a line.
               */
              const naming = tool === 'align'
                && (grab === 'point'
                  ? fold.pending?.t === 'alignFrom'
                  : fold.pending?.t === 'align');
              fold.tap(p, naming
                ? pickAt(session.model, session.viewCreases, snaps, p, reach,
                  grab === 'edge' ? 'edge' : undefined)
                : null, paperAt(sheet));
            }}
            onHover={(p, kind, sheet) => {
              if (pocketPick && pocket) {
                // The line that would be caught, lit.
                const onto = p ? pickAt(session.model, session.viewCreases, snaps, p, 0.004, 'edge') : null;
                setPocketHover(onto && onto.kind === 'edge' ? [onto.s.a, onto.s.b] : null);
                return;
              }
              if (tool === 'select') { setHoverStep(p ? creaseAt(p) : null); return; }
              // Show the point that will actually be taken, not the raw one
              // under the cursor - otherwise the reading jumps the moment you
              // click, which is the one moment it must not.
              fold.setHoverSide(p ? (roundedSpan(p, kind) ?? p) : null, paperAt(sheet));
              // Once a number is being typed the direction is settled: reaching
              // for the box drags the pointer across other lines on the way.
              if (p && fold.pending?.t === 'anchor' && (tool === 'measure' || tool === 'line')
                && measureCm === '') {
                setMeasureAim(aimFrom(fold.pending.a, p));
              }
            }}
            creases={imported || !showCreases ? undefined : stageCreases}
            dimensions={imported || !showDims ? undefined : session.viewDimensions}
            highlights={highlights}
            guide={(() => {
              const at = fold.pending;
              if (at?.t === 'side') return { a: at.a, b: at.b };
              /*
               * A lead line while a fold is being drawn.
               *
               * The segment between the two points says how long it is; the
               * line carried right across the paper says where the crease will
               * run and which side of it travels. Both, then - the reach for
               * the fold, the span for the measurement.

               * The paper is never cut. The line divides it into two halves
               * that stay joined along the crease, which is the whole of what
               * a fold is.
               */
              if (at?.t === 'anchor' && tool === 'line' && fold.hoverSide) {
                return { a: at.a, b: fold.hoverSide };
              }
              return null;
            })()}
            rubber={(() => {
              const at = fold.pending;
              if (!fold.hoverSide) return null;
              if (at?.t === 'anchor') return { a: at.a, b: fold.hoverSide };
              // The align tool stretches the same band while naming its target.
              if (at?.t === 'alignFrom') return { a: at.a, b: fold.hoverSide };
              // Aiming at a line: the band becomes where the paper will land.
              if (at?.t === 'align') return landing;
              return null;
            })()}
            marks={stageMarks}
            // Selecting is not drawing: snapping would drag the pointer off
            // the very line being pointed at, putting it out of reach.
            snaps={tool === 'select' ? [] : snaps}
            snapMm={tool === 'select' ? 0 : snapMm}
            prompt={stagePrompt}
            onSnap={setSnapKind}
            onContext={(p, at) => setMenu({ at, step: p ? creaseAt(p) : null })}
            dragDraws={tool === 'line' || tool === 'measure'}
            orbit={tool === 'select'}
            onDrag={(a, b) => fold.dragLine(a, b)}
            onGrab={grabDimension}
            onGrabMove={moveGrabbed}
            onGrabEnd={dropGrabbed}
          />
          {!readOnly && <WorkBar
            tool={tool} onTool={setTool}
            grab={grab} onGrab={setGrab}
            onFlip={flipOverStep}
            onUnfold={unfoldLast} canUnfold={canUnfold}
            onRefold={refoldLast} canRefold={canRefold}
            symmetric={symmetric} onSymmetric={setSymmetric}
          />}
        </main>
        {/*
          * Right: what is selected, and what the model is. A step's own
          * settings when one is picked, otherwise the reading of the paper.
          */}
        <aside className="panel right">
          {/*
            * Paper does not cut and it does not thread through a fold that is
            * already shut. When the stack says otherwise the model on screen is
            * not a fold any hand could make, so say which step broke it rather
            * than letting a plausible-looking picture stand.
            */}
          {collapseNote && (
            <div className="alarm">
              <strong>이렇게는 접을 수 없어요</strong>
              <p>{collapseNote}</p>
              <button type="button" onClick={() => setCollapseNote(null)}>닫기</button>
            </div>
          )}
          {session.blockedAt >= 0 && (
            <div className="alarm">
              <strong>접을 수 없는 단계입니다</strong>
              <p>
                {session.blockedAt + 1}단계
                {(() => {
                  const step = steps[session.blockedAt];
                  return step ? ` \u00b7 ${step.label}` : '';
                })()}
                에서 종이가 스스로를 통과합니다. 이 아래 단계는 손으로 접을 수 없습니다.
              </p>
              <ul>
                {session.impossible.slice(0, 3).map((v, i) => (
                  <li key={i}>
                    {v.kind === 'taco-taco'
                      ? '이미 접힌 주름 사이로 다른 주름이 끼어듭니다.'
                      : '닫힌 주름 안쪽에 있으면서 그 끝을 뚫고 나갑니다.'}
                  </li>
                ))}
              </ul>
              <button type="button" onClick={() => setSelected(session.blockedAt)}>
                해당 단계 보기
              </button>
            </div>

          )}
          {selectedStep && !readOnly ? (
            <StepInspector
              index={selected!}
              step={selectedStep}
              layerCount={layersBeforeSelected}
              onUpdate={updateStep}
              onResize={resizeDimension}
              onMirror={canMirror(selected!) ? () => mirrorStep(selected!) : undefined}
              onDelete={deleteStep}
              onClose={() => setSelected(null)}
            />
          ) : !readOnly && (
            <section>
              <h2>겹 선택</h2>
              <PlyPicker
                value={plySelection}
                onChange={setPlySelection}
                layerCount={session.model.layers.length}
              />
              <p className="note">
                접기가 가져갈 겹입니다. 스쿼시처럼 위쪽 몇 겹만 움직이는 접기는
                겹을 골라야 제대로 동작합니다.
              </p>
            </section>
          )}
            <section>
              <h2>상태</h2>
              <dl className="readout">
                <div><dt>레이어</dt><dd>{stats.layerCount}</dd></div>
                <div><dt>접는 선</dt><dd>{stats.creaseCount}</dd></div>
                <div><dt>치수</dt><dd>{stats.dimensionCount}</dd></div>
                <div><dt>크기</dt>
                  <dd title="접힌 모양을 공간에서 잰 것입니다 (가로 × 세로 × 높이).">
                    {(stats.spanMm / 10).toFixed(1)} × {(stats.lengthMm / 10).toFixed(1)}
                    {stats.standMm >= 0.5
                      && ` × ${(stats.standMm / 10).toFixed(1)}`} cm
                  </dd></div>
                <div><dt>도면</dt>
                  <dd title="세운 것을 눕혀 그린 전개 도면의 크기입니다.">
                    {(stats.widthMm / 10).toFixed(1)} × {(stats.heightMm / 10).toFixed(1)} cm
                  </dd></div>
                <div><dt>최대 겹침</dt>
                  <dd title="한 자리에 실제로 포개진 겹입니다. 90°로 선 날개는 도면에서만 겹칩니다.">
                    {stats.maxPlies}겹</dd></div>
                {stats.hardestStep >= 0 && (
                  <div><dt>한 번에 접는 겹</dt>
                    <dd className={stats.tooThick ? 'warn' : ''}
                      title="한 번의 접기로 눌러 접는 겹 수 중 가장 많은 것입니다. 손으로 접기 어려운 정도는 이걸로 정해집니다.">
                      {stats.hardestPlies}겹</dd></div>
                )}
                <div><dt>면적 보존</dt>
                  <dd className={Math.abs(stats.areaRatio - 1) > 1e-6 ? 'warn' : 'good'}>
                    {(stats.areaRatio * 100).toFixed(4)} %
                  </dd></div>
              </dl>
              {stats.tooThick && (
                <p className="warning">
                  {stats.hardestStep + 1}단계
                  {steps[stats.hardestStep]?.label ? ` (${steps[stats.hardestStep]!.label})` : ''}에서
                  한 번에 {stats.hardestPlies}겹을 접습니다. 이만큼 두꺼우면 손으로는
                  접는 선이 그린 자리에 서지 않습니다.
                </p>
              )}
            </section>

          <section className="history-section">
            <h2>단계</h2>
            {!readOnly && <div className="history-controls">
              <button onClick={undo} disabled={past.length === 0}
                title="한 단계 되돌립니다 (Cmd Z)">↶ 뒤로</button>
              <button onClick={redo} disabled={future.length === 0}
                title="되돌린 것을 다시 적용합니다 (Cmd ⇧ Z)">↷ 앞으로</button>
              <button onClick={reset} disabled={steps.length === 0}>처음부터</button>
            </div>}
            {marked.size > 1 && (
              <div className="history-bulk">
                <span>{marked.size}개 선택됨</span>
                <button className="danger" onClick={deleteMarked}>선택 단계 삭제</button>
                <button onClick={() => { setMarked(new Set()); setSelected(null); }}>
                  선택 해제
                </button>
              </div>
            )}
            <ol className="history">
              {steps.length === 0 && <li className="empty">아직 단계가 없습니다.</li>}
              {steps.map((s, i) => (
                <li key={i}
                  className={[
                    selected === i ? 'on' : '',
                    marked.has(i) ? 'marked' : '',
                    hoverStep === i ? 'hovered' : '',
                    s.kind === 'dimension' ? 'dim-step'
                      : s.kind === 'flip' ? 'flip-step'
                        : s.kind === 'collapse' ? 'collapse-step'
                          : s.creaseOnly ? 'crease-step' : '',
                  ].join(' ').trim()}
                  onMouseEnter={() => setHoverStep(i)}
                  onMouseLeave={() => setHoverStep(null)}
                  onClick={(e) => pickStep(i, e)}>
                  <span className="idx">{i + 1}</span>
                  <span>{s.label}</span>
                  <span className="sense">
                    {s.kind === 'dimension' ? '↔'
                      : s.kind === 'flip' ? '⇋'
                        : s.kind === 'collapse' ? '✳'
                          : s.creaseOnly ? '⌇' : senseMark(s.sense)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>

      {/*
        * The fold chooser belongs to neither panel.
        *
        * A line can now be drawn on the flat draft or straight onto the model,
        * so anchoring it inside one of them would mean finishing the fold on
        * the other side of the screen from where it was begun.
        */}
      {pocket && (
        <PocketChooser options={pocket.options} note={pocket.note} picked={pocket.picked}
          picking={pocketAlign ? 'align' : pocketPick?.stage ?? null}
          onAlong={() => {
            if (pocketAlign) { fold.cancel(); setTool(pocketAlign.tool); setGrab(pocketAlign.grab); setPocketAlign(null); }
            setPocketPick({ stage: 'line' });
          }}
          onNarrow={() => {
            setPocketPick(null);
            setPocketAlign({ tool, grab });
            fold.cancel();
            setTool('align');
            setGrab('edge');
          }}
          onShowAll={() => {
            if (pocketAlign) { fold.cancel(); setTool(pocketAlign.tool); setGrab(pocketAlign.grab); setPocketAlign(null); }
            setPocket({ ...pocket, options: pocket.all, note: undefined, picked: undefined }); setPocketPick(null);
          }}
          onPick={(o) => {
            const base = pocket.step.kind === 'fold' ? pocket.step.label : '접기';
            pushStep({ kind: 'collapse', at: pocket.step.kind === 'fold' ? pocket.step.movingSide : [0, 0], label: `${base} · ${o.label}`, lines: o.lines });
            setPocket(null);
          }}
          onCancel={() => { setPocket(null); setPocketPick(null); }} />
      )}
      <FoldChooser fold={fold} angleDeg={foldAngle} onAngleChange={setFoldAngle}
        ply={plySelection} onPly={(v) => { askedPly.current = true; setPlySelection(v); }} layers={pliesUnderFold} />
          {fold.pending?.t === 'anchor' && (tool === 'measure' || tool === 'line') && (
            <form className="fold-chooser measure-bar"
              onSubmit={(e) => {
                e.preventDefault();
                const cmValue = Number(measureCm.replace(',', '.'));
                const pending = fold.pending;
                if (!measureAim || pending?.t !== 'anchor' || !(cmValue > 0)) return;
                const from = pending.a;
                const at: Vec2 = [from[0] + measureAim.dir[0] * cmValue / 100,
                  from[1] + measureAim.dir[1] * cmValue / 100];
                fold.tap(at, null);
                setMeasureCm('');
              }}>
              <span className="chooser-note">{tool === 'measure' ? '치수' : '직선'}</span>
              <label className="chooser-measure">
                <em>찍은 점에서</em>
                <input type="text" inputMode="decimal" autoFocus value={measureCm}
                  placeholder="7" aria-label="찍은 점에서의 거리 (cm)"
                  onChange={(e) => setMeasureCm(e.target.value)} />
                <em>cm</em>
              </label>
              <em className="dim">
                {measureAim?.along ? '선을 따라' : '커서 쪽으로'}
                {measureCm === '' ? ' — 커서를 선에 대고 숫자를 치세요' : ' — 방향 고정됨'}
              </em>
              <button type="submit" className="on" disabled={!measureAim || !(Number(measureCm.replace(',', '.')) > 0)}>
                {tool === 'measure' ? '점 찍기' : '끝점 놓기'}
              </button>
              <button type="button" onClick={fold.cancel}>취소</button>
            </form>
          )}

      {menu && (
        <ContextMenu at={menu.at} onClose={() => setMenu(null)} items={menuItems} />
      )}
    </div>
  );
}
