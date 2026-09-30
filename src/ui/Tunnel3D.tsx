/**
 * The wind tunnel, in the round.
 *
 * Side-on, the tunnel showed the wing as a line and the air as lines past it;
 * what a pupil cannot see from the side is the thing that makes a paper
 * aeroplane what it is - the air turned down behind the whole span, curling
 * round each tip, and the wings' V. So the folded model itself is set in a
 * stream of drifting specks, pitched to the angle chosen, with the three
 * forces as arrows from its centre of gravity, and seen from the same
 * oblique angle as the folding screen: nose toward you, to the left.
 *
 * The air is a picture of the numbers, not a flow solution. Each speck runs
 * straight at the wing, is turned down behind it by as much as the lift says
 * (the downwash, which is what lift is), swirls round the tips in proportion
 * to it, and tumbles over the top once the wing has stalled.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Airframe } from '../aero/airframe.js';
import type { Vec3 } from '../geometry/math.js';
import type { RenderFace } from '../origami/space.js';
import { liftWings } from './flightReport.js';

interface Props {
  af: Airframe;
  drawPlies: readonly RenderFace[];
  /** Angle of attack, radians. */
  alpha: number;
  /** Bank, radians: how far it is rolled onto its side. */
  bank?: number;
  /** Climb angle, radians: which way the weight pulls against the stream. */
  gamma?: number;
  /** The air's speed past it, m/s: how fast the specks drift. */
  airSpeed?: number;
  /** Wings set in a V, degrees. */
  vee: number;
  cl: number;
  stalled: boolean;
  /** Forces, N, and the weight they are drawn against. */
  lift: number;
  drag: number;
  weight: number;
  /** Nose-up (+) or nose-down (-) pitching coefficient. */
  cm: number;
  labels: { lift: string; drag: string; weight: string };
}

const VIEWS: ReadonlyArray<readonly [string, Vec3]> = [
  // Nose toward you and to the left, as on the folding screen.
  ['비스듬히', [0.62, 0.42, -0.72]],
  ['옆에서', [0.02, 0.05, -1]],
  ['앞에서', [1, 0.12, 0.001]],
  ['위에서', [0.001, 1, -0.02]],
];

/** Body axes (x forward, y right, z down) to the scene's (x forward, y up, z right). */
const scene3 = (q: Vec3): THREE.Vector3 => new THREE.Vector3(q[0], -q[2], q[1]);

