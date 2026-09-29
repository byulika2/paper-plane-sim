import { SAMPLES } from './samples.js';
import { replay } from '../src/ui/foldSession.js';
import { tacos } from '../src/origami/layers.js';

const W = 0.210;
const H = 0.297;

for (const sample of SAMPLES) {
  const steps = sample.build(W, H);
  const t0 = performance.now();
  const session = replay(W, H, steps);
  const ms = performance.now() - t0;
  console.log(`${sample.id}: ${session.state.graph.faces_vertices.length} faces, `
    + `${tacos(session.state).length} closed creases, blocked at step `
    + `${session.blockedAt} (${session.impossible.length} violations), ${ms.toFixed(1)}ms`);
  for (const one of session.impossible.slice(0, 4)) console.log(`   ${one.kind}: ${one.detail}`);
  if (session.blockedAt >= 0) {
    const s = steps[session.blockedAt]!;
    console.log(`   step: ${s.label}`);
  }
}
