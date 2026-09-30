/**
 * Engine checks with known answers. Run with `npm run validate`.
 *
 * Both halves of the engine have a property that must hold regardless of input:
 * folding conserves paper area exactly, and the vortex lattice must land near
 * lifting-line theory for a rectangular wing at moderate aspect ratio.
 */

import {
  affineApply, affineInverse, affineMul, flipLine, fold, foldThrough, layerOutline,
  lineThrough, lineToLocal, maxPlies, modelBounds, plyFilter, pointInPolygon, polygonArea,
  reflectionAbout, sheetModel, signedDistance, totalArea,
} from '../src/geometry/fold.js';
import type { Affine } from '../src/geometry/fold.js';
import type { FoldSense, PlySelection } from '../src/geometry/fold.js';
import type { Vec2 } from '../src/geometry/math.js';
import { foldStats, pleatSteps, replay, resolveSnap, snapPoints } from '../src/ui/foldSession.js';
import { framedSteps } from '../src/ui/useAnimatedPlies.js';
import { segmentKey } from '../src/geometry/crease.js';
import { faceUnder } from '../src/origami/folding.js';
import { pliesAtLine, pocketHinges, pocketOptions } from '../src/origami/pocket.js';
import { collapsePattern } from '../src/origami/collapse.js';
import type { Step } from '../src/ui/foldSession.js';
import { SAMPLES } from './samples.js';
import { readFileSync } from 'node:fs';
import { lengthenNose, noseStretch } from '../src/aero/airframe.js';
import { foldEdges, rollLength } from '../src/ui/foldSession.js';
import { CELL, measurePlane } from '../src/aero/spec.js';
import { throwsAround } from '../src/ui/flightStats.js';
import { airborneVee, flightBase, flightReport, DEFAULT_FLIGHT } from '../src/ui/flightReport.js';
import { sideEdgeVortex } from '../src/aero/flight.js';
import { wingletSteps } from '../src/ui/winglets.js';
import { buildAirframe } from '../src/aero/airframe.js';
import { aeroModel, bestElevator, fly, noseBulge, withDihedral, withNoseBulge } from '../src/aero/flight.js';
import { readSessionFile, sessionFile } from '../src/ui/sessionFile.js';
import { SHELF_KEY, dropPlane, readShelf, shelvePlane } from '../src/ui/planeLibrary.js';
import type { Shelf } from '../src/ui/planeLibrary.js';
import { bodyAndWings } from '../src/ui/foldSession.js';
import {
  closeCreases, collapseAlong, collapseAtPoint, creasesAt, linesThrough, openingsThatFold,
} from '../src/origami/collapse.js';
import { solveOrder } from '../src/origami/order.js';
import { alignFold } from '../src/geometry/constructions.js';
import type { Pick, Segment } from '../src/geometry/constructions.js';
import { paperProps, SHEET_SIZES } from '../src/paper/stock.js';
/** The checks are written in A4 numbers, so say so rather than trusting an index. */
const A4 = SHEET_SIZES.find((z) => z.id === 'a4');
import {
  addCrease, faceAdjacency, lineThroughPoints, sheetGraph,
  totalArea as graphArea,
} from '../src/origami/graph.js';
import {
  faceIsFlipped, faceOutline, flatSheet, foldThroughPoints, paperArea, plyCountAt,
} from '../src/origami/folding.js';
import type { FoldedState } from '../src/origami/folding.js';
import {
  foldInSpace as foldInSpaceHeld, patternCreases, planTurn, renderFaces as renderFacesHeld, restingPose,
} from '../src/origami/space.js';
/*
 * Shapes are checked as the model rests, largest piece down: a finished
 * aeroplane on its wings, keel hanging. The drawing holds the body still while
 * folding instead, which is checked on its own below.
 */
const renderFaces: typeof renderFacesHeld = (state, ...rest) =>
  renderFacesHeld(restingPose(state), ...rest);
const foldInSpace: typeof foldInSpaceHeld = (state, ...rest) =>
  foldInSpaceHeld(restingPose(state), ...rest);
