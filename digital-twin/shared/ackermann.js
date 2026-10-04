
export const DEG = Math.PI / 180;
const EPS = 1e-6;

export const DEFAULT_PARAMS = Object.freeze({
  wheelbase: 2.6,         
  track: 1.6,              
  wheelRadius: 0.34,       
  wheelWidth: 0.26,        
  maxSteer: 35 * DEG,     
  steerRate: 70 * DEG,    
  steeringRatio: 15,      
  maxLatAccel: 6.5,        
  maxSpeed: 16,           
  maxReverse: 5,          
  accel: 4.5,              
  brake: 9,                
  rolling: 0.35,           
  aero: 0.004,            
});

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

export function createState(x = 0, z = 0, heading = 0) {
  return { x, z, heading, speed: 0, steer: 0 };
}

/** Signed turn radius of the rear-axle centre. +left, −right, Infinity when straight. */
export function turnRadius(steer, p = DEFAULT_PARAMS) {
  if (Math.abs(steer) < EPS) return Infinity;
  return p.wheelbase / Math.tan(steer);
}


 
export function wheelAngles(steer, p = DEFAULT_PARAMS, ackermann = 1) {
  if (Math.abs(steer) < EPS) {
    return { left: 0, right: 0, idealLeft: 0, idealRight: 0 };
  }
  const R = turnRadius(steer, p);
  const h = p.track / 2;
  const L = p.wheelbase;
  const idealLeft = Math.atan(L / (R - h));
  const idealRight = Math.atan(L / (R + h));
  return {
    left: steer + ackermann * (idealLeft - steer),
    right: steer + ackermann * (idealRight - steer),
    idealLeft,
    idealRight,
  };
}


export function wheelSpeeds(speed, steer, p = DEFAULT_PARAMS) {
  const R = turnRadius(steer, p);
  if (!Number.isFinite(R)) return { fl: speed, fr: speed, rl: speed, rr: speed };
  const h = p.track / 2;
  const L = p.wheelbase;
  const absR = Math.abs(R);
  return {
    rl: (speed * Math.abs(R - h)) / absR,
    rr: (speed * Math.abs(R + h)) / absR,
    fl: (speed * Math.hypot(R - h, L)) / absR,
    fr: (speed * Math.hypot(R + h, L)) / absR,
  };
}


export function derive(state, p = DEFAULT_PARAMS, ackermann = 1) {
  const R = turnRadius(state.steer, p);
  const angles = wheelAngles(state.steer, p, ackermann);
  return {
    radius: R,
    yawRate: (state.speed * Math.tan(state.steer)) / p.wheelbase,
    angles,
    scrub: {
      left: angles.left - angles.idealLeft,
      right: angles.right - angles.idealRight,
    },
    speeds: wheelSpeeds(state.speed, state.steer, p),
    handwheel: state.steer * p.steeringRatio,
    lock: steerLimit(state.speed, p),
  };
}


export function steerLimit(speed, p = DEFAULT_PARAMS) {
  const v2 = speed * speed;
  if (!p.maxLatAccel || v2 < 1e-6) return p.maxSteer;
  return Math.min(p.maxSteer, Math.atan((p.wheelbase * p.maxLatAccel) / v2));
}


export function step(state, input, dt, p = DEFAULT_PARAMS) {
  
  const lock = steerLimit(state.speed, p);
  const target = clamp(input.steer || 0, -1, 1) * lock;
  const maxDelta = p.steerRate * dt;
  state.steer = clamp(state.steer + clamp(target - state.steer, -maxDelta, maxDelta), -p.maxSteer, p.maxSteer);

 
  const th = clamp(input.throttle || 0, -1, 1);
  const v = state.speed;
  let a = 0;
  let braking = false;
  if (th > 0) {
    braking = v < -EPS;
    a = th * (braking ? p.brake : p.accel);
  } else if (th < 0) {
    braking = v > EPS;
    a = th * (braking ? p.brake : p.accel);
  }
  let nv = v + a * dt;
  
  if (braking && Math.sign(nv) !== Math.sign(v)) nv = 0;

  const resist = (p.rolling + p.aero * nv * nv) * dt;
  nv = Math.abs(nv) <= resist ? 0 : nv - Math.sign(nv) * resist;
  state.speed = clamp(nv, -p.maxReverse, p.maxSpeed);

 
  const yawRate = (state.speed * Math.tan(state.steer)) / p.wheelbase;
  const midHeading = state.heading + yawRate * dt * 0.5; // midpoint integration
  state.x += state.speed * Math.sin(midHeading) * dt;
  state.z += state.speed * Math.cos(midHeading) * dt;
  state.heading = wrapAngle(state.heading + yawRate * dt);
  return state;
}


export function icrWorld(state, p = DEFAULT_PARAMS) {
  const R = turnRadius(state.steer, p);
  if (!Number.isFinite(R)) return null;
 
  return { x: state.x + R * Math.cos(state.heading), z: state.z - R * Math.sin(state.heading) };
}
