// Airspace map: grid, deterministic city blocks, bases, trails, waypoints and drones. North is up, heading 0 = north.

const BG = '#0d131b';
const BORDER = '#1f2a37';
const MUTED = '#8aa0b4';
const BAD = '#f87171';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// City blocks in metres, generated once with a fixed seed (same picture on every load).
const BLOCKS = (() => {
  const rnd = mulberry32(20261127);
  const out = [];
  for (let cx = 0; cx < 10; cx++) {
    for (let cy = 0; cy < 10; cy++) {
      if (rnd() < 0.42) continue;
      const x0 = cx * 100 + 10 + rnd() * 16;
      const y0 = cy * 100 + 10 + rnd() * 16;
      const x1 = (cx + 1) * 100 - 10 - rnd() * 16;
      const y1 = (cy + 1) * 100 - 10 - rnd() * 16;
      out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx, cy });
    }
  }
  return out;
})();

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(138,160,180,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

const num = (v) => (Number.isFinite(v) ? v : null);

export function drawMap(canvas, snap) {
  const dpr = window.devicePixelRatio || 1;
  const size = Math.max(200, Math.floor(canvas.clientWidth || 600));
  const px = Math.round(size * dpr);
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const W = snap?.area?.w || 1000;
  const H = snap?.area?.h || 1000;
  const drones = Array.isArray(snap?.drones) ? snap.drones : [];
  const pad = size < 420 ? 32 : 28; // the y-axis labels ("1000") need ~30 px on the left
  const scale = (size - pad * 2) / Math.max(W, H);
  const sx = (x) => pad + x * scale;
  const sy = (y) => size - pad - y * scale; // y grows upward (north)

  // background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, size, size);

  // city blocks (skip those on top of a base)
  ctx.lineWidth = 1;
  for (const b of BLOCKS) {
    const cxm = b.cx * 100 + 50;
    const cym = b.cy * 100 + 50;
    if (drones.some((d) => d.home && Math.abs(d.home.x - cxm) < 70 && Math.abs(d.home.y - cym) < 70)) continue;
    ctx.fillStyle = 'rgba(148,163,184,0.07)';
    ctx.strokeStyle = 'rgba(148,163,184,0.13)';
    ctx.beginPath();
    ctx.rect(sx(b.x) + 0.5, sy(b.y + b.h) + 0.5, b.w * scale, b.h * scale);
    ctx.fill();
    ctx.stroke();
  }

  // grid every 100 m, stronger every 500 m
  for (let v = 0; v <= Math.max(W, H); v += 100) {
    const major = v % 500 === 0;
    ctx.strokeStyle = major ? 'rgba(138,160,180,0.26)' : 'rgba(138,160,180,0.10)';
    ctx.beginPath();
    if (v <= W) {
      ctx.moveTo(Math.round(sx(v)) + 0.5, sy(0));
      ctx.lineTo(Math.round(sx(v)) + 0.5, sy(H));
    }
    if (v <= H) {
      ctx.moveTo(sx(0), Math.round(sy(v)) + 0.5);
      ctx.lineTo(sx(W), Math.round(sy(v)) + 0.5);
    }
    ctx.stroke();
  }

  // axis labels
  ctx.font = '10px ui-monospace, Consolas, monospace';
  ctx.fillStyle = MUTED;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (let v = 0; v <= W; v += 200) ctx.fillText(String(v), sx(v), sy(0) + 5);
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let v = 200; v <= H; v += 200) ctx.fillText(String(v), sx(0) - 5, sy(v));

  // frame
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.strokeRect(sx(0) + 0.5, sy(H) + 0.5, W * scale, H * scale);

  // bases
  ctx.font = '600 10px system-ui, sans-serif';
  for (const d of drones) {
    if (!d.home) continue;
    const x = sx(d.home.x);
    const y = sy(d.home.y);
    ctx.strokeStyle = hexA(d.color, 0.55);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = hexA(d.color, 0.8);
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${d.name} base`, x, y + 14);
  }

  // waypoints
  for (const d of drones) {
    const wps = Array.isArray(d.mission) ? d.mission.filter((w) => num(w.x) !== null && num(w.y) !== null) : [];
    if (!wps.length) continue;
    const pts = wps.map((w) => [sx(w.x), sy(w.y)]);
    const t = d.telemetry;
    if (pts.length === 1 && t && num(t.x) !== null) pts.unshift([sx(t.x), sy(t.y)]);
    ctx.strokeStyle = hexA(d.color, 0.55);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const w of wps) {
      const x = sx(w.x);
      const y = sy(w.y);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x + 6, y);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x - 6, y);
      ctx.closePath();
      ctx.fillStyle = hexA(d.color, 0.22);
      ctx.fill();
      ctx.strokeStyle = hexA(d.color, 0.95);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  // trails: opacity grows toward the present
  for (const d of drones) {
    const trail = Array.isArray(d.trail) ? d.trail.filter((p) => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null) : [];
    const t = d.telemetry;
    const pts = trail.map((p) => [sx(p[0]), sy(p[1])]);
    if (t && num(t.x) !== null && num(t.y) !== null) pts.push([sx(t.x), sy(t.y)]);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      ctx.strokeStyle = hexA(d.color, 0.08 + 0.8 * (i / pts.length));
      ctx.beginPath();
      ctx.moveTo(pts[i - 1][0], pts[i - 1][1]);
      ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  // drones
  for (const d of drones) {
    const t = d.telemetry;
    const known = !!t && num(t.x) !== null && num(t.y) !== null;
    const wx = known ? t.x : d.home?.x ?? 0;
    const wy = known ? t.y : d.home?.y ?? 0;
    const x = sx(wx);
    const y = sy(wy);
    const connected = !!d.tcp?.connected;
    const alpha = known ? 1 : 0.35;

    if (connected && known) {
      const g = ctx.createRadialGradient(x, y, 0, x, y, 20);
      g.addColorStop(0, hexA(d.color, 0.38));
      g.addColorStop(1, hexA(d.color, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fill();
    }

    if (d.incident) {
      ctx.strokeStyle = { info: '#3ad1ff', warning: '#fbbf24', critical: BAD }[d.incident.severity] || BAD;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(((known ? num(t.heading) ?? 0 : 0) * Math.PI) / 180);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fillStyle = d.color || '#3ad1ff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = BG;
    ctx.stroke();
    ctx.restore();

    if (!connected) {
      ctx.strokeStyle = BAD;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 8);
      ctx.lineTo(x + 8, y + 8);
      ctx.moveTo(x + 8, y - 8);
      ctx.lineTo(x - 8, y + 8);
      ctx.stroke();
      ctx.lineCap = 'butt';
    }

    // label "Alpha 40 m"
    const label = `${d.name} ${known && num(t.alt) !== null ? Math.round(t.alt) + ' m' : '--'}`;
    ctx.font = '600 11px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const right = x + 12 + tw > size - 4;
    const lx = right ? x - 12 : x + 12;
    const ly = y - 14 < 10 ? y + 16 : y - 14;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = BG;
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = d.color || '#e5edf5';
    ctx.fillText(label, lx, ly);
  }
}