import { creasePatternFile, foldedStateFile, readFoldFile } from '../src/origami/foldFile.js';
import { orderViolations, stackLevels, tacos } from '../src/origami/layers.js';
import { buildSystem, freestream, liftAxis, solve, RHO } from '../src/aero/vlm.js';
import type { LatticePanel } from '../src/aero/vlm.js';
import type { Vec3 } from '../src/geometry/math.js';

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name.padEnd(46)} ${detail}`);
  if (!ok) failures++;
}

// --- Folding conserves paper ------------------------------------------------
{
  const W = 0.21, H = 0.297;
  let model = sheetModel(W, H);
  const expected = W * H;

  const script: Array<[string, () => void]> = [
    ['fold in half', () => { model = foldThrough(model, [W / 2, 0], [W / 2, H], [W, H / 2]); }],
    ['left nose', () => { model = foldThrough(model, [W / 2, H], [0, H - 0.12], [0, H]); }],
    ['right nose', () => { model = foldThrough(model, [W / 2, H], [W, H - 0.12], [W, H]); }],
    ['mountain wing', () => {
      model = foldThrough(model, [W * 0.3, 0], [W * 0.3, H], [0, H / 2], 'mountain');
    }],
  ];

  for (const [label, step] of script) {
    step();
    const ratio = totalArea(model) / expected;
    check(`area conserved after ${label}`, Math.abs(ratio - 1) < 1e-9,
      `ratio=${ratio.toFixed(12)}  layers=${model.layers.length}`);
  }
  const plies = maxPlies(model);
  check('ply count is plausible', plies >= 2 && plies <= 16, `max=${plies}`);
}

// --- Folding only some of the plies ------------------------------------------
// A squash fold moves the plies on top and leaves the rest put. Paper is still
// conserved, and the plies left out must come through untouched.
{
  const W = 0.21;
  const H = 0.297;
  let model = sheetModel(W, H);
  model = foldThrough(model, [W / 2, 0], [W / 2, H], [W, H / 2]);
  model = foldThrough(model, [0, H / 2], [W, H / 2], [W / 2, H]);
  const before = model.layers.length;
  const untouched = model.layers.slice(0, 2).map((l) => JSON.stringify(l.outline));

  // After two half folds the stack lives in x 0..W/2, y 0..H/2, so the crease
  // has to sit inside that quarter to cross any paper at all.
  const cut = H * 0.25;
  const line = lineThrough([0, cut], [W, cut]);
  const oriented = signedDistance(line, [W / 4, H * 0.4]) < 0 ? flipLine(line) : line;

  const all = fold(model, oriented, 'valley');
  const topTwo = fold(model, oriented, 'valley', plyFilter({ kind: 'top', count: 2 }, model.layers));

  check('partial fold conserves paper', Math.abs(totalArea(topTwo) / (W * H) - 1) < 1e-9,
    `ratio=${(totalArea(topTwo) / (W * H)).toFixed(12)}`);
  check('partial fold leaves the others whole',
    untouched.every((o) => topTwo.layers.some((l) => JSON.stringify(l.outline) === o)),
    `${before} plies in, ${topTwo.layers.length} out`);
  check('partial fold moves less than a full one',
    topTwo.layers.length < all.layers.length,
    `top-2 -> ${topTwo.layers.length} plies, all -> ${all.layers.length}`);

  const none = fold(model, oriented, 'valley', plyFilter({ kind: 'top', count: 0 }, model.layers));
  check('selecting no plies changes nothing', none.layers.length === before,
    `${none.layers.length} vs ${before}`);
}

// --- Paper thickness ---------------------------------------------------------
// Folding a stack, the plies on the outside of the bend travel further, so their
// free edges land short. Paper is still conserved; it just does not reach as far.
{
  const W = 0.21;
  const H = 0.297;
  const halve = (times: number, thickness: number) => {
    let m = sheetModel(W, H);
    for (let i = 0; i < times; i++) {
      const b = modelBounds(m);
      const x = (b.min[0] + b.max[0]) / 2;
      let line = lineThrough([x, b.min[1]], [x, b.max[1]]);
      if (signedDistance(line, [b.max[0], (b.min[1] + b.max[1]) / 2]) < 0) line = flipLine(line);
      m = fold(m, line, 'valley', undefined, thickness);
    }
    return m;
  };
  const shortfall = (m: ReturnType<typeof sheetModel>) => {
    const edges = m.layers.map((l) => Math.min(...layerOutline(l).map((p) => p[0])));
    return Math.max(...edges) - Math.min(...edges);
  };

  const thin = paperProps(A4!, 80).thickness;
  const thick = paperProps(A4!, 120).thickness;

  check('thickness does not create or destroy paper',
    Math.abs(totalArea(halve(4, thin)) / (W * H) - 1) < 1e-9,
    `ratio=${(totalArea(halve(4, thin)) / (W * H)).toFixed(12)}`);
  check('ideal paper loses nothing', shortfall(halve(4, 0)) < 1e-12,
    `${(shortfall(halve(4, 0)) * 1000).toFixed(3)} mm`);

  const two = shortfall(halve(2, thin));
  const four = shortfall(halve(4, thin));
  check('more folds lose more', four > two * 2,
    `2 folds ${(two * 1000).toFixed(2)}mm, 4 folds ${(four * 1000).toFixed(2)}mm`);
  check('thicker paper loses more', shortfall(halve(4, thick)) > four,
    `80g ${(four * 1000).toFixed(2)}mm, 120g ${(shortfall(halve(4, thick)) * 1000).toFixed(2)}mm`);
  check('the loss is a few calipers, not a few millimetres per ply',
    four > 8 * thin && four < 20 * thin,
    `${(four * 1000).toFixed(2)}mm for ${(thin * 1000).toFixed(3)}mm paper`);
}

// --- Pleat -------------------------------------------------------------------
// Fold and fold back: the second crease must land where the flap actually is,
// not where it was quoted on the flat sheet, or the two creases coincide.
{
  const W = 0.21;
  const H = 0.297;
  const spacing = 0.02;
  const steps = pleatSteps(
    sheetModel(W, H), [0, H * 0.6], [W, H * 0.6], [W / 2, H], 'valley', spacing);
  const out = replay(W, H, steps);

  check('a pleat makes two creases', steps.length === 2, `${steps.length} steps`);
  check('a pleat conserves paper',
    Math.abs(totalArea(out.model) / (W * H) - 1) < 1e-9,
    `ratio=${(totalArea(out.model) / (W * H)).toFixed(12)}`);
  check('a pleat stacks three plies', maxPlies(out.model) === 3,
    `${out.model.layers.length} layers, ${maxPlies(out.model)} deep`);

  // The step should be exactly as wide as it was asked to be.
  const { min, max } = modelBounds(out.model);
  const lost = H - (max[1] - min[1]);
  check('a pleat shortens the sheet by twice its spacing',
    Math.abs(lost - 2 * spacing) < 1e-9,
    `lost ${(lost * 1000).toFixed(2)}mm for ${(spacing * 1000).toFixed(1)}mm spacing`);
}

// --- Symmetric folds ---------------------------------------------------------
// Saying a fold once with the symmetry flag has to land exactly where saying it
// twice by hand does, or the shorthand is not shorthand but a second design.
{
  const W = 0.21;
  const H = 0.297;
  const mid = W / 2;
  const lineA: [Vec2, Vec2] = [[mid, H], [0, H - 0.1]];
  const mirrored: [Vec2, Vec2] = [[mid, H], [W, H - 0.1]];

  const byHand = replay(W, H, [
    { kind: 'fold', a: lineA[0], b: lineA[1], movingSide: [0, H],
      sense: 'valley', creaseOnly: false, label: 'left' },
    { kind: 'fold', a: mirrored[0], b: mirrored[1], movingSide: [W, H],
      sense: 'valley', creaseOnly: false, label: 'right' },
  ]);
  const byFlag = replay(W, H, [
    { kind: 'fold', a: lineA[0], b: lineA[1], movingSide: [0, H],
      sense: 'valley', creaseOnly: false, symmetric: true, label: 'both' },
  ]);

  check('symmetric fold matches two folds by hand',
    byFlag.model.layers.length === byHand.model.layers.length,
    `${byFlag.model.layers.length} vs ${byHand.model.layers.length} plies`);
  check('symmetric fold conserves paper',
    Math.abs(totalArea(byFlag.model) / (W * H) - 1) < 1e-9,
    `ratio=${(totalArea(byFlag.model) / (W * H)).toFixed(12)}`);

  let drift = 0;
  byHand.model.layers.forEach((layer, i) => {
    const other = byFlag.model.layers[i];
    if (!other) { drift = Infinity; return; }
    drift = Math.abs(polygonArea(layer.outline) - polygonArea(other.outline)) > drift
      ? Math.abs(polygonArea(layer.outline) - polygonArea(other.outline)) : drift;
  });
  check('symmetric fold produces the same plies', drift < 1e-12,
    `max area drift=${drift.toExponential(2)} m2`);

  // A crease already on the axis must not be doubled onto itself.
  const onAxis = replay(W, H, [
    { kind: 'fold', a: [mid, 0], b: [mid, H], movingSide: [W, H / 2],
      sense: 'valley', creaseOnly: false, symmetric: true, label: 'centre' },
  ]);
  check('a fold on the axis is not doubled', onAxis.model.layers.length === 2,
    `${onAxis.model.layers.length} plies`);
}

// --- Inside reverse fold -----------------------------------------------------
// The geometry is the same as an ordinary fold; what differs is where the tips
// end up in the stack. On a two-ply flap: a valley lays them on top, a mountain
// slides them underneath, and a reverse threads them between the two bodies.
{
  const W = 0.21;
  const H = 0.297;
  let flap = sheetModel(W, H);
  flap = foldThrough(flap, [W / 2, 0], [W / 2, H], [W, H / 2]);

  const cut = lineThrough([0, H * 0.8], [W, H * 0.8]);
  const oriented = signedDistance(cut, [W / 4, H]) < 0 ? flipLine(cut) : cut;

  /** Where the two small tip pieces sit in the stack. */
  const tipSlots = (model: ReturnType<typeof sheetModel>) => {
    const areas = model.layers.map((l, i) => ({ i, a: polygonArea(l.outline) }));
    return areas.sort((x, y) => x.a - y.a).slice(0, 2).map((e) => e.i).sort((x, y) => x - y);
  };

  for (const [sense, expected] of [
    ['valley', [2, 3]],
    ['mountain', [0, 1]],
  ] as const) {
    const out = fold(flap, oriented, sense);
    const slots = tipSlots(out);
    check(`${sense} puts the tips at ${expected.join(',')}`,
      out.layers.length === 4 && slots[0] === expected[0] && slots[1] === expected[1],
      `${out.layers.length} plies, tips at ${slots.join(',')}`);
    check(`${sense} conserves paper`, Math.abs(totalArea(out) / (W * H) - 1) < 1e-9,
      `ratio=${(totalArea(out) / (W * H)).toFixed(12)}`);
  }
}

// --- Pulling a crease back onto a ply ---------------------------------------
// A ply folded an even number of times carries a rotation, and a rotation is
// not symmetric. Transforming the crease normal by the wrong matrix still
// conserves area, so only a direct residual check catches it.
{
  const axis = (deg: number): Affine => {
    const r = (deg * Math.PI) / 180;
    return reflectionAbout(lineThrough([0, 0], [Math.cos(r), Math.sin(r)]));
  };
  const cases: Array<[string, Affine]> = [
    ['single reflection', axis(37)],
    ['rotation 54 deg', affineMul(axis(37), axis(10))],
    ['rotation 138 deg', affineMul(axis(80), axis(11))],
    ['reflection after rotation', affineMul(affineMul(axis(23), axis(61)), axis(7))],
  ];
  const view = lineThrough([0.03, 0.1], [0.17, 0.21]);
  for (const [name, xf] of cases) {
    const local = lineToLocal(view, xf);
    const inv = affineInverse(xf);
    let worst = 0;
    for (let t = -1; t <= 1.001; t += 0.25) {
      const onView: Vec2 = [0.03 + t * 0.14, 0.1 + t * 0.11];
      worst = Math.max(worst, Math.abs(signedDistance(local, affineApply(inv, onView))));
    }
    check(`crease pulls back onto ${name}`, worst < 1e-12, `residual=${worst.toExponential(2)} m`);
  }
}

/*
 * The same script, folded in space.
 *
 * These checks were written against the ply-stack engine and are kept word for
 * word against the crease-pattern one, because what they assert is about paper,
 * not about how the program represents it: a flat fold must stay in the plane
 * and cover the same ground as the flat model, one fold takes every ply it cuts
 * the same way round, and closing a fold further must bring the flap down.
 */
interface Step3 {
  a: Vec2;
  b: Vec2;
  movingSide: Vec2;
  sense: FoldSense;
  creaseOnly: boolean;
  angleDeg?: number;
  plies?: PlySelection;
}

const foldTo3D = (w: number, h: number, steps: readonly Step3[]) =>
  renderFaces(replay(w, h,
    steps.map((s3) => ({ kind: 'fold' as const, label: '', ...s3 }))).state);

{
  const W = 0.21;
  const H = 0.297;
  const steps: Step3[] = [
    { a: [W / 2, 0], b: [W / 2, H], movingSide: [W, H / 2], sense: 'valley', creaseOnly: false },
    { a: [W / 2, H], b: [0, H - 0.12], movingSide: [0, H], sense: 'valley', creaseOnly: false },
    { a: [W * 0.3, 0], b: [W * 0.3, H], movingSide: [0, H / 2], sense: 'mountain', creaseOnly: false },
  ];

  const plies = foldTo3D(W, H, steps);
  let flat = sheetModel(W, H);
  for (const s2 of steps) flat = foldThrough(flat, s2.a, s2.b, s2.movingSide, s2.sense);

  let outOfPlane = 0;
  for (const ply of plies) for (const q of ply.points) outOfPlane = Math.max(outOfPlane, Math.abs(q[2]));
  check('flat folds stay in the sheet plane', outOfPlane < 1e-12, `max|z|=${outOfPlane.toExponential(2)} m`);
  check('3D ply count matches the flat model', plies.length === flat.layers.length,
    `${plies.length} vs ${flat.layers.length}`);

  /*
   * The two views cannot be compared point for point: where the flat model sits
   * is fixed by the sheet, while the model in space is built by walking out from
   * one face and is therefore only pinned down up to a rigid motion. What must
   * agree is the paper itself - the same pieces, of the same sizes.
   */
  const sizes = (areas: number[]) => areas.map((a) => (a * 1e6).toFixed(3)).sort().join(',');
  check('3D carries the same pieces as the flat model',
    sizes(plies.map((p) => p.area))
      === sizes(flat.layers.map((l) => polygonArea(layerOutline(l)))),
    `${plies.length} pieces, ${(plies.reduce((t, p) => t + p.area, 0) * 1e4).toFixed(2)} cm2`);

  // One fold takes every ply it cuts the same way round, so a single wing fold
  // on a folded-in-half sheet gives one wing, not two. Getting both means two
  // folds, each naming its own half of the stack - which is exactly what you do
  // with real paper when you turn the model over between them.
  {
    const mid = W / 2;
    const half: Step3 = { a: [mid, 0], b: [mid, H], movingSide: [W, H / 2],
      sense: 'mountain', creaseOnly: false, angleDeg: 180 };
    const crease = { a: [mid - 0.022, 0] as Vec2, b: [mid - 0.022, H] as Vec2,
      movingSide: [0, H / 2] as Vec2, creaseOnly: false, angleDeg: 100 };

    const oneFold = foldTo3D(W, H, [half, { ...crease, sense: 'valley' }]);
    /*
     * Which way a wing went cannot be read off the z axis, because the model in
     * space is only fixed up to a rigid motion. It can be read off the paper:
     * the body is the paper that stayed put, and a wing is above or below the
     * plane the body lies in. That question survives any rotation of the model.
     */
    const sides = (plies: typeof oneFold) => {
      const middle = (p: typeof plies[number]) => p.points.reduce(
        (t, q) => [t[0] + q[0] / p.points.length, t[1] + q[1] / p.points.length,
          t[2] + q[2] / p.points.length] as [number, number, number], [0, 0, 0]);
      // The body is the plane the most paper lies in; everything else is a flap.
      const byPlane = new Map<string, typeof plies[number][]>();
      for (const p of plies) {
        const n = p.normal[2] < 0 || (p.normal[2] === 0 && p.normal[1] < 0)
          ? ([-p.normal[0], -p.normal[1], -p.normal[2]] as const) : p.normal;
        const c = middle(p);
        const d = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
        const key = [n[0], n[1], n[2], d].map((v) => v.toFixed(4)).join(',');
        byPlane.set(key, [...(byPlane.get(key) ?? []), p]);
      }
      const body = [...byPlane.values()].sort((a, b) =>
        b.length - a.length
        || b.reduce((t, p) => t + p.area, 0) - a.reduce((t, p) => t + p.area, 0))[0]!;
      const rest = plies.filter((p) => !body.includes(p));
      const n = body[0]!.normal;
      const o = middle(body[0]!);
      let up = 0;
      let down = 0;
      for (const p of rest) {
        const c = middle(p);
        const d = (c[0] - o[0]) * n[0] + (c[1] - o[1]) * n[1] + (c[2] - o[2]) * n[2];
        if (d > 1e-4) up += p.area; else if (d < -1e-4) down += p.area;
      }
      return { up, down };
    };
    const one = sides(oneFold);
    check('one fold makes one wing', one.up === 0 || one.down === 0,
      `+z ${(one.up * 1e4).toFixed(1)}cm2, -z ${(one.down * 1e4).toFixed(1)}cm2`);

    const both = sides(foldTo3D(W, H, [
      half,
      { ...crease, sense: 'valley', plies: { kind: 'top', count: 1 } },
      { ...crease, sense: 'mountain', plies: { kind: 'bottom', count: 1 } },
    ]));
    check('two ply-selected folds make two wings',
      both.up > 0 && both.down > 0
      && Math.abs(both.up - both.down) / Math.max(both.up, both.down) < 0.02,
      `+z ${(both.up * 1e4).toFixed(1)}cm2, -z ${(both.down * 1e4).toFixed(1)}cm2`);
  }

  // Closing the last fold further must bring the flap back toward the plane.
  const heights = [90, 120, 160].map((deg) => {
    const bent = foldTo3D(W, H, steps.map((s2, i) => (i === 2 ? { ...s2, angleDeg: deg } : s2)));
    let hi = 0;
    for (const ply of bent) for (const q of ply.points) hi = Math.max(hi, Math.abs(q[2]));
    return hi;
  });
  check('partial folds leave the plane', heights[0]! > 0.01, `90 deg -> ${(heights[0]! * 1000).toFixed(1)} mm`);
  check('closing the fold lowers the flap',
    heights[0]! > heights[1]! && heights[1]! > heights[2]!,
    heights.map((h) => (h * 1000).toFixed(1)).join(' > ') + ' mm');
}

// --- Folded paper to an airframe ---------------------------------------------
// Folding moves paper around; it never creates or destroys any. And a body made
// of paper is flat, so the moment about the axis square to it must equal the
// sum of the other two - which also fixes which axis is which.
{
  const W = 0.21;
  const H = 0.297;
  const paper = paperProps(A4!, 80);
  const plies = renderFaces(replay(W, H, SAMPLES[0]!.build(W, H)).state);
  const af = buildAirframe(plies, paper);

  check('airframe mass equals the sheet',
    Math.abs(af.mass.mass - paper.mass) < 1e-9,
    `${(af.mass.mass * 1000).toFixed(3)} g vs ${(paper.mass * 1000).toFixed(3)} g`);

  const [ixx, iyy, izz] = af.mass.inertia;
  check('roll is the easiest axis to turn about', ixx < iyy && ixx < izz,
    `Ixx=${(ixx * 1e6).toFixed(2)} Iyy=${(iyy * 1e6).toFixed(2)} Izz=${(izz * 1e6).toFixed(2)} g cm2`);
  check('a flat body obeys the perpendicular-axis theorem',
    Math.abs(izz - (ixx + iyy)) / izz < 0.05,
    `Izz=${(izz * 1e6).toFixed(2)} vs Ixx+Iyy=${((ixx + iyy) * 1e6).toFixed(2)} g cm2`);

  check('span fits inside the sheet', af.span > 0.04 && af.span < W,
    `${(af.span * 1000).toFixed(0)} mm`);
  check('planform is a sensible fraction of the sheet',
    af.wingArea > 0.05 * W * H && af.wingArea < 0.6 * W * H,
    `${(af.wingArea * 1e4).toFixed(0)} cm2 of ${(W * H * 1e4).toFixed(0)} cm2`);
  check('wetted area counts both faces',
    Math.abs(af.wettedArea - 2 * W * H) < 1e-9,
    `${(af.wettedArea * 1e4).toFixed(0)} cm2`);
}

// --- Crease pattern as a graph -----------------------------------------------
// The new model keeps the sheet as faces joined through shared edges. Creasing
// it must divide the paper without losing any, and must leave the pieces joined
// - which is what makes tearing impossible rather than merely detectable.
{
  const W = 0.21;
  const H = 0.297;
  const mid = W / 2;
  const blank = sheetGraph(W, H);

  check('a blank is one face', blank.faces_vertices.length === 1
    && blank.vertices_coords.length === 4 && blank.edges_vertices.length === 4,
    `${blank.faces_vertices.length} face, ${blank.edges_vertices.length} edges`);

  const once = addCrease(blank, lineThroughPoints([mid, 0], [mid, H]), 'valley');
  check('one crease makes two faces', once.faces_vertices.length === 2,
    `${once.faces_vertices.length} faces`);
  check('creasing keeps every bit of paper',
    Math.abs(graphArea(once) / (W * H) - 1) < 1e-12,
    `ratio=${(graphArea(once) / (W * H)).toFixed(12)}`);
  check('the crease is recorded as a valley at 180',
    once.edges_assignment.filter((a) => a === 'valley').length === 1
    && once.edges_foldAngle.some((a) => Math.abs(a - Math.PI) < 1e-9),
    once.edges_assignment.join(','));

  // A crease that misses the paper changes nothing.
  const missed = addCrease(once, lineThroughPoints([W * 2, 0], [W * 2, H]), 'mountain');
  check('a crease off the sheet does nothing',
    missed.faces_vertices.length === once.faces_vertices.length,
    `${missed.faces_vertices.length} faces`);

  // Cross creases: a grid of four faces, all still joined through shared edges.
  const twice = addCrease(once, lineThroughPoints([0, H / 2], [W, H / 2]), 'mountain');
  check('crossing creases make four faces', twice.faces_vertices.length === 4,
    `${twice.faces_vertices.length} faces`);
  check('crossing creases keep every bit of paper',
    Math.abs(graphArea(twice) / (W * H) - 1) < 1e-12,
    `ratio=${(graphArea(twice) / (W * H)).toFixed(12)}`);

  // Every face has to be reachable from every other: the sheet is one piece.
  const adjacency = faceAdjacency(twice);
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.pop()!) ?? []) {
      if (!seen.has(next.face)) { seen.add(next.face); queue.push(next.face); }
    }
  }
  check('the sheet stays in one piece', seen.size === twice.faces_vertices.length,
    `${seen.size} of ${twice.faces_vertices.length} faces reachable`);
}

// --- Folding on the crease-pattern graph -------------------------------------
// The same folds as the old engine, on the new model. Paper is conserved, the
// stack deepens the way it should, and the sheet cannot come apart because the
// faces are joined through shared edges rather than merely stacked.
{
  const W = 0.21;
  const H = 0.297;
  const mid = W / 2;

  let state = flatSheet(W, H);
  check('a flat sheet is one face', state.graph.faces_vertices.length === 1,
    `${state.graph.faces_vertices.length} face`);

  state = foldThroughPoints(state, [mid, 0], [mid, H], [W, H / 2], 'valley');
  check('folding in half makes two faces', state.graph.faces_vertices.length === 2,
    `${state.graph.faces_vertices.length} faces`);
  check('folding conserves paper', Math.abs(paperArea(state) / (W * H) - 1) < 1e-12,
    `ratio=${(paperArea(state) / (W * H)).toFixed(12)}`);

  // The flap really moved: everything now sits on one side of the crease.
  const beyond = state.faces_matrix.flatMap((_, f) =>
    faceOutline(state, f).map((p) => p[0]));
  check('the flap came over', Math.max(...beyond) <= mid + 1e-9,
    `widest point ${(Math.max(...beyond) * 1000).toFixed(1)}mm of ${(mid * 1000).toFixed(0)}mm`);

  // A valley lays the travelling half on top.
  check('a valley puts the flap on top',
    state.faces_order.length === 2 && state.faces_order[1] !== state.faces_order[0],
    `order ${state.faces_order.join(',')}`);
  check('the flap is showing its other face',
    faceIsFlipped(state, state.faces_order[1]!) !== faceIsFlipped(state, state.faces_order[0]!),
    'one of the two has turned over');

  // Fold again: the crease is one line on screen but two on the paper.
  const before = state.graph.faces_vertices.length;
  state = foldThroughPoints(state, [0, H / 2], [mid, H / 2], [mid / 2, H], 'valley');
  check('a second fold cuts every face under it',
    state.graph.faces_vertices.length === before * 2,
    `${before} faces -> ${state.graph.faces_vertices.length}`);
  check('two folds still conserve paper',
    Math.abs(paperArea(state) / (W * H) - 1) < 1e-12,
    `ratio=${(paperArea(state) / (W * H)).toFixed(12)}`);
  check('the stack is four deep in the middle',
    plyCountAt(state, [mid / 2, H / 4]) === 4,
    `${plyCountAt(state, [mid / 2, H / 4])} plies`);

  // Creasing leaves the pattern but not the shape.
  const creased = foldThroughPoints(flatSheet(W, H), [mid, 0], [mid, H], [W, H / 2],
    'valley', { creaseOnly: true });
  check('creasing divides the pattern without folding it',
    creased.graph.faces_vertices.length === 2
    && Math.max(...creased.faces_matrix.flatMap((_, f) =>
      faceOutline(creased, f).map((p) => p[0]))) > W - 1e-9,
    `${creased.graph.faces_vertices.length} faces, still full width`);
}

// --- Three dimensions by walking the hinges ----------------------------------
// The shape follows from the angles: no reflecting, no handedness to get wrong.
{
  const W = 0.21;
  const H = 0.297;
  const mid = W / 2;

  const flat = foldInSpace(foldThroughPoints(flatSheet(W, H),
    [mid, 0], [mid, H], [W, H / 2], 'valley'));
  let off = 0;
  for (const f of flat) for (const p of f.points) off = Math.max(off, Math.abs(p[2]));
  check('a full fold lies flat', off < 1e-12, `max|z| = ${off.toExponential(2)} m`);

  // Folded flat, the two halves come to rest on the same ground. Where that
  // ground is does not matter: in space the whole model is only fixed up to a
  // rigid motion, and which face was held still is a question about the drawing
  // rather than about the paper.
  const spans = flat.map((f) => {
    const xs = f.points.map((p) => p[0]);
    return [Math.min(...xs), Math.max(...xs)] as const;
  });
  const coincident = spans.every(([lo, hi]) =>
    Math.abs(lo - spans[0]![0]) < 1e-9 && Math.abs(hi - spans[0]![1]) < 1e-9);
  check('the halves land on top of each other',
    coincident && Math.abs((spans[0]![1] - spans[0]![0]) - mid) < 1e-9,
    spans.map(([lo, hi]) => `${(lo * 1000).toFixed(0)}~${(hi * 1000).toFixed(0)}`).join(' '));

  // Part way, the flap stands up; at a right angle it reaches exactly its own width.
  const upright = foldInSpace(foldThroughPoints(flatSheet(W, H),
    [mid, 0], [mid, H], [W, H / 2], 'valley', { angleDeg: 90 }));
  let high = 0;
  for (const f of upright) for (const p of f.points) high = Math.max(high, Math.abs(p[2]));
  check('a right-angle fold stands the flap up',
    Math.abs(high - mid) < 1e-9, `${(high * 1000).toFixed(1)}mm, half-width ${(mid * 1000).toFixed(0)}mm`);

  // Closing it further brings the flap back down.
  const heights = [60, 120, 170].map((deg) => {
    const s2 = foldInSpace(foldThroughPoints(flatSheet(W, H),
      [mid, 0], [mid, H], [W, H / 2], 'valley', { angleDeg: deg }));
    let h = 0;
    for (const f of s2) for (const p of f.points) h = Math.max(h, Math.abs(p[2]));
    return h;
  });
  check('closing the fold lowers the flap again',
    heights[1]! > heights[0]! && heights[1]! > heights[2]!,
    heights.map((h) => (h * 1000).toFixed(0)).join(' / ') + ' mm');

  // Every crease of the pattern is a real fold line, not a duplicate.
  const twice = foldThroughPoints(
    foldThroughPoints(flatSheet(W, H), [mid, 0], [mid, H], [W, H / 2], 'valley'),
    [0, H / 2], [mid, H / 2], [mid / 2, H], 'mountain');
  check('the pattern lists one crease per fold made',
    patternCreases(twice).length >= 2, `${patternCreases(twice).length} creases`);
}

// --- Vortex lattice against lifting-line theory ------------------------------
function rectWing(span: number, chord: number, ny = 16, nx = 6): LatticePanel[] {
  const panels: LatticePanel[] = [];
  for (let i = 0; i < ny; i++) {
    const y0 = -span / 2 + (span * i) / ny;
    const y1 = -span / 2 + (span * (i + 1)) / ny;
    for (let k = 0; k < nx; k++) {
      const xq = (-chord * (k + 0.25)) / nx;
      const xc = (-chord * (k + 0.75)) / nx;
      panels.push({
        a: [xq, y0, 0] as Vec3,
        b: [xq, y1, 0] as Vec3,
        control: [xc, (y0 + y1) / 2, 0] as Vec3,
        normal: [0, 0, -1] as Vec3,
        area: ((y1 - y0) * chord) / nx,
        chord: chord / nx,
        isFin: false,
      });
    }
  }
  return panels;
}

for (const ar of [4, 6, 8]) {
  const chord = 0.2;
  const span = ar * chord;
  const area = span * chord;
  const sys = buildSystem(rectWing(span, chord), freestream(0, 0));
  const speed = 10;
  const q = 0.5 * RHO * speed * speed;

  const sample = (alphaDeg: number) => {
    const alpha = (alphaDeg * Math.PI) / 180;
    const r = solve(sys, { speed, alpha, beta: 0 }, [0, 0, 0]);
    const la = liftAxis(alpha, 0);
    const wa = freestream(alpha, 0);
    const lift = r.force[0] * la[0] + r.force[1] * la[1] + r.force[2] * la[2];
    const drag = r.force[0] * wa[0] + r.force[1] * wa[1] + r.force[2] * wa[2];
    return { cl: lift / (q * area), cd: drag / (q * area) };
  };

  const a = sample(0.5);
  const b = sample(1.0);
  const slope = (b.cl - a.cl) / ((0.5 * Math.PI) / 180);
  const liftingLine = (2 * Math.PI * ar) / (ar + 2);
  const ratio = slope / liftingLine;
  // A lattice sits a little below lifting-line theory, more so at low aspect
  // ratio where that theory stops being valid.
  check(`AR=${ar} lift slope near lifting line`, ratio > 0.85 && ratio < 1.0,
    `CLa=${slope.toFixed(3)} vs ${liftingLine.toFixed(3)} (${ratio.toFixed(3)}x)`);

  const oswald = (b.cl * b.cl) / (Math.PI * ar * b.cd);
  check(`AR=${ar} induced efficiency physical`, oswald > 0.85 && oswald < 1.12,
    `e=${oswald.toFixed(3)}`);
}

/*
 * And at the size of a paper aeroplane.
 *
 * The solver's test wing above is a metre across. Its cut-off for a point
 * lying on a vortex was a fixed number that scales with length to the fourth
 * power, and on panels two centimetres across it silenced neighbours: a paper
 * wing split chordwise flew with twice its lift, at half its chord, and every
 * aeroplane in the book came out unstable. A 10cm chord, split as the flight
 * model splits it, still carries its lift at the quarter chord.
 */
{
  const small = rectWing(0.5, 0.1, 20, 4);
  const a = (2 * Math.PI) / 180;
  const r = solve(buildSystem(small, freestream(a, 0)), { speed: 1, alpha: a, beta: 0 }, [0, 0, 0]);
  const cla = -r.force[2] / (0.5 * RHO * 0.05) / a;
  const ac = r.moment[1] / -r.force[2] / 0.1;
  check('a paper-sized wing lifts at its quarter chord', Math.abs(ac + 0.25) < 0.03 && cla > 3.5 && cla < 4.5,
    `CLa=${cla.toFixed(2)}, lift ${(-ac * 100).toFixed(0)}% back`);

  // And the flight model reads a delta's neutral point where theory puts it,
  // near two thirds of the root chord behind the apex.
  const cr = 0.14;
  const b = 0.105;
  const stations = Array.from({ length: 24 }, (_, i) => {
    const y = -b / 2 + ((i + 0.5) * b) / 24;
    const c = cr * (1 - Math.abs(y) / (b / 2));
    return { y, leading: -(cr - c), trailing: -cr, chord: c, z: 0 };
  });
  const delta = {
    stations, wingArea: (b * cr) / 2, meanChord: (2 / 3) * cr, aspectRatio: (2 * b) / cr,
    finArea: 0, cgFromNose: 0, mass: { mass: 0.005, inertia: [1e-5, 1e-5, 1e-5, 0, 0, 0] },
  } as unknown as Parameters<typeof aeroModel>[0];
  const np = aeroModel(delta).neutralFromNose / cr;
  check('a delta wing balances near two thirds of its root', np > 0.55 && np < 0.7, `${(np * 100).toFixed(0)}% of the root chord`);
}

/*
 * Birdman is wider than it is long, and still flies nose first.
 *
 * The body axes were the principal axes of the mass, the smallest along the
 * fuselage - which on a flying wing 17cm across and 12cm long is the span, and
 * the aerodynamics flew it sideways. The axis the aeroplane mirrors across is
 * the span, whatever its proportions.
 */
{
  const bird = SAMPLES.find((z) => z.id === 'birdman')!;
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const paper = paperProps(A4!, 80);
  const af = buildAirframe(renderFaces(replay(W, H, bird.build(W, H)).state, -1, paper.thickness), paper);
  check('a flying wing wider than it is long is flown nose first', af.span > af.length,
    `span ${(af.span * 100).toFixed(1)}cm, length ${(af.length * 100).toFixed(1)}cm`);
}

/*
 * Thrown the way the guide teaches, Birdman stays up as long as the guide says.
 *
 * The flight model has two figures set against the guide rather than derived
 * (edge drag, and how fast the wings roll level), chosen so that Birdman
 * thrown overhand at a national-team thrower's 25 m/s, on its side, at 75
 * degrees, stays up about 15 to 20 seconds and comes out of the climb into a
 * glide. This keeps them from drifting: change the physics and this says so.
 */
{
  const bird = SAMPLES.find((z) => z.id === 'birdman')!;
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const paper = paperProps(A4!, 90);
  const plies = renderFaces(replay(W, H, bird.build(W, H)).state, -1, paper.thickness);
  const spec0 = measurePlane(plies, paper, paper.thickness)!;
  const af0 = spec0.af;
  const { af, m } = withDihedral(af0, withNoseBulge(af0, aeroModel(af0), noseBulge(spec0)), 15);
  const launch = { speed: 25, angleDeg: 75, height: 2.2, headwind: 0, crosswind: 0, elevatorDeg: 0, bankDeg: 90 };
  const e = bestElevator(af, m, launch);
  const r = fly(af, m, { ...launch, elevatorDeg: e });
  // The best throw there is, an adult's 25 m/s: up to the half minute a pupil's square plane is timed at.
  check('Birdman thrown like the guide stays up 15 to 30 seconds', r.time > 15 && r.time < 30,
    `${r.time.toFixed(1)}s, climbed ${r.score.climb.toFixed(1)}m, elevator ${e}°`);
  check('and glides out of the climb, sinking like a paper glider',
    r.score.transitionLoss !== null && r.score.glideSink !== null && r.score.glideSink > 0.4 && r.score.glideSink < 1.2,
    `transition ${r.score.transitionLoss?.toFixed(1)}m, sink ${r.score.glideSink?.toFixed(2)} m/s`);
}

/*
 * A stacking order is not a matter of taste: paper cannot pass through paper.
 * A crease folded flat makes a closed pocket, and nothing may be caught half in
 * and half out of it, nor lie inside it and also run past its shut end. The
 * audit names any face in such a position, so a fold script that is merely
 * plausible on screen cannot pass for a fold that could be made by hand.
 */
{
  const width = A4!.widthMm / 1000;
  const height = A4!.heightMm / 1000;
  const dart = SAMPLES.find((s) => s.id === 'dart')!;
  const session = replay(width, height, dart.build(width, height));
  const pockets = tacos(session.state);
  const bad = orderViolations(session.state);
  check('the dart closes creases', pockets.length > 0, `${pockets.length} pockets`);
  check('the dart stacks in an order paper can take', bad.length === 0,
    bad.length === 0 ? 'no face passes through another'
      : bad.map((v) => v.detail).join('; '));

  /*
   * The audit has to be able to fail, or it proves nothing. Turning the pile
   * upside down is no good as a control: a mirror of a valid order is valid.
   * Pushing a face in between the two halves of a closed fold is the real
   * defect, so do exactly that and insist it gets caught.
   */
  const pocket = pockets[0]!;
  const order = session.state.faces_order;
  let caught = 0;
  let tried = 0;
  for (const intruder of order) {
    if (intruder === pocket.faces[0] || intruder === pocket.faces[1]) continue;
    const rest = order.filter((f) => f !== intruder);
    const at = rest.indexOf(pocket.faces[0]);
    const wedged = [...rest.slice(0, at + 1), intruder, ...rest.slice(at + 1)];
    tried++;
    if (orderViolations({ ...session.state, faces_order: wedged }).length > 0) caught++;
  }
  check('the audit catches an impossible order', caught > 0,
    `${caught} of ${tried} faces wedged into a closed fold were caught`);
}

/*
 * Two faces of a flat fold occupy the same plane, and paper of no thickness put
 * there twice is not paper. Every ply has to stand off the one below it.
 */
{
  const width = A4!.widthMm / 1000;
  const height = A4!.heightMm / 1000;
  const caliper = 0.0001;
  const dart = SAMPLES.find((s) => s.id === 'dart')!;
  const state = replay(width, height, dart.build(width, height)).state;
  const flat = renderFaces(state, -1, 0);
  const thick = renderFaces(state, -1, caliper);

  /*
   * Each face rises by the paper actually under it, straight out along its
   * normal - and by nothing at all where there is none under it.
   *
   * Lifting by a face's place in the ORDER instead was wrong in a way that only
   * shows on a real model: a face near the top of a fifty-face order can be
   * lying by itself out at a wing tip with nothing beneath it, and raising it
   * fifty calipers tore it off the paper it is joined to. The model came apart
   * into slices with daylight between them. Paper only stands off what it is
   * resting on.
   */
  let worstSlide = 0;
  let highest = 0;
  flat.forEach((f, i) => {
    f.points.forEach((p, j) => {
      const q = thick[i]!.points[j]!;
      const d: [number, number, number] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
      const along = d[0] * f.normal[0] + d[1] * f.normal[1] + d[2] * f.normal[2];
      const slide = Math.hypot(d[0] - along * f.normal[0], d[1] - along * f.normal[1],
        d[2] - along * f.normal[2]);
      worstSlide = Math.max(worstSlide, slide);
      highest = Math.max(highest, Math.abs(along));
    });
  });
  /*
   * Paper that is in the same place is not at the same height.
   *
   * This is what thickness is for. Two faces stacked at one spot and left at
   * the same height are a tie the drawing has to break by guessing, and the
   * guess is not steady: two mirror-image quarters of the same nose came out
   * one white and one dark, because on one side the guess went to the paper on
   * top and on the other to the paper beneath it. Real paper has no ties -
   * whatever is underneath holds the rest up.
   */
  /**
   * How high a face lies over a point, with its corners raised as they are.
   *
   * The corners of one face are not raised by the same amount, so the face is
   * no longer flat and a single plane through three of its corners is not it.
   * The corner fan is, and it answers for any point the face covers.
   */
  const heightOver = (poly: readonly Vec3[], x: number, y: number): number | null => {
    for (let i = 1; i + 1 < poly.length; i++) {
      const [a, b, c] = [poly[0]!, poly[i]!, poly[i + 1]!];
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-15) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      const w = 1 - u - v;
      if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
      return u * a[2]! + v * b[2]! + w * c[2]!;
    }
    return null;
  };

  const inSameSpot = (poly: readonly Vec3[], p: Vec3) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if ((a[1] > p[1]) !== (b[1] > p[1])
        && p[0] < a[0] + ((p[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) hit = !hit;
    }
    return hit;
  };
  let ties = 0;
  for (const f of thick) {
    const mid: Vec3 = [
      f.points.reduce((a, q) => a + q[0], 0) / f.points.length,
      f.points.reduce((a, q) => a + q[1], 0) / f.points.length,
      f.points.reduce((a, q) => a + q[2], 0) / f.points.length,
    ];
    for (const g of thick) {
      if (g === f || !inSameSpot(g.points, mid)) continue;
      // Only paper lying the same way can be stacked with it.
      if (Math.abs(g.normal[2] * f.normal[2]) < 0.9) continue;
      /*
       * Measured where the two actually lie over each other.
       *
       * Each corner is raised by what is under THAT corner, so one face can
       * be level with another along an edge they share and clear of it
       * everywhere else - which is what paper does over a thick fuselage, and
       * is not a tie. Pairing the two outlines corner by corner instead called
       * that a tie as soon as the faces had different numbers of corners: a
       * triangle's three were read against three of a quadrilateral's four,
       * which are not the same places on the paper at all. So both are asked
       * for their height over one point that is on both of them.
       *
       * What is asked for there is daylight, not a whole caliper of it. Each
       * corner rises by what is under THAT corner, so a ply ramps from one
       * depth to the next across its own width and passes within a fraction of
       * a caliper of its neighbours on the way - which is what paper riding
       * over a thick nose does. The fault this catches is the tie: two faces
       * left at the very same height, where the drawing has to guess which one
       * the eye sees and does not guess the same way twice.
       */
      const za = heightOver(f.points, mid[0], mid[1]);
      const zb = heightOver(g.points, mid[0], mid[1]);
      if (za !== null && zb !== null && Math.abs(za - zb) < 1e-9) ties++;
    }
  }
  check('paper in the same place is not left at the same height',
    ties === 0, `${ties} pair(s) with nothing between them`);
  check('thickness moves no paper sideways', worstSlide < 1e-12,
    `worst sideways drift ${(worstSlide * 1e6).toExponential(1)} um`);
  check('the bottom ply does not move', flat[0]!.points.every((p, j) => {
    const q = thick[0]!.points[j]!;
    return Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-12;
  }), 'the pile grows upward from the table');
}

/*
 * The pile drawn is the pile of the resting model, whatever pose it is shown in.
 *
 * The drawing keeps the body still while folding, so a finished aeroplane is
 * shown on its side (or stood up in its flight attitude). Piled up in that pose
 * the two sides of the Transition's nose were stacked by different rules and
 * one stood a ply proud of the other seen head-on. Each face's rise along its
 * own normal has to be the one the resting model gives it.
 */
for (const id of ['jet', 'triangle', 'transition', 'skyking', 'birdman', 'highest'] as const) {
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const plane = SAMPLES.find((z) => z.id === id)!;
  const state = replay(W, H, plane.build(W, H)).state;
  const drawn = renderFacesHeld(state, -1, 0.000113);
  const rest = renderFaces(state, -1, 0.000113);
  const riseOf = (f: typeof drawn[number]) =>
    f.lift[0] * f.normal[0] + f.lift[1] * f.normal[1] + f.lift[2] * f.normal[2];
  const restRise = new Map(rest.map((f) => [f.face, riseOf(f)]));
  const off = drawn.filter((f) => Math.abs(riseOf(f) - (restRise.get(f.face) ?? NaN)) > 1e-12).length;
  check(`${plane.name}: the pile drawn is the resting model's`, off === 0,
    `${off} of ${drawn.length} faces raised differently`);
}

