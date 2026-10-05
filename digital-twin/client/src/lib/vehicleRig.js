// Procedural 3D rover with a working Ackermann steering linkage.
//
// Hierarchy (local frame: origin = rear-axle centre on the ground,
// +Z forward, +X left — identical to shared/ackermann.js):
//
//   root (world pose: x, z, heading)
//   ├── body meshes, axle beams, lidar mast
//   ├── wheel[i].pivot   (kingpin — rotation.y = road-wheel angle)
//   │     └── spinner    (rotation.x = rolling angle)
//   │           └── tyre, rim, spokes
//   ├── steering arms (children of front pivots) + tie rod
//   └── overlay           (ICR marker, axle lines, swept-path circles)

import * as THREE from 'three';
import { wheelAngles, wheelSpeeds, turnRadius } from '../../../shared/ackermann.js';

const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.1, ...extra });

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function line(color, points = 2, { dashed = false, opacity = 1 } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points * 3), 3));
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.35, gapSize: 0.2, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const l = new THREE.Line(geo, material);
  l.frustumCulled = false;
  return l;
}

function setSegment(l, ax, ay, az, bx, by, bz) {
  const a = l.geometry.attributes.position;
  a.setXYZ(0, ax, ay, az);
  a.setXYZ(1, bx, by, bz);
  a.needsUpdate = true;
  if (l.material.isLineDashedMaterial) l.computeLineDistances();
}

