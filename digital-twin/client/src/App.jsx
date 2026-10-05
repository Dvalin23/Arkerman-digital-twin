import { useCallback, useEffect, useRef, useState } from 'react';
import Joystick from './components/Joystick.jsx';
import Telemetry from './components/Telemetry.jsx';
import { Engine } from './lib/engine.js';
import { WsLink, LocalLink } from './lib/link.js';
import { INPUT_HZ } from '../../shared/protocol.js';


const ENV = import.meta.env || {};
const STANDALONE = !!ENV.VITE_STANDALONE;

function defaultServerUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (ENV.DEV || !location.host) return `ws://${location.hostname || 'localhost'}:8080`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

const isPhone = () => window.matchMedia('(max-width: 760px), (max-height: 500px)').matches;

const CAMERAS = [
  ['chase', 'Chase'],
  ['orbit', 'Orbit'],
  ['top', 'Top'],
];

function ackermannLabel(p) {
  if (p >= 0.995 && p <= 1.005) return 'Pure Ackermann';
  if (Math.abs(p) < 0.005) return 'Parallel steer';
  if (p < 0) return 'Anti-Ackermann';
  return p > 1 ? 'Over-Ackermann' : 'Partial Ackermann';
}

export default function App() {
  const [mode, setMode] = useState(STANDALONE ? 'local' : 'server');
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [link, setLink] = useState(null);
  const [telemetry, setTelemetry] = useState(null);
  const [notice, setNotice] = useState(null);
  const [overlay, setOverlay] = useState(true);
  const [trail, setTrail] = useState(true);
  const [camera, setCamera] = useState('chase');
  const [ackermann, setAckermann] = useState(1);
  const [latency, setLatency] = useState(60);
  // On phones both panels start closed so the car stays visible, and only one opens at a time.
  const [controlsOpen, setControlsOpen] = useState(() => !isPhone());
  const [detailsOpen, setDetailsOpen] = useState(() => !isPhone());
  const toggleControls = () => {
    const next = !controlsOpen;
    setControlsOpen(next);
    if (next && isPhone()) setDetailsOpen(false);
  };
  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    if (next && isPhone()) setControlsOpen(false);
  };

  const viewportRef = useRef(null);
  const opts = useRef({ overlay, trail, camera, clearTrail: false });
  opts.current.overlay = overlay;
  opts.current.trail = trail;
  opts.current.camera = camera;

  // ---- link lifecycle -------------------------------------------------------
  useEffect(() => {
    let l;
    if (mode === 'server') {
      l = new WsLink(serverUrl);
      const off = l.on('disconnect', ({ everConnected }) => {
        if (!everConnected) {
          setNotice(`Couldn't reach ${serverUrl}. Running the in-browser twin instead.`);
          setMode('local');
        }
      });
      l.on('welcome', () => setNotice(null));
      setLink(l);
      return () => { off(); l.close(); };
    }
    l = new LocalLink({ latencyMs: latency });
    setLink(l);
    return () => l.close();
    // latency is applied live below; don't rebuild the world when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, serverUrl]);

  useEffect(() => { link?.setLatency?.(latency); }, [link, latency]);
  useEffect(() => { link?.setAckermann(ackermann); }, [link, ackermann]);

  // ---- 3D engine --------------------------------------------------------------
  useEffect(() => {
    if (!link || !viewportRef.current) return;
    const engine = new Engine(viewportRef.current, link, opts, setTelemetry);
    opts.current.clearTrail = true;
    return () => engine.dispose();
  }, [link]);

  // ---- operator input: joystick + keyboard, streamed at INPUT_HZ ------------
  const joy = useRef({ x: 0, y: 0, active: false });
  const keys = useRef(new Set());
  const onJoy = useCallback((v) => { joy.current = v; }, []);

  useEffect(() => {
    const map = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
    const down = (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type === 'text') return;
      if (map[e.code]) { keys.current.add(map[e.code]); e.preventDefault(); }
      if (e.code === 'KeyR' && !e.repeat) { link?.reset(); opts.current.clearTrail = true; }
      if (e.code === 'KeyC' && !e.repeat) setCamera((c) => CAMERAS[(CAMERAS.findIndex(([k]) => k === c) + 1) % CAMERAS.length][0]);
    };
    const up = (e) => { if (map[e.code]) keys.current.delete(map[e.code]); };
    const blur = () => keys.current.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [link]);

  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => {
      const k = keys.current;
      let throttle = (k.has('up') ? 1 : 0) - (k.has('down') ? 1 : 0);
      let steer = (k.has('left') ? 1 : 0) - (k.has('right') ? 1 : 0);
      if (joy.current.active) {
        throttle = joy.current.y;
        steer = -joy.current.x; // stick right → negative (right-hand) steer
      }
      link.sendInput(throttle, steer);
    }, 1000 / INPUT_HZ);
    return () => clearInterval(timer);
  }, [link]);

  // ---- UI -------------------------------------------------------------------
  const t = telemetry;
  const statusText = !t ? 'Starting…'
    : t.kind === 'local' ? 'Local twin'
      : t.status === 'online' ? 'Server online'
        : t.status === 'connecting' ? 'Connecting…' : 'Offline — retrying';
  const statusClass = !t ? 'idle' : t.kind === 'local' ? 'local' : t.status;

  const connect = (e) => {
    e.preventDefault();
    setNotice(null);
    setServerUrl(urlDraft.trim());
    setMode('server');
  };

  return (
    <div className="app">
      <div ref={viewportRef} className="viewport" />

      <div className="hud-left">
        <div className="mini-hud">
          <span className={`badge-dot ${statusClass}`} title={statusText} />
          {!detailsOpen && t?.own && (
            <span className="mini-read">
              <b>{Math.round(Math.abs(t.own.speed) * 3.6)}</b> km/h
              <span className="mini-steer">
                <span className="mini-sep">·</span>
                δ {(t.own.steer * 180 / Math.PI).toFixed(0)}°
              </span>
              <span className="mini-sep">·</span>
              R {Number.isFinite(t.own.radius) && Math.abs(t.own.radius) < 999 ? `${Math.abs(t.own.radius).toFixed(1)} m` : '∞'}
            </span>
          )}
          <button className="mini-toggle" onClick={toggleDetails} aria-expanded={detailsOpen}>
            {detailsOpen ? 'Hide' : 'Data'}
          </button>
        </div>
        <div className={`details${detailsOpen ? ' open' : ''}`}>
        <section className="panel status">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <div>
              <h1>Ackermann Twin</h1>
              <p className="muted small">Browser digital twin · kinematic rover</p>
            </div>
          </div>
          <div className={`badge ${statusClass}`}><span className="dot" />{statusText}</div>
          <dl className="stats">
            <div><dt>RTT</dt><dd>{t?.rtt != null ? `${Math.round(t.rtt)} ms` : '—'}</dd></div>
            <div><dt>Snaps/s</dt><dd>{t?.snapRate ?? '—'}</dd></div>
            <div><dt>FPS</dt><dd>{t?.fps || '—'}</dd></div>
            <div><dt>Rovers</dt><dd>{t?.vehicles ?? '—'}</dd></div>
          </dl>
        </section>
        <Telemetry t={t} />
        </div>
      </div>

      <div className="hud-right">
        <button className="panel-toggle" onClick={toggleControls} aria-expanded={controlsOpen}>
          {controlsOpen ? (isPhone() ? 'Close' : 'Hide controls') : 'Controls'}
        </button>
        {controlsOpen && (
          <section className="panel controls">
            <div className="field">
              <span className="label">Camera <kbd>C</kbd></span>
              <div className="segmented" role="radiogroup" aria-label="Camera">
                {CAMERAS.map(([k, label]) => (
                  <button key={k} role="radio" aria-checked={camera === k} className={camera === k ? 'on' : ''} onClick={() => setCamera(k)}>{label}</button>
                ))}
              </div>
            </div>

            <div className="field">
              <span className="label">Steering geometry</span>
              <input
                type="range" min={-0.5} max={1.25} step={0.05} value={ackermann}
                onChange={(e) => setAckermann(Number(e.target.value))}
                aria-label="Ackermann percentage"
              />
              <div className="range-meta">
                <span>{Math.round(ackermann * 100)}%</span>
                <span className="muted">{ackermannLabel(ackermann)}</span>
              </div>
            </div>

            <label className="check"><input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} /> ICR &amp; axle lines</label>
            <label className="check"><input type="checkbox" checked={trail} onChange={(e) => setTrail(e.target.checked)} /> Path trail</label>

            {mode === 'local' && (
              <div className="field">
                <span className="label">Simulated network RTT</span>
                <input type="range" min={0} max={400} step={10} value={latency} onChange={(e) => setLatency(Number(e.target.value))} aria-label="Simulated latency" />
                <div className="range-meta"><span>{latency} ms</span><span className="muted">interp buffer 100 ms</span></div>
              </div>
            )}

            <div className="row">
              <button className="btn" onClick={() => { link?.reset(); opts.current.clearTrail = true; }}>Respawn <kbd>R</kbd></button>
              <button className="btn ghost" onClick={() => { opts.current.clearTrail = true; }}>Clear trail</button>
            </div>

            {!STANDALONE ? (
              <form className="field server" onSubmit={connect}>
                <span className="label">WebSocket server</span>
                <input type="text" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} spellCheck={false} aria-label="Server URL" />
                <div className="row">
                  <button className="btn" type="submit">Connect</button>
                  <button className="btn ghost" type="button" onClick={() => { setNotice(null); setMode('local'); }} disabled={mode === 'local'}>Use local twin</button>
                </div>
              </form>
            ) : (
              <p className="muted small">
                This demo runs the same physics as the Node.js server inside your browser, with a simulated network. Run the repo locally to drive over a real WebSocket link.
              </p>
            )}
          </section>
        )}
      </div>

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button className="btn ghost" onClick={() => setNotice(null)} aria-label="Dismiss">✕</button>
        </div>
      )}

      <div className="hint muted small">
        <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> drive · drag in Orbit view
      </div>

      <div className="joystick-wrap">
        <Joystick onChange={onJoy} />
      </div>
    </div>
  );
}