/*
 * A fold made the same on both sides stacks the same on both sides.
 *
 * The layer view floated each ply at its place in the pile's one list, so of
 * two ears folded in one after the other the second sat a layer higher though
 * neither lies on the other, and the fold looked as if it had gone the other
 * way on one side. After every step that finishes a pair, each ply's mirror
 * image has to sit at the same level.
 */
for (const [id, after] of [['jet', 6], ['jet', 3], ['triangle', 3], ['triangle', 5], ['transition', 9]] as const) {
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const plane = SAMPLES.find((z) => z.id === id)!;
  const model = replay(W, H, plane.build(W, H).slice(0, after)).model;
  const outlines = model.layers.map((l) => layerOutline(l));
  const levels = stackLevels(outlines);
  const xs = outlines.flat().map((q) => q[0]);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const key = (poly: readonly Vec2[], mirror: boolean) => poly
    .map((q) => `${((mirror ? 2 * mid - q[0] : q[0]) * 1e5).toFixed(0)},${(q[1] * 1e5).toFixed(0)}`)
    .sort().join(' ');
  // Plies of one shape can lie several deep, so compare every level a shape
  // is found at on one side with the levels its mirror is found at.
  const at = (mirror: boolean) => {
    const m = new Map<string, number[]>();
    outlines.forEach((poly, i) => {
      const k = key(poly, mirror);
      m.set(k, [...(m.get(k) ?? []), levels[i]!].sort((a, b) => a - b));
    });
    return m;
  };
  const plain = at(false);
  const turned = at(true);
  let off = 0;
  for (const [k, list] of plain) {
    const other = turned.get(k) ?? [];
    if (list.join() !== other.join()) off += list.length;
  }
  check(`${plane.name} after step ${after}: mirror plies sit at the same level`, off === 0,
    `${off} of ${outlines.length} plies differ from their mirror`);
}

/*
 * Reverse folds: a flap folded in half, its point turned in or round.
 *
 * Both halves of the point turn about the same line, opposite ways, so the
 * point goes in between the two halves of the model (inside) or wraps round
 * them (outside). Which one the paper can take depends on where the point
 * lands: turned in, it must fit inside the model; turned out, it must clear it.
 */
{
  const W = 0.21;
  const H = 0.297;
  const halved = foldThroughPoints(flatSheet(W, H), [W / 2, 0], [W / 2, H], [W, H / 2], 'valley');
  const tip: Vec2 = [0.03, H - 0.001];
  const into = foldThroughPoints(halved, [W / 2, H - 0.08], [0, H - 0.02], tip, 'valley', { reverse: 'inside' });
  const round = foldThroughPoints(halved, [W / 2, H - 0.03], [0, H - 0.10], tip, 'valley', { reverse: 'outside' });
  const moved = (st: typeof into) => st.faces_order.map((f) => !!st.faces_moved?.[f]);
  // Bottom to top: inside is body, point, point, body; outside point, body, body, point.
  check('an inside reverse fold puts the point between the halves',
    orderViolations(into).length === 0 && moved(into).join() === 'false,true,true,false',
    moved(into).map((m) => (m ? 'point' : 'body')).join(' / '));
  check('an outside reverse fold wraps the point round them',
    orderViolations(round).length === 0 && moved(round).join() === 'true,false,false,true',
    moved(round).map((m) => (m ? 'point' : 'body')).join(' / '));
  const wrong = foldThroughPoints(halved, [W / 2, H - 0.08], [0, H - 0.02], tip, 'valley', { reverse: 'outside' });
  check('a point that cannot clear the model is not turned round it',
    orderViolations(wrong).length > 0, `${orderViolations(wrong).length} impossible`);
}

