// Snapshot interpolation buffer.
//
// The server sends discrete snapshots at 30 Hz with jittery arrival times.
// We render a fixed delay in the past (on the server's clock) and lerp
// between the two snapshots that bracket that instant, giving smooth motion
// at any display refresh rate. Short gaps are bridged by dead-reckoning.

const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => {
  let d = b - a;
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
};
const MAX_EXTRAPOLATE_MS = 150;

export class SnapshotBuffer {
  constructor(delayMs = 100) {
    this.delay = delayMs;
    this.buf = [];
    this.offset = null; // serverClock − clientClock (minus best-case one-way latency)
    this.arrivals = [];
  }

  push(snap, recvNow) {
    const sample = snap.time - recvNow;
    // Track the *largest* sample (least-delayed packet) quickly, drift down slowly.
    if (this.offset === null || sample > this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.01;

    // keep ordered; ignore out-of-order duplicates
    const last = this.buf[this.buf.length - 1];
    if (last && snap.time <= last.time) return;
    this.buf.push(snap);
    if (this.buf.length > 90) this.buf.shift();

    this.arrivals.push(recvNow);
    while (this.arrivals.length && recvNow - this.arrivals[0] > 1000) this.arrivals.shift();
  }

  /** Snapshots received in the last second. */
  get rate() {
    return this.arrivals.length;
  }

  clear() {
    this.buf = [];
    this.offset = null;
    this.arrivals = [];
  }

  /** Interpolated vehicles at client time `now`. Returns Map(id → vehicle). */
  sample(now) {
    const out = new Map();
    const n = this.buf.length;
    if (!n) return out;
    const rt = now + this.offset - this.delay;

    // newest snapshot is older than the render time → dead-reckon forward
    if (rt >= this.buf[n - 1].time) {
      const s = this.buf[n - 1];
      const dt = Math.min(rt - s.time, MAX_EXTRAPOLATE_MS) / 1000;
      for (const v of s.vehicles) {
        out.set(v.id, { ...v, x: v.x + v.v * Math.sin(v.h) * dt, z: v.z + v.v * Math.cos(v.h) * dt });
      }
      return out;
    }
    if (rt <= this.buf[0].time) {
      for (const v of this.buf[0].vehicles) out.set(v.id, { ...v });
      return out;
    }

    let i = n - 2;
    while (i > 0 && this.buf[i].time > rt) i--;
    const a = this.buf[i];
    const b = this.buf[i + 1];
    const t = (rt - a.time) / (b.time - a.time);
    const prev = new Map(a.vehicles.map((v) => [v.id, v]));
    for (const vb of b.vehicles) {
      const va = prev.get(vb.id);
      if (!va) { out.set(vb.id, { ...vb }); continue; }
      out.set(vb.id, {
        ...vb,
        x: lerp(va.x, vb.x, t),
        z: lerp(va.z, vb.z, t),
        h: lerpAngle(va.h, vb.h, t),
        v: lerp(va.v, vb.v, t),
        d: lerp(va.d, vb.d, t),
      });
    }
    return out;
  }
}
