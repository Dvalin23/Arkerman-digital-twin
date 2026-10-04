// Imperative three.js renderer, owned by the <Viewport> React component.
// React handles UI state; this class owns the GPU resources and the frame loop
// so per-frame updates never trigger React re-renders.

import * as THREE from 'three';
import { VehicleRig } from './vehicleRig.js';
import { derive } from '../../../shared/ackermann.js';

const TRAIL_POINTS = 800;

export class Engine {
  /**
   * @param container  DOM element to mount the canvas in
   * @param link       WsLink | LocalLink
   * @param opts       ref-like { current: { overlay, trail, camera } }
   * @param onTelemetry  called ~10×/s with HUD data
   */
  constructor(container, link, opts, onTelemetry) {
    this.container = container;
    this.link = link;
    this.opts = opts;
    this.onTelemetry = onTelemetry;
    this.rigs = new Map();
    this.frames = 0;
    this.fps = 0;
    this.lastTelemetry = 0;
    this.lastFpsAt = performance.now();

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0d1520');
    scene.fog = new THREE.Fog('#0d1520', 60, 190);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
    this.camera.position.set(0, 4, -12);
    this.camTarget = new THREE.Vector3();
    this.orbit = { yaw: Math.PI * 0.85, pitch: 0.42, dist: 11 };

    this.buildEnvironment();
    this.buildTrail();
    this.bindPointer();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.clock = new THREE.Clock();
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  buildEnvironment() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#bcd7ff', '#1b2330', 1.4));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(18, 30, -10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -25; c.right = 25; c.top = 25; c.bottom = -25; c.near = 1; c.far = 90;
    sun.shadow.bias = -0.0005;
    s.add(sun, sun.target);
    this.sun = sun;

    // test pad
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshStandardMaterial({ color: '#1a222d', roughness: 0.95 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    s.add(ground);

    const minor = new THREE.GridHelper(300, 300, '#233040', '#1f2a37');
    minor.position.y = 0.002;
    const major = new THREE.GridHelper(300, 30, '#2f4157', '#2f4157');
    major.position.y = 0.004;
    s.add(minor, major);

    // start line
    const start = new THREE.Mesh(new THREE.PlaneGeometry(36, 0.4), new THREE.MeshBasicMaterial({ color: '#e2e8f0' }));
    start.rotation.x = -Math.PI / 2;
    start.position.set(0, 0.006, -3);
    s.add(start);

    // cones: slalom straight ahead, skid-pad ring on the right, gate on the left
    const coneGeo = new THREE.ConeGeometry(0.22, 0.62, 18);
    coneGeo.translate(0, 0.31, 0);
    const coneMat = new THREE.MeshStandardMaterial({ color: '#f97316', roughness: 0.5 });
    const addCone = (x, z) => {
      const m = new THREE.Mesh(coneGeo, coneMat);
      m.position.set(x, 0, z);
      m.castShadow = true;
      s.add(m);
    };
    for (let i = 0; i < 8; i++) addCone(0, 14 + i * 9);
    const pad = { x: -24, z: 18 };
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      addCone(pad.x + Math.cos(a) * 9, pad.z + Math.sin(a) * 9);
      if (i % 2 === 0) addCone(pad.x + Math.cos(a) * 4.2, pad.z + Math.sin(a) * 4.2);
    }
    for (let i = 0; i < 6; i++) { addCone(22 + i * 3, 20); addCone(22 + i * 3, 25); }

    // painted skid-pad circle
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(6.4, 6.6, 96),
      new THREE.MeshBasicMaterial({ color: '#334155', side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pad.x, 0.005, pad.z);
    s.add(ring);
  }

  buildTrail() {
    const geo = new THREE.BufferGeometry();
    this.trailPositions = new Float32Array(TRAIL_POINTS * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    geo.setDrawRange(0, 0);
    this.trail = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: '#22d3ee', transparent: true, opacity: 0.7 }));
    this.trail.frustumCulled = false;
    this.trailCount = 0;
    this.scene.add(this.trail);
  }

