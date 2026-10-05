

export const TICK_HZ = 60;       
export const SNAP_HZ = 30;       
export const INPUT_HZ = 30;      
export const FAILSAFE_MS = 500; 
export const DEFAULT_PORT = 8080;
export const MAX_CLIENTS = 16;

const r3 = (n) => Math.round(n * 1000) / 1000;

export function encodeVehicle(v) {
  return {
    id: v.id,
    name: v.name,
    color: v.color,
    x: r3(v.state.x),
    z: r3(v.state.z),
    h: r3(v.state.heading),
    v: r3(v.state.speed),
    d: Math.round(v.state.steer * 1e4) / 1e4,
    a: v.ackermann,
    wb: v.params.wheelbase,
    tr: v.params.track,
    seq: v.seq,
    fs: v.failsafe ? 1 : 0,
  };
}
