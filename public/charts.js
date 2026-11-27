// Tiny canvas sparkline: right-aligned history, optional second series, label and last value.

const MUTED = '#8aa0b4';
const LINE = '#1f2a37';

function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(138,160,180,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

const clean = (arr) => (Array.isArray(arr) ? arr.map((v) => (Number.isFinite(v) ? v : null)) : []);

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<number|null>} values
 * @param {{color?:string,min?:number,max?:number,minSpan?:number,label?:string,digits?:number,slots?:number,
 *          series2?:{values:Array<number|null>,color:string}}} opts
 */
export function sparkline(canvas, values, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || Math.round(canvas.width / dpr) || 100;
  const h = canvas.clientHeight || Math.round(canvas.height / dpr) || 44;
  const pw = Math.round(w * dpr);
  const ph = Math.round(h * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const color = opts.color || '#3ad1ff';
  const slots = opts.slots || 60;
  const a = clean(values);
  const b = opts.series2 ? clean(opts.series2.values) : [];
  const all = a.concat(b).filter((v) => v !== null);

  const top = 15;
  const bottom = h - 3;
  let lo = opts.min ?? (all.length ? Math.min(...all) : 0);
  let hi = opts.max ?? (all.length ? Math.max(...all) : 1);
  const span = opts.minSpan ?? 1;
  if (hi - lo < span) hi = lo + span;
  const X = (i, n) => w - 1 - (n - 1 - i) * ((w - 2) / (slots - 1));
  const Y = (v) => bottom - ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * (bottom - top);

  // baseline + mid guide
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Y(lo) + 0.5);
  ctx.lineTo(w, Y(lo) + 0.5);
  ctx.moveTo(0, (top + bottom) / 2 + 0.5);
  ctx.lineTo(w, (top + bottom) / 2 + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const series = (arr, col, fill) => {
    const n = arr.length;
    if (n === 0) return null;
    let started = false;
    let lastPt = null;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      if (arr[i] === null) {
        started = false;
        continue;
      }
      const x = X(i, n);
      const y = Y(arr[i]);
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
      lastPt = [x, y];
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    if (fill && lastPt && n > 1) {
      const firstIdx = arr.findIndex((v) => v !== null);
      ctx.lineTo(lastPt[0], bottom);
      ctx.lineTo(X(firstIdx, n), bottom);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, hexA(col, 0.28));
      g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g;
      ctx.fill();
    }
    if (lastPt) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(lastPt[0] - 1, lastPt[1], 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    return arr[n - 1];
  };

  if (b.length) series(b, opts.series2.color, false);
  const last = series(a, color, !b.length);

  ctx.font = '600 9px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  if (opts.label) ctx.fillText(opts.label.toUpperCase(), 1, 1);
  ctx.textAlign = 'right';
  ctx.font = '600 10px ui-monospace, Consolas, monospace';
  ctx.fillStyle = color;
  ctx.fillText(last === null || last === undefined ? '--' : last.toFixed(opts.digits ?? 1), w - 1, 0);
}
