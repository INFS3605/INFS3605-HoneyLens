/*
  admin/js/admin-charts.js — hand-rolled inline-SVG chart builders, zero
  external dependencies (consistent with the main app's "vendor locally,
  never a CDN" rule — the simplest version of that here is just not to
  need a charting library at all). Every function returns an SVG string
  ready to drop into innerHTML. Deliberately simple: these are read-only
  analytics visuals, not an interactive charting engine.
*/
(function () {
  'use strict';

  const COLORS = {
    teal: '#1cc3d6', tealDeep: '#0e83a0', blue: '#4d8bf5', green: '#4ade80',
    amber: '#f5b945', red: '#f06a7a', paddle: '#7d56c9', dim: '#7c83b4',
  };
  const PALETTE = [COLORS.teal, COLORS.blue, COLORS.paddle, COLORS.amber, COLORS.green, COLORS.red];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /** points: [{x:label, y:number}] */
  function lineChart(points, { width = 560, height = 200, color = COLORS.teal } = {}) {
    if (!points || !points.length) return '';
    const padL = 36, padB = 24, padT = 12, padR = 12;
    const innerW = width - padL - padR, innerH = height - padT - padB;
    const maxY = Math.max(1, ...points.map((p) => p.y));
    const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
    const coords = points.map((p, i) => {
      const x = padL + i * stepX;
      const y = padT + innerH - (p.y / maxY) * innerH;
      return { ...p, x, y };
    });
    const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
    const area = `${path} L${coords[coords.length - 1].x.toFixed(1)},${(padT + innerH).toFixed(1)} L${coords[0].x.toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
    const gridLines = [0, 0.5, 1].map((f) => {
      const y = padT + innerH * f;
      const val = Math.round(maxY * (1 - f));
      return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="rgba(154,164,228,.12)" stroke-width="1"/>
        <text x="${padL - 8}" y="${y + 4}" font-size="10" fill="${COLORS.dim}" text-anchor="end">${val}</text>`;
    }).join('');
    const labelEvery = Math.max(1, Math.ceil(points.length / 6));
    const labels = coords.filter((_, i) => i % labelEvery === 0).map((c) =>
      `<text x="${c.x.toFixed(1)}" y="${height - 6}" font-size="10" fill="${COLORS.dim}" text-anchor="middle">${esc(c.x_label != null ? c.x_label : c.x)}</text>`
    ).join('');
    const dots = coords.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="${color}"/>`).join('');
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet">
      ${gridLines}
      <path d="${area}" fill="${color}" opacity="0.12"/>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${labels}
    </svg>`;
  }

  /** bars: [{label, value}] */
  function barChart(bars, { width = 560, height = 200, color = COLORS.teal } = {}) {
    if (!bars || !bars.length) return '';
    const padL = 36, padB = 30, padT = 12, padR = 12;
    const innerW = width - padL - padR, innerH = height - padT - padB;
    const maxV = Math.max(1, ...bars.map((b) => b.value));
    const gap = 8;
    const bw = (innerW - gap * (bars.length - 1)) / bars.length;
    const rects = bars.map((b, i) => {
      const h = (b.value / maxV) * innerH;
      const x = padL + i * (bw + gap);
      const y = padT + innerH - h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${b.color || color}"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${height - 8}" font-size="10" fill="${COLORS.dim}" text-anchor="middle">${esc(b.label)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(y - 6).toFixed(1)}" font-size="11" fill="${COLORS.text || '#fff'}" text-anchor="middle" font-weight="700">${b.value}</text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="xMidYMid meet">${rects}</svg>`;
  }

  /** segments: [{label, value, color}] */
  function donutChart(segments, { size = 180, thickness = 26 } = {}) {
    const total = segments.reduce((s, x) => s + x.value, 0);
    const r = (size - thickness) / 2;
    const cx = size / 2, cy = size / 2;
    const circ = 2 * Math.PI * r;
    let offset = 0;
    const arcs = segments.map((seg, i) => {
      const frac = total > 0 ? seg.value / total : 0;
      const dash = frac * circ;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color || PALETTE[i % PALETTE.length]}"
        stroke-width="${thickness}" stroke-dasharray="${dash.toFixed(2)} ${(circ - dash).toFixed(2)}"
        stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += dash;
      return el;
    }).join('');
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
      ${arcs}
      <text x="${cx}" y="${cy - 2}" font-size="20" font-weight="800" fill="#fff" text-anchor="middle">${total}</text>
      <text x="${cx}" y="${cy + 16}" font-size="10" fill="${COLORS.dim}" text-anchor="middle">total</text>
    </svg>`;
  }

  /** stages: [{label, value}] — widths shrink relative to the FIRST stage */
  function funnelChart(stages, { width = 560, rowHeight = 34, gap = 8 } = {}) {
    if (!stages || !stages.length) return '';
    const maxV = Math.max(1, stages[0].value);
    const height = stages.length * (rowHeight + gap);
    const rows = stages.map((s, i) => {
      const w = Math.max(6, (s.value / maxV) * (width - 120));
      const y = i * (rowHeight + gap);
      const pct = maxV > 0 ? Math.round((s.value / maxV) * 100) : 0;
      return `<text x="0" y="${y + rowHeight / 2 + 4}" font-size="12" fill="${COLORS.dim}">${esc(s.label)}</text>
        <rect x="110" y="${y}" width="${w.toFixed(1)}" height="${rowHeight}" rx="7" fill="${PALETTE[i % PALETTE.length]}" opacity="0.85"/>
        <text x="${110 + w + 8}" y="${y + rowHeight / 2 + 4}" font-size="12" font-weight="700" fill="#fff">${s.value} <tspan fill="${COLORS.dim}" font-weight="400">(${pct}%)</tspan></text>`;
    }).join('');
    return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${rows}</svg>`;
  }

  window.AdminCharts = { lineChart, barChart, donutChart, funnelChart, COLORS, PALETTE, esc };
})();
