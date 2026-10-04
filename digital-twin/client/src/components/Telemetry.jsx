const DEG = 180 / Math.PI;
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');
const deg = (rad, d = 1) => `${fmt(rad * DEG, d)}°`;
const rpm = (v, r) => (v / r / (2 * Math.PI)) * 60;

/** Top-down schematic: wheel angles + per-wheel RPM (electronic differential). */
function WheelDiagram({ own, params }) {
  const { angles, speeds } = own;
  const r = params.wheelRadius;
  // vehicle drawn forward-up; vehicle-left is screen-left
  const wheels = [
    { key: 'fl', x: 26, y: 34, a: angles.left },
    { key: 'fr', x: 94, y: 34, a: angles.right },
    { key: 'rl', x: 26, y: 126, a: 0 },
    { key: 'rr', x: 94, y: 126, a: 0 },
  ];
  const maxV = Math.max(...Object.values(speeds).map(Math.abs), 0.01);
  return (
    <svg viewBox="0 0 120 160" className="wheel-diagram" role="img" aria-label="Top view of wheel angles and speeds">
      <rect x="36" y="18" width="48" height="126" rx="10" className="wd-body" />
      <line x1="26" y1="34" x2="94" y2="34" className="wd-axle" />
      <line x1="26" y1="126" x2="94" y2="126" className="wd-axle" />
      {wheels.map((w) => {
        const v = speeds[w.key];
        const share = Math.abs(v) / maxV;
        return (
          <g key={w.key} transform={`translate(${w.x} ${w.y}) rotate(${-w.a * DEG})`}>
            <rect x="-5" y="-13" width="10" height="26" rx="2.5" className="wd-wheel" style={{ opacity: 0.45 + 0.55 * share }} />
          </g>
        );
      })}
      {wheels.map((w) => (
        <text key={`t-${w.key}`} x={w.x} y={w.y + (w.key[0] === 'f' ? -18 : 26)} className="wd-label">
          {fmt(rpm(speeds[w.key], r), 0)}
        </text>
      ))}
      <text x="60" y="84" className="wd-caption">RPM</text>
    </svg>
  );
}

export default function Telemetry({ t }) {
  const own = t?.own;
  if (!own) {
    return (
      <section className="panel telemetry">
        <div className="panel-title">Telemetry</div>
        <p className="muted">Waiting for first snapshot…</p>
      </section>
    );
  }
  const left = own.steer >= 0;
  const inner = left ? own.angles.left : own.angles.right;
  const outer = left ? own.angles.right : own.angles.left;
  const scrub = Math.max(Math.abs(own.scrub.left), Math.abs(own.scrub.right)) * DEG;
  const R = Math.abs(own.radius);

  return (
    <section className="panel telemetry">
      <div className="panel-title">
        <span className="swatch" style={{ background: own.color }} />
        {own.name}
        {own.failsafe && <span className="tag danger">FAILSAFE</span>}
      </div>

      <div className="speed">
        <span className="speed-value">{fmt(Math.abs(own.speed) * 3.6, 0)}</span>
        <span className="speed-unit">km/h{own.speed < -0.05 ? ' · R' : ''}</span>
      </div>

      <div className="telemetry-body">
        <dl className="readouts">
          <dt>Virtual steer δ</dt><dd>{deg(own.steer)}</dd>
          <dt>Handwheel</dt><dd>{deg(own.handwheel, 0)}</dd>
          <dt>Lock limit</dt><dd>±{deg(own.lock)}</dd>
          <dt>Inner wheel</dt><dd>{own.steer === 0 ? '—' : deg(Math.abs(inner))}</dd>
          <dt>Outer wheel</dt><dd>{own.steer === 0 ? '—' : deg(Math.abs(outer))}</dd>
          <dt>Turn radius</dt><dd>{Number.isFinite(R) && R < 999 ? `${fmt(R)} m` : '∞'}</dd>
          <dt>Yaw rate</dt><dd>{fmt(own.yawRate * DEG)}°/s</dd>
          <dt>Tyre scrub</dt>
          <dd className={scrub > 1 ? 'warn' : ''}>{fmt(scrub, 2)}°</dd>
        </dl>
        <WheelDiagram own={own} params={t.params} />
      </div>
    </section>
  );
}
