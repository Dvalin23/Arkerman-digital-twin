
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

import { World, figureEightBot } from '../shared/world.js';
import { TICK_HZ, SNAP_HZ, DEFAULT_PORT, MAX_CLIENTS, FAILSAFE_MS } from '../shared/protocol.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : process.env[name.toUpperCase()] ?? fallback;
};

export function startServer({ port = DEFAULT_PORT, bots = 0, log = console.log } = {}) {
  const world = new World();
  for (let i = 0; i < bots; i++) {
    world.addVehicle(`bot-${i}`, {
      name: `Auto-${i + 1}`,
      bot: figureEightBot({ targetSpeed: 5 + i, steer: 0.55 + 0.1 * i }),
      spawn: { x: -36 - i * 20, z: 40, heading: 0 },
    });
  }

 
  const distDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tick: world.tick, vehicles: world.vehicles.size }));
      return;
    }
    let file = normalize(join(distDir, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(distDir)) { res.writeHead(403).end(); return; }
    try {
      if (!(await stat(file)).isFile()) throw new Error();
    } catch {
      file = join(distDir, 'index.html'); 
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Client not built. Run `npm run build`, or use `npm run dev` for the Vite dev server.');
    }
  });

 
  const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 });

  wss.on('connection', (ws, req) => {
    if (wss.clients.size > MAX_CLIENTS) {
      ws.send(JSON.stringify({ t: 'error', msg: 'Server full' }));
      ws.close(1013, 'Server full');
      return;
    }
    const id = randomUUID().slice(0, 8);
    const vehicle = world.addVehicle(id);
    ws.isAlive = true;
    log(`[+] ${vehicle.name} (${id}) from ${req.socket.remoteAddress} — ${world.vehicles.size} vehicle(s)`);

    ws.send(JSON.stringify({
      t: 'welcome', id, params: world.params, tickHz: TICK_HZ, snapHz: SNAP_HZ, failsafeMs: FAILSAFE_MS,
    }));

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      switch (m.t) {
        case 'in': world.setInput(id, m.seq, m.th, m.st); break;
        case 'ping': ws.send(JSON.stringify({ t: 'pong', c: m.c, s: performance.now() })); break;
        case 'cfg': world.setConfig(id, m); break;
        case 'reset': world.reset(id); break;
      }
    });

    ws.on('close', () => {
      world.removeVehicle(id);
      log(`[-] ${vehicle.name} (${id}) — ${world.vehicles.size} vehicle(s)`);
    });
  });

  
  const dt = 1 / TICK_HZ;
  let last = performance.now();
  let acc = 0;
  const physics = setInterval(() => {
    const t = performance.now();
    acc += Math.min((t - last) / 1000, 0.25); // clamp to avoid spiral of death after a stall
    last = t;
    while (acc >= dt) { world.step(dt); acc -= dt; }
  }, 1000 / TICK_HZ / 2);

  const broadcast = setInterval(() => {
    if (wss.clients.size === 0) return;
    const frame = JSON.stringify(world.snapshot());
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(frame);
  }, 1000 / SNAP_HZ);

 
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 10000);

  return new Promise((resolve) => {
    server.listen(port, () => {
      const actual = server.address().port;
      log(`Digital twin server on http://localhost:${actual}  (ws://localhost:${actual})  physics ${TICK_HZ} Hz, snapshots ${SNAP_HZ} Hz`);
      resolve({
        port: actual,
        world,
        close: () => new Promise((done) => {
          clearInterval(physics); clearInterval(broadcast); clearInterval(heartbeat);
          for (const ws of wss.clients) ws.terminate();
          wss.close(); server.close(() => done());
        }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  startServer({ port: Number(arg('port', DEFAULT_PORT)), bots: Number(arg('bots', 1)) });
}
