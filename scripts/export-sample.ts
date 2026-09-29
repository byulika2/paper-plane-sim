/**
 * Write a reference design out as a session file the app can open.
 *
 * `npx tsx scripts/export-sample.ts jet out.json`
 *
 * The step script is the model, so this is the same thing 작업 저장 produces -
 * it opens in the app with every step listed, selectable and editable.
 */
import { writeFileSync } from 'node:fs';
import { SHEET_SIZES } from '../src/paper/stock.js';
import { sessionFile } from '../src/ui/sessionFile.js';
import { SAMPLES } from './samples.js';

const [, , id = 'jet', out = `${id}.json`, sizeId = 'a4', gsm = '90'] = process.argv;
const sample = SAMPLES.find((s) => s.id === id);
const size = SHEET_SIZES.find((z) => z.id === sizeId);
if (!sample) throw new Error(`no sample called ${id}: ${SAMPLES.map((s) => s.id).join(', ')}`);
if (!size) throw new Error(`no sheet called ${sizeId}`);

/*
 * Each book plane as it is flown: the throw angle and elevator that keep it up
 * longest for a grown-up's overhand throw (20 m/s), found the way a finished
 * plane is tuned (`recommendThrow`: of 70, 80 and 90 degrees, the elevator
 * that flies longest over the hundred throws, among those that mostly come
 * level). The tuning is part of the plane's record, so the list and the flying
 * screen read the same numbers from it - marked as worked out, so they are
 * worked out again when the sums change rather than held to.
 */
const TUNING: Record<string, { widthCm: number; angleDeg: number; throwAngle: number }> = {
  jet: { widthCm: 1, angleDeg: -4, throwAngle: 70 },
  triangle: { widthCm: 3, angleDeg: 30, throwAngle: 70 },
  transition: { widthCm: 1, angleDeg: -5, throwAngle: 80 },
  skyking: { widthCm: 2, angleDeg: 12, throwAngle: 70 },
  birdman: { widthCm: 2, angleDeg: 23, throwAngle: 70 },
  highest: { widthCm: 3, angleDeg: 22, throwAngle: 70 },
};
/*
 * The wings' V as each book sets it before a flight: degrees up from wings
 * spread square to the body. 오르막길's tutorial gives none.
 */
const VEE: Record<string, number> = { jet: 20, triangle: 30, transition: 20, skyking: 20, birdman: 20 };
const steps = sample.build(size.widthMm / 1000, size.heightMm / 1000);
const tuned = TUNING[id];
writeFileSync(out, JSON.stringify(
  sessionFile(size.widthMm, size.heightMm, Number(gsm), steps, sample.name,
    tuned !== undefined ? { fromCm: 1, widthCm: tuned.widthCm, depthCm: 0.5, angleDeg: tuned.angleDeg, auto: true } : null,
    true, VEE[id] ?? null, tuned?.throwAngle ?? null), null, 1));
console.log(`${out}: ${sample.name} - ${steps.length} steps on ${size.name} `
  + `(${size.widthMm} x ${size.heightMm} mm, ${gsm} g/m2)`);
for (const s of steps) console.log(`  ${s.label}`);