function unitCircle(color, opacity) {
  const seg = 96;
  const pts = new Float32Array((seg + 1) * 3);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts[i * 3] = Math.cos(a);
    pts[i * 3 + 2] = Math.sin(a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  l.frustumCulled = false;
  return l;
}

export class VehicleRig {
  constructor(params, color, { withOverlay = false } = {}) {
    this.p = params;
    const L = params.wheelbase;
    const h = params.track / 2;
    const r = params.wheelRadius;
    const w = params.wheelWidth;

    this.root = new THREE.Group();
    const bodyMat = mat(color, { roughness: 0.45, metalness: 0.25 });
    const darkMat = mat('#1f2328', { roughness: 0.8 });
    const metalMat = mat('#9aa4b2', { metalness: 0.7, roughness: 0.35 });
    const linkMat = mat('#facc15', { metalness: 0.4, roughness: 0.4, emissive: '#3a2a00' });
    this.bodyMat = bodyMat;

    // --- chassis -----------------------------------------------------------
    const tubLen = L + 1.1;
    // body width follows the track so the wheels stay clear of the body
    const bw = Math.min(1.6, Math.max(0.6, params.track - 0.4));
    this.root.add(box(bw - 0.1, 0.22, tubLen, darkMat, 0, 0.42, L / 2));                // floor pan
    this.root.add(box(bw, 0.3, tubLen - 0.3, bodyMat, 0, 0.66, L / 2));            // body shell
    this.root.add(box(bw, 0.18, 0.7, bodyMat, 0, 0.6, L + 0.42));                  // nose
    const glass = new THREE.MeshStandardMaterial({ color: '#0b1220', roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.85 });
    this.root.add(box(bw - 0.2, 0.42, Math.min(1.2, L * 0.46), glass, 0, 1.02, L / 2 - 0.15));              // cabin
    this.root.add(box(bw - 0.3, 0.22, 0.8, darkMat, 0, 0.92, -0.05));                    // battery pack
    // roll hoop
    for (const s of [-1, 1]) this.root.add(box(0.06, 0.55, 0.06, metalMat, s * (bw / 2 - 0.07), 1.05, L / 2 - 0.8));
    this.root.add(box(bw - 0.09, 0.06, 0.06, metalMat, 0, 1.32, L / 2 - 0.8));

    // lights
    const head = new THREE.MeshStandardMaterial({ color: '#fff7d6', emissive: '#fff2b0', emissiveIntensity: 1.2 });
    const tail = new THREE.MeshStandardMaterial({ color: '#ff3b30', emissive: '#ff1a10', emissiveIntensity: 0.6 });
    this.tailMat = tail;
    for (const s of [-1, 1]) {
      this.root.add(box(0.26, 0.08, 0.04, head, s * bw * 0.32, 0.64, L + 0.78));
      this.root.add(box(0.22, 0.08, 0.04, tail, s * bw * 0.36, 0.7, -0.53));
    }

    // lidar mast — spins so you can see the twin is "alive"
    this.root.add(box(0.05, 0.3, 0.05, metalMat, 0, 1.38, L / 2 + 0.2));
    this.lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.12, 20), darkMat);
    this.lidar.position.set(0, 1.58, L / 2 + 0.2);
    this.lidar.add(box(0.1, 0.05, 0.02, mat('#22d3ee', { emissive: '#0e7490' }), 0, 0, 0.12));
    this.root.add(this.lidar);

    // axle beams
    this.root.add(box(params.track - 0.25, 0.08, 0.08, metalMat, 0, r, 0));
    this.root.add(box(params.track - 0.3, 0.07, 0.07, metalMat, 0, r + 0.02, L));

    // --- wheels ---------------------------------------------------------------
    const tyreGeo = new THREE.CylinderGeometry(r, r, w, 32);
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(r * 0.6, r * 0.6, w + 0.02, 24);
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = new THREE.BoxGeometry(w + 0.04, r * 1.15, 0.07);
    const tyreMat = mat('#16181c', { roughness: 0.95 });
    const spokeMat = mat(color, { metalness: 0.3 });

    const spec = [
      ['fl', h, L, true], ['fr', -h, L, true],
      ['rl', h, 0, false], ['rr', -h, 0, false],
    ];
    this.wheels = {};
    for (const [key, x, z, steer] of spec) {
      const pivot = new THREE.Group();
      pivot.position.set(x, r, z);
      const spinner = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, tyreMat);
      tyre.castShadow = true;
      spinner.add(tyre);
      spinner.add(new THREE.Mesh(rimGeo, metalMat));
      for (let k = 0; k < 3; k++) {
        const spoke = new THREE.Mesh(spokeGeo, spokeMat);
        spoke.rotation.x = (k * Math.PI) / 3;
        spinner.add(spoke);
      }
      pivot.add(spinner);
      this.root.add(pivot);
      this.wheels[key] = { pivot, spinner, x, z, steer, spin: 0 };
    }

    // --- Ackermann linkage -------------------------------------------------
    // Classic layout: steering arms point from each kingpin toward the
    // rear-axle centre; a tie rod joins their ends.
    this.armLen = 0.42;
    const knuckle = 0.2; // arm root sits inboard of the tyre so the linkage is visible
    for (const key of ['fl', 'fr']) {
      const wh = this.wheels[key];
      const kx = -Math.sign(wh.x) * knuckle;
      const dx = -wh.x;
      const dz = -L;
      const n = Math.hypot(dx, dz);
      wh.arm = { x: kx + (dx / n) * this.armLen, z: (dz / n) * this.armLen };
      wh.pivot.add(box(knuckle, 0.07, 0.07, linkMat, kx / 2, 0, 0));
      const armGroup = new THREE.Group();
      armGroup.position.x = kx;
      armGroup.rotation.y = Math.atan2(dx, dz);
      armGroup.add(box(0.05, 0.05, this.armLen, linkMat, 0, 0, this.armLen / 2));
      wh.pivot.add(armGroup);
    }
    const rodGeo = new THREE.BoxGeometry(0.04, 0.04, 1);
    this.tieRod = new THREE.Mesh(rodGeo, linkMat);
    this.tieRod.castShadow = true;
    this.root.add(this.tieRod);

    // --- engineering overlay -------------------------------------------------
    this.overlay = null;
    if (withOverlay) this.buildOverlay();
  }

  buildOverlay() {
    const o = new THREE.Group();
    const y = 0.04;
    this.overlayY = y;
    const icrMat = new THREE.MeshBasicMaterial({ color: '#e879f9', side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.34, 32), icrMat);
    ring.rotation.x = -Math.PI / 2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 8), icrMat);
    pole.position.y = 0.8;
    const icr = new THREE.Group();
    icr.add(ring, pole);
    o.add(icr);

    const axles = {};
    for (const key of ['fl', 'fr', 'rl', 'rr']) {
      axles[key] = line(key[0] === 'f' ? '#22d3ee' : '#94a3b8', 2, { dashed: true });
      o.add(axles[key]);
    }
    const inner = unitCircle('#a3e635', 0.55);
    const outer = unitCircle('#f97316', 0.55);
    o.add(inner, outer);
    this.root.add(o);
    this.overlay = { group: o, icr, axles, inner, outer };
  }

  setColor(color) {
    this.bodyMat.color.set(color);
  }

  /**
   * @param v   interpolated vehicle snapshot { x, z, h, v, d, a }
   * @param dt  frame time [s]
   * @param showOverlay  draw ICR geometry
   */
  update(v, dt, showOverlay = false) {
    const p = this.p;
    this.root.position.set(v.x, 0, v.z);
    this.root.rotation.y = v.h;

    const ang = wheelAngles(v.d, p, v.a ?? 1);
    this.wheels.fl.pivot.rotation.y = ang.left;
    this.wheels.fr.pivot.rotation.y = ang.right;

    // per-wheel rolling speed (electronic differential)
    const sp = wheelSpeeds(v.v, v.d, p);
    for (const key of ['fl', 'fr', 'rl', 'rr']) {
      const wh = this.wheels[key];
      wh.spin = (wh.spin + (sp[key] / p.wheelRadius) * dt) % (Math.PI * 2);
      wh.spinner.rotation.x = wh.spin;
    }

    // tie rod between the two (rotated) steering-arm tips
    const tip = (wh, a) => ({
      x: wh.x + wh.arm.x * Math.cos(a) + wh.arm.z * Math.sin(a),
      z: wh.z - wh.arm.x * Math.sin(a) + wh.arm.z * Math.cos(a),
    });
    const A = tip(this.wheels.fl, ang.left);
    const B = tip(this.wheels.fr, ang.right);
    this.tieRod.position.set((A.x + B.x) / 2, p.wheelRadius, (A.z + B.z) / 2);
    this.tieRod.rotation.y = Math.atan2(B.x - A.x, B.z - A.z);
    this.tieRod.scale.z = Math.hypot(B.x - A.x, B.z - A.z);

    this.lidar.rotation.y += dt * 9;
    this.tailMat.emissiveIntensity = v.v < -0.05 ? 2.2 : 0.6; // brighter in reverse

    if (this.overlay) this.updateOverlay(v, ang, showOverlay);
  }

  updateOverlay(v, ang, show) {
    const o = this.overlay;
    const R = turnRadius(v.d, this.p);
    const visible = show && Number.isFinite(R) && Math.abs(R) < 250;
    o.group.visible = visible;
    if (!visible) return;
    const L = this.p.wheelbase;
    const h = this.p.track / 2;
    const y = this.overlayY;

    o.icr.position.set(R, 0, 0);
    // rear axle lines run along the axle to the ICR
    setSegment(o.axles.rl, h, y, 0, R, y, 0);
    setSegment(o.axles.rr, -h, y, 0, R, y, 0);
    // front axle lines: extend each wheel's spin axis to the rear-axle line.
    // At 100 % Ackermann they converge exactly on the ICR; otherwise they miss
    // and the gap is the tyre scrub you would feel in a real vehicle.
    for (const [key, x, a] of [['fl', h, ang.left], ['fr', -h, ang.right]]) {
      const t = Math.tan(a);
      if (Math.abs(t) < 1e-4) { o.axles[key].visible = false; continue; }
      o.axles[key].visible = true;
      setSegment(o.axles[key], x, y, L, x + L / t, y, 0);
    }
    // swept-path envelope: innermost rear wheel and outermost front wheel
    const rIn = Math.abs(Math.abs(R) - h);
    const rOut = Math.hypot(Math.abs(R) + h, L);
    o.inner.position.set(R, y, 0);
    o.inner.scale.set(rIn, 1, rIn);
    o.outer.position.set(R, y, 0);
    o.outer.scale.set(rOut, 1, rOut);
  }

  dispose() {
    this.root.traverse((obj) => {
      obj.geometry?.dispose();
      if (obj.material) [].concat(obj.material).forEach((m) => m.dispose());
    });
  }
}
