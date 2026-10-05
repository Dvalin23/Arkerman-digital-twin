import { useRef, useCallback } from 'react';

/**
 * Virtual analogue stick (mouse, pen, touch).
 * Calls onChange({ x, y }) with x ∈ [−1, 1] right-positive and y ∈ [−1, 1]
 * up-positive. Springs back to centre on release, like a real RC transmitter.
 */
export default function Joystick({ onChange, size: sizeProp, deadzone = 0.08 }) {
  const size = sizeProp ?? (window.matchMedia('(max-width: 760px), (max-height: 500px)').matches ? 124 : 148);
  const baseRef = useRef(null);
  const knobRef = useRef(null);
  const pointer = useRef(null);
  const radius = size / 2 - 26;

  const setKnob = useCallback((dx, dy) => {
    if (knobRef.current) knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  }, []);

  const update = useCallback((e) => {
    const rect = baseRef.current.getBoundingClientRect();
    let dx = e.clientX - (rect.left + rect.width / 2);
    let dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > radius) { dx = (dx / len) * radius; dy = (dy / len) * radius; }
    setKnob(dx, dy);
    const shape = (v) => (Math.abs(v) < deadzone ? 0 : Math.sign(v) * ((Math.abs(v) - deadzone) / (1 - deadzone)));
    onChange({ x: shape(dx / radius), y: shape(-dy / radius), active: true });
  }, [radius, deadzone, onChange, setKnob]);

  const onDown = (e) => {
    if (pointer.current !== null) return;
    pointer.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    baseRef.current.dataset.active = 'true';
    update(e);
  };
  const onMove = (e) => { if (e.pointerId === pointer.current) update(e); };
  const onUp = (e) => {
    if (e.pointerId !== pointer.current) return;
    pointer.current = null;
    baseRef.current.dataset.active = 'false';
    setKnob(0, 0);
    onChange({ x: 0, y: 0, active: false });
  };

  return (
    <div
      ref={baseRef}
      className="joystick"
      style={{ width: size, height: size }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      role="application"
      aria-label="Drive joystick: up throttle, down brake or reverse, left and right steer"
    >
      <span className="joystick-label top">THR</span>
      <span className="joystick-label bottom">BRK / REV</span>
      <span className="joystick-cross" />
      <div ref={knobRef} className="joystick-knob" />
    </div>
  );

}
