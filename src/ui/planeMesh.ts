/**
 * The folded model as three.js draws it for flying: its plies in the body's
 * axes about the centre of gravity, the wings lifted into their V about the
 * keel - the same aeroplane the flight is worked out for, whichever picture
 * shows it.
 */

import * as THREE from 'three';
import type { Airframe } from '../aero/airframe.js';
import type { Vec3 } from '../geometry/math.js';
import type { RenderFace } from '../origami/space.js';
import { liftWings } from './flightReport.js';
import { foldBands } from './foldBands.js';

/** Body axes (x forward, y right, z down) to the scene's (x forward, y up, z right). */
export const scene3 = (q: Vec3): THREE.Vector3 => new THREE.Vector3(q[0], -q[2], q[1]);

/** Paper and its edges, as meshes to add to a group. */
export function planeMeshes(af: Airframe, drawPlies: readonly RenderFace[], veeDeg: number): THREE.Object3D[] {
  const vee = liftWings(af, drawPlies, veeDeg);
  const pos: number[] = [];
  const edges: number[] = [];
  for (const f of drawPlies) {
    const pts = f.points.map((q) => scene3(vee(af.frame.toBody(q))));
    for (let i = 1; i + 1 < pts.length; i++) {
      for (const k of [0, i, i + 1]) pos.push(pts[k]!.x, pts[k]!.y, pts[k]!.z);
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      edges.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  // The paper turning round at each closed fold, as on the folding screen.
  for (const q of foldBands(drawPlies)) {
    const v = scene3(vee(af.frame.toBody(q)));
    pos.push(v.x, v.y, v.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  const eg = new THREE.BufferGeometry();
  eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
  return [
    new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: 0xe8edf3, side: THREE.DoubleSide, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1,
    })),
    new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x7a8aa0, transparent: true, opacity: 0.55 })),
  ];
}