/*
 * Paper that a fold does not move stays where it is on screen.
 *
 * The drawing is worked outward from one face, and it used to be the biggest
 * one that had not just moved. Once a wing stands at ninety degrees that is
 * not safe: the layout lays the wing flat on the body, face down, and drawing
 * from it turns the whole model a quarter or a half over. Folding the second
 * wing laid the first one flat; folding a winglet turned the aeroplane upside
 * down, so the next fold "toward you" went to the keel's side. Every sheet
 * point on paper a step did not move must be where it was.
 */
for (const plane of SAMPLES.filter((z) => z.id === 'jet' || z.id === 'triangle' || z.id === 'transition' || z.id === 'skyking' || z.id === 'birdman' || z.id === 'highest')) {
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const steps = plane.build(W, H);
  const probe: Vec2[] = [];
  for (let i = 1; i < 14; i++) for (let j = 1; j < 20; j++) probe.push([(W * i) / 14 + 1e-4, (H * j) / 20 + 1e-4]);
  const at = (st: ReturnType<typeof replay>['state'], placed: ReturnType<typeof foldInSpaceHeld>, q: Vec2) => {
    const f = st.graph.faces_vertices.findIndex((loop) =>
      pointInPolygon(loop.map((v) => st.graph.vertices_coords[v]!), q));
    if (f < 0) return null;
    const { r, t } = placed[f]!.transform;
    return { f, p: [r[0]! * q[0] + r[1]! * q[1] + t[0]!, r[3]! * q[0] + r[4]! * q[1] + t[1]!,
      r[6]! * q[0] + r[7]! * q[1] + t[2]!] };
  };
  let prev: ReturnType<typeof replay>['state'] | null = null;
  let prevPlaced: ReturnType<typeof foldInSpaceHeld> = [];
  const jumped: string[] = [];
  steps.forEach((step, n) => {
    const st = replay(W, H, steps.slice(0, n + 1)).state;
    const placed = foldInSpaceHeld(st);
    if (prev && step.kind === 'fold' && !step.creaseOnly) {
      let moved = 0;
      for (const q of probe) {
        const a = at(prev, prevPlaced, q);
        const b = at(st, placed, q);
        if (!a || !b || st.faces_moved?.[b.f]) continue;
        if (Math.hypot(a.p[0]! - b.p[0]!, a.p[1]! - b.p[1]!, a.p[2]! - b.p[2]!) > 1e-6) moved++;
      }
      if (moved) jumped.push(step.label);
    }
    prev = st;
    prevPlaced = placed;
  });
  check(`${plane.name}: paper a fold does not move stays where it is on screen`,
    jumped.length === 0, jumped.length ? jumped.join(', ') : 'every step');
}

/*
 * The app's own wing maker, and the other route to the same aeroplane.
 *
 * 몸통 접기 folds the second wing away from you on the bottom plies rather
 * than turning the model over, which is the same move. The pile once stacked
 * a flap swung away at ninety degrees the other way up from one swung toward
 * you, to make up for turning over being drawn as a mirror; with the turn
 * made real, that left this route's two wings showing different paper.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const start = SAMPLES.find((z) => z.id === 'dart')!.build(W, H).slice(0, 3);
  const steps = [...start, ...bodyAndWings(W, H, start, 20, 20, 90, 1)];
  const state = replay(W, H, steps).state;
  const flat = renderFaces(state, -1, 0);
  const thick = renderFaces(state, -1, 0.000113).filter((f) => Math.abs(f.normal[2]!) > 0.9);
  const xs = flat.flatMap((f) => f.points.map((q) => q[0]!));
  const ys = flat.flatMap((f) => f.points.map((q) => q[1]!));
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  const covers = (poly: readonly (readonly number[])[], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if ((a[1]! > y) !== (b[1]! > y)
        && x < a[0]! + ((y - a[1]!) / (b[1]! - a[1]!)) * (b[0]! - a[0]!)) inside = !inside;
    }
    return inside;
  };
  const zAt = (f: typeof thick[number]) => f.points.reduce((a, q) => a + q[2]!, 0) / f.points.length;
  const topAt = (x: number, y: number) => {
    const t = thick.filter((f) => covers(f.points, x, y)).sort((a, b) => zAt(a) - zAt(b))[0];
    return t ? `${Math.round(t.area * 1e6)}${t.normal[2]! > 0 ? 'f' : 'b'}@${String(Math.round(zAt(t) * 1e6))}` : '';
  };
  let seen = 0;
  let off = 0;
  for (let i = 1; i < 20; i++) {
    const y = Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * i) / 20;
    for (const out of [0.02, 0.034, 0.05]) {
      const l = topAt(middle - out, y);
      const r = topAt(middle + out, y);
      if (!l && !r) continue;
      seen++;
      if (l !== r) off++;
    }
  }
  check('몸통 접기: with thickness, both wings show the same ply on top', off === 0 && seen > 20,
    `${off} of ${seen} places differ`);
}

/*
 * Folding along a line that is already creased.
 *
 * Pressing the centre line and then folding the sheet in half along it is about
 * as ordinary as folding gets, and it used to do nothing at all: the fold found
 * no face to divide, because the crease had already divided them, so it passed
 * over the hinge without giving it an angle. Everything after it was then made
 * on a sheet that was still flat, and the model came out as a Z rather than an
 * aeroplane - with no error anywhere, because each individual step had worked.
 */
{
  const W = 0.21;
  const H = 0.297;
  const line = (sense: FoldSense, creaseOnly: boolean): Step3 => ({
    a: [W / 2, 0], b: [W / 2, H], movingSide: [W, H / 2], sense, creaseOnly,
  });

  const fresh = foldTo3D(W, H, [line('mountain', false)]);
  const creasedFirst = foldTo3D(W, H, [line('valley', true), line('mountain', false)]);
  const depth = (plies: typeof fresh) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of plies) for (const q of p.points) { lo = Math.min(lo, q[0]); hi = Math.max(hi, q[0]); }
    return hi - lo;
  };
  check('a crease does not stop the sheet folding on it',
    Math.abs(depth(creasedFirst) - depth(fresh)) < 1e-9,
    `${(depth(creasedFirst) * 1000).toFixed(1)}mm across, same as folding it cold`);
  check('folding in half halves the sheet', Math.abs(depth(fresh) - W / 2) < 1e-9,
    `${(depth(fresh) * 1000).toFixed(1)}mm of ${(W * 1000).toFixed(0)}mm`);
}

/*
 * The dart, measured rather than admired.
 *
 * A dart is a keel with a wing either side of it, and both wings hang from the
 * same edge of that keel. Saying so in numbers is what distinguishes it from
 * the two shapes it was mistaken for while this was being built: a Z, with one
 * wing at each end of a keel twice as deep as it should be, and a single wing
 * with the other folded back on top of it.
 */
{
  const W = 0.21;
  const H = 0.297;
  const keelWidth = 0.020;
  const plies = renderFaces(replay(W, H, SAMPLES[0]!.build(W, H)).state);
  const flat = plies.filter((p) => Math.abs(p.normal[2]) >= 0.35);
  const onEdge = plies.filter((p) => Math.abs(p.normal[2]) < 0.35);
  const zs = (list: typeof plies) => list.flatMap((p) => p.points.map((q) => q[2]));

  check('the dart has a keel and wings', onEdge.length > 0 && flat.length > 0,
    `${onEdge.length} plies on edge, ${flat.length} flat`);
  const keelDepth = Math.max(...zs(onEdge)) - Math.min(...zs(onEdge));
  check('the keel is as deep as the fold that made it',
    Math.abs(keelDepth - keelWidth) < 1e-6,
    `${(keelDepth * 1000).toFixed(1)}mm, fold set at ${(keelWidth * 1000).toFixed(0)}mm`);
  const spread = Math.max(...zs(flat)) - Math.min(...zs(flat));
  check('both wings hang from the same edge of the keel', spread < 1e-6,
    `wings span ${(spread * 1000).toFixed(3)}mm of height`);

  // One wing each side: the two halves must cover different ground.
  const af = buildAirframe(plies, paperProps(A4!, 80));
  // The body frame comes from the principal axes, which sit a fraction of a
  // degree off the sheet's own long axis, so the length is read to within 1%
  // rather than exactly. A dart folded only on one side came out at 308mm - 4%
  // over - because it was lying across the sheet diagonally; that is the error
  // this is here to catch, and it is nowhere near the tolerance.
  check('the dart is no longer than the sheet', af.length <= H * 1.01,
    `${(af.length * 1000).toFixed(1)}mm of ${(H * 1000).toFixed(0)}mm`);
  check('the dart spans two wings', af.span > W * 0.7,
    `${(af.span * 1000).toFixed(1)}mm across a ${(W * 1000).toFixed(0)}mm sheet`);
  check('the keel counts as fin, not wing', af.finArea > 0.01,
    `${(af.finArea * 1e4).toFixed(1)} cm2 standing on edge`);
}

/*
 * Snapping, shared by both views.
 *
 * A fold made by pointing at the model in space has to land on the same corner
 * it would have landed on in the flat draft. The rule is one function so the
 * two cannot drift apart, and paper features beat the grid: folding brings a
 * corner to a crease, not to 47mm.
 */
{
  const W = 0.21;
  const H = 0.297;
  const session = replay(W, H, []);
  const snaps = snapPoints(session.model, session.viewCreases, session.viewDimensions);
  const corner: Vec2 = [0, H];
  const near: Vec2 = [0.0012, H - 0.0009];

  const toCorner = resolveSnap(snaps, near, 0.004, 5);
  check('a pick near a corner takes the corner',
    Math.hypot(toCorner.p[0] - corner[0], toCorner.p[1] - corner[1]) < 1e-12,
    `${toCorner.snap?.kind} at ${toCorner.p.map((v) => (v * 1000).toFixed(1)).join(', ')}mm`);

  const middle: Vec2 = [0.0731, 0.1214];
  const toGrid = resolveSnap(snaps, middle, 0.004, 5);
  check('open paper falls to the grid', toGrid.snap?.kind === 'grid'
    && Math.abs(toGrid.p[0] * 1000 - 75) < 1e-9 && Math.abs(toGrid.p[1] * 1000 - 120) < 1e-9,
    `${(toGrid.p[0] * 1000).toFixed(1)}, ${(toGrid.p[1] * 1000).toFixed(1)}mm`);

  const free = resolveSnap(snaps, middle, 0.004, 0);
  check('with the grid off a pick stays where it was put', free.snap === null
    && free.p[0] === middle[0] && free.p[1] === middle[1], 'unchanged');

  const farOff = resolveSnap(snaps, [0.05, 0.05], 0.0005, 0);
  check('nothing within reach changes nothing', farOff.snap === null, 'unchanged');
}

/*
 * FOLD, out and back.
 *
 * The point of writing this format is that somebody else's program can read it
 * and disagree with us. That only works if what comes out is what we meant, so
 * the file is read back and compared - and, more importantly, the shape it
 * folds to is compared, because a file that round-trips through our own reader
 * but describes a different model would pass a shallower check.
 */
{
  const W = 0.21;
  const H = 0.297;
  const state = replay(W, H, SAMPLES[0]!.build(W, H)).state;
  const file = creasePatternFile(state.graph);

  check('the pattern says what it is',
    file.frame_classes[0] === 'creasePattern' && file.frame_unit === 'mm'
    && file.file_spec >= 1,
    `spec ${file.file_spec}, ${file.vertices_coords.length} vertices, `
      + `${file.edges_vertices.length} edges, ${file.faces_vertices.length} faces`);

  const marks = new Set(file.edges_assignment);
  check('every crease is marked the way FOLD marks them',
    [...marks].every((m) => 'MVBF'.includes(m)) && marks.has('M') && marks.has('V')
      && marks.has('B'),
    [...marks].sort().join(''));

  // A boundary is not a fold; anything else that is folded must carry an angle.
  const angled = file.edges_assignment
    .map((m, i) => ({ m, deg: file.edges_foldAngle[i]! }))
    .filter((e) => e.m === 'M' || e.m === 'V');
  check('mountains fold one way and valleys the other',
    angled.every((e) => (e.m === 'M' ? e.deg <= 0 : e.deg >= 0)) && angled.length > 0,
    `${angled.length} creases, ${angled.filter((e) => e.m === 'M').length} mountain`);

  const back = readFoldFile(JSON.stringify(file));
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  check('reading it back gives the same graph',
    back.vertices_coords.length === state.graph.vertices_coords.length
    && back.vertices_coords.every((p, i) =>
      near(p[0], state.graph.vertices_coords[i]![0])
      && near(p[1], state.graph.vertices_coords[i]![1]))
    && back.edges_vertices.every(([u, v], i) =>
      u === state.graph.edges_vertices[i]![0] && v === state.graph.edges_vertices[i]![1])
    && back.edges_assignment.every((a, i) => a === state.graph.edges_assignment[i])
    && back.edges_foldAngle.every((a, i) =>
      Math.abs(a - state.graph.edges_foldAngle[i]!) < 1e-6),
    `${back.vertices_coords.length} vertices, ${back.edges_vertices.length} edges`);

  // The real test: does the file fold to the same shape?
  const shape = (g: typeof back) => {
    const pts = foldInSpace({
      graph: g,
      faces_matrix: g.faces_vertices.map(() => [1, 0, 0, 1, 0, 0] as const),
      faces_order: g.faces_vertices.map((_, i) => i),
    }).flatMap((f) => f.points);
    const span = (k: number) => Math.max(...pts.map((q) => q[k]!)) - Math.min(...pts.map((q) => q[k]!));
    return [span(0), span(1), span(2)];
  };
  const before = shape(state.graph);
  const after = shape(back);
  check('the file folds to the same shape',
    before.every((v, i) => Math.abs(v - after[i]!) < 1e-9),
    before.map((v) => (v * 1000).toFixed(1)).join(' x ') + ' mm');

  const folded = foldedStateFile(state);
  check('the folded form carries its stacking order',
    folded.frame_classes[0] === 'foldedForm'
    && folded.faces_layer?.length === state.graph.faces_vertices.length
    && new Set(folded.faces_layer).size === folded.faces_layer!.length,
    `${folded.faces_layer?.length} faces, each at its own depth`);
}

/*
 * Which half travels, and mirroring that does not double up.
 *
 * Two things a fold has to get right and neither shows up in the size of the
 * result: a 3.7cm flap folded down and a 26cm body folded up both leave a
 * 26cm stack. They differ in WHERE it is, so that is what is checked.
 *
 * And a crease the mirror sends back onto itself must be made once. Folding
 * across the centre line, with symmetry on, used to apply the same fold twice
 * - the second one undoing the choice of side, so both answers came out the
 * same whatever you picked.
 */
{
  const W = 0.21;
  const H = 0.297;
  const y = H - 0.037;
  const fold = (side: Vec2, symmetric: boolean): Step[] => [{
    kind: 'fold', a: [0, y], b: [W, y], movingSide: side,
    sense: 'valley', creaseOnly: false, angleDeg: 180, symmetric, label: 'test',
  }];
  const where = (steps: Step[]) => {
    const { min, max } = modelBounds(replay(W, H, steps).model);
    return { lo: min[1], hi: max[1] };
  };

  const flap = where(fold([W / 2, H - 0.01], false));
  const body = where(fold([W / 2, 0.05], false));
  check('folding the flap leaves the body where it was',
    Math.abs(flap.lo - 0) < 1e-9 && Math.abs(flap.hi - (H - 0.037)) < 1e-9,
    `${(flap.lo * 100).toFixed(1)}..${(flap.hi * 100).toFixed(1)}cm`);
  check('folding the body takes it over the crease',
    Math.abs(body.lo - (H - 0.037)) < 1e-9,
    `${(body.lo * 100).toFixed(1)}..${(body.hi * 100).toFixed(1)}cm`);
  check('the two halves are different folds',
    Math.abs(flap.lo - body.lo) > 0.1,
    `${(flap.lo * 100).toFixed(1)}cm apart from ${(body.lo * 100).toFixed(1)}cm`);

  for (const [name, side] of [['flap', [W / 2, H - 0.01]], ['body', [W / 2, 0.05]]] as const) {
    const plain = where(fold(side as Vec2, false));
    const mirrored = where(fold(side as Vec2, true));
    check(`mirroring a crease across the axis changes nothing (${name})`,
      Math.abs(plain.lo - mirrored.lo) < 1e-9 && Math.abs(plain.hi - mirrored.hi) < 1e-9,
      `${(mirrored.lo * 100).toFixed(1)}..${(mirrored.hi * 100).toFixed(1)}cm`);
  }
}

