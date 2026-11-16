// 写真の台形補正: 斜めに撮った紙の四隅を指で合わせ、まっすぐな長方形に直す。
// 角はドラッグだけで動かせる（長押し・2本指は使わない）。動かしている間は、指で隠れる所を拡大鏡で見せる。
import { h, makeCanvas, clamp, busy } from './util.js';
import { icon } from './icons.js';

const MAX_OUT = 2200;

// ---- 射影変換（4点 → 長方形） ----
function solve(A, b) { // ガウスの消去法（8元）
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
// from[i] → to[i] となる 3x3 行列（h33 = 1）
export function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// quad: 左上・右上・右下・左下（元画像の座標）。まっすぐに直したキャンバスを返す。
export function warp(src, quad) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, MAX_OUT / Math.max(W, H)); W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  if (!m) return null;
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H), octx = out.getContext('2d'), od = octx.createImageData(W, H), o = od.data;
  const [a, b, c, d, e, f, g, hh] = m;
  for (let v = 0, i = 0; v < H; v++) {
    const yv = v + 0.5;
    for (let u = 0; u < W; u++, i += 4) {
      const xu = u + 0.5, w = g * xu + hh * yv + 1;
      const x = clamp((a * xu + b * yv + c) / w - 0.5, 0, sw - 1.001), y = clamp((d * xu + e * yv + f) / w - 0.5, 0, sh - 1.001);
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, p = (y0 * sw + x0) * 4, q = p + sw * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      o[i] = sd[p] * w00 + sd[p + 4] * w10 + sd[q] * w01 + sd[q + 4] * w11;
      o[i + 1] = sd[p + 1] * w00 + sd[p + 5] * w10 + sd[q + 1] * w01 + sd[q + 5] * w11;
      o[i + 2] = sd[p + 2] * w00 + sd[p + 6] * w10 + sd[q + 2] * w01 + sd[q + 6] * w11;
      o[i + 3] = 255;
    }
  }
  octx.putImageData(od, 0, 0);
  return out;
}

// ---- 紙の四隅の見当をつける（明るい大きなかたまり＝紙、とみなす簡単な方法。外れたら全体より少し内側の枠にする） ----
export function guessQuad(src) {
  const W = src.width, H = src.height, inset = (r) => [[W * r, H * r], [W * (1 - r), H * r], [W * (1 - r), H * (1 - r)], [W * r, H * (1 - r)]];
  try {
    const k = 160 / Math.max(W, H), w = Math.max(8, Math.round(W * k)), hh = Math.max(8, Math.round(H * k));
    const c = makeCanvas(w, hh), ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0, w, hh);
    const d = ctx.getImageData(0, 0, w, hh).data, n = w * hh, lum = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) { const v = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10 | 0; lum[i] = v; hist[v]++; }
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t]; // 大津の方法でしきい値
    let sb = 0, wb = 0, best = 0, th = 128;
    for (let t = 0; t < 256; t++) { wb += hist[t]; if (!wb) continue; const wf = n - wb; if (!wf) break; sb += t * hist[t]; const mb = sb / wb, mf = (sum - sb) / wf, v = wb * wf * (mb - mf) ** 2; if (v > best) { best = v; th = t; } }
    const seen = new Uint8Array(n); let bestComp = null;
    const stack = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (seen[s] || lum[s] <= th) continue;
      let top = 0, count = 0; stack[top++] = s; seen[s] = 1;
      const ext = { a: [Infinity, 0, 0], b: [-Infinity, 0, 0], c: [-Infinity, 0, 0], d: [Infinity, 0, 0] };
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0; count++;
        if (x + y < ext.a[0]) ext.a = [x + y, x, y]; if (x - y > ext.b[0]) ext.b = [x - y, x, y];
        if (x + y > ext.c[0]) ext.c = [x + y, x, y]; if (x - y < ext.d[0]) ext.d = [x - y, x, y];
        if (x > 0 && !seen[i - 1] && lum[i - 1] > th) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && lum[i + 1] > th) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && !seen[i - w] && lum[i - w] > th) { seen[i - w] = 1; stack[top++] = i - w; }
        if (y < hh - 1 && !seen[i + w] && lum[i + w] > th) { seen[i + w] = 1; stack[top++] = i + w; }
      }
      if (!bestComp || count > bestComp.count) bestComp = { count, ext };
    }
    if (!bestComp) return { quad: inset(0.04), auto: false };
    const q = ['a', 'b', 'c', 'd'].map((key) => [(bestComp.ext[key][1] + 0.5) / k, (bestComp.ext[key][2] + 0.5) / k]);
    const area = Math.abs(q.reduce((s, p, i) => { const r = q[(i + 1) % 4]; return s + p[0] * r[1] - r[0] * p[1]; }, 0)) / 2;
    const ratio = area / (W * H), fill = bestComp.count / (area * k * k || 1);
    // 紙らしい大きさ・形のときだけ採用（画面いっぱい＝すでにまっすぐ、小さすぎ＝別の物、すき間だらけ＝紙ではない）
    if (ratio > 0.2 && ratio < 0.9 && fill > 0.8 && fill < 1.2) return { quad: q, auto: true };
    return { quad: inset(ratio >= 0.9 ? 0 : 0.04), auto: false };
  } catch { return { quad: inset(0.04), auto: false }; }
}

function rotate90(src, quad, dir) { // dir: -1=左, 1=右
  const c = makeCanvas(src.height, src.width), ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2); ctx.rotate(dir * Math.PI / 2); ctx.drawImage(src, -src.width / 2, -src.height / 2);
  const pts = quad.map(([x, y]) => (dir < 0 ? [y, src.width - x] : [src.height - y, x]));
  // 並びを 左上・右上・右下・左下 に戻す
  return { canvas: c, quad: dir < 0 ? [pts[1], pts[2], pts[3], pts[0]] : [pts[3], pts[0], pts[1], pts[2]] };
}

