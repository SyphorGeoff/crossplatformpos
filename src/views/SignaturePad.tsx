/*
 * Signature pad — a finger/stylus canvas shown after a card authorization when
 * the tender wants a signature (captureSignature) and the device did not
 * collect one itself. Returns a PNG data URL; the seam hands it to the
 * processor (attachSignature) when the processor stores signatures.
 */

import { useEffect, useRef, useState } from "react";

export default function SignaturePad({ title, sub, onDone, onSkip }: { title: string; sub?: string; onDone: (png: string) => void; onSkip?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const [inked, setInked] = useState(false);

  useEffect(() => {
    const c = canvasRef.current; if (!c) return;
    const scale = window.devicePixelRatio || 1;
    c.width = c.clientWidth * scale; c.height = c.clientHeight * scale;
    const g = c.getContext("2d"); if (!g) return;
    g.scale(scale, scale); g.lineWidth = 2.5; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#1a1a1a";
  }, []);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = e.currentTarget.getContext("2d"); if (!g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true; const p = pos(e); g.beginPath(); g.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = e.currentTarget.getContext("2d"); if (!g) return;
    const p = pos(e); g.lineTo(p.x, p.y); g.stroke(); if (!inked) setInked(true);
  };
  const up = () => { drawing.current = false; };
  const clear = () => {
    const c = canvasRef.current; const g = c?.getContext("2d"); if (!c || !g) return;
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); g.restore(); setInked(false);
  };

  return (
    <div className="sigpad">
      <div className="pvtitle">{title}</div>
      {sub && <div className="pvnote">{sub}</div>}
      <canvas ref={canvasRef} className="sigcanvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} />
      <div className="sigline">✕ ______________________________________</div>
      <div className="pvactions">
        {onSkip && <button className="mfbtn ghost" onClick={onSkip}>Skip</button>}
        <button className="mfbtn ghost" onClick={clear}>Clear</button>
        <button className="mfbtn go" disabled={!inked} onClick={() => onDone(canvasRef.current?.toDataURL("image/png") ?? "")}>Accept</button>
      </div>
    </div>
  );
}