/*
 * A symmetric fold makes two creases that are exact mirror images.
 *
 * The existing mirror checks measure the model's bounds, which a horizontal
 * crease answers whichever way it is applied. A slanted one is the case that
 * can actually come out crooked, and it was reported as looking crooked on
 * screen - so compare the crease ENDPOINTS, not the outline.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const slant: Step[] = [{
    kind: 'fold', a: [0, 0.10], b: [W / 2, H], movingSide: [0.01, H - 0.01],
    sense: 'valley', creaseOnly: true, symmetric: true, label: 'slant',
  }];
  const creases = replay(W, H, slant).creases;
  // Each endpoint of one crease has to appear, mirrored, on the other.
  const key = (p: Vec2) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  const ends = new Set<string>();
  for (const c of creases) { ends.add(key(c.a)); ends.add(key(c.b)); }
  let unmatched = 0;
  for (const e of ends) {
    const [x, y] = e.split(',').map(Number) as [number, number];
    if (!ends.has(key([W - x, y]))) unmatched++;
  }
  check('a symmetric slanted crease is an exact mirror pair',
    creases.length === 2 && unmatched === 0,
    `${creases.length} creases, ${unmatched} endpoint(s) with no mirror`);
}

/*
 * Flat paper has no attitude, and asking for one made it spin.
 *
 * The 기체 자세 view stands the model up in the airframe's own body frame, which
 * is read off the principal axes of the mass. A sheet that has not been folded
 * out of its plane has two equal principal moments, so those axes are not
 * determined, and the third moment that decides nose from tail is rounding
 * noise about zero - so both flipped on every crease. On screen the paper
 * turned over each time a line was pressed, and a click then landed at the
 * opposite end of the sheet from the pointer.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const paper = paperProps(A4!, 80);
  const guide = (x: number): Step => ({
    kind: 'fold', a: [x, 0], b: [x, H], movingSide: [x + 1e-3, H / 2],
    sense: 'valley', creaseOnly: true, label: 'guide',
  });
  /** The frame's rotation, as three columns, with the translation taken out. */
  const basis = (steps: Step[]): number[] | null => {
    const af = buildAirframe(
      renderFaces(replay(W, H, steps).state, -1, paper.thickness), paper);
    if (!af) return null;
    const o = af.frame.toBody([0, 0, 0]);
    return ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[])
      .flatMap((v) => af.frame.toBody(v).map((c, i) => c - o[i]!));
  };

  const centre = guide(W / 2);
  const stages: Array<[string, Step[]]> = [
    ['blank', []],
    ['one crease', [centre]],
    ['three creases', [centre, guide(W / 2 - 0.015), guide(W / 2 + 0.015)]],
  ];
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const [name, steps] of stages) {
    const b = basis(steps);
    check(`flat paper is left lying as it is (${name})`,
      b !== null && b.every((v, i) => Number.isFinite(v) && Math.abs(v - identity[i]!) < 1e-9),
      b === null ? 'no airframe' : b.map((v) => v.toFixed(3)).join(' '));
  }

  // The guard must not swallow the real thing: a dart has a genuine attitude.
  const dartBasis = basis(SAMPLES.find((s) => s.id === 'dart')!.build(W, H));
  check('a folded dart still gets its own attitude',
    dartBasis !== null && dartBasis.every(Number.isFinite)
      && dartBasis.some((v, i) => Math.abs(v - identity[i]!) > 0.5),
    dartBasis === null ? 'no airframe' : dartBasis.map((v) => v.toFixed(2)).join(' '));
}

/*
 * A saved session comes back as the same script.
 *
 * A FOLD file cannot be carried on with, because it records where the creases
 * are and not what the hands did - which was pressed first, which half
 * travelled, which were only reference marks. The step script has all of that,
 * so that is what gets saved, and it has to survive the trip exactly: a file
 * that reads back nearly right is worse than one that plainly fails, because
 * it replays into a shape that looks plausible and is not the one saved.
 */
{
  /** JSON with the keys in a fixed order, so only the content is compared. */
  const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as object).filter(([, y]) => y !== undefined).sort())
      : x));

  for (const sample of SAMPLES) {
    const steps = sample.build(0.21, 0.297);
    const text = JSON.stringify(sessionFile(210, 297, 80, steps));
    const back = readSessionFile(text);
    check(`a saved session reads back as the same script (${sample.id})`,
      canonical(back.steps) === canonical(steps)
        && back.widthMm === 210 && back.heightMm === 297 && back.gsm === 80,
      `${back.steps.length} of ${steps.length} steps`);
  }

  // And a file that is not one of ours is refused rather than half-read.
  for (const [what, text] of [
    ['a FOLD file', '{"file_spec":1.1,"vertices_coords":[[0,0]]}'],
    ['a newer version', '{"kind":"paper-plane-session","version":9,"steps":[]}'],
    ['a step with no sense', '{"kind":"paper-plane-session","version":1,'
      + '"sheet":{"widthMm":210,"heightMm":297},"gsm":80,'
      + '"steps":[{"kind":"fold","a":[0,0],"b":[1,1],"movingSide":[0,1]}]}'],
  ] as const) {
    let refused = false;
    try { readSessionFile(text); } catch { refused = true; }
    check(`opening ${what} is refused, not half-read`, refused, 'threw as it should');
  }
}

/*
 * Closing several creases at once, which is what a collapse is.
 *
 * A simple fold swings one side of one line. A squash, a rabbit ear, a reverse
 * fold and every base begins with creases closing TOGETHER - done one at a
 * time the paper would tear. Where each face lands then depends only on which
 * closed creases lie between it and the paper being held, so a folded state is
 * recovered from that set alone, and the same walk reports when a set cannot
 * fold flat at all.
 */
{
  const W = 0.21;
  const H = 0.21;
  const yBar = 0.087;
  const xBar = 0.09;
  const crease = (a: Vec2, b: Vec2, label: string): Step => ({
    kind: 'fold', a, b,
    movingSide: [(a[0] + b[0]) / 2 - (b[1] - a[1]) * 1e-3,
      (a[1] + b[1]) / 2 + (b[0] - a[0]) * 1e-3],
    sense: 'valley', creaseOnly: true, label,
  });
  const totalArea = (st: FoldedState) => st.graph.faces_vertices.reduce((sum, _, f) => {
    const p = faceOutline(st, f);
    let twice = 0;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length]!;
      twice += p[i]![0] * q[1] - q[0] * p[i]![1];
    }
    return sum + Math.abs(twice) / 2;
  }, 0);
  const extent = (st: FoldedState) => {
    const pts = st.graph.faces_vertices.flatMap((_, f) => faceOutline(st, f));
    return [0, 1].map((k) => Math.max(...pts.map((p) => p[k as 0 | 1]))
      - Math.min(...pts.map((p) => p[k as 0 | 1])));
  };

  /*
   * Kawasaki, from the geometry rather than from the formula.
   *
   * Two straight creases crossing make a four-crease vertex, and it is a
   * standing temptation to think any such vertex folds flat. It does not: four
   * reflections about lines through one point compose to a rotation by four
   * times the angle between them, so they cancel only at a right angle. The
   * walk finds this out by arriving at a face twice and disagreeing, which is
   * the same fact stated as "the paper would have to be in two places".
   */
  for (const deg of [30, 45, 60, 90]) {
    const t = (deg * Math.PI) / 180;
    const state = replay(W, H, [
      crease([0, yBar], [W, yBar], 'across'),
      crease([xBar - Math.cos(t) * 0.3, yBar - Math.sin(t) * 0.3],
        [xBar + Math.cos(t) * 0.3, yBar + Math.sin(t) * 0.3], 'slant'),
    ]).state;
    const at = creasesAt(state, [xBar, yBar]);
    const r = closeCreases(state, at, (e) => (e === at[0] ? 'mountain' : 'valley'));
    const flatFoldable = deg === 90;
    check(`two creases crossing at ${deg}° ${flatFoldable ? 'collapse' : 'cannot fold flat'}`,
      at.length === 4 && (r.conflict === undefined) === flatFoldable,
      at.length !== 4 ? `${at.length} creases at the vertex`
        : r.conflict ? 'refused, as it should be' : 'folded flat');

    if (!flatFoldable) continue;
    // A sheet creased on two perpendicular lines folds into the larger half of
    // each: 21 - 9 = 12 wide and 21 - 8.7 = 12.3 tall, with no paper lost.
    const [w, h] = extent(r.state);
    check('the perpendicular collapse lands where the ruler says',
      Math.abs(w! - 0.12) < 1e-9 && Math.abs(h! - 0.123) < 1e-9,
      `${(w! * 100).toFixed(2)} x ${(h! * 100).toFixed(2)} cm`);
    check('the collapse creates and destroys no paper',
      Math.abs(totalArea(r.state) - W * H) < 1e-12,
      `${(totalArea(r.state) * 1e4).toFixed(4)} of ${(W * H * 1e4).toFixed(4)} cm2`);
    check('the collapse finds a stacking paper can take',
      r.violations.length === 0, `${r.violations.length} violation(s)`);
  }

  /*
   * And it has to agree with the engine it sits beside.
   *
   * An ordinary fold is a collapse with one crease in it, so closing that one
   * crease has to put every face exactly where folding along the line did.
   * Two ways of arriving at the same state is the only real test that the
   * shortcut is not a different model wearing the same name.
   */
  {
    const plain = replay(W, H, [{
      kind: 'fold', a: [xBar, 0], b: [xBar, H], movingSide: [W, H / 2],
      sense: 'valley', creaseOnly: false, label: 'plain',
    }]).state;
    const creased = replay(W, H, [crease([xBar, 0], [xBar, H], 'guide')]).state;
    const edges = creased.graph.edges_assignment
      .map((a, i) => ({ a, i })).filter((e) => e.a !== 'boundary').map((e) => e.i);
    const viaCollapse = closeCreases(creased, edges, () => 'valley');
    const [pw, ph] = extent(plain);
    const [cw, ch] = extent(viaCollapse.state);
    check('closing one crease matches folding along it',
      viaCollapse.conflict === undefined
        && Math.abs(pw! - cw!) < 1e-12 && Math.abs(ph! - ch!) < 1e-12,
      `fold ${(pw! * 100).toFixed(2)}x${(ph! * 100).toFixed(2)}, `
        + `collapse ${(cw! * 100).toFixed(2)}x${(ch! * 100).toFixed(2)} cm`);
  }
}

/*
 * Aligning: the crease that brings one thing onto another.
 *
 * Instructions almost never say "crease from here to here" - they say "bring
 * this corner onto that point", "lay this edge along that one". The test is
 * therefore not what the crease looks like but where the paper LANDS: fold
 * across the line the construction gives and the thing named has to arrive on
 * its target, to the last decimal.
 */
{
  const W = 0.21;
  const H = 0.297;
  const across = (p: Vec2, a: Vec2, b: Vec2): Vec2 => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy);
    const f: Vec2 = [a[0] + t * dx, a[1] + t * dy];
    return [2 * f[0] - p[0], 2 * f[1] - p[1]];
  };
  const away = (p: Vec2, q: Vec2) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const offLine = (p: Vec2, a: Vec2, b: Vec2) =>
    Math.abs(signedDistance(lineThrough(a, b), p));
  const pt = (p: Vec2): Pick => ({ kind: 'point', p });
  const ed = (a: Vec2, b: Vec2, at?: Vec2): Pick =>
    ({ kind: 'edge', s: { a, b }, at: at ?? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });

  for (const [name, from, to] of [
    ['corner to the top middle', [0, H], [W / 2, H]],
    ['corner to the far corner', [0, 0], [W, H]],
    ['corner to the centre', [W, 0], [W / 2, H / 2]],
  ] as Array<[string, Vec2, Vec2]>) {
    const c = alignFold(pt(from), pt(to));
    const landed = c && across(from, c.line.a, c.line.b);
    check(`점→점 lands on its target (${name})`,
      landed !== null && away(landed!, to) < 1e-12,
      landed ? `${(away(landed, to) * 1e6).toExponential(1)} um off` : 'no construction');
  }

  for (const [name, p, ea, eb, expect] of [
    ['corner to the centre line', [0, H], [W / 2, 0], [W / 2, H], [W / 2, H]],
    ['corner to the top edge', [0, 0], [0, H], [W, H], [0, H]],
  ] as Array<[string, Vec2, Vec2, Vec2, Vec2]>) {
    const c = alignFold(pt(p), ed(ea, eb));
    const landed = c && across(p, c.line.a, c.line.b);
    check(`점→변 puts the point on the line (${name})`,
      landed !== null && offLine(landed!, ea, eb) < 1e-12 && away(landed!, expect) < 1e-12,
      landed ? `landed at ${(landed[0] * 100).toFixed(2)}, ${(landed[1] * 100).toFixed(2)} cm`
        : 'no construction');
  }

  /*
   * An edge straddles its target, so where it was grabbed is part of the ask.
   *
   * The top edge of a sheet crosses the centre line, and both halves can be
   * brought down onto it - by two different creases. Taking the midpoint would
   * answer neither question; the point under the finger answers the one that
   * was asked, and the two grabs have to give different creases.
   */
  {
    const creases: Segment[] = [];
    for (const grab of [[W * 0.25, H], [W * 0.75, H]] as Vec2[]) {
      const c = alignFold(ed([0, H], [W, H], grab), ed([W / 2, 0], [W / 2, H]));
      const landed = c && across(grab, c.line.a, c.line.b);
      check(`변→변 lays the grabbed half on the line (x=${(grab[0] * 100).toFixed(1)}cm)`,
        landed !== null && offLine(landed!, [W / 2, 0], [W / 2, H]) < 1e-12,
        landed ? `${(offLine(landed, [W / 2, 0], [W / 2, H]) * 1e6).toExponential(1)} um off`
          : 'no construction');
      if (c) creases.push(c.line);
    }
    const [l, r] = creases;
    check('변→변 gives a different crease for each half grabbed',
      creases.length === 2
        && offLine(r!.b, l!.a, l!.b) > 0.01,
      creases.length === 2
        ? `${(offLine(r!.b, l!.a, l!.b) * 100).toFixed(1)}cm apart` : 'missing a construction');
  }
}

/*
 * Fuselage and wings, in one press.
 *
 * Fold in half, wing down, turn over, wing down. The turning over is what
 * makes it awkward to write out, so the macro counts the stack instead: the
 * paper that travelled in the half fold is turned over and the paper that
 * stayed is not, and that split is exactly where one wing ends and the other
 * begins. The test is not that it produces steps but that it produces an
 * AEROPLANE - wings that open as the angle opens, and a keel left standing.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const measure = (deg: number) => {
    const built = bodyAndWings(W, H, [], 15, 15, deg, 1);
    const s = replay(W, H, built);
    const plies = renderFaces(s.state, -1, 0);
    const pts = plies.flatMap((f) => f.points);
    const span = (k: 0 | 1 | 2) =>
      Math.max(...pts.map((q) => q[k])) - Math.min(...pts.map((q) => q[k]));
    return {
      steps: built.length, blocked: s.blockedAt, plies: s.model.layers.length,
      span: span(0), length: span(1), height: span(2),
      standing: plies.filter((f) => Math.abs(f.normal[2]) < 0.35).length,
    };
  };

  const open = measure(80);
  check('동체·날개 접기 lays down the three folds it takes',
    open.steps === 3 && open.blocked < 0, `${open.steps} steps, blocked ${open.blocked}`);
  check('동체·날개 접기 leaves four plies',
    open.plies === 4, `${open.plies} plies`);
  check('the wings leave the keel standing',
    open.standing > 0 && open.height > 0.02,
    `${open.standing} upright face(s), ${(open.height * 100).toFixed(1)}cm tall`);
  check('the plane is no longer than the sheet',
    Math.abs(open.length - H) < 1e-9, `${(open.length * 100).toFixed(1)}cm`);

  /*
   * Flat wings are not wings.
   *
   * At 180 degrees they lie back against the fuselage and the model has no
   * depth at all; opening the angle has to open the span with it. If those two
   * ever stop moving together the fold is going somewhere other than the hinge
   * it was given.
   */
  const shut = measure(180);
  check('wings shut flat have no height', shut.height < 1e-9,
    `${(shut.height * 100).toFixed(2)}cm tall`);
  check('opening the wings opens the span',
    open.span > shut.span + 0.05,
    `${(shut.span * 100).toFixed(1)}cm shut, ${(open.span * 100).toFixed(1)}cm at 80°`);

  // A fuselage wider than the paper has no wings to fold, and says so rather
  // than folding something else.
  check('a fuselage wider than the paper is refused',
    bodyAndWings(W, H, [], 200, 200, 80, 1).length === 0, 'no steps, as it should be');
}