export function Tunnel3D(props: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;
  const api = useRef<{ view(dir: Vec3): void; rebuild(): void; pose(): void } | null>(null);
  const [viewName, setViewName] = useState('비스듬히');

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.005, 20);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(0.5, 1, -0.3);
    scene.add(sun);

    // The model and its forces, rebuilt when the model or the angle changes.
    const plane = new THREE.Group();
    scene.add(plane);
    const forces = new THREE.Group();
    scene.add(forces);
    const air = new THREE.Group();
    scene.add(air);
    let reach = 0.12;
    let specks: { path: THREE.Vector3[]; phase: number }[] = [];
    let points: THREE.Points | null = null;

    const clear = (g: THREE.Group) => {
      for (const c of [...g.children]) {
        g.remove(c);
        c.traverse((o) => {
          const m = o as THREE.Mesh;
          m.geometry?.dispose();
          const mat = m.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose();
        });
      }
    };

    // The model itself: built when the aeroplane changes, not with every moment of a flight.
    const rebuild = () => {
      const p = live.current;
      const { af } = p;
      clear(plane);
      reach = Math.max(af.span, af.length, 0.08);
      // The wings lifted into their V about the keel, as on the flying screen.
      const vee = liftWings(af, p.drawPlies, p.vee);
      const pos: number[] = [];
      const edges: number[] = [];
      for (const f of p.drawPlies) {
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
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      plane.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: 0xe8edf3, side: THREE.DoubleSide, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: 1,
      })));
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.Float32BufferAttribute(edges, 3));
      plane.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x7a8aa0, transparent: true, opacity: 0.55 })));
      pose();
    };

    // The moment: its angle to the air, its bank, the forces and the air, redrawn as the flight goes on.
    const pose = () => {
      const p = live.current;
      const { af } = p;
      clear(forces); clear(air);
      const bank = p.bank ?? 0;
      const gamma = p.gamma ?? 0;
      // Pitched nose-up about the span and rolled onto its side, the air still coming straight at it.
      plane.rotation.set(bank, 0, p.alpha, 'XYZ');

      // Forces from the centre of gravity, in the air's axes: lift square to
      // the stream, drag along it, weight straight down. One scale for all.
      const unit = (reach * 0.4) / Math.max(1e-6, p.weight);
      const arrow = (dir: THREE.Vector3, n: number, color: number, min = 0.012) => {
        const len = Math.max(min, Math.min(reach * 0.9, n * unit));
        forces.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), len, color, Math.min(0.03, len * 0.3), Math.min(0.018, len * 0.2)));
        return dir.clone().multiplyScalar(len);
      };
      // Lift square to the stream and tipped with the wings; weight straight down,
      // which against a stream climbing at gamma leans back along it.
      tips.lift = arrow(new THREE.Vector3(0, Math.cos(bank), Math.sin(bank)), Math.max(0, p.lift), 0x22c55e);
      // Drag drawn four times over, or it is too short to see.
      tips.drag = arrow(new THREE.Vector3(-1, 0, 0), p.drag * 4, 0xf59e0b);
      tips.weight = arrow(new THREE.Vector3(-Math.sin(gamma), -Math.cos(gamma), 0), p.weight, 0xef4444);

      // The air: rows of specks across the span and above and below it.
      const half = af.span / 2;
      const down = Math.max(-0.45, Math.min(0.45, p.cl * 0.22));
      const swirl = Math.min(1, Math.abs(p.cl)) * 0.6;
      specks = [];
      const x0 = reach * 1.1;
      const x1 = -reach * 1.5;
      for (let iy = -4; iy <= 4; iy++) {
        for (const h of [-0.035, -0.015, 0.012, 0.03]) {
          const z = (iy / 4) * half * 1.25;
          const path: THREE.Vector3[] = [];
          const nearTip = Math.abs(Math.abs(z) - half) < half * 0.22;
          const inside = Math.abs(z) < half;
          for (let i = 0; i <= 60; i++) {
            const x = x0 + ((x1 - x0) * i) / 60;
            let y = h * reach * 4;
            let zz = z;
            // Past the leading edge the stream is turned down across the span.
            const behind = Math.max(0, (af.length * 0.35 - x) / reach);
            if (inside) y -= down * behind * reach * (h > 0 ? 1 : 0.8);
            // Over the top, lifted a little as it meets the wing.
            if (x < af.length * 0.5 && x > -af.length * 0.6 && h > 0) y += 0.004 * Math.max(0, p.cl);
            if (p.stalled && h > 0 && inside && x < 0) y += Math.sin(i * 0.9) * 0.01 + 0.006;
            // Round each tip: a corkscrew that grows behind it.
            if (nearTip && behind > 0) {
              const r = 0.01 + behind * 0.02 * swirl;
              const a = behind * 18 * Math.sign(z);
              y += Math.sin(a) * r * swirl;
              zz += Math.cos(a) * r * swirl * 0.8;
            }
            path.push(new THREE.Vector3(x, y, zz));
          }
          specks.push({ path, phase: Math.random() });
        }
      }
      const pg = new THREE.BufferGeometry();
      pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(specks.length * 3 * 6), 3));
      points = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0x5aa9ff, size: reach * 0.018, transparent: true, opacity: 0.85 }));
      air.add(points);
      // The stream lines themselves, faint.
      for (const s of specks) {
        const lg = new THREE.BufferGeometry().setFromPoints(s.path);
        air.add(new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.16 })));
      }
    };
    const tips: { lift?: THREE.Vector3; drag?: THREE.Vector3; weight?: THREE.Vector3 } = {};

    const view = (dir: Vec3) => {
      const d = new THREE.Vector3(...dir).normalize();
      camera.position.copy(d.multiplyScalar(reach * 2.6));
      controls.target.set(0, 0, 0);
      camera.up.set(0, 1, 0);
      controls.update();
    };
    api.current = { view, rebuild, pose };
    rebuild();
    view(VIEWS[0]![1]);

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
    let last = performance.now();
    const label = (el: Element | undefined, at: THREE.Vector3 | undefined) => {
      if (!el || !at) return;
      const pr = at.clone().project(camera);
      const e = el as HTMLElement;
      e.style.left = `${((pr.x + 1) / 2) * mount.clientWidth}px`;
      e.style.top = `${((1 - pr.y) / 2) * mount.clientHeight}px`;
    };
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // The specks drift at a pace that reads, not at the wind's real speed.
      if (points) {
        const arr = (points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        let k = 0;
        for (const s of specks) {
          // Faster air, faster specks: a throw's rush and a glide's drift read apart.
          const pace = live.current.airSpeed ? Math.min(0.9, Math.max(0.05, 0.18 * (live.current.airSpeed / 5))) : 0.18;
          s.phase = (s.phase + dt * pace) % 1;
          for (let j = 0; j < 6; j++) {
            const t = (s.phase + j / 6) % 1;
            const f = t * (s.path.length - 1);
            const i = Math.floor(f);
            const a = s.path[i]!;
            const b = s.path[Math.min(s.path.length - 1, i + 1)]!;
            const u = f - i;
            arr[k++] = a.x + (b.x - a.x) * u;
            arr[k++] = a.y + (b.y - a.y) * u;
            arr[k++] = a.z + (b.z - a.z) * u;
          }
        }
        points.geometry.getAttribute('position').needsUpdate = true;
      }
      controls.update();
      renderer.render(scene, camera);
      const ls = labelRef.current?.children;
      if (ls) {
        label(ls[0], tips.lift);
        label(ls[1], tips.drag);
        label(ls[2], tips.weight);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      clear(plane); clear(forces); clear(air);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      api.current = null;
    };
  }, []);

  // A new aeroplane rebuilds the model; a new moment only turns it and redraws the air. The camera stays put.
  const { af, drawPlies, alpha, vee, cl, stalled, lift, drag, weight, bank, gamma } = props;
  useEffect(() => { api.current?.rebuild(); }, [af, drawPlies, vee]);
  useEffect(() => { api.current?.pose(); }, [alpha, cl, stalled, lift, drag, weight, bank, gamma]);

  return (
    <div className="tunnel3d">
      <div className="tunnel3d-stage" ref={mountRef}>
        <div className="tunnel3d-labels" ref={labelRef}>
          <span className="lift">{props.labels.lift}</span>
          <span className="drag">{props.labels.drag}</span>
          <span className="weight">{props.labels.weight}</span>
        </div>
        <span className="tunnel3d-note">바람은 코 쪽에서 불어와요 · 끌어서 돌려 볼 수 있어요</span>
        {Math.abs(props.cm) >= 0.004 && (
          <span className={`tunnel3d-pitch ${props.cm > 0 ? 'up' : 'down'}`}>
            {props.cm > 0 ? '↺ 머리를 드는 힘' : '↻ 머리를 숙이는 힘'}
          </span>
        )}
      </div>
      <div className="flight-choices tunnel3d-views">
        {VIEWS.map(([name, dir]) => (
          <button key={name} className={viewName === name ? 'on' : ''}
            onClick={() => { setViewName(name); api.current?.view(dir); }}>{name}</button>
        ))}
      </div>
    </div>
  );
}
