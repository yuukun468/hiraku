// ページ表示の共通部品: 画像＋マスクの描画、拡大縮小・移動（ピンチ／ホイール／ボタン）。
import { clamp, h } from './util.js';
import { icon } from './icons.js';
import { pathOf, bounds } from './geom.js';
import { markerFill, markerById } from './rewards.js';

export class PageView {
  constructor(canvas, stage) {
    this.canvas = canvas; this.stage = stage; this.ctx = canvas.getContext('2d');
    this.s = 1; this.tx = 0; this.ty = 0; this.img = null; this.page = null; this.autoFit = true;
    this.paint = null; // (ctx, view) => ページ座標系での追加描画
    this.paintScreen = null; // 画面座標系での追加描画（ハンドルなど）
    this.sheet = null; // 'red' | 'green' | null （赤シート）
    this.loupe = null; // {x, y}（画面座標）: 指の下を拡大して見せる拡大鏡。指で細かい所をなぞるときの補助
    this._raf = 0;
    this.ro = new ResizeObserver(() => { this.resize(); });
    this.ro.observe(stage);
    this.resize();
  }
  destroy() { this.ro.disconnect(); cancelAnimationFrame(this._raf); }
  resize() {
    const r = this.stage.getBoundingClientRect(); this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.cw = Math.max(50, r.width); this.ch = Math.max(50, r.height);
    this.canvas.width = Math.round(this.cw * this.dpr); this.canvas.height = Math.round(this.ch * this.dpr);
    this.canvas.style.width = this.cw + 'px'; this.canvas.style.height = this.ch + 'px';
    if (this.autoFit) this.fit(); else this.draw();
  }
  setPage(page, img) { this.page = page; this.img = img; this.autoFit = true; this.fit(); }
  fit() {
    if (!this.page) return;
    const pad = 14;
    this.s = Math.min((this.cw - pad * 2) / this.page.w, (this.ch - pad * 2) / this.page.h);
    this.tx = (this.cw - this.page.w * this.s) / 2; this.ty = (this.ch - this.page.h * this.s) / 2;
    this.draw();
  }
  toPage(x, y) { return [(x - this.tx) / this.s, (y - this.ty) / this.s]; }
  toScreen(x, y) { return [x * this.s + this.tx, y * this.s + this.ty]; }
  local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  zoomAt(x, y, f) {
    if (!this.page) return;
    const min = Math.min(this.cw / this.page.w, this.ch / this.page.h) * 0.5;
    const ns = clamp(this.s * f, min, 12);
    f = ns / this.s; this.tx = x - (x - this.tx) * f; this.ty = y - (y - this.ty) * f; this.s = ns;
    this.autoFit = false; this.clampPan(); this.draw();
  }
  zoomBy(f) { this.zoomAt(this.cw / 2, this.ch / 2, f); }
  panBy(dx, dy) { this.tx += dx; this.ty += dy; this.autoFit = false; this.clampPan(); this.draw(); }
  clampPan() {
    const w = this.page.w * this.s, hh = this.page.h * this.s, m = 60;
    this.tx = clamp(this.tx, Math.min(m - w, (this.cw - w) / 2), Math.max(this.cw - m, (this.cw - w) / 2));
    this.ty = clamp(this.ty, Math.min(m - hh, (this.ch - hh) / 2), Math.max(this.ch - m, (this.ch - hh) / 2));
  }
  // マスクが見えるように寄る
  focus(m, zoomTo) {
    const b = bounds(m), w = b.x1 - b.x0, hh = b.y1 - b.y0;
    if (zoomTo) this.s = clamp(Math.min(this.cw / (w * 4.5), this.ch / (hh * 9), 3), Math.min(this.cw / this.page.w, this.ch / this.page.h), 6);
    const [sx, sy] = this.toScreen((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    if (zoomTo || sx < 40 || sy < 40 || sx > this.cw - 40 || sy > this.ch - 90) {
      this.tx += this.cw / 2 - sx; this.ty += this.ch * 0.42 - sy; this.autoFit = false; this.clampPan();
    }
    this.draw();
  }
  draw() { cancelAnimationFrame(this._raf); this._raf = requestAnimationFrame(() => this._draw()); }
  _draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.page || !this.img) return;
    ctx.setTransform(dpr * this.s, 0, 0, dpr * this.s, dpr * this.tx, dpr * this.ty);
    ctx.shadowColor = 'rgba(20,24,40,.22)'; ctx.shadowBlur = 18 * dpr; ctx.shadowOffsetY = 4 * dpr;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.page.w, this.page.h);
    ctx.shadowColor = 'transparent';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.img, 0, 0, this.page.w, this.page.h);
    if (this.sheet) { // 赤シート: 乗算で重ねると、赤い字が紙色に溶けて見えなくなる
      ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = this.sheet === 'red' ? '#ff4a3d' : '#2fbf71';
      ctx.fillRect(0, 0, this.page.w, this.page.h); ctx.globalCompositeOperation = 'source-over';
    }
    if (this.paint) this.paint(ctx, this);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.paintScreen) this.paintScreen(ctx, this);
    if (this.loupe) this._drawLoupe();
  }
  // 拡大鏡: 指で隠れてしまう所を、指から離れた上の隅に大きく映す
  _drawLoupe() {
    const { ctx, dpr } = this, L = this.loupe;
    const R = clamp(Math.min(this.cw, this.ch) * 0.2, 48, 72), gap = 12;
    const nearLeft = L.x < R * 2 + 70 && L.y < R * 2 + 90;
    const cx = nearLeft ? this.cw - R - 64 : R + gap, cy = R + gap;
    const [px, py] = this.toPage(L.x, L.y), s2 = Math.max(this.s * 2.4, Math.min(this.s * 4, 1));
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.shadowColor = 'rgba(20,24,40,.35)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 4;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fillStyle = '#e9ebf2'; ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.clip();
    ctx.setTransform(dpr * s2, 0, 0, dpr * s2, dpr * (cx - px * s2), dpr * (cy - py * s2));
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.page.w, this.page.h);
    ctx.drawImage(this.img, 0, 0, this.page.w, this.page.h);
    if (this.paint) this.paint(ctx, { s: s2, loupe: true });
    ctx.restore();
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, R + 1.5, 0, 7); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(76,110,245,.9)'; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(224,49,49,.9)'; ctx.beginPath(); // 十字（いま指している点）
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(cx + dx * 4, cy + dy * 4); ctx.lineTo(cx + dx * 13, cy + dy * 13); }
    ctx.stroke(); ctx.restore();
  }
}

