// Transport layer. Both links expose the same surface so the UI and the 3D
// engine never care whether the twin is driven by the remote Node.js server
// or by the in-browser copy of the same simulation.
//
//   link.status      'connecting' | 'online' | 'offline'
//   link.id          own vehicle id (after welcome)
//   link.params      vehicle parameters from the authority
//   link.buffer      SnapshotBuffer (render-side interpolation)
//   link.rtt         smoothed round-trip time [ms]
//   link.sendInput(throttle, steer) / setAckermann(p) / reset() / close()
//   link.on('status' | 'welcome', fn)

import { SnapshotBuffer } from './interpolation.js';
import { World, figureEightBot } from '../../../shared/world.js';
import { TICK_HZ, SNAP_HZ } from '../../../shared/protocol.js';
import { DEFAULT_PARAMS } from '../../../shared/ackermann.js';

class Emitter {
  constructor() { this.handlers = {}; }
  on(evt, fn) {
    (this.handlers[evt] ||= new Set()).add(fn);
    return () => this.handlers[evt].delete(fn);
  }
  emit(evt, data) { this.handlers[evt]?.forEach((fn) => fn(data)); }
}

const smooth = (prev, sample) => (prev == null ? sample : prev * 0.8 + sample * 0.2);

export class WsLink extends Emitter {
  constructor(url) {
    super();
    this.kind = 'server';
    this.url = url;
    this.status = 'connecting';
    this.id = null;
    this.params = DEFAULT_PARAMS;
    this.buffer = new SnapshotBuffer(100);
    this.rtt = null;
    this.seq = 0;
    this.closed = false;
    this.everConnected = false;
    this.backoff = 500;
    this.connect();
    this.pinger = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 1000);
  }

  setStatus(s) {
    if (this.status !== s) { this.status = s; this.emit('status', s); }
  }

  connect() {
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(this.url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.onopen = () => { this.backoff = 500; this.everConnected = true; };
    ws.onmessage = (e) => {
      const now = performance.now();
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'snap') this.buffer.push(m, now);
      else if (m.t === 'welcome') {
        this.id = m.id;
        this.params = m.params;
        this.meta = { tickHz: m.tickHz, snapHz: m.snapHz, failsafeMs: m.failsafeMs };
        this.buffer.clear();
        this.setStatus('online');
        this.emit('welcome', m);
        if (this.ackermann != null) this.send({ t: 'cfg', ackermann: this.ackermann });
      } else if (m.t === 'pong') this.rtt = smooth(this.rtt, now - m.c);
    };
    ws.onclose = () => { this.ws = null; this.setStatus('offline'); this.scheduleReconnect(); };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.emit('disconnect', { everConnected: this.everConnected });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 5000);
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendInput(throttle, steer) { this.send({ t: 'in', seq: ++this.seq, th: +throttle.toFixed(3), st: +steer.toFixed(3) }); }
  setAckermann(p) { this.ackermann = p; this.send({ t: 'cfg', ackermann: p }); }
  reset() { this.send({ t: 'reset' }); }

  close() {
    this.closed = true;
    clearInterval(this.pinger);
    clearTimeout(this.retry);
    this.ws?.close();
  }
}

/**
 * Runs the authoritative World in the browser and mimics the network with a
 * configurable one-way latency — so interpolation, failsafe and seq acks behave
 * exactly as they do against the real server.
 */
export class LocalLink extends Emitter {
  constructor({ latencyMs = 40, bots = 1 } = {}) {
    super();
    this.kind = 'local';
    this.status = 'online';
    this.world = new World();
    this.params = this.world.params;
    this.buffer = new SnapshotBuffer(100);
    this.latency = latencyMs; // round-trip
    this.rtt = latencyMs;
    this.seq = 0;
    this.timers = new Set();
    this.meta = { tickHz: TICK_HZ, snapHz: SNAP_HZ, failsafeMs: this.world.failsafeMs };

    for (let i = 0; i < bots; i++) {
      this.world.addVehicle(`bot-${i}`, {
        name: `Auto-${i + 1}`,
        bot: figureEightBot({ targetSpeed: 5 + i, steer: 0.55 + 0.1 * i }),
        spawn: { x: -36 - i * 20, z: 40, heading: 0 },
      });
    }
    this.id = 'you';
    this.world.addVehicle(this.id, { name: 'Rover-01' });

    const dt = 1 / TICK_HZ;
    let last = performance.now();
    let acc = 0;
    this.physics = setInterval(() => {
      const t = performance.now();
      acc += Math.min((t - last) / 1000, 0.25);
      last = t;
      while (acc >= dt) { this.world.step(dt); acc -= dt; }
    }, 1000 / TICK_HZ / 2);
    this.broadcast = setInterval(() => {
      const snap = this.world.snapshot();
      this.later(() => this.buffer.push(snap, performance.now()));
    }, 1000 / SNAP_HZ);
    queueMicrotask(() => this.emit('welcome', { id: this.id, params: this.params }));
  }

  later(fn) {
    // one-way delay ± 15 % jitter
    const oneWay = (this.latency / 2) * (0.85 + Math.random() * 0.3);
    if (oneWay < 1) { fn(); return; }
    const h = setTimeout(() => { this.timers.delete(h); fn(); }, oneWay);
    this.timers.add(h);
  }

  setLatency(ms) { this.latency = ms; this.rtt = ms; }
  sendInput(throttle, steer) {
    const seq = ++this.seq;
    this.later(() => this.world.setInput(this.id, seq, throttle, steer));
  }
  setAckermann(p) { this.later(() => this.world.setConfig(this.id, { ackermann: p })); }
  reset() { this.later(() => this.world.reset(this.id)); }

  close() {
    clearInterval(this.physics);
    clearInterval(this.broadcast);
    this.timers.forEach(clearTimeout);
  }
}
