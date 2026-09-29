/**
 * Replay a saved session outside the browser.
 *
 * `npx tsx scripts/open-session.ts <file.json>`
 *
 * Prints what the script builds: the shape, the creases, and whether the
 * stacking is one paper can take. This is how a session saved in the app gets
 * examined here, with the same code the app runs.
 */
import { readFileSync } from 'node:fs';
import { readSessionFile } from '../src/ui/sessionFile.js';
import { replay } from '../src/ui/foldSession.js';
import { patternCreases } from '../src/origami/space.js';
import { modelBounds } from '../src/geometry/fold.js';

const path = process.argv[2];
if (!path) {
  console.error('usage: tsx scripts/open-session.ts <session.json>');
  process.exit(2);
}

const { widthMm, heightMm, gsm, steps } = readSessionFile(readFileSync(path, 'utf8'));
const W = widthMm / 1000;
const H = heightMm / 1000;
const s = replay(W, H, steps);
const cm = (m: number) => (m * 100).toFixed(1);
const { min, max } = modelBounds(s.model);

console.log(`${path}`);
console.log(`  sheet   ${cm(W)} x ${cm(H)} cm, ${gsm} g/m2`);
console.log(`  steps   ${steps.length}`);
console.log(`  shape   ${cm(max[0] - min[0])} x ${cm(max[1] - min[1])} cm, `
  + `${s.state.faces_order.length} faces, ${s.model.layers.length} plies`);
console.log(`  creases ${s.creases.length} in the pattern`);
console.log(`  folds   ${s.blockedAt >= 0
  ? `BLOCKED at step ${s.blockedAt + 1} (${s.impossible.length} violation(s))`
  : 'no layer-order violations'}`);

console.log('\n  steps:');
steps.forEach((step, i) => {
  const mark = step.kind === 'dimension' ? '↔'
    : step.kind === 'flip' ? '⇋'
      : step.kind === 'collapse' ? '✳'
        : step.creaseOnly ? '⌇' : step.sense === 'mountain' ? '△' : '▽';
  console.log(`   ${String(i + 1).padStart(3)} ${mark} ${step.label}`);
});

console.log('\n  creases in the flat pattern (cm):');
for (const c of patternCreases(s.state)) {
  console.log(`    ${c.assignment.padEnd(8)} `
    + `(${cm(c.a[0])}, ${cm(c.a[1])}) -> (${cm(c.b[0])}, ${cm(c.b[1])})`
    + `${Math.abs(c.angleDeg) > 0.5 ? `  ${c.angleDeg.toFixed(0)}°` : ''}`);
}
