import { replay } from '../src/ui/foldSession.js';
import type { Step } from '../src/ui/foldSession.js';
import { modelBounds } from '../src/geometry/fold.js';

const W = 0.21; const H = 0.297;
// a 45 degree corner fold on the left, which HAS a distinct mirror image
const step = (symmetric: boolean): Step[] => [{
  kind: 'fold', a: [W / 2, H], b: [0, H - W / 2], movingSide: [0.001, H - 0.001],
  sense: 'valley', creaseOnly: false, angleDeg: 180, symmetric, label: 'corner',
}];

for (const symmetric of [false, true]) {
  const s = replay(W, H, step(symmetric));
  const { min, max } = modelBounds(s.model);
  console.log(`대칭=${symmetric ? 'ON ' : 'OFF'}: 면 ${s.state.graph.faces_vertices.length}`
    + `, 접는 선 ${s.creases.length}`
    + `, 크기 ${((max[0]-min[0])*100).toFixed(1)}x${((max[1]-min[1])*100).toFixed(1)}cm`
    + `, 면적비 ${(s.state.graph.faces_vertices.reduce((t,f)=>t+Math.abs(
        f.reduce((a,_,i)=>{const p=s.state.graph.vertices_coords[f[i]!]!,q=s.state.graph.vertices_coords[f[(i+1)%f.length]!]!;
        return a+p[0]*q[1]-q[0]*p[1];},0)/2),0)/(W*H)).toFixed(6)}`);
}