/*
 * Turning the model over turns it over once.
 *
 * The step mirrors the layout and reverses the pile, which is what a hand
 * does. The view used to spin round to look from the other side as well, and
 * the two cancelled in one direction while doubling in the other - so the
 * command left the model looking much as it had, upside down. Flipping twice
 * has to come back to exactly where it started, and once must not.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const corner: Step = {
    kind: 'fold', a: [W / 2, H], b: [0, H - W / 2], movingSide: [0.01, H - 0.01],
    sense: 'valley', creaseOnly: false, label: 'corner',
  };
  const flip: Step = { kind: 'flip', label: 'flip' };
  const shape = (steps: Step[]) => {
    const st = replay(W, H, steps).state;
    return st.graph.faces_vertices.map((_, f) =>
      faceOutline(st, f).map((p) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`).join(' ')).join('|');
  };
  const order = (steps: Step[]) => replay(W, H, steps).state.faces_order.join(',');

  check('turning the model over moves the paper',
    shape([corner]) !== shape([corner, flip]), 'the layout mirrors');
  check('turning it over reverses the pile',
    order([corner]).split(',').reverse().join(',') === order([corner, flip]),
    `${order([corner])} -> ${order([corner, flip])}`);
  check('turning it over twice is no turn at all',
    shape([corner]) === shape([corner, flip, flip])
      && order([corner]) === order([corner, flip, flip]),
    'back where it started');
}

/*
 * A page out of a folding book, followed.
 *
 * The real test of the tool is not that it folds, but that it folds what the
 * instructions say. These are the first five steps of an aeroplane from a
 * children's book, written the way the page writes them - halve it, halve it
 * the other way, bring the edge to the middle, crease the ears, fold them in -
 * and checked against what the page DRAWS: after the fifth step the paper has
 * come to a single point on the left.
 *
 * That last one settles a real ambiguity. "맞춰" can mean bring the edge onto
 * that line or bring the corner onto it, and the two build different creases.
 * Only one of them gives the point in the picture.
 */
{
  const sq = SHEET_SIZES.find((z) => z.id === 'sq21');
  const W = (sq?.widthMm ?? 0) / 1000;
  check('the book\'s square stock is on the shelf', sq !== undefined && sq.widthMm === sq.heightMm,
    sq ? `${sq.name}, ${sq.widthMm}x${sq.heightMm}mm` : 'missing');

  const f = (a: Vec2, b: Vec2, moving: Vec2, label: string, creaseOnly = false): Step =>
    ({ kind: 'fold', a, b, movingSide: moving, sense: 'valley', creaseOnly, label });
  const bring = (from: [Vec2, Vec2], onto: [Vec2, Vec2]): [Vec2, Vec2] => {
    const c = alignFold(
      { kind: 'edge', s: { a: from[0], b: from[1] },
        at: [(from[0][0] + from[1][0]) / 2, (from[0][1] + from[1][1]) / 2] },
      { kind: 'edge', s: { a: onto[0], b: onto[1] }, at: onto[0] });
    if (!c) throw new Error('no construction');
    return [c.line.a, c.line.b];
  };

  const midLeft: Vec2 = [W / 4, W / 2];
  const steps: Step[] = [
    f([W / 2, 0], [W / 2, W], [W, W / 2], '① 세로 중심선', true),
    f([0, W / 2], [W, W / 2], [W / 2, W], '② 가로 중심선', true),
    f([W / 4, 0], [W / 4, W], [0, W / 2], '③ 중심선에 맞춰 반으로'),
  ];
  for (const corner of [[W / 4, W], [W / 4, 0]] as Vec2[]) {
    const [a, b] = bring([midLeft, corner], [midLeft, [W, W / 2]]);
    steps.push(f(a, b, corner, '④ 귀 삼각형 (자국)', true));
  }
  const afterThree = replay(W, W, steps.slice(0, 3));
  const b3 = modelBounds(afterThree.model);
  check('③ brings the edge to the middle, leaving three quarters',
    Math.abs(b3.max[0] - b3.min[0] - W * 0.75) < 1e-9 && Math.abs(b3.min[0] - W / 4) < 1e-9,
    `${((b3.max[0] - b3.min[0]) * 100).toFixed(2)}cm wide, from x=${(b3.min[0] * 100).toFixed(2)}`);

  // ⑤ - the reading that gives the picture's point, and the one that does not.
  const withFive = (corner: (c: Vec2, l: [Vec2, Vec2]) => [Vec2, Vec2]) => {
    const out = [...steps];
    for (const [c, line] of [
      [[W / 4, W], [midLeft, [W * 0.75, W]]], [[W / 4, 0], [midLeft, [W * 0.75, 0]]],
    ] as Array<[Vec2, [Vec2, Vec2]]>) {
      const [a, b] = corner(c, line);
      out.push(f(a, b, c, '⑤ 삼각형'));
    }
    const s2 = replay(W, W, out);
    const pts = s2.model.layers.flatMap((l) => layerOutline(l));
    const left = Math.min(...pts.map((q) => q[0]));
    const ys = new Set(pts.filter((q) => q[0] < left + 1e-6).map((q) => q[1].toFixed(6)));
    return { blocked: s2.blockedAt, corners: ys.size };
  };

  const byEdge = withFive((c, line) => bring([midLeft, c], line));
  check('①~⑤ fold without the paper passing through itself', byEdge.blocked < 0,
    byEdge.blocked < 0 ? 'no violations' : `blocked at ${byEdge.blocked + 1}`);
  check('⑤ brings the paper to a single point, as the page draws it',
    byEdge.corners === 1, `${byEdge.corners} place(s) reach the left`);

  const byCorner = withFive((c, line) => {
    const con = alignFold({ kind: 'point', p: c },
      { kind: 'edge', s: { a: line[0], b: line[1] }, at: line[1] });
    if (!con) throw new Error('none');
    return [con.line.a, con.line.b];
  });
  check('the other reading of ⑤ does not, which is how they are told apart',
    byCorner.corners > 1, `${byCorner.corners} place(s) reach the left`);
}

/*
 * Which face of the paper each piece is showing.
 *
 * Measured, not looked at. A face is carried into space by a rigid motion, so
 * where its own +z ends up pointing IS which side of the sheet you can see:
 * toward you, the front; away, the back. Screenshots were being used for this
 * and screenshots cannot tell "the colour is wrong" from "the fold is wrong".
 */
{
  const W = SHEET_SIZES.find((z) => z.id === 'a4')!.widthMm / 1000;
  const H = SHEET_SIZES.find((z) => z.id === 'a4')!.heightMm / 1000;
  /** The sign of each face's outward normal, biggest face first. */
  const facing = (steps: Step[]) => renderFaces(replay(W, H, steps).state, -1, 0)
    .slice()
    .sort((a, b) => b.area - a.area)
    .map((f) => Math.sign(f.normal[2]));

  // One corner brought over flat. The flap has been turned over and the body
  // has not, so they cannot be showing the same side of the paper.
  const corner: Step = {
    kind: 'fold', a: [W / 2, H], b: [0, H - W / 2], movingSide: [0.01, H - 0.01],
    sense: 'valley', creaseOnly: false, label: 'corner',
  };
  const one = facing([corner]);
  check('a folded flap shows the other side of the paper from the body',
    one.length >= 2 && one[0] !== 0 && one[0] === -one[1]!,
    `body ${one[0]}, flap ${one[1]}`);

  /*
   * And both corners of a symmetric fold show the SAME side.
   *
   * This is the one that matters and the one nothing was checking. Two flaps
   * that are mirror images of each other have been through the same thing -
   * one fold each, toward you - so they show the same face, and a model whose
   * two halves come out different colours is wrong however plausible it looks.
   */
  const pair = facing([{ ...corner, symmetric: true, label: 'both corners' }]);
  const flaps = pair.slice(1, 3);
  check('mirror-image flaps show the same side as each other',
    flaps.length === 2 && flaps[0] !== 0 && flaps[0] === flaps[1],
    `body ${pair[0]}, flaps ${flaps.join(' and ')}`);
}

/*
 * Searching for a pile the paper can take, instead of assuming one.
 *
 * Folding assigns the order as it goes - the flap that travelled goes on top,
 * or underneath - which is a guess made one fold at a time. A pile has to
 * satisfy every fold at once, so the guess can be impossible even when each
 * fold in turn looked reasonable. The search decides only what is actually
 * determined: for every pair of faces that share paper, which is on top.
 * Faces that never meet are left alone, because nothing about them is decided.
 */
{
  const W = SHEET_SIZES.find((z) => z.id === 'a4')!.widthMm / 1000;
  const H = SHEET_SIZES.find((z) => z.id === 'a4')!.heightMm / 1000;

  for (const sample of SAMPLES) {
    const built = sample.build(W, H);
    const st = replay(W, H, built).state;
    const found = solveOrder(st);
    const searched = found.order !== null && !found.exhausted
      && orderViolations({ ...st, faces_order: found.order }).length === 0;
    /*
     * A lock collapsed along drawn lines (오르막길's nose) is stacked when it
     * is made, pleats and all, and the search from a blank start does not
     * always get back to it. The pile it was folded into is audited instead:
     * nothing may pass through anything.
     */
    const locked = built.some((x) => x.kind === 'collapse' && !!x.lines);
    const ownPileGood = orderViolations(st).length === 0;
    check(`the search finds a pile for the ${sample.id}`,
      searched || (locked && ownPileGood),
      searched
        ? `${found.pairs} pairs decided in ${found.steps} steps`
        : locked && ownPileGood
          ? `folded pile holds (no violations); a fresh search stops after ${found.steps} steps`
          : `no order after ${found.steps} steps`);
  }

  /*
   * And it has to actually repair a pile, not only bless a good one.
   *
   * The dart's own order is shuffled into one the paper cannot take, and the
   * search is asked to put it right - which is the case that matters, because
   * a search that only ever confirms what it was given is doing nothing.
   */
  {
    const dartSteps = SAMPLES.find((x) => x.id === 'dart')!.build(W, H);
    const good = replay(W, H, dartSteps).state;
    // Reversing a good pile gives another good one - it is the same model seen
    // from underneath - so a pair is swapped until the paper really is through
    // itself, which is the state the search has to be able to get out of.
    let wrecked = good;
    outer: for (let a = 0; a < good.faces_order.length; a++) {
      for (let b = a + 1; b < good.faces_order.length; b++) {
        const swapped = [...good.faces_order];
        [swapped[a], swapped[b]] = [swapped[b]!, swapped[a]!];
        const tried = { ...good, faces_order: swapped };
        if (orderViolations(tried).length > 0) { wrecked = tried; break outer; }
      }
    }
    const before = orderViolations(wrecked).length;
    const found = solveOrder(wrecked);
    const after = found.order
      ? orderViolations({ ...wrecked, faces_order: found.order }).length : -1;
    check('the search repairs a pile the paper cannot take',
      before > 0 && found.order !== null && after === 0,
      `${before} violation(s) -> ${after}, ${found.steps} steps`);
  }

  /*
   * Paper that never meets is not shuffled.
   *
   * Two faces lying in different places have no order between them in any
   * sense the paper cares about, and deciding one anyway is how an
   * aeroplane's two wings ended up at different heights. The search leaves
   * every such pair exactly as it found it.
   */
  {
    const flat = replay(W, H, []).state;
    const found = solveOrder(flat);
    check('a sheet with nothing to decide is left alone',
      found.pairs === 0 && found.order?.join(',') === flat.faces_order.join(','),
      `${found.pairs} pairs`);
  }
}

/*
 * A finished aeroplane is the same on both sides.
 *
 * Every fold in the pattern is made either on the middle line or once on each
 * side of it, so the model that comes out has a mirror plane down its keel -
 * and a mirror through a vertical plane leaves up where it was, so the two
 * wings show the SAME face of the paper, at the same heights, all the way out.
 *
 * Nothing in the engine enforces that, and for a long time nothing checked it.
 * Three separate faults hid behind it at once: a wing came away as only the
 * paper it was creased to and left behind the flaps folded inside it, the
 * second winglet was folded a centimetre from the wing root rather than its
 * tip, and both wings had their plies turned over although only one of them
 * comes over towards you. The aeroplane still measured the right size and the
 * layer audit still passed. This is the check that would have said otherwise.
 */
for (const plane of SAMPLES.filter((z) => z.id === 'jet' || z.id === 'triangle' || z.id === 'transition' || z.id === 'skyking' || z.id === 'birdman' || z.id === 'highest')) {
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const session = replay(W, H, plane.build(W, H));
  // Square in plan first: see planTurn. Thickness is turned by the same angle,
  // or the plies' own offset tilts its axes by a hair.
  const flat = renderFaces(session.state, -1, 0);
  const turn = planTurn(flat);
  const square = (list: typeof flat) =>
    list.map((f) => ({ ...f, points: f.points.map(turn), normal: turn(f.normal) }));
  const faces = square(flat);
  const xs = faces.flatMap((f) => f.points.map((p) => p[0]!));
  const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
  const named = (what: string) => `${plane.name}: ${what}`;

  /*
   * Matched to a micron rather than by a rounded key.
   *
   * Rounding each corner to a tenth of a millimetre and comparing the strings
   * is only as good as where the grid falls: a keel at 13.125cm sits exactly
   * on a boundary, and the two halves of a model that IS symmetric rounded to
   * different sides of it. Faces this size are placed to a millionth of a
   * metre, so they are matched at that - and ordered on a coarser rounding
   * still, or the last bit of arithmetic decides which corner comes first.
   */
  const corners = (f: typeof faces[number], mirror: boolean) => f.points
    .map((p) => [mirror ? 2 * middle - p[0]! : p[0]!, p[1]!, p[2]!])
    // Ordered on the corners rounded to a tenth of a micron, because the same
    // corner reached along two different paths differs in the last bit and
    // sorting on that put two identical faces' corners in different orders.
    .sort((a, b) => a.map((v) => Math.round(v * 1e7))
      .reduce<number>((ord, v, k) => ord || (v - Math.round(b[k]! * 1e7)), 0));
  const same = (a: number[][], b: number[][]) => a.length === b.length
    && a.every((p, i) => p.every((v, k) => Math.abs(v - b[i]![k]!) < 2e-6));
  const taken = faces.map(() => false);
  let unpaired = 0;
  for (const f of faces) {
    const want = corners(f, true);
    const at = faces.findIndex((g, k) => !taken[k] && same(want, corners(g, false)));
    if (at < 0) unpaired++; else taken[at] = true;
  }
  check(named('both sides of the aeroplane are the same shape'), unpaired === 0,
    `${unpaired} of ${faces.length} faces have no mirror image`);

  /*
   * And the same way up. Two faces in one place are told apart by the order,
   * so the plies of one wing have to read the same, top down, as the plies of
   * the other - which is where the nose gave itself away, showing the body on
   * one wing and the ear folded into it on the other.
   */
  const rank = new Map<number, number>();
  session.state.faces_order.forEach((f, i) => rank.set(f, i));
  const covers = (poly: readonly Vec3[], x: number, y: number) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if ((a[1] > y) !== (b[1] > y)
        && x < a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
    }
    return inside;
  };
  /*
   * The pile's order is the layout's, and the layout is read from its own
   * top. A wing is drawn there folded flat onto the body, so for one of the two
   * wings the layout's top is the aeroplane's underside: its plies are in the
   * right order, counted from the other end. A face tells which by comparing
   * the way it faces in the layout (turned over or not) with the way it faces
   * in the air.
   */
  const upward = (f: typeof faces[number]) => {
    const m = session.state.faces_matrix[f.face]!;
    const turned = m[0] * m[3] - m[1] * m[2] < 0;
    return (f.normal[2]! > 0) !== turned ? 1 : -1;
  };
  const lying = faces.filter((f) => Math.abs(f.normal[2]!) > 0.9);
  const pileAt = (x: number, y: number) => lying
    .filter((f) => covers(f.points, x, y))
    .sort((a, b) => upward(b) * rank.get(b.face)! - upward(a) * rank.get(a.face)!)
    // Named by area to a tenth of a square centimetre: 오르막길's rolled bands
    // are 1.925cm by 9cm, 17.325cm^2, and at square millimetres the two wings'
    // identical plies rounded either side of the half on the last bit.
    .map((f) => `${Math.round(f.area * 1e5)}${f.normal[2]! > 0 ? 'f' : 'b'}`)
    .join('/');
  const ys = faces.flatMap((f) => f.points.map((p) => p[1]!));
  let sampled = 0;
  let differ = 0;
  for (let i = 1; i < 20; i++) {
    const y = Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * i) / 20;
    for (const out of [0.02, 0.034]) {
      const left = pileAt(middle - out, y);
      const right = pileAt(middle + out, y);
      if (!left && !right) continue;
      sampled++;
      if (left !== right) differ++;
    }
  }
  check(named('both wings show the same paper, in the same order'), differ === 0 && sampled > 20,
    `${differ} of ${sampled} places across the two wings disagree`);

  /*
   * And drawn with thickness, the same paper on top of both wings.
   *
   * The pile's order comes from the layout, where a wing lies folded flat on
   * the body - so for one wing of the two the layout's top is the side facing
   * away, and read straight its plies were drawn innermost-out: the other face
   * of the paper showing, on that wing only, in a model whose shape was
   * perfectly symmetric. Looked down on, the ply nearest the eye at a point on
   * one wing has to be the mirror of the one on the other, and at the same
   * height.
   */
  {
    const thick = square(renderFaces(session.state, -1, 0.000113));
    const flatOnes = thick.filter((f) => Math.abs(f.normal[2]!) > 0.9);
    const zAt = (f: typeof thick[number]) => f.points.reduce((a, q) => a + q[2]!, 0) / f.points.length;
    const topAt = (x: number, y: number) => {
      const hit = flatOnes.filter((f) => covers(f.points, x, y)).sort((a, b) => zAt(a) - zAt(b));
      const t = hit[0];
      return t ? `${Math.round(t.area * 1e6)}${t.normal[2]! > 0 ? 'f' : 'b'}@${String(Math.round(zAt(t) * 1e6))}` : '';
    };
    let seen = 0;
    let off = 0;
    for (let i = 1; i < 20; i++) {
      const y = Math.min(...ys) + ((Math.max(...ys) - Math.min(...ys)) * i) / 20;
      for (const out of [0.02, 0.034, 0.05]) {
        const l = topAt(middle - out, y);
        const r = topAt(middle + out, y);
        if (!l && !r) continue;
        seen++;
        if (l !== r) off++;
      }
    }
    check(named('with thickness, both wings show the same ply on top'), off === 0 && seen > 20,
      `${off} of ${seen} places differ`);
  }

  /*
   * The keel hangs one way and the winglets turn the other.
   *
   * They are the only two things standing off the wings, and an aeroplane you
   * can hold has them on opposite sides: the keel below, where the fingers go,
   * and a centimetre of each tip turned up. Written as one fold, the model
   * over, the other - the same words as the wings - the two winglets came out
   * pointing opposite ways, one up and one down, and the check for the two
   * sides being the same shape is what now says so. This says which way.
   */
  const standing = faces.filter((f) => Math.abs(f.normal[0]!) > 0.9);
  const height = (list: typeof faces) => list
    .flatMap((f) => f.points.map((p) => p[2]!))
    .reduce((a, b) => a + b, 0) / Math.max(1, list.flatMap((f) => f.points).length);
  const onMiddle = (f: typeof faces[number]) =>
    f.points.every((p) => Math.abs(p[0]! - middle) < 1e-6);
  const keel = standing.filter(onMiddle);
  const tips = standing.filter((f) => !onMiddle(f));
  // 오르막길 has no winglets: the tutorial ends at the wings.
  if (plane.id !== 'highest') check(named('the keel and the winglets stand on opposite sides of the wing'),
    keel.length > 0 && tips.length > 0 && height(keel) * height(tips) < 0,
    `keel ${(height(keel) * 1000).toFixed(1)}mm, winglets ${(height(tips) * 1000).toFixed(1)}mm`);

  /*
   * And the sidebar says the aeroplane's size, not its drawing's.
   *
   * Every figure shown beside the model used to be read off the flat layout,
   * where anything standing up is drawn lying down: a finished aeroplane 14cm
   * across was reported as 7.0 x 13.9cm, and the nose - twelve plies of paper
   * either side of the keel - as 48 plies, with a warning that it could not be
   * folded at all. Both are measurements of the drawing.
   */
  {
    const stats = foldStats(session, paperProps(A4!, 90));
    const span = Math.max(...xs) - Math.min(...xs);
    check(named('the size shown is the aeroplane, not its flattened drawing'),
      Math.abs(stats.spanMm / 1000 - span) < 1e-9 && stats.spanMm > stats.widthMm,
      `${(stats.spanMm / 10).toFixed(1)}cm across, drawn ${(stats.widthMm / 10).toFixed(1)}cm`);
    if (plane.id === 'jet') {
      const keelPlies = standing.filter((f) => onMiddle(f)).length / 2;
      check('the plies shown are the ones actually stacked', stats.maxPlies === keelPlies * 2,
        `${stats.maxPlies} plies, keel carries ${keelPlies} either side`);
    }
  }

  /*
   * Nothing in the keel's plane reaches past the wings.
   *
   * The keel hangs one way from the wing root; paper lying in its plane on the
   * other side is paper the wings should have taken with them and did not. The
   * Triangle's first wings, each taken hold of by a point near the tail, left
   * the front of every half standing: a wall four centimetres tall through the
   * middle of the aeroplane, where the page draws the wings running to the
   * nose. The sidebar still read the right span and the audit still passed.
   */
  const keelSide = Math.sign(height(keel));
  const through = keel.filter((f) => f.points.some((p) => p[2]! * keelSide < -1e-6));
  check(named('nothing in the keel plane stands up through the wings'), through.length === 0,
    `${through.length} of ${keel.length} keel faces reach past the wing root`);
}