// 画面の右上に置く、拡大・縮小・全体表示のボタン（2本指のピンチと同じことが、見えるボタンでできる）
export function zoomControls(view, extra = []) {
  const b = (label, ic, fn) => h('button.zf-btn', { 'aria-label': label, title: label, onclick: fn }, icon(ic));
  return h('div.zoom-float', { role: 'group', 'aria-label': '表示の拡大・縮小' },
    b('拡大', 'plus', () => view.zoomBy(1.3)), b('縮小', 'minus', () => view.zoomBy(1 / 1.3)),
    b('全体を表示', 'fit', () => { view.autoFit = true; view.fit(); }), extra);
}

// マスク1個を描く。mode: edit(半透明でうっすら下が見える) / hidden(完全に隠す) / peek(覚える時間: 答えにマーカー) / open(めくった後)
export function drawMask(ctx, m, marker, mode, view, opt = {}) {
  if (m.mk) marker = markerById(m.mk); // 隠しごとの色（無ければ、いま選んでいる色）
  const path = pathOf(m);
  const b = bounds(m);
  ctx.save();
  if (mode === 'open') {
    ctx.lineWidth = 2.5 / view.s; ctx.strokeStyle = opt.color || 'rgba(90,100,130,.55)'; ctx.setLineDash([6 / view.s, 4 / view.s]); ctx.stroke(path);
  } else {
    ctx.globalAlpha = mode === 'edit' ? 0.62 : mode === 'peek' ? 0.28 : 1;
    ctx.fillStyle = markerFill(ctx, marker, b);
    ctx.fill(path);
    ctx.globalAlpha = 1;
    if (mode === 'edit' && m.uncertain) { // 不確かな形は色＋破線＋記号で示す（色だけに頼らない）
      ctx.lineWidth = 2.5 / view.s; ctx.strokeStyle = '#e8590c'; ctx.setLineDash([7 / view.s, 5 / view.s]); ctx.stroke(path);
    }
  }
  if (opt.ring) { ctx.setLineDash([]); ctx.lineWidth = 4 / view.s; ctx.strokeStyle = opt.ring; ctx.shadowColor = opt.ring; ctx.shadowBlur = 14; ctx.stroke(pathOf(m, 3 / view.s)); }
  ctx.restore();
}

// キャンバスへの入力（1本指/ペン/マウス＋2本指ピンチ）を整理して渡す。長押しは一切使わない。
export function bindPointers(view, handlers) {
  const cv = view.canvas, pts = new Map();
  let pinch = null, active = null;
  const penDown = () => [...pts.values()].some((p) => p.type === 'pen');
  const down = (e) => {
    if (e.pointerType === 'touch' && penDown()) return; // ペンで書いている間に触れた手のひら・指は無視する（iPad + Apple Pencil など）
    if (e.pointerType === 'pen' && pts.size) { pts.clear(); pinch = null; if (active != null) { handlers.cancel?.(); active = null; } } // 先に置いた手のひらより、ペンを優先する
    if (e.pointerType === 'touch' && e.isPrimary && pts.size) { pts.clear(); pinch = null; if (active != null) { handlers.cancel?.(); active = null; } } // 取りこぼした指の後始末（1本指がピンチ扱いになるのを防ぐ）
    try { cv.setPointerCapture?.(e.pointerId); } catch { /* 合成イベントなど */ }
    const [x, y] = view.local(e); pts.set(e.pointerId, { x, y, type: e.pointerType });
    if (pts.size === 2) {
      if (active) { handlers.cancel?.(); active = null; }
      const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      return;
    }
    if (pts.size > 2) return;
    active = e.pointerId; handlers.down?.(x, y, e);
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) { if (e.pointerType !== 'touch') { const [x, y] = view.local(e); handlers.hover?.(x, y, e); } return; }
    const [x, y] = view.local(e); const p = pts.get(e.pointerId); p.x = x; p.y = y;
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      view.tx += cx - pinch.cx; view.ty += cy - pinch.cy; view.zoomAt(cx, cy, d / (pinch.d || 1));
      pinch = { d, cx, cy }; return;
    }
    if (active === e.pointerId) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (evs.length > 1) for (const c of evs) { const [qx, qy] = view.local(c); handlers.move?.(qx, qy, e); } else handlers.move?.(x, y, e);
    }
  };
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    const [x, y] = view.local(e); pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    if (active === e.pointerId) { active = null; e.type === 'pointercancel' ? handlers.cancel?.() : handlers.up?.(x, y, e); }
  };
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = view.local(e); if (e.ctrlKey || !e.shiftKey) view.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015)); else view.panBy(-e.deltaY, 0); }, { passive: false });
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
}
