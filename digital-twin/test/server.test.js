import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';

const nextMessage = (ws, pred) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 3000);
  ws.on('message', function on(raw) {
    const m = JSON.parse(raw);
    if (pred(m)) { clearTimeout(timer); ws.off('message', on); resolve(m); }
  });
});

test('client joins, drives forward, sees itself in snapshots, gets pong', async () => {
  const srv = await startServer({ port: 0, bots: 1, log: () => {} });
  try {
    const ws = new WebSocket(`ws://localhost:${srv.port}`);
    const welcome = await nextMessage(ws, (m) => m.t === 'welcome');
    assert.ok(welcome.id && welcome.params.wheelbase > 0);
    assert.equal(welcome.tickHz, 60);

    const first = await nextMessage(ws, (m) => m.t === 'snap');
    assert.equal(first.vehicles.length, 2, 'self + bot');
    const start = first.vehicles.find((v) => v.id === welcome.id);

    let seq = 0;
    const pump = setInterval(() => ws.send(JSON.stringify({ t: 'in', seq: ++seq, th: 1, st: 0 })), 33);
    await new Promise((r) => setTimeout(r, 800));
    const later = await nextMessage(ws, (m) => m.t === 'snap');
    clearInterval(pump);
    const me = later.vehicles.find((v) => v.id === welcome.id);
    assert.ok(me.z - start.z > 0.5, `moved ${me.z - start.z} m`);
    assert.ok(me.v > 1);
    assert.ok(me.seq > 0, 'server acks input sequence');
    assert.equal(me.fs, 0);

    ws.send(JSON.stringify({ t: 'ping', c: 123 }));
    const pong = await nextMessage(ws, (m) => m.t === 'pong');
    assert.equal(pong.c, 123);

    ws.send(JSON.stringify({ t: 'cfg', ackermann: 0.25 }));
    const cfg = await nextMessage(ws, (m) => m.t === 'snap' && m.vehicles.some((v) => v.id === welcome.id && v.a === 0.25));
    assert.ok(cfg);

    ws.send(JSON.stringify({ t: 'cfg', wheelbase: 3.4, track: 2.0 }));
    const geo = await nextMessage(ws, (m) => m.t === 'snap' && m.vehicles.some((v) => v.id === welcome.id && v.wb === 3.4 && v.tr === 2.0));
    assert.ok(geo, 'snapshot carries the new size');

    // stop sending → failsafe engages within ~500 ms
    const fs = await nextMessage(ws, (m) => m.t === 'snap' && m.vehicles.find((v) => v.id === welcome.id)?.fs === 1);
    assert.ok(fs);

    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.world.vehicles.size, 1, 'vehicle removed on disconnect');

    const health = await (await fetch(`http://localhost:${srv.port}/health`)).json();
    assert.equal(health.ok, true);
  } finally {
    await srv.close();
  }
});