/*
 * The model on screen is the model the app is working on.
 *
 * The 3D stage folds its own copy of the step list, because the last fold has
 * to be swept from zero for the animation. Everything else - the crease
 * overlay, the snapping, the readout, every check above - works from the steps
 * themselves. Nothing ties the two together, so when they part company they do
 * it in silence: the stage once folded `steps.filter(isFold)`, which drops the
 * flips, and drew an aeroplane of 66 faces 8.9cm across while the rest of the
 * app described the real one, 52 faces and 13.8cm. The creases were placed
 * correctly on a model that was not being drawn, so they hung in mid-air.
 *
 * Checked at rest, with nothing pending: that is the state the eye spends its
 * time in, and it is the one where the two must agree exactly.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const corner = (p: readonly number[]) => p.map((v) => Math.round(v * 1e7)).join(',');
  const shape = (steps: readonly Step[]) => renderFaces(replay(W, H, steps).state, -1, 0)
    .map((f) => f.points.map(corner).join(' '))
    .sort()
    .join('\n');

  for (const sample of SAMPLES) {
    const steps = sample.build(W, H);
    const shown = framedSteps(steps, null, 1);
    const drawn = shape(shown.list);
    const real = shape(steps);
    const faces = drawn === '' ? 0 : drawn.split('\n').length;
    check(`the stage draws the ${sample.id} the app is working on`, drawn === real,
      drawn === real
        ? `${faces} faces, ${shown.list.length} of ${steps.length} steps folded`
        : `${faces} faces drawn, ${real.split('\n').length} in the model`);
  }
}

/*
 * The shelf of saved planes.
 *
 * It keeps the session file's own text, so a plane taken off the shelf is read
 * by the same reader a file is - which is the point: a shelved plane that has
 * been damaged has to be dropped, not replayed into a shape nobody folded.
 * Checked against a plain object standing in for the browser's storage, so
 * these run where there is no browser.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const jet = SAMPLES.find((z) => z.id === 'jet')!;
  const steps = jet.build(W, H);
  const text = JSON.stringify(
    sessionFile(A4!.widthMm, A4!.heightMm, 90, steps, jet.name));

  const make = (): Shelf => {
    const held = new Map<string, string>();
    return {
      getItem: (k) => held.get(k) ?? null,
      setItem: (k, v) => { held.set(k, v); },
    };
  };

  {
    const shelf = make();
    const after = shelvePlane(shelf, jet.name, text);
    check('a shelved plane comes back with its name and its script',
      after.length === 1 && after[0]!.name === jet.name
        && after[0]!.steps.length === steps.length,
      `${after.length} on the shelf, ${after[0]?.steps.length} steps as ${after[0]?.name}`);

    const replayed = replay(W, H, after[0]!.steps);
    check('a shelved plane folds back into the same model',
      replayed.state.graph.faces_vertices.length
        === replay(W, H, steps).state.graph.faces_vertices.length,
      `${replayed.state.graph.faces_vertices.length} faces`);
  }

  {
    const shelf = make();
    shelvePlane(shelf, '드롭십', text);
    const twice = shelvePlane(shelf, ' 드롭십 ', text);
    check('saving under a name already there replaces it', twice.length === 1,
      `${twice.length} row(s) after saving 드롭십 twice`);
    const gone = dropPlane(shelf, twice[0]!.id);
    check('a plane taken off the shelf is gone', gone.length === 0,
      `${gone.length} left`);
  }

  {
    // Damaged on the shelf: half a script is not a plane.
    const shelf = make();
    shelf.setItem(SHELF_KEY, JSON.stringify([
      { id: 'a', name: '성한 것', saved: '2026-01-02', text },
      { id: 'b', name: '깨진 것', saved: '2026-01-01', text: '{"kind":"nonsense"}' },
      { id: 'c', name: '글자가 아닌 것', saved: '2026-01-03' },
    ]));
    const list = readShelf(shelf);
    check('a damaged row is left off the shelf rather than replayed',
      list.length === 1 && list[0]!.name === '성한 것',
      `${list.length} of 3 rows read back`);
  }

  {
    // Storage switched off entirely, which a private window does.
    const refused: Shelf = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    check('storage that refuses leaves an empty shelf, not an error',
      readShelf(refused).length === 0 && shelvePlane(refused, 'x', text).length === 0,
      'no rows, no throw');
  }
}

/*
 * A collapse that leaves a crease open.
 *
 * The collapse that closes every crease at a point cannot make a waterbomb:
 * the waterbomb folds the two diagonals and one middle line and leaves the
 * other middle line exactly as it was. First checked on the textbook case - a
 * square, creased corner to corner and across one way, collapsed into the
 * triangle every origami book starts from - and then on the book move that
 * needed it, the Triangle's sixth step.
 */
{
  const E = 0.2;
  const sq: Step[] = [
    { kind: 'fold', a: [0, 0], b: [E, E], movingSide: [0, E], sense: 'valley',
      creaseOnly: true, label: 'diagonal' },
    { kind: 'fold', a: [0, E], b: [E, 0], movingSide: [0, 0], sense: 'valley',
      creaseOnly: true, label: 'diagonal' },
    { kind: 'fold', a: [0, E / 2], b: [E, E / 2], movingSide: [E / 2, E], sense: 'valley',
      creaseOnly: true, label: 'across' },
    { kind: 'fold', a: [E / 2, 0], b: [E / 2, E], movingSide: [E, E / 2], sense: 'valley',
      creaseOnly: true, label: 'up' },
  ];
  const base = replay(E, E, sq).state;
  const wb = collapseAlong(base, [E / 2, E / 2], [[E / 2, E]]);
  const { lo, hi } = (() => {
    const pts = wb.state.graph.faces_vertices.flatMap((_, f) => faceOutline(wb.state, f));
    return {
      lo: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
      hi: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
    };
  })();
  /*
   * A triangle, whichever way it stands: the side along the line left open is
   * the whole sheet, the other is half of it, and the outline has three
   * corners. A rectangle of the same size would be the square simply halved.
   */
  const hull = (() => {
    // Rounded first: the same corner reached through different faces differs
    // in the last bit, and a point on a side then sorts as if it were a corner.
    const pts = wb.state.graph.faces_vertices.flatMap((_, f) => faceOutline(wb.state, f))
      .map((p) => [Math.round(p[0] * 1e9) / 1e9, Math.round(p[1] * 1e9) / 1e9] as Vec2)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: Vec2, a: Vec2, b: Vec2) =>
      (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const half = (list: Vec2[]) => {
      const out: Vec2[] = [];
      for (const p of list) {
        while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 1e-12) {
          out.pop();
        }
        out.push(p);
      }
      return out.slice(0, -1);
    };
    return [...half(pts), ...half([...pts].reverse())];
  })();
  const sides = [hi[0]! - lo[0]!, hi[1]! - lo[1]!].sort((a, b) => a - b);
  check('a square collapses into the waterbomb triangle',
    !wb.conflict && wb.violations.length === 0 && hull.length === 3
      && Math.abs(sides[0]! - E / 2) < 1e-9 && Math.abs(sides[1]! - E) < 1e-9,
    wb.conflict ?? `${hull.length} corners, ${(sides[1]! * 100).toFixed(1)} x `
      + `${(sides[0]! * 100).toFixed(1)}cm, ${wb.violations.length} violations`);
  const every = collapseAtPoint(base, [E / 2, E / 2]);
  const sameShape = every.state.graph.faces_vertices.length
      === wb.state.graph.faces_vertices.length && every.state.faces_matrix.every((m, i) =>
      m.every((v, k) => Math.abs(v - wb.state.faces_matrix[i]![k]!) < 1e-9));
  check('closing every crease there is a different base', !every.conflict && !sameShape,
    every.conflict ?? 'the preliminary base, not the waterbomb');
}

{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const tri = SAMPLES.find((z) => z.id === 'triangle')!;
  const steps = tri.build(W, H);
  const at6 = steps.findIndex((st) => st.kind === 'collapse');
  const before = replay(W, H, steps.slice(0, at6)).state;
  const after = replay(W, H, steps.slice(0, at6 + 1));
  check('the Triangle\'s sixth step folds with nothing through anything',
    after.blockedAt < 0 && orderViolations(after.state).length === 0,
    `blocked at ${after.blockedAt}, ${orderViolations(after.state).length} violations`);

  // The two ringed points: the ends of the line across the model at the meeting
  // point, where it reaches the edges the third step left.
  const S = Math.min(W, H);
  const meet = (S / 2) * Math.SQRT2;
  const reach = meet * Math.tan(Math.PI / 8);
  const rings: Vec2[] = [[S / 2 + reach, meet], [S / 2 - reach, meet]];
  const landed = rings.map((ring) => {
    const out: Vec2[] = [];
    before.graph.faces_vertices.forEach((loop, face) => loop.forEach((v) => {
      const p = affineApply(before.faces_matrix[face]!, before.graph.vertices_coords[v]!);
      if (Math.hypot(p[0] - ring[0], p[1] - ring[1]) > 1e-6) return;
      out.push(affineApply(after.state.faces_matrix[face]!, after.state.graph.vertices_coords[v]!));
    }));
    return out;
  });
  check('both rings end up on the middle line, where the page puts them',
    landed.every((l) => l.length > 0 && l.every((p) => Math.abs(p[0] - S / 2) < 1e-9)),
    landed.map((l) => l.map((p) => `(${(p[1] * 100).toFixed(2)}, ${(p[0] * 100).toFixed(2)})`)
      .join(' ')).join(' | '));

  // The middle line was named as the one left alone.
  const middleOpen = after.state.graph.edges_vertices.every(([u, v], e) => {
    const a = after.state.graph.vertices_coords[u]!;
    const b = after.state.graph.vertices_coords[v]!;
    const onMiddle = Math.abs(a[0] - S / 2) < 1e-9 && Math.abs(b[0] - S / 2) < 1e-9
      && Math.max(a[1], b[1]) > meet + 1e-6;
    return !onMiddle || Math.abs(after.state.graph.edges_foldAngle[e] ?? 0) < 1e-9;
  });
  check('the crease named open is still open', middleOpen, 'middle line behind the point, 0°');

  const again = replay(W, H, steps.slice(0, at6 + 1));
  check('the same collapse replays into the same pile',
    again.state.faces_order.join(',') === after.state.faces_order.join(','),
    `${after.state.faces_order.length} faces in the same order twice`);
}