  pushTrail(x, z) {
    const n = this.trailCount;
    const a = this.trailPositions;
    if (n > 0) {
      const lx = a[(n - 1) * 3];
      const lz = a[(n - 1) * 3 + 2];
      const d = Math.hypot(x - lx, z - lz);
      if (d < 0.2) return;
      if (d > 8) { this.trailCount = 0; return this.pushTrail(x, z); } // respawn → restart
    }
    if (n >= TRAIL_POINTS) {
      a.copyWithin(0, 3);
      this.trailCount = TRAIL_POINTS - 1;
    }
    const i = this.trailCount++;
    a[i * 3] = x; a[i * 3 + 1] = 0.03; a[i * 3 + 2] = z;
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trailCount);
  }

  clearTrail() {
    this.trailCount = 0;
    this.trail.geometry.setDrawRange(0, 0);
  }

  bindPointer() {
    const el = this.renderer.domElement;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
      if (this.opts.current.camera !== 'orbit') return;
      this.orbit.yaw -= dx * 0.008;
      this.orbit.pitch = Math.min(1.45, Math.max(0.08, this.orbit.pitch + dy * 0.006));
    });
    const end = () => { drag = null; };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => {
      if (this.opts.current.camera !== 'orbit') return;
      e.preventDefault();
      this.orbit.dist = Math.min(60, Math.max(4, this.orbit.dist * (1 + Math.sign(e.deltaY) * 0.1)));
    }, { passive: false });
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  syncRigs(vehicles) {
    const ownId = this.link.id;
    for (const [id, v] of vehicles) {
      let rig = this.rigs.get(id);
      if (!rig) {
        rig = new VehicleRig(this.link.params, v.color, { withOverlay: id === ownId });
        rig.isOwn = id === ownId;
        this.rigs.set(id, rig);
        this.scene.add(rig.root);
      }
    }
    for (const [id, rig] of this.rigs) {
      if (!vehicles.has(id) || rig.isOwn !== (id === ownId)) {
        this.scene.remove(rig.root);
        rig.dispose();
        this.rigs.delete(id);
      }
    }
  }

  updateCamera(own, dt) {
    const mode = this.opts.current.camera;
    const target = new THREE.Vector3(own ? own.x : 0, 0, own ? own.z : 0);
    const h = own ? own.h : 0;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    let desired;
    let look;
    if (mode === 'top') {
      desired = target.clone().add(new THREE.Vector3(0, 34, -0.01));
      look = target;
    } else if (mode === 'orbit') {
      const { yaw, pitch, dist } = this.orbit;
      desired = target.clone().add(new THREE.Vector3(
        Math.sin(yaw) * Math.cos(pitch) * dist,
        Math.sin(pitch) * dist,
        Math.cos(yaw) * Math.cos(pitch) * dist,
      ));
      look = target.clone().add(new THREE.Vector3(0, 0.8, 0));
    } else {
      // chase: behind and above, looking a little ahead of the car
      desired = target.clone().addScaledVector(fwd, -7.5).add(new THREE.Vector3(0, 3.4, 0));
      look = target.clone().addScaledVector(fwd, 3).add(new THREE.Vector3(0, 0.9, 0));
    }
    const k = mode === 'orbit' ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(desired, k);
    this.camTarget.lerp(look, mode === 'orbit' ? 1 : 1 - Math.exp(-dt * 8));
    if (mode === 'top') this.camera.up.set(0, 0, 1);
    else this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camTarget);

    // keep the shadow frustum centred on the action
    this.sun.position.set(target.x + 18, 30, target.z - 10);
    this.sun.target.position.copy(target);
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();
    const vehicles = this.link.buffer.sample(now);
    this.syncRigs(vehicles);

    const o = this.opts.current;
    const own = vehicles.get(this.link.id);
    for (const [id, v] of vehicles) {
      this.rigs.get(id)?.update(v, dt, o.overlay && id === this.link.id);
    }
    if (own) this.pushTrail(own.x, own.z);
    this.trail.visible = o.trail;
    if (o.clearTrail) { this.clearTrail(); o.clearTrail = false; }

    this.updateCamera(own, dt);
    this.renderer.render(this.scene, this.camera);

    this.frames++;
    if (now - this.lastFpsAt >= 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.lastFpsAt));
      this.frames = 0;
      this.lastFpsAt = now;
    }
    if (now - this.lastTelemetry > 100) {
      this.lastTelemetry = now;
      this.emitTelemetry(own, vehicles.size);
    }
  }

  emitTelemetry(own, count) {
    const link = this.link;
    const base = {
      status: link.status,
      kind: link.kind,
      rtt: link.rtt,
      snapRate: link.buffer.rate,
      fps: this.fps,
      vehicles: count,
      params: link.params,
    };
    if (!own) { this.onTelemetry({ ...base, own: null }); return; }
    const d = derive({ speed: own.v, steer: own.d }, link.params, own.a ?? 1);
    this.onTelemetry({
      ...base,
      own: {
        name: own.name,
        color: own.color,
        speed: own.v,
        steer: own.d,
        ackermann: own.a ?? 1,
        failsafe: !!own.fs,
        seq: own.seq,
        x: own.x,
        z: own.z,
        heading: own.h,
        ...d,
      },
    });
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    for (const rig of this.rigs.values()) rig.dispose();
    this.scene.traverse((obj) => {
      obj.geometry?.dispose();
      if (obj.material) [].concat(obj.material).forEach((m) => m.dispose());
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
