/**
 * The folded paper itself, seen from behind, while it is being tuned: the
 * whole aeroplane with its wings in their V, or close up on the trailing edge
 * with the elevator bent in - as the pupil sees the real model held at arm's
 * length and looked at from the tail. It changes as the setting changes.
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { Airframe } from '../aero/airframe.js';
import type { RenderFace } from '../origami/space.js';
import { planeMeshes } from './planeMesh.js';
import { liftWings } from './flightReport.js';

interface Props {
  af: Airframe;
  /** The model as drawn, the elevator bent into it. */
  plies: readonly RenderFace[];
  vee: number;
  /** The whole aeroplane from behind, or the trailing edge close up. */
  focus: 'wings' | 'elevator';
  /** Where the elevator is, cm out from the middle: the close-up is framed on it. */
  region?: { fromCm: number; widthCm: number };
}

export function PaperPreview3D({ af, plies, vee, focus, region }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(-1, 2, 1);
    scene.add(sun);
    const model = new THREE.Group();
    for (const o of planeMeshes(af, plies, vee)) model.add(o);
    scene.add(model);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.002, 5);
    let aim: ((aspect: number) => void) | null = null;
    // From straight behind (the scene's x is forward), a little above the wing.
    const tail = af.cgFromNose - af.length;
    if (focus === 'wings') {
      const r = Math.max(af.span, 0.08);
      camera.position.set(-r * 2.2, r * 0.25, 0);
      camera.lookAt(0, 0, 0);
    } else {
      /*
       * The bent stretch of the right wing's trailing edge, filling the
       * picture, seen from behind and a little above - with a dashed line
       * where the edge was before it was bent, so a millimetre up or down
       * shows against it.
       */
      const from = Math.max(0, (region?.fromCm ?? 1) / 100);
      const to = Math.min(af.span / 2, from + (region?.widthCm ?? 3) / 100);
      const mid = (from + to) / 2;
      const halfWide = (to - from) / 2 + 0.006;
      // The trailing edge's height just inboard of the bend, off the unbent paper.
      // With the wings in their V, as the model is drawn: the unbent edge rises across the span with it.
      const lift = liftWings(af, plies, vee);
      const edgeAt = (yy: number) => {
        let ys = 0; let n = 0;
        for (const f of plies) for (const q of f.points) {
          const b = af.frame.toBody(q);
          if (b[0] < tail + 0.004 && Math.abs(b[1] - yy) < 0.004) { ys += -lift(b)[2]; n++; }
        }
        return n ? ys / n : 0;
      };
      const y = edgeAt(from - 0.003);
      const slope = Math.tan((vee * Math.PI) / 180);
      const ref = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(tail, y + (0.003) * slope, from), new THREE.Vector3(tail, y + (to - from + 0.003) * slope, to)]);
      const dash = new THREE.Line(ref, new THREE.LineDashedMaterial({ color: 0xf87171, dashSize: 0.002, gapSize: 0.0015 }));
      dash.computeLineDistances();
      scene.add(dash);
      aim = (aspect: number) => {
        // Near enough that the picture's width is the bent stretch and no more.
        const half = Math.tan((camera.fov * Math.PI) / 360) * Math.max(1, aspect);
        const d = halfWide / half;
        camera.position.set(tail - d, y + d * 0.18, mid);
        camera.lookAt(tail + 0.002, y, mid);
      };
    }
    const draw = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      aim?.(camera.aspect);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(mount);
    draw();
    return () => {
      ro.disconnect();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, [af, plies, vee, focus, region?.fromCm, region?.widthCm]);
  return <div className={`paper-preview ${focus}`} ref={mountRef} />;
}
