/**
 * The throw in the room: the folded model flying its real path over the
 * floor - up from the hand, over at the top, round in its turn and down the
 * glide - with the way it has come drawn behind it in the colours of the
 * parts of a flight, and the camera following it or standing back to see the
 * whole. The wind tunnel beside it shows the same moment close up.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Airframe } from '../aero/airframe.js';
import type { Flight, FlightPoint } from '../aero/flight.js';
import type { RenderFace } from '../origami/space.js';
import { momentAt, phaseAt, pointAt } from './flightPhase.js';
import type { Phase } from './flightPhase.js';
import { planeMeshes } from './planeMesh.js';

interface Props {
  af: Airframe;
  drawPlies: readonly RenderFace[];
  vee: number;
  flight: Flight;
  /** The moment shown, s. */
  t: number;
  colours: Record<Phase, string>;
}

// The floor's x along the throw, y up, z to its side.
const at = (p: FlightPoint) => new THREE.Vector3(p.gx ?? p.x, p.h, p.gy ?? 0);

/** The aeroplane's attitude: heading about the vertical, nose raised by climb plus angle of attack, rolled by its bank. */
function attitude(p: FlightPoint): THREE.Quaternion {
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -(p.heading ?? 0));
  const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), (p.gamma ?? 0) + (p.alpha ?? 0));
  const roll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), p.bank ?? 0);
  return yaw.multiply(pitch).multiply(roll);
}

export function FlightScene3D({ af, drawPlies, vee, flight, t, colours }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const live = useRef({ t, follow });
  live.current = { t, follow };
  const api = useRef<{ fit(): void } | null>(null);

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 400);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
    sun.position.set(5, 10, 3);
    scene.add(sun);

    // The room: a floor a metre a square, as wide as the flight goes.
    const pts = flight.path;
    const box = new THREE.Box3();
    for (const p of pts) box.expandByPoint(at(p));
    box.expandByPoint(new THREE.Vector3(0, 0, 0));
    const size = Math.max(10, Math.ceil(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) + 6));
    const floor = new THREE.GridHelper(size * 2, size * 2, 0x3b4b63, 0x243042);
    floor.position.set((box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2);
    scene.add(floor);
    // Where the thrower stands.
    const hand = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, pts[0]!.h, 16),
      new THREE.MeshStandardMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }));
    hand.position.set(0, pts[0]!.h / 2, 0);
    scene.add(hand);

    // The way it goes: faint whole, coloured as far as it has come.
    const n = pts.length;
    const positions = new Float32Array(n * 3);
    const tints = new Float32Array(n * 3);
    pts.forEach((p, i) => {
      const v = at(p);
      positions.set([v.x, v.y, v.z], i * 3);
      const c = new THREE.Color(colours[phaseAt(flight, p)]);
      tints.set([c.r, c.g, c.b], i * 3);
    });
    const whole = new THREE.BufferGeometry();
    whole.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    scene.add(new THREE.Line(whole, new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.25 })));
    const flown = new THREE.BufferGeometry();
    flown.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    flown.setAttribute('color', new THREE.BufferAttribute(tints, 3));
    const trail = new THREE.Line(flown, new THREE.LineBasicMaterial({ vertexColors: true }));
    scene.add(trail);
    // Its shadow on the floor, to tell how high it is.
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.08, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }));
    shadow.rotation.x = -Math.PI / 2;
    scene.add(shadow);

    // The aeroplane, drawn three times its size so it reads against the room.
    const plane = new THREE.Group();
    for (const o of planeMeshes(af, drawPlies, vee)) plane.add(o);
    plane.scale.setScalar(3);
    scene.add(plane);

    const fit = () => {
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(4, box.getSize(new THREE.Vector3()).length() * 0.7);
      camera.position.set(c.x - r * 0.2, c.y + r * 0.45, c.z + r * 1.1);
      controls.target.copy(c);
      controls.update();
    };
    api.current = { fit };
    fit();

    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);
    resize();

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = live.current.t;
      const p = momentAt(pts, now);
      const i = Math.max(0, pts.indexOf(pointAt(pts, now)));
      const where = at(p);
      plane.position.copy(where);
      plane.quaternion.copy(attitude(p));
      shadow.position.set(where.x, 0.005, where.z);
      flown.setDrawRange(0, i + 1);
      if (live.current.follow) {
        // Behind it and to the side, a little above, catching up smoothly.
        const heading = p.heading ?? 0;
        const back = new THREE.Vector3(-Math.cos(heading), 0, -Math.sin(heading));
        const side = new THREE.Vector3(-Math.sin(heading), 0, Math.cos(heading));
        const want = where.clone().addScaledVector(back, 1.6).addScaledVector(side, 1.2).add(new THREE.Vector3(0, 0.6, 0));
        camera.position.lerp(want, 0.08);
        controls.target.lerp(where, 0.2);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
      });
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      api.current = null;
    };
  }, [af, drawPlies, vee, flight, colours]);

  return (
    <div className="flight-scene">
      <div className="flight-scene-stage" ref={mountRef}>
        <span className="tunnel3d-note">체육관 바닥 한 칸이 1m예요 · 비행기는 세 배로 크게 그렸어요</span>
      </div>
      <div className="flight-choices tunnel3d-views">
        <button className={follow ? 'on' : ''} onClick={() => setFollow(true)}>따라가기</button>
        <button className={!follow ? 'on' : ''} onClick={() => { setFollow(false); api.current?.fit(); }}>전체 보기</button>
      </div>
    </div>
  );
}
