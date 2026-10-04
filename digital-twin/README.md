# Ackermann Twin

A browser-based **digital twin of an Ackermann-steered rover**. No physical chassis is involved. The vehicle is rendered in 3D with React + Three.js, its kinematics are written by hand in JavaScript, and a Node.js WebSocket server runs the authoritative simulation that a virtual joystick drives in real time.

```
 ┌──────────── Browser (React + Three.js) ────────────┐            ┌────────── Node.js server ──────────┐
 │ Joystick / WASD ──► input @30 Hz {seq, th, st} ────┼── ws:// ──►│ World.setInput (drops stale seq)    │
 │                                                    │            │ fixed-step physics @60 Hz           │
 │ SnapshotBuffer ◄── snapshots @30 Hz ◄──────────────┼────────────┤ dead-man failsafe (500 ms)          │
 │  └─ renders 100 ms in the past, lerps, dead-reckons│            │ broadcast World.snapshot()          │
 │ Engine: rover rig, steering linkage, ICR overlay   │            └─────────────────────────────────────┘
 └────────────────────────────────────────────────────┘
              shared/ackermann.js + shared/world.js run on BOTH sides
```

## Run it

```bash
npm install
npm run server     # terminal 1 → ws://localhost:8080  (physics 60 Hz, snapshots 30 Hz, 1 autonomous bot)
npm run dev        # terminal 2 → http://localhost:5173
```

Open several tabs (or phones on your LAN at `http://<your-ip>:5173`); every client gets its own rover and sees the others.

| Command | What it does |
|---|---|
| `npm run server -- --port 9000 --bots 3` | Custom port, more autonomous figure-eight bots |
| `npm start` | Builds the client and serves it **and** the WebSocket from one port (deploy mode) |
| `npm run build:standalone` | Builds a version with no server that runs the world in-browser |
| `npm test` | 16 tests: kinematics, failsafe, protocol, live server round-trip |

If the server can't be reached the client falls back to the **local twin**. It runs the same `World` class in the browser behind a simulated link with adjustable round-trip latency, so interpolation and the failsafe behave the same way. Use `?server=ws://host:port` to point the client at a remote server.

**Controls:** `W A S D` / arrow keys or the on-screen stick · `C` cycles camera (chase / orbit / top) · `R` respawns.

## The engineering

### Kinematics (`shared/ackermann.js`)
Kinematic bicycle model referenced to the rear-axle centre (no lateral slip):

- Turn radius `R = L / tan δ`, yaw rate `ψ̇ = v · tan δ / L`, midpoint-integrated pose.
- **Ackermann wheel angles** `δ_L = atan(L / (R − W/2))`, `δ_R = atan(L / (R + W/2))`, so `cot δ_o − cot δ_i = W/L` holds exactly (tested).
- **Ackermann % blend**: 100 % pure, 0 % parallel steer, negative is anti-Ackermann. The HUD shows the resulting **tyre scrub angle**, and the overlay shows the front axle lines missing the ICR.
- **Electronic differential**: each wheel's ground speed comes from its distance to the ICR, and the HUD shows per-wheel RPM.
- **Actuator realism**: steering slew-rate limit (70°/s), steering ratio 15:1 (handwheel angle), separate drive and brake rates, rolling and aero resistance, and braking that stops before it can reverse.
- **Speed-sensitive lock limiter** caps `δ` so `v²·tan δ / L ≤ a_lat,max`. This keeps the no-slip assumption valid, much like an EPS steering limiter does.

### 3D rig (`client/src/lib/vehicleRig.js`)
Kingpin pivots rotate by the computed Ackermann angles. Spinners roll at each wheel's own speed. Steering arms point at the rear-axle centre (the classic Ackermann trapezoid), and a tie rod joins them every frame. The overlay draws the ICR, all four axle lines, and the swept-path envelope (inner rear wheel and outer front wheel circles).

### Networking (`server/index.js`, `client/src/lib/link.js`, `interpolation.js`)
- The server is authoritative: a fixed timestep with an accumulator, clamped against stalls.
- Inputs carry a sequence number, so stale or reordered packets are dropped, and each snapshot echoes the last applied `seq`.
- **Dead-man failsafe**: 500 ms without input cuts throttle and centres the steering. The HUD flags `FAILSAFE`.
- The client estimates server-clock offset, renders 100 ms behind, interpolates (shortest-path heading lerp), and dead-reckons up to 150 ms through gaps.
- Ping/pong measures RTT. A heartbeat drops half-open sockets. Max 16 clients, 4 KB max frame.

## Layout
```
shared/    ackermann.js (kinematics) · world.js (multi-vehicle sim, bot) · protocol.js
server/    index.js (WebSocket + static hosting)
client/    index.html · src/App.jsx · components/ (Joystick, Telemetry) · lib/ (engine, vehicleRig, link, interpolation)
test/      ackermann.test.js · server.test.js
```

## Ideas for next steps
- Client-side prediction with server reconciliation for the own rover (the `seq` ack is already there).
- Dynamic bicycle model (Pacejka tyre forces) to go beyond the no-slip limit.
- Gamepad API input, record and replay of input streams, and obstacle collision.
- Swap the joystick for a real ROS 2 `/cmd_vel` bridge so the twin mirrors a physical robot.
