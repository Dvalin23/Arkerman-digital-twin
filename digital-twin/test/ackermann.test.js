import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PARAMS as P, DEG, createState, step, steerLimit, wheelAngles, wheelSpeeds, turnRadius, icrWorld, derive,
} from '../shared/ackermann.js';
import { World, figureEightBot } from '../shared/world.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

test('ideal Ackermann satisfies cot(δo) − cot(δi) = W/L for any steer', () => {
  for (const deg of [2, 10, 20, 35, -5, -20, -35]) {
    const { left, right } = wheelAngles(deg * DEG, P, 1);
    const [inner, outer] = deg > 0 ? [left, right] : [right, left];
    assert.ok(Math.abs(inner) > Math.abs(outer), 'inner wheel steers more');
    const lhs = 1 / Math.tan(Math.abs(outer)) - 1 / Math.tan(Math.abs(inner));
    close(lhs, P.track / P.wheelbase, 1e-9, `at ${deg}°`);
  }
});

test('parallel steer (0 %) puts both wheels at the virtual angle', () => {
  const a = wheelAngles(20 * DEG, P, 0);
  close(a.left, 20 * DEG, 1e-12);
  close(a.right, 20 * DEG, 1e-12);
});

test('every axle line passes through the ICR at 100 % Ackermann', () => {
  const steer = 25 * DEG;
  const R = turnRadius(steer, P);
  const { left, right } = wheelAngles(steer, P, 1);
  const h = P.track / 2;
  // front wheel axle line hits the rear-axle line at x = x_i + L / tan(δ_i)
  close(h + P.wheelbase / Math.tan(left), R, 1e-9, 'left');
  close(-h + P.wheelbase / Math.tan(right), R, 1e-9, 'right');
});

test('straight-line driving keeps heading and lateral position', () => {
  const s = createState();
  for (let i = 0; i < 600; i++) step(s, { throttle: 1, steer: 0 }, 1 / 60);
  close(s.heading, 0, 1e-12);
  close(s.x, 0, 1e-9);
  assert.ok(s.z > 50, `moved forward, z=${s.z}`);
  assert.ok(s.speed <= P.maxSpeed);
});

test('constant steer traces a circle of radius L/tan(δ) about the ICR', () => {
  const s = createState();
  const dt = 1 / 60;
  // settle steering and speed
  for (let i = 0; i < 300; i++) step(s, { throttle: (5 - s.speed) * 0.8, steer: 0.5 }, dt);
  const centre = icrWorld(s, P);
  const R = Math.abs(turnRadius(s.steer, P));
  for (let i = 0; i < 1200; i++) {
    step(s, { throttle: (5 - s.speed) * 0.8, steer: 0.5 }, dt);
    close(Math.hypot(s.x - centre.x, s.z - centre.z), R, R * 0.005, 'radius drift');
  }
});

test('positive steer turns left (heading increases, moves toward +X)', () => {
  const s = createState();
  for (let i = 0; i < 120; i++) step(s, { throttle: 1, steer: 1 }, 1 / 60);
  assert.ok(s.heading > 0);
  assert.ok(s.x > 0);
});

test('steering actuator is slew-rate limited', () => {
  const s = createState();
  step(s, { throttle: 0, steer: 1 }, 0.1);
  close(s.steer, P.steerRate * 0.1, 1e-12);
});

test('braking stops without rolling into reverse, then reverse engages', () => {
  const s = createState();
  s.speed = 3;
  let crossed = false;
  for (let i = 0; i < 60; i++) {
    const before = s.speed;
    step(s, { throttle: -1, steer: 0 }, 1 / 60);
    if (before > 0 && s.speed < 0) crossed = true;
  }
  assert.equal(crossed, false, 'never jumps from + to − in one step');
  assert.ok(s.speed < 0, 'reverses after stopping');
  assert.ok(s.speed >= -P.maxReverse);
});

test('coasting decelerates to exactly zero', () => {
  const s = createState();
  s.speed = 2;
  for (let i = 0; i < 2000; i++) step(s, { throttle: 0, steer: 0 }, 1 / 60);
  assert.equal(s.speed, 0);
});

