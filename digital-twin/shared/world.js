

import { DEFAULT_PARAMS, createState, step, clamp, DEG } from './ackermann.js';
import { FAILSAFE_MS, encodeVehicle } from './protocol.js';

const COLORS = ['#f97316', '#22d3ee', '#a3e635', '#e879f9', '#facc15', '#60a5fa', '#f87171', '#34d399'];
const ARENA = 140; 

// Limits for the user-adjustable vehicle size [m]
export const SIZE_LIMITS = Object.freeze({
  wheelbase: { min: 1.6, max: 4.5 },
  track: { min: 1.0, max: 2.4 },
});

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class World {
  constructor({ params = DEFAULT_PARAMS, failsafeMs = FAILSAFE_MS, clock = now } = {}) {
    this.params = params;
    this.failsafeMs = failsafeMs;
    this.clock = clock;
    this.vehicles = new Map();
    this.tick = 0;
    this.spawnCount = 0;
  }

  addVehicle(id, { name, bot = null, spawn = null } = {}) {
    const n = this.spawnCount++;
    const v = {
      id,
      name: name || `Rover-${String(n + 1).padStart(2, '0')}`,
      color: COLORS[n % COLORS.length],
      state: createState(),
      input: { throttle: 0, steer: 0 },
      lastInput: this.clock(),
      seq: 0,
      ackermann: 1,
      params: { ...this.params },
      failsafe: false,
      bot,
      spawnIndex: n,
      spawn,
    };
    this.respawn(v);
    this.vehicles.set(id, v);
    return v;
  }

  respawn(v) {
    if (v.spawn) {
      Object.assign(v.state, createState(v.spawn.x, v.spawn.z, v.spawn.heading || 0));
      return;
    }
   
    const slot = v.spawnIndex % 8;
    const side = slot % 2 === 0 ? 1 : -1;
    Object.assign(v.state, createState(side * Math.ceil(slot / 2) * 4, -6, 0));
  }

  removeVehicle(id) {
    this.vehicles.delete(id);
  }

  setInput(id, seq, throttle, steer) {
    const v = this.vehicles.get(id);
    if (!v || !(seq > v.seq)) return; // drop stale / duplicate packets
    v.seq = seq;
    v.input.throttle = clamp(Number(throttle) || 0, -1, 1);
    v.input.steer = clamp(Number(steer) || 0, -1, 1);
    v.lastInput = this.clock();
  }

  setConfig(id, { ackermann, wheelbase, track }) {
    const v = this.vehicles.get(id);
    if (!v) return;
    if (Number.isFinite(ackermann)) v.ackermann = clamp(ackermann, -1, 1.5);
    const L = SIZE_LIMITS.wheelbase;
    const W = SIZE_LIMITS.track;
    if (Number.isFinite(wheelbase)) v.params = { ...v.params, wheelbase: clamp(wheelbase, L.min, L.max) };
    if (Number.isFinite(track)) v.params = { ...v.params, track: clamp(track, W.min, W.max) };
  }

  reset(id) {
    const v = this.vehicles.get(id);
    if (v) this.respawn(v);
  }

  step(dt) {
    const t = this.clock();
    for (const v of this.vehicles.values()) {
      let input = v.input;
      if (v.bot) {
        input = v.bot(this.tick * dt, v.state);
        v.failsafe = false;
      } else {
      
        v.failsafe = t - v.lastInput > this.failsafeMs;
        if (v.failsafe) input = { throttle: 0, steer: 0 };
      }
      step(v.state, input, dt, v.params);

     
      const s = v.state;
      if (Math.abs(s.x) > ARENA || Math.abs(s.z) > ARENA) {
        s.x = clamp(s.x, -ARENA, ARENA);
        s.z = clamp(s.z, -ARENA, ARENA);
        s.speed = 0;
      }
    }
    this.tick++;
  }

  snapshot() {
    const vehicles = [];
    for (const v of this.vehicles.values()) vehicles.push(encodeVehicle(v));
    return { t: 'snap', tick: this.tick, time: this.clock(), vehicles };
  }
}


export function figureEightBot({ targetSpeed = 6, steer = 0.6 } = {}) {
  let dir = 1;
  let turned = 0;
  let lastHeading = null;
  return (_t, s) => {
    if (lastHeading !== null) {
      let dh = s.heading - lastHeading;
      if (dh > Math.PI) dh -= 2 * Math.PI;
      if (dh < -Math.PI) dh += 2 * Math.PI;
      turned += Math.abs(dh);
      if (turned >= 2 * Math.PI) { dir = -dir; turned = 0; }
    }
    lastHeading = s.heading;
    return { throttle: clamp((targetSpeed - s.speed) * 0.6, -1, 1), steer: dir * steer };
  };
}

export { ARENA, DEG };
