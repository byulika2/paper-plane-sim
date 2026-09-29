/**
 * The book planes as the list's cards judge them: `npx tsx scripts/calibrate.ts`.
 * For checking the model against the guide (Birdman: some 20 m up, 15 to 20 s).
 */
import { readFileSync } from 'node:fs';
import { readSessionFile } from '../src/ui/sessionFile.js';
import { cardFlight } from '../src/ui/planeCard.js';
for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['birdman', 'jet', 'transition', 'skyking', 'triangle', 'highest']) {
  const rec = readSessionFile(readFileSync(`public/${id}.json`, 'utf8'));
  const t0 = Date.now();
  const c = cardFlight({ ...rec, elevator: undefined });
  if (!c) { console.log(id, 'no flight'); continue; }
  console.log(`${id.padEnd(11)} ${c.time.toFixed(1)}s  높이 ${c.height.toFixed(1)}m  ${c.angle}°  엘리베이터 ${c.elevator.angleDeg}° 가로${c.elevator.widthCm}  `
    + c.grades.map((g) => `${g.label} ${(g.score / 10).toFixed(1)}`).join(' / ') + `  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