test('wheel speeds: rear average equals body speed, outer > inner, fronts fastest', () => {
  const w = wheelSpeeds(10, 20 * DEG, P); // left turn → left is inner
  close((w.rl + w.rr) / 2, 10, 1e-9);
  assert.ok(w.rr > w.rl && w.fr > w.fl);
  assert.ok(w.fl > w.rl && w.fr > w.rr);
  const straight = wheelSpeeds(10, 0, P);
  assert.deepEqual(straight, { fl: 10, fr: 10, rl: 10, rr: 10 });
});

test('derive() reports zero scrub at 100 % and non-zero at parallel steer', () => {
  const s = { ...createState(), steer: 20 * DEG, speed: 5 };
  const ideal = derive(s, P, 1);
  close(ideal.scrub.left, 0, 1e-12);
  const parallel = derive(s, P, 0);
  assert.ok(Math.abs(parallel.scrub.left) > 1 * DEG);
  close(ideal.handwheel, 20 * DEG * P.steeringRatio, 1e-12);
});

test('world failsafe cuts throttle when inputs stop', () => {
  let t = 0;
  const world = new World({ clock: () => t, failsafeMs: 500 });
  const v = world.addVehicle('a');
  world.setInput('a', 1, 1, 0);
  for (let i = 0; i < 60; i++) { t += 1000 / 60; world.step(1 / 60); }
  assert.equal(v.failsafe, true, 'engaged after 1 s of silence');
  const vAtFailsafe = v.state.speed;
  for (let i = 0; i < 600; i++) { t += 1000 / 60; world.step(1 / 60); }
  assert.ok(v.state.speed < vAtFailsafe);
  world.setInput('a', 2, 0, 0);
  world.step(1 / 60);
  assert.equal(v.failsafe, false, 'releases on fresh input');
});

test('world drops stale input packets', () => {
  const world = new World();
  const v = world.addVehicle('a');
  world.setInput('a', 5, 1, 0);
  world.setInput('a', 4, -1, 0);
  assert.equal(v.input.throttle, 1);
  assert.equal(v.seq, 5);
});

test('figure-eight bot alternates turn direction and holds speed', () => {
  const world = new World();
  const v = world.addVehicle('b', { bot: figureEightBot({ targetSpeed: 6 }) });
  let sawLeft = false, sawRight = false;
  for (let i = 0; i < 60 * 30; i++) {
    world.step(1 / 60);
    if (v.state.steer > 0.1) sawLeft = true;
    if (v.state.steer < -0.1) sawRight = true;
  }
  assert.ok(sawLeft && sawRight);
  close(v.state.speed, 6, 0.6);
});

test('speed-sensitive steer limiter keeps lateral acceleration under the grip limit', () => {
  assert.equal(steerLimit(0, P), P.maxSteer);
  const s = createState();
  for (let i = 0; i < 60 * 8; i++) step(s, { throttle: 1, steer: 1 }, 1 / 60);
  const aLat = (s.speed * s.speed * Math.tan(Math.abs(s.steer))) / P.wheelbase;
  assert.ok(aLat <= P.maxLatAccel + 1e-6, `a_lat ${aLat}`);
  assert.ok(Math.abs(s.steer) < P.maxSteer, 'lock reduced at speed');
});

test('vehicle size is per-vehicle, clamped, and changes the turning circle', () => {
  const world = new World();
  const a = world.addVehicle('a');
  const b = world.addVehicle('b');
  world.setConfig('a', { wheelbase: 4, track: 2 });
  assert.equal(a.params.wheelbase, 4);
  assert.equal(a.params.track, 2);
  assert.equal(b.params.wheelbase, P.wheelbase, 'other vehicles keep their size');
  world.setConfig('a', { wheelbase: 99, track: 0.1 });
  assert.equal(a.params.wheelbase, 4.5);
  assert.equal(a.params.track, 1.0);
  for (const v of [a, b]) { v.state.steer = 20 * DEG; }
  assert.ok(turnRadius(a.state.steer, a.params) > turnRadius(b.state.steer, b.params), 'longer car turns wider');
});

test('wider track needs a bigger inner/outer angle difference', () => {
  const narrow = wheelAngles(20 * DEG, { ...P, track: 1.0 });
  const wide = wheelAngles(20 * DEG, { ...P, track: 2.4 });
  assert.ok(wide.left - wide.right > narrow.left - narrow.right);
});