// 四隅を合わせる画面を開く。補正後のキャンバス（そのまま使うなら元のキャンバス）を返す。やめたら null。
export function adjustPhoto(source, { okLabel = 'この形で取り込む' } = {}) {
  return new Promise((resolve) => {
    let img = source, { quad, auto } = guessQuad(source);
    let drag = null, s = 1, ox = 0, oy = 0, cw = 0, ch = 0, dpr = 1, raf = 0;
    const canvas = h('canvas.scan-canvas', { 'aria-label': '写真。四隅の丸を紙の角に合わせます' });
    const stage = h('div.scan-stage', canvas);
    const note = h('p.scan-note');
    const setNote = () => { note.textContent = auto ? '紙の角を自動で見つけました。ずれていたら、丸をドラッグして紙の角に合わせてください。' : '四隅の丸をドラッグして、紙の角に合わせてください。'; };
    const finish = (v) => { cancelAnimationFrame(raf); ro.disconnect(); el.remove(); resolve(v); };
    const full = () => [[0, 0], [img.width, 0], [img.width, img.height], [0, img.height]];
    const isFull = () => quad.every((p, i) => dist(p, full()[i]) < Math.max(img.width, img.height) * 0.012);
    const el = h('div.scan', { role: 'dialog', 'aria-label': '写真の形を整える' },
      h('header.scan-top', h('button.icon-btn', { 'aria-label': 'やめる', onclick: () => finish(null) }, '✕'), h('div.scan-title', h('strong', '写真の形を整える'), note)),
      stage,
      h('footer.scan-bar',
        h('button.btn', { onclick: () => { ({ canvas: img, quad } = rotate90(img, quad, -1)); layout(); } }, icon('rotl', 16), '回す'),
        h('button.btn', { onclick: () => { quad = full(); auto = false; setNote(); draw(); } }, '全体を使う'),
        h('button.btn.primary', { onclick: async () => {
          if (isFull()) return finish(img);
          const b = busy('まっすぐに直しています…'); await new Promise((r) => setTimeout(r, 40));
          let out = null; try { out = warp(img, quad); } catch (e) { console.error(e); } finally { b.done(); }
          finish(out || img);
        } }, icon('check', 16), okLabel)));
    document.body.append(el); setNote();

    const toScreen = ([x, y]) => [x * s + ox, y * s + oy];
    function layout() {
      const r = stage.getBoundingClientRect(); dpr = Math.min(2.5, window.devicePixelRatio || 1); cw = Math.max(50, r.width); ch = Math.max(50, r.height);
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
      const pad = 30; s = Math.min((cw - pad * 2) / img.width, (ch - pad * 2) / img.height); ox = (cw - img.width * s) / 2; oy = (ch - img.height * s) / 2;
      draw();
    }
    const draw = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(paint); };
    function paint() {
      const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, ox, oy, img.width * s, img.height * s);
      const P = quad.map(toScreen);
      ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.moveTo(...P[0]); for (const i of [3, 2, 1]) ctx.lineTo(...P[i]); ctx.closePath();
      ctx.fillStyle = 'rgba(12,14,22,.55)'; ctx.fill('evenodd');
      ctx.beginPath(); P.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.lineWidth = 2; ctx.strokeStyle = '#7b93ff'; ctx.stroke();
      P.forEach((p, i) => { ctx.beginPath(); ctx.arc(p[0], p[1], 15, 0, 7); ctx.fillStyle = drag?.i === i ? 'rgba(76,110,245,.35)' : 'rgba(255,255,255,.3)'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.fillStyle = '#4c6ef5'; ctx.fill(); });
      if (drag) { // 拡大鏡: 動かしている角を、指から離れた上の隅に映す
        const R = clamp(Math.min(cw, ch) * 0.2, 52, 76), [qx, qy] = quad[drag.i], [sx, sy] = P[drag.i];
        const cx = sx < cw / 2 ? cw - R - 12 : R + 12, cy = R + 12, z = Math.max(s * 3, 0.6);
        ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.fillStyle = '#14161f'; ctx.fill(); ctx.clip();
        ctx.drawImage(img, cx - qx * z, cy - qy * z, img.width * z, img.height * z);
        ctx.beginPath(); quad.forEach(([x, y], i) => { const X = cx + (x - qx) * z, Y = cy + (y - qy) * z; i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); }); ctx.closePath(); ctx.lineWidth = 2; ctx.strokeStyle = '#7b93ff'; ctx.stroke();
        ctx.restore();
        ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.beginPath(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff6b6b'; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(cx + dx * 4, cy + dy * 4); ctx.lineTo(cx + dx * 14, cy + dy * 14); } ctx.stroke();
      }
    }
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = local(e); let bi = -1, bd = 56;
      quad.map(toScreen).forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; bi = i; } });
      if (bi < 0) return;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* 合成イベントなど */ }
      const p = toScreen(quad[bi]); drag = { i: bi, id: e.pointerId, dx: p[0] - x, dy: p[1] - y }; auto = false; draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const [x, y] = local(e);
      quad[drag.i] = [clamp((x + drag.dx - ox) / s, 0, img.width), clamp((y + drag.dy - oy) / s, 0, img.height)]; draw();
    });
    const end = (e) => { if (drag && drag.id === e.pointerId) { drag = null; setNote(); draw(); } };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    const ro = new ResizeObserver(layout); ro.observe(stage);
    layout();
  });
}
