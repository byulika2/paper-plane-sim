/**
 * Paper stock properties.
 *
 * Everything the simulator needs about the sheet is derived from two inputs:
 * the cut size and the basis weight.
 */

export interface SheetSize {
  readonly id: string;
  readonly name: string;
  /** Short edge, mm. */
  readonly widthMm: number;
  /** Long edge, mm. */
  readonly heightMm: number;
}

export const SHEET_SIZES: readonly SheetSize[] = [
  /*
   * Square stock comes first, because the folding books are written for it.
   *
   * Almost every diagram in a paper-aeroplane book starts "fold in half, and
   * again the other way" on a square, and a rectangle cannot follow those
   * instructions at all - the second half fold lands somewhere else and every
   * measurement after it is wrong. Origami paper is sold at 15cm; the sheets
   * that come with the aeroplane books are the width of A4 squared off.
   */
  { id: 'sq15', name: '정사각 15cm', widthMm: 150, heightMm: 150 },
  { id: 'sq21', name: '정사각 21cm', widthMm: 210, heightMm: 210 },
  { id: 'a4', name: 'A4', widthMm: 210, heightMm: 297 },
  { id: 'a5', name: 'A5', widthMm: 148, heightMm: 210 },
  { id: 'b5jis', name: 'B5 (JIS)', widthMm: 182, heightMm: 257 },
  { id: 'b5iso', name: 'B5 (ISO)', widthMm: 176, heightMm: 250 },
  { id: 'letter', name: 'US Letter', widthMm: 215.9, heightMm: 279.4 },
];

/** Apparent density of uncoated office paper, kg/m^3. */
const PAPER_DENSITY = 800;
/** In-plane Young's modulus of office paper, Pa. */
const E_PAPER = 3.0e9;
const POISSON = 0.3;

export interface PaperProps {
  readonly sheet: SheetSize;
  readonly gsm: number;
  /** Sheet area, m^2. */
  readonly area: number;
  /** Total sheet mass, kg. Folding never changes this. */
  readonly mass: number;
  /** Mass per unit area, kg/m^2. */
  readonly arealDensity: number;
  /** Single-ply caliper, m. */
  readonly thickness: number;
  /** How far apart plies lie once folded onto each other, m: the caliper and the air a fold leaves. */
  readonly foldedPitch: number;
  /** Flexural rigidity D = E t^3 / 12(1-v^2), N*m. Scales with the cube of
   *  caliper, so 80 to 100 gsm roughly doubles it. */
  readonly bendingRigidity: number;
}

/*
 * Folded paper does not lie flat on itself. A crease springs back a little and
 * every fold leaves air in it, so a stack of n plies is thicker than n sheets
 * pressed together - and the stiffer the paper, the more: stiffness goes with
 * the cube of the caliper, so heavier paper holds its folds further open.
 * The share of a caliper each folded ply adds, by weight. These are set from
 * folding, not measured - no study of it was found - and are here to be
 * adjusted: a thicker stack makes a fatter rolled nose, more camber on top,
 * a shorter real nose and a thicker wing.
 */
const FOLD_GAP: ReadonlyArray<readonly [gsm: number, share: number]> = [
  [60, 0.25], [80, 0.4], [100, 0.55], [120, 0.7], [160, 0.9],
];

export function foldGap(gsm: number): number {
  const t = FOLD_GAP;
  if (gsm <= t[0]![0]) return t[0]![1];
  for (let i = 1; i < t.length; i++) {
    const [g0, s0] = t[i - 1]!; const [g1, s1] = t[i]!;
    if (gsm <= g1) return s0 + ((s1 - s0) * (gsm - g0)) / (g1 - g0);
  }
  return t[t.length - 1]![1];
}

/** One folded ply's share of a stack's height, m, from the paper's weight. */
/*
 * How much of that gap a pressed fold keeps. Measured on a real one - the
 * pupil's Unis, 11.1 cm folded, which a half turn round each roll at the
 * bare caliper makes 11.04 and the gaps above would make 11.6 - none: a nose
 * creased hard lies tight. The table stays for paper folded loosely.
 */
const GAP_KEPT = 0;

export function foldedPitchOf(gsm: number): number {
  return (gsm / 1000 / PAPER_DENSITY) * (1 + GAP_KEPT * foldGap(gsm));
}

export function paperProps(sheet: SheetSize, gsm: number): PaperProps {
  const area = (sheet.widthMm / 1000) * (sheet.heightMm / 1000);
  const arealDensity = gsm / 1000;
  const thickness = arealDensity / PAPER_DENSITY;
  return {
    sheet,
    gsm,
    area,
    mass: area * arealDensity,
    arealDensity,
    thickness,
    foldedPitch: foldedPitchOf(gsm),
    bendingRigidity: (E_PAPER * thickness ** 3) / (12 * (1 - POISSON * POISSON)),
  };
}