/*
 * What the screen relies on, now that folding is done on it by hand.
 */
{
  const W = A4!.widthMm / 1000;
  const H = A4!.heightMm / 1000;
  const tri = SAMPLES.find((z) => z.id === 'triangle')!.build(W, H);

  /*
   * The model is drawn in the layout's frame whichever face holds still.
   *
   * While a fold is being set up, the half that would travel counts as moving,
   * so a different face holds still - and the model used to be drawn in that
   * face's own frame, which after it had been turned over was the mirror
   * image. On screen the model jumped across its spine and the paper that was
   * pointed at was no longer under the pointer.
   */
  {
    const st = replay(W, H, tri.slice(0, tri.findIndex((x) => (x as { label?: string }).label?.startsWith('⑪')))).state;
    const n = st.graph.faces_vertices.length;
    const a = renderFaces({ ...st, faces_moved: st.graph.faces_vertices.map(() => false) }, -1, 0);
    const b = renderFaces({ ...st, faces_moved: st.graph.faces_vertices.map((_, f) => f < n / 2) }, -1, 0);
    const far = a.reduce((m, f, i) => Math.max(m, ...f.points.map((p, k) =>
      Math.hypot(p[0] - b[i]!.points[k]![0], p[1] - b[i]!.points[k]![1], p[2] - b[i]!.points[k]![2]))), 0);
    check('the model stays put whichever face is held still', far < 1e-9,
      `${(far * 1000).toFixed(3)}mm furthest shift`);
  }

  /*
   * A wing folded as a half of the packet, whether or not the mirror is on.
   *
   * The mirror copy of a fold that names its own paper found no paper under
   * its finger and fell back to folding everything past its line.
   */
  {
    const i11 = tri.findIndex((x) => (x as { label?: string }).label?.startsWith('⑪'));
    const base = tri.slice(0, i11);
    const wing = tri[i11] as Extract<Step, { kind: 'fold' }>;
    const bent = (symmetric: boolean) => replay(W, H, [...base, { ...wing, symmetric }]).bent[i11];
    check('a half folds one half, mirror or not', bent(false) === 13 && bent(true) === 13,
      `${bent(false)} plies without the mirror, ${bent(true)} with it`);
  }

  /*
   * The ways a collapse can go, offered when closing every line cannot.
   */
  {
    const i6 = tri.findIndex((x) => x.kind === 'collapse');
    const st = replay(W, H, tri.slice(0, i6)).state;
    const at = (tri[i6] as { at: Vec2 }).at;
    const lines = linesThrough(st, at);
    const options = openingsThatFold(st, at, lines);
    const middle = lines.findIndex((l) => Math.abs(l.dir[0]) < 1e-6);
    check('the Triangle\'s sixth step is offered with the middle line open',
      lines.length === 4 && options.some((o) => o[middle] && o.filter(Boolean).length === 1),
      `${lines.length} lines, ${options.length} ways that fold`);
  }

  /*
   * How hard a step is, by the plies it bends at once.
   *
   * Every book aeroplane bends a dozen or so at the nose and is folded by
   * children; halving a sheet five times bends thirty-two in the last fold.
   */
  {
    // 오르막길's nose is rolled nine times and halving it bends 17 plies; the
    // limit was raised to 18 for it, since people fold it.
    const books = SAMPLES.filter((z) => z.id === 'jet' || z.id === 'triangle' || z.id === 'transition' || z.id === 'skyking' || z.id === 'birdman' || z.id === 'highest')
      .map((z) => Math.max(...replay(W, H, z.build(W, H)).bent));
    const halvings: Step[] = [];
    let w = W;
    let h = H;
    for (let i = 0; i < 6; i++) {
      halvings.push(i % 2 === 0
        ? { kind: 'fold', a: [w / 2, 0], b: [w / 2, H], movingSide: [w, H / 2], sense: 'valley',
          creaseOnly: false, label: `half ${i}` }
        : { kind: 'fold', a: [0, h / 2], b: [W, h / 2], movingSide: [W / 2, h], sense: 'valley',
          creaseOnly: false, label: `half ${i}` });
      if (i % 2 === 0) w /= 2; else h /= 2;
    }
    const thick = foldStats(replay(W, H, halvings), paperProps(A4!, 90));
    check('the book aeroplanes are not called too thick to fold',
      books.every((n) => n <= 18), `at most ${books.join(' and ')} plies at once`);
    check('halving six times is', thick.tooThick && thick.hardestPlies >= 32,
      `${thick.hardestPlies} plies at step ${thick.hardestStep + 1}`);
  }

  /*
   * Opening two folds, the later one first, leaves the later crease where the
   * paper has it. Halve the sheet, fold a corner through both halves, open the
   * corner, open the half: the corner's crease is a V across the middle line.
   * Replayed as a view line over the opened sheet it came back straight, its
   * far half on the wrong part of the paper.
   */
  {
    const half: Step = { kind: 'fold', a: [W / 2, 0], b: [W / 2, H], movingSide: [W * 0.95, H / 2], sense: 'valley', creaseOnly: false, label: 'half' };
    const corner: Step = { kind: 'fold', a: [0, H * 0.84], b: [W / 2, H * 0.67], movingSide: [W * 0.25, H * 0.98], sense: 'valley', creaseOnly: false, label: 'corner' };
    const cornerOpen: Step = { ...corner, creaseOnly: true, unfolded: true, unfoldedAt: 1 };
    const before = replay(W, H, [half, cornerOpen]);
    const opened = replay(W, H, [{ ...half, creaseOnly: true, unfolded: true, unfoldedAt: 2 }, { ...cornerOpen, pinned: before.stepCreases[1] }]);
    const keys = (r: typeof before) => r.creases.map((c) => segmentKey(c)).sort().join(' ');
    check('a crease stays put when the fold under it is opened', keys(opened) === keys(before),
      `${opened.creases.length} lines, ${keys(opened) === keys(before) ? 'the same' : 'moved'}`);
  }

  /*
   * Highest's nose lock, reached by a pupil's click: folded to its twelfth
   * step, one ply folded on the 8.6cm roll line opens a pocket right at the
   * point the book's lock is made round - so the lock is offered there, and
   * takes the paper flat. The search finds squashes of its own there too.
   */
  {
    const book = SAMPLES.find((z) => z.id === 'highest')!.build(W, H);
    const lock = book[13] as Extract<Step, { kind: 'collapse' }>;
    const st = replay(W, H, book.slice(0, 13)).state;
    const y = lock.at[1];
    const a: Vec2 = [0, y], b: Vec2 = [W, y], m: Vec2 = [W / 2, y - 0.01];
    const taken = pliesAtLine(st, a, b, m, 1);
    const hinges = pocketHinges(st, a, b, taken);
    const nearLock = hinges.filter((h) => lock.lines!.some((l) => [l.a, l.b].some((q) => Math.hypot(q[0] - h.P[0], q[1] - h.P[1]) < 0.015)));
    const flat = collapsePattern(st, lock.lines!);
    const found = pocketOptions(st, a, b, m, taken, W / 2);
    check('Highest\'s nose lock is there for a one-ply fold on its roll line',
      nearLock.length > 0 && !flat.conflict && flat.violations.length === 0 && found.length > 0,
      `${nearLock.length} pocket(s) at the lock point, lock ${flat.conflict ? 'conflicts' : `${flat.violations.length} crossings`}, ${found.length} squashes found`);
  }

  /*
   * A pupil's pocket, from a real session: the nose band folded up, then its
   * top ply folded along the triangle's crease where that crosses the band.
   * The band is joined to the sheet along its folded edge, so a pocket opens
   * where the line meets it - and one way of squashing it lays the band's
   * folded edge along the triangle line on the sheet beneath, which is how
   * the paper in the photograph lies.
   */
  {
    const steps = JSON.parse('[{"kind":"fold","a":[0.105,0],"b":[0.105,0.297],"movingSide":[0.2099,0.1485],"sense":"valley","creaseOnly":true},{"kind":"fold","a":[0.09,0.297],"b":[0.09,0],"movingSide":[0.08,0.1485],"sense":"valley","creaseOnly":true},{"kind":"fold","a":[0.12,0.297],"b":[0.12,0],"movingSide":[0.13,0.1485],"sense":"valley","creaseOnly":true},{"kind":"fold","a":[0,0.131],"b":[0.09,0.297],"movingSide":[0.03,0.28],"sense":"valley","creaseOnly":true,"symmetric":true,"unfolded":true,"unfoldedAt":1},{"kind":"fold","a":[0.105,0.231],"b":[0.065,0.231],"movingSide":[0.07,0.245],"sense":"valley","creaseOnly":false,"symmetric":true}]') as Step[];
    const st = replay(W, H, steps).state;
    const a: Vec2 = [0.12, 0.165], b: Vec2 = [0.1558, 0.231], m: Vec2 = [0.19, 0.19];
    const taken = pliesAtLine(st, a, b, m, 1);
    const ways = pocketOptions(st, a, b, m, taken, W / 2);
    // The band's folded edge, on its own paper, and the triangle line it should come to lie along.
    const onBand = (q: Vec2): Vec2 | null => {
      const inward: Vec2 = [q[0], q[1] - 0.0005];
      const f = faceUnder(st, inward, 1e-6);
      return f === null ? null : affineApply(affineInverse(st.faces_matrix[f]!), inward);
    };
    const edge = [onBand([0.17, 0.231]), onBand([0.2, 0.231])];
    const lands = (s2: typeof st, q: Vec2) => {
      const g = s2.graph;
      const f = g.faces_vertices.findIndex((loop) => pointInPolygon(loop.map((v) => g.vertices_coords[v]!), q));
      return f < 0 ? null : affineApply(s2.faces_matrix[f]!, q);
    };
    const t0: Vec2 = [0.1558, 0.231], t1: Vec2 = [0.21, 0.131];
    const off = (q: Vec2) => Math.abs((q[0] - t0[0]) * (t1[1] - t0[1]) - (q[1] - t0[1]) * (t1[0] - t0[0])) / Math.hypot(t1[0] - t0[0], t1[1] - t0[1]);
    const good = ways.filter((w) => edge.every((q) => { const at = q && lands(w.state, q); return !!at && off(at) < 0.0015; }));
    check('a pupil\'s band pocket can be squashed along the triangle line',
      pocketHinges(st, a, b, taken).length > 0 && good.length > 0, `${ways.length} way(s), ${good.length} lay the band's edge on the line`);
  }

  /*
   * A pocket crease that meets a fold carries on through it, mirrored: the
   * paper beyond is turned over. Stopped at the fold it would end in the
   * middle of the paper, where nothing lies flat.
   */
  {
    const half: Step = { kind: 'fold', a: [W / 2, 0], b: [W / 2, H], movingSide: [W * 0.95, H / 2], sense: 'valley', creaseOnly: false, label: 'half' };
    const st = replay(W, H, [half]).state;
    const a: Vec2 = [0, H * 0.6], b: Vec2 = [W / 2, H * 0.4], m: Vec2 = [W * 0.05, H * 0.2];
    const taken = pliesAtLine(st, a, b, m, 1);
    const opts = pocketOptions(st, a, b, m, taken);
    check('a halved sheet folds its top ply across the spine one way or another',
      pocketHinges(st, a, b, taken).length === 0 || opts.length > 0,
      `${pocketHinges(st, a, b, taken).length} join(s) crossed, ${opts.length} way(s)`);
  }
}

/*
 * Real paper, as the flight counts it: rolls lengthen the nose, the keel sits
 * on the middle, a thrown plane opens its V, winglets take the whole tip.
 */
{
  const bookPlane = (id: string) => readSessionFile(readFileSync(`public/${id}.json`, 'utf8'));
  const built = (id: string) => {
    const r = bookPlane(id);
    const paper = paperProps(SHEET_SIZES.find((z) => z.widthMm === r.widthMm && z.heightMm === r.heightMm) ?? SHEET_SIZES[0]!, r.gsm);
    const sess = replay(r.widthMm / 1000, r.heightMm / 1000, r.steps, paper.foldedPitch);
    const drawn = renderFacesHeld(sess.state, -1, paper.foldedPitch);
    const roll = rollLength(r.steps, sess, paper.foldedPitch, drawn, paper);
    const plies = lengthenNose(drawn, paper, roll.extra, roll.band);
    const spec = measurePlane(plies, paper, paper.foldedPitch, foldEdges(r.steps, sess, paper.foldedPitch, drawn, paper))!;
    return { r, paper, sess, drawn, roll, plies, spec, af0: buildAirframe(drawn, paper), af: buildAirframe(plies, paper) };
  };

  // Highest rolls its nose over and over: longer for it, by about what a
  // half turn round each bundle takes - some millimetres, not centimetres.
  const hi = built('highest');
  const grew = hi.af.length - hi.af0.length;
  check('rolled paper leaves the nose longer, by millimetres',
    grew > 0.003 && grew < 0.015 && Math.abs(grew - hi.roll.extra) < 0.002,
    `${(hi.af0.length * 100).toFixed(2)} -> ${(hi.af.length * 100).toFixed(2)}cm, rolls ${(hi.roll.extra * 1000).toFixed(1)}mm`);

  // The dart's folds are along its length and its flaps behind the nose: no rolls.
  const jet = built('jet');
  check('a dart has no nose rolls to lengthen', jet.roll.extra < 0.002,
    `${(jet.roll.extra * 1000).toFixed(1)}mm`);

  // The stretch leaves the tail where it is and moves the nose by all of it.
  const move = noseStretch(hi.drawn, hi.paper, 0.01, hi.roll.band);
  const frame = hi.af0.frame;
  let tailMoved = 0;
  let noseMoved = 0;
  for (const f of hi.drawn) for (const p of f.points) {
    const x = frame.toBody(p)[0];
    const d = Math.hypot(...(move!(p).map((v, i) => v - p[i]!) as [number, number, number]));
    if (x < hi.af0.cgFromNose - hi.af0.length + 1e-6) tailMoved = Math.max(tailMoved, d);
    if (x > hi.af0.cgFromNose - 1e-4) noseMoved = Math.max(noseMoved, d);
  }
  check('stretching the nose moves the nose, not the tail',
    !!move && tailMoved < 1e-6 && Math.abs(noseMoved - 0.01) < 1e-6,
    `tail ${(tailMoved * 1000).toFixed(3)}mm, nose ${(noseMoved * 1000).toFixed(3)}mm`);

  // The keel's two sides lie either side of the middle.
  for (const id of ['highest', 'birdman', 'jet']) {
    const b = built(id);
    const o = b.af.frame.toBody([0, 0, 0]);
    const ys: number[] = [];
    for (const f of b.plies) {
      const q = b.af.frame.toBody(f.normal);
      const nz = Math.abs(q[2] - o[2]) / (Math.hypot(q[0] - o[0], q[1] - o[1], q[2] - o[2]) || 1);
      const pts = f.points.map(b.af.frame.toBody);
      if (nz < 0.35 && pts.every((p) => Math.abs(p[1]) < 0.02)) ys.push(...pts.map((p) => p[1]));
    }
    const mid = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 1;
    check(`${id}'s keel stands on the middle`, Math.abs(mid) < 5e-4, `${(mid * 1000).toFixed(2)}mm off`);
  }

  // Thrown, a V set at 20 flies nearly flat, and never droops below flat.
  check('a thrown plane opens its V toward flat',
    Math.abs(airborneVee(20) - 7.5) < 1e-9 && airborneVee(5) === 0 && airborneVee(-5) === -5,
    `20 -> ${airborneVee(20)}, 5 -> ${airborneVee(5)}, -5 -> ${airborneVee(-5)}`);

  // Birdman's nose is thick on top (the guide) - read that way off the paper.
  const bm = built('birdman');
  const bulge = noseBulge(bm.spec);
  check('Birdman\'s nose bulges on top', bulge.side === 1, `side ${bulge.side}, ${(bulge.offset * 1000).toFixed(2)}mm`);

  // Side-edge vortex lift: Torres & Mueller's plates - about 4 at aspect ratio 1, about 1 at 2, nothing long.
  check('side-edge vortices lift a square wing and not a long one',
    Math.abs(sideEdgeVortex(1) - 4.1) < 0.05 && sideEdgeVortex(2) > 0.7 && sideEdgeVortex(2) < 1.2 && sideEdgeVortex(6) < 0.01,
    `Kv ${sideEdgeVortex(1).toFixed(2)}, ${sideEdgeVortex(2).toFixed(2)}, ${sideEdgeVortex(6).toFixed(3)}`);

  // A square plane balanced near its quarter chord holds its glide: Highest flies, its margin is positive.
  {
    const rep = flightReport(flightBase(hi.spec), hi.spec, hi.paper, { ...DEFAULT_FLIGHT, vee: hi.r.vee ?? null });
    check('a square plane holds its glide on its side-edge vortices', rep.margin > 0.02,
      `glide margin ${(rep.margin * 100).toFixed(1)}%, lattice ${(rep.m.staticMargin * 100).toFixed(1)}%`);
  }

  /*
   * The measured plane: the maps hold all the paper and put it where the
   * pieces have it, a symmetric plane measures symmetric, and the flight on
   * the measurements does not swing with a hair's difference in the paper.
   */
  for (const id of ['birdman', 'highest', 'jet']) {
    const b = built(id);
    const sp = b.spec;
    check(`${id}: the maps hold all the paper`, Math.abs(sp.mapMass / sp.af.mass.mass - 1) < 0.01,
      `${(sp.mapMass * 1000).toFixed(3)}g of ${(sp.af.mass.mass * 1000).toFixed(3)}g`);
    // Its balance from the maps against the pieces'.
    let mx = 0; let mm = 0;
    for (let k = 0; k < sp.top.mass.length; k++) { const c = k % sp.top.nx; mx += sp.top.mass[k]! * (sp.top.x0 + c * CELL); mm += sp.top.mass[k]!; }
    for (let k = 0; k < sp.keel.mass.length; k++) { const c = k % sp.keel.nx; mx += sp.keel.mass[k]! * (sp.keel.x0 + c * CELL); mm += sp.keel.mass[k]!; }
    for (const f of sp.fins) { mx += f.mass * f.centre[0]; mm += f.mass; }
    const cgX = mm > 0 ? mx / mm : 0;
    check(`${id}: the maps balance where the paper does`, Math.abs(cgX) < 0.0005, `${(cgX * 1000).toFixed(2)}mm off`);
    // Mirror image across the middle: the map's cells match their mirror.
    let same = 0; let all = 0;
    for (let r = 0; r < sp.top.ny; r++) for (let c = 0; c < sp.top.nx; c++) {
      const a = sp.top.plies[r * sp.top.nx + c]!; const m = sp.top.plies[(sp.top.ny - 1 - r) * sp.top.nx + c]!;
      if (a === 0 && m === 0) continue;
      all++; if (a === m) same++;
    }
    check(`${id}: measured the same on both sides`, all > 0 && same / all > 0.97, `${((same / Math.max(1, all)) * 100).toFixed(1)}% of cells`);
  }
  {
    const cg = bm.spec.summary.cgFromNose;
    check('Birdman balances about 2.5cm from its nose (the guide)', Math.abs(cg - 0.025) < 0.004,
      `${(cg * 100).toFixed(2)}cm`);
  }
  // A hair's more or less paper does not turn a flight over: 5% thicker, the same flight within 15%.
  for (const id of ['birdman', 'highest']) {
    const flown = (scale: number) => {
      const r = bookPlane(id);
      const paper = paperProps(SHEET_SIZES.find((z) => z.widthMm === r.widthMm && z.heightMm === r.heightMm) ?? SHEET_SIZES[0]!, r.gsm);
      const pitch = paper.foldedPitch * scale;
      const sess = replay(r.widthMm / 1000, r.heightMm / 1000, r.steps, pitch);
      const drawn = renderFacesHeld(sess.state, -1, pitch);
      const roll = rollLength(r.steps, sess, pitch, drawn, paper);
      const sp = measurePlane(lengthenNose(drawn, paper, roll.extra, roll.band), paper, pitch)!;
      const rep = flightReport(flightBase(sp), sp, paper, { ...DEFAULT_FLIGHT, vee: r.vee ?? null, elevator: 5 });
      const runs = throwsAround(rep.launch, 30).map((l) => fly(rep.af, rep.m, l, 0.004));
      return runs.reduce((a, x) => a + x.time, 0) / runs.length;
    };
    const t0 = flown(1); const t1 = flown(1.05); const t2 = flown(0.95);
    check(`${id}: 5% thicker or thinner paper flies within 15%`,
      Math.abs(t1 / t0 - 1) < 0.15 && Math.abs(t2 / t0 - 1) < 0.15,
      `${t2.toFixed(1)} / ${t0.toFixed(1)} / ${t1.toFixed(1)}s`);
  }

  // Winglets on Highest: both tips come up together, the span shorter by both.
  {
    const r = hi.r;
    const made = wingletSteps(r.widthMm / 1000, r.heightMm / 1000, r.steps, 10, hi.paper, 1);
    if (typeof made === 'string') check('winglets fold on Highest', false, made);
    else {
      const all = [...r.steps, ...made];
      const s2 = replay(r.widthMm / 1000, r.heightMm / 1000, all, 0);
      const plies2 = renderFacesHeld(s2.state, -1, 0);
      const af2 = buildAirframe(plies2, hi.paper);
      const af1 = buildAirframe(renderFacesHeld(replay(r.widthMm / 1000, r.heightMm / 1000, r.steps, 0).state, -1, 0), hi.paper);
      const n = r.steps.length;
      check('winglets take the whole tip of both wings',
        s2.blockedAt < 0 && s2.bent[n]! > 0 && s2.bent[n] === s2.bent[n + 1] && af1.span - af2.span > 0.015,
        `plies ${s2.bent[n]} and ${s2.bent[n + 1]}, span ${(af1.span * 100).toFixed(1)} -> ${(af2.span * 100).toFixed(1)}cm`);
    }
  }
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
