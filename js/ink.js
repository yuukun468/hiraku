// インク解析（端末内・AI不要）。
//  - ページ画像を解析用解像度に縮小し、インク(文字)画素と色クラスを求める
//  - なぞった線を「その行の文字の高さ」に沿う可変幅リボンへ自動フィット（隣の行は行間で止める）
//  - 赤字・青字・蛍光マーカーなど色で領域を抽出
//  - OCRの文字枠を実際のインクへ締める
import { makeCanvas } from './util.js';
import { resample, smooth, ribbonPoly, polyMask, rectMask, straightness } from './geom.js';

const MAX_DIM = 1500;
const cache = new Map(); // pageId -> InkMap

export const COLOR = { none: 0, red: 1, blue: 2, green: 3, hlYellow: 4, hlPink: 5, hlGreen: 6, hlBlue: 7 };
export const COLOR_LABEL = { 1: '赤字', 2: '青字', 3: '緑字', 4: '黄マーカー', 5: 'ピンクマーカー', 6: '緑マーカー', 7: '青マーカー' };

function classify(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (max < 40 || d < 28) return 0;
  const sat = d / max, v = max / 255;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6; else if (max === g) hue = (b - r) / d + 2; else hue = (r - g) / d + 4;
  hue *= 60; if (hue < 0) hue += 360;
  const light = v > 0.78 && min > 110; // 明るい＝蛍光マーカー系
  if (light) {
    if (sat < 0.16) return 0;
    if (hue >= 40 && hue < 75) return COLOR.hlYellow;
    if (hue >= 75 && hue < 170) return COLOR.hlGreen;
    if (hue >= 170 && hue < 250) return COLOR.hlBlue;
    if (hue >= 290 || hue < 20) return COLOR.hlPink;
    return 0;
  }
  if (sat < 0.38) return 0;
  if (hue < 22 || hue >= 335) return COLOR.red;
  if (hue >= 195 && hue < 265) return COLOR.blue;
  if (hue >= 85 && hue < 170) return COLOR.green;
  return 0;
}

export function analyze(pageId, img, pw, ph) {
  if (cache.has(pageId)) return cache.get(pageId);
  const k = Math.min(1, MAX_DIM / Math.max(pw, ph));
  const W = Math.max(1, Math.round(pw * k)), H = Math.max(1, Math.round(ph * k));
  const c = makeCanvas(W, H), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const data = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8Array(W * H), cls = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    gray[i] = (r * 77 + g * 150 + b * 29) >> 8;
    cls[i] = classify(r, g, b);
  }
  // 適応しきい値（積分画像による局所平均）: 影やムラのある写真でも文字を拾う
  const integ = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += gray[y * W + x]; integ[(y + 1) * (W + 1) + x + 1] = integ[y * (W + 1) + x + 1] + row; }
  }
  const R = Math.max(8, Math.round(Math.max(W, H) / 60));
  const ink = new Uint8Array(W * H), dark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const sum = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const g = gray[y * W + x];
      if (g < mean - 22 || g < 70) {
        const i = y * W + x; ink[i] = 1; dark[i] = Math.max(0, Math.min(255, mean - g));
        // 細いペンの線は、ふちがにじんで「明るい色」に見える。濃い彩度なら蛍光マーカーではなく色ペンの字として扱う
        if (cls[i] >= 5) { const p = i * 4, mx = Math.max(data[p], data[p + 1], data[p + 2]), mn = Math.min(data[p], data[p + 1], data[p + 2]); if ((mx - mn) / mx > 0.45) cls[i] = cls[i] === 5 ? 1 : cls[i] === 6 ? 3 : 2; }
      }
    }
  }
  const map = { W, H, k, ink, cls, dark, textH: 0, vertical: false };
  map.vertical = detectVertical(map);
  map.textH = map.vertical ? estimateTextHeight(transposed(map)) : estimateTextHeight(map);
  cache.set(pageId, map);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return map;
}
export const dropInk = (pageId) => cache.delete(pageId);

// 縦書きのページは、x と y を入れ替えた「転置ビュー」で横書きと同じ処理に通す
function transposed(m) {
  if (m.T) return m.T;
  const { W, H } = m, tr = (a) => { const o = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) o[x * H + y] = a[y * W + x]; return o; };
  return (m.T = { W: H, H: W, k: m.k, ink: tr(m.ink), cls: tr(m.cls), dark: tr(m.dark), textH: m.textH, vertical: false });
}
const swapBox = (b) => ({ x0: b.y0, y0: b.x0, x1: b.y1, y1: b.x1 });

// インクの連結成分（8近傍）。lab[i] = 成分番号+1、boxes[番号] = { x0, y0, x1, y1, n }
function components(m) {
  if (m.comps) return m.comps;
  const { W, H, ink } = m, lab = new Int32Array(W * H), boxes = [], stack = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (!ink[s0] || lab[s0]) continue;
    const id = boxes.length + 1, b = { x0: W, y0: H, x1: 0, y1: 0, n: 0 };
    stack.push(s0); lab[s0] = id;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0; b.n++;
      if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const z = Y * W + X; if (ink[z] && !lab[z]) { lab[z] = id; stack.push(z); }
      }
    }
    boxes.push(b);
  }
  return (m.comps = { lab, boxes });
}

// 縦書きかどうか: かな・漢字くらいの大きさのかたまりについて「いちばん近いとなり」が上下にあるか左右にあるかを数える。
// 横書きは字間 < 行間なので左右、縦書きは上下が多くなる。はっきり上下が多いときだけ縦書きとする。
function detectVertical(m) {
  const { boxes } = components(m);
  const sz = boxes.map((b) => Math.max(b.x1 - b.x0, b.y1 - b.y0) + 1).filter((v) => v >= 6).sort((a, b) => a - b);
  if (sz.length < 30) return false;
  const med = sz[sz.length >> 1];
  const cs = boxes.filter((b) => { const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1; return Math.max(w, h) >= med * 0.5 && Math.max(w, h) <= med * 2.2 && w / h < 2.5 && h / w < 2.5; });
  if (cs.length < 30) return false;
  const cell = med * 3, grid = new Map(), key = (x, y) => Math.floor(x / cell) + ':' + Math.floor(y / cell);
  for (const b of cs) { const k2 = key((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2); (grid.get(k2) || grid.set(k2, []).get(k2)).push(b); }
  let hor = 0, ver = 0; const votes = [];
  for (const a of cs) {
    const ax = (a.x0 + a.x1) / 2, ay = (a.y0 + a.y1) / 2; let best = null, bd = med * 2.5;
    for (let gy = -1; gy <= 1; gy++) for (let gx = -1; gx <= 1; gx++) for (const b of grid.get(key(ax + gx * cell, ay + gy * cell)) || []) {
      if (b === a) continue;
      const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)), dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)), d = Math.hypot(dx, dy);
      if (d < bd) { bd = d; best = [dx, dy, Math.abs((b.x0 + b.x1) / 2 - ax), Math.abs((b.y0 + b.y1) / 2 - ay)]; }
    }
    if (!best) continue;
    const sz2 = Math.max(a.x1 - a.x0, a.y1 - a.y0) + 1;
    if (best[2] > best[3] * 1.5) { hor++; votes.push([ax, ay, 0, sz2]); } else if (best[3] > best[2] * 1.5) { ver++; votes.push([ax, ay, 1, sz2]); }
  }
  m.orient = { hor, ver }; m.votes = votes;
  return ver > hor * 1.5 && ver > 20;
}
// 箱（ページ座標）のあたりが縦書きかどうか。横書きと縦書きが混ざったページ用
function localVertical(m, b) {
  const r = m.textH * 2.5, x0 = b.x0 * m.k - r, y0 = b.y0 * m.k - r, x1 = b.x1 * m.k + r, y1 = b.y1 * m.k + r; let hor = 0, ver = 0;
  for (const [x, y, v, sz] of m.votes || []) if (x >= x0 && x <= x1 && y >= y0 && y <= y1) { if (v) ver += sz; else hor += sz; }
  return hor + ver === 0 ? m.vertical : ver > hor;
}
// 横書き用の処理 run を、ページの向きに合わせて実行する。混在ページでは両方の向きで走らせ、その場所の向きに合う結果だけ残す
function oriented(m, run) {
  const o = m.orient || { hor: 1, ver: 0 }, T = () => Object.assign(transposed(m), { textH: m.textH });
  const mixed = Math.min(o.hor, o.ver) > 15 && Math.min(o.hor, o.ver) > Math.max(o.hor, o.ver) * 0.5;
  if (!mixed) return m.vertical ? run(T()).map(swapBox) : run(m);
  return [...run(m).filter((b) => !localVertical(m, b)), ...run(T()).map(swapBox).filter((b) => localVertical(m, b))];
}

// 縦方向のインク連続長の代表値 ≒ 文字の高さの目安
function estimateTextHeight(m) {
  const { W, H, ink } = m, runs = [];
  // まず横書きの「行」の高さ（インクのある行の連なり）から見積もる
  const lines = []; let run = 0;
  for (let y = 0; y <= H; y++) {
    let n = 0; if (y < H) for (let x = 0; x < W; x += 2) n += ink[y * W + x];
    if (n > 2) run++; else { if (run >= 5 && run < H / 3) lines.push(run); run = 0; }
  }
  if (lines.length >= 3) { lines.sort((a, b) => a - b); return Math.max(6, lines[Math.floor(lines.length * 0.5)]); }
  const step = Math.max(3, Math.round(W / 160));
  for (let x = step; x < W; x += step) {
    let run = 0, gap = 0;
    for (let y = 0; y < H; y++) {
      if (ink[y * W + x]) { run += gap + 1; gap = 0; }
      else if (run) { gap++; if (gap > 2) { if (run >= 4 && run < H / 8) runs.push(run); run = 0; gap = 0; } }
    }
  }
  if (runs.length < 10) return Math.round(H / 45);
  runs.sort((a, b) => a - b);
  return Math.max(6, runs[Math.floor(runs.length * 0.75)]);
}

const pct = (arr, q) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

// 1方向に走査して、中心線から続くインクの端までの距離を返す。
function scan(m, x, y, nx, ny, tx, ty, startMax, gap, cap) {
  const { W, H, ink } = m;
  let last = -1, gapRun = 0, started = false, hitCap = false;
  for (let t = 0; t <= cap; t++) {
    let on = 0;
    for (let s = -1; s <= 1; s++) {
      const px = Math.round(x + nx * t + tx * s), py = Math.round(y + ny * t + ty * s);
      if (px >= 0 && py >= 0 && px < W && py < H && ink[py * W + px]) { on = 1; break; }
    }
    if (on) { last = t; gapRun = 0; started = true; if (t === cap) hitCap = true; }
    else { gapRun++; if (started && gapRun >= gap) break; if (!started && t > startMax) break; }
  }
  return { ext: last, hitCap };
}

// なぞった線(ページ座標の点列) → 文字に沿うマスク。
// 返り値: { mask, fitted, uncertain }
export function fitStroke(m, strokePts, { fallbackHalf, snap = true } = {}) {
  const k = m ? m.k : 1;
  const st = straightness(strokePts);
  const fb = fallbackHalf;
  const plain = () => {
    // 文字が見つからない/自動フィットOFF: 一定幅。まっすぐなら任意角度の四角、曲がっていればリボン。
    let angle = st.angle;
    if (st.dev < Math.max(6, st.len * 0.04)) {
      if (snap) { const d = Math.abs(Math.sin(angle)); if (d < 0.07) angle = Math.cos(angle) > 0 ? 0 : Math.PI; else if (Math.abs(Math.cos(angle)) < 0.07) angle = Math.sin(angle) > 0 ? Math.PI / 2 : -Math.PI / 2; }
      const a = strokePts[0], b = strokePts[strokePts.length - 1];
      const mk = rectMask(0, 0, 1, 1);
      return { mask: { ...mk, cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, w: st.len + fb, h: fb * 2, angle: flipUp(angle) }, fitted: false, uncertain: false };
    }
    const c = smooth(resample(strokePts, Math.max(3, fb * 0.5)), 2);
    const w = c.map(() => fb);
    return { mask: polyMask(ribbonPoly(c, w, w), flipUp(st.angle)), fitted: false, uncertain: false };
  };
  if (!m || strokePts.length < 2 || st.len < 4) return plain();

  const step = 2;
  let c = smooth(resample(strokePts.map(([x, y]) => [x * k, y * k]), step), 3);
  if (c.length < 3) return plain();
  const n = c.length;
  const tang = c.map((_, i) => { const a = c[Math.max(0, i - 3)], b = c[Math.min(n - 1, i + 3)]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; });

  // --- 文字のかたまり（連結成分）で考える ---
  // 1) なぞった線のまわりの帯の各画素に「いちばん近い線上の点 i」と「線からの符号つき距離 t」を割り当てる
  const build = (R) => {
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of c) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
  bx0 = Math.max(0, Math.floor(bx0 - R - 2)); by0 = Math.max(0, Math.floor(by0 - R - 2)); bx1 = Math.min(m.W - 1, Math.ceil(bx1 + R + 2)); by1 = Math.min(m.H - 1, Math.ceil(by1 + R + 2));
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  if (bw < 2 || bh < 2) return null;
  const idx = new Int32Array(bw * bh).fill(-1), tt = new Float32Array(bw * bh);
  for (let i = 0; i < n; i++) {
    const nx = -tang[i][1], ny = tang[i][0];
    for (let t = -R; t <= R; t++) for (let o = 0; o < 3; o++) {
      const px = Math.round(c[i][0] + nx * t) + (o === 1 ? 1 : 0) - bx0, py = Math.round(c[i][1] + ny * t) + (o === 2 ? 1 : 0) - by0;
      if (px < 0 || py < 0 || px >= bw || py >= bh) continue;
      const q = py * bw + px;
      if (idx[q] < 0 || Math.abs(t) < Math.abs(tt[q])) { idx[q] = i; tt[q] = t; }
    }
  }
  // 2) 帯の中のインクを連結成分に分ける。線が通った成分＝対象
  const lab = new Uint8Array(bw * bh), comps = [], stack = [];
  const touchR = Math.max(2, m.textH * 0.12);
  const isInk = (q) => idx[q] >= 0 && m.ink[(by0 + ((q / bw) | 0)) * m.W + bx0 + (q % bw)];
  for (let s = 0; s < bw * bh; s++) {
    if (lab[s] || !isInk(s)) continue;
    const cp = { pix: [], touch: false, role: 0, minT: Infinity, maxT: -Infinity };
    stack.push(s); lab[s] = 1;
    while (stack.length) {
      const q = stack.pop(), x = q % bw, y = (q / bw) | 0, t = tt[q];
      cp.pix.push(q); if (Math.abs(t) <= touchR) cp.touch = true; if (t < cp.minT) cp.minT = t; if (t > cp.maxT) cp.maxT = t;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
        const z = Y * bw + X; if (!lab[z] && isInk(z)) { lab[z] = 1; stack.push(z); }
      }
    }
    comps.push(cp);
  }
    return { idx, tt, comps };
  };
  // 帯の幅は文字の大きさの見積りから始め、対象の字が帯からはみ出すなら広げてやり直す（大きな手書きにも対応）
  let R = Math.round(Math.max(12, m.textH * 1.7)), B = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    B = build(R); if (!B) return plain();
    if (!B.comps.some((cp) => cp.touch && (cp.minT <= -R + 1 || cp.maxT >= R - 1))) break;
    R = Math.min(R * 2, Math.round(Math.max(m.W, m.H) / 4));
  }
  const { idx, tt, comps } = B;
  const rawUp = new Float32Array(n).fill(-1), rawDn = new Float32Array(n).fill(-1);
  const addComp = (cp, role) => { cp.role = role; for (const q of cp.pix) { const i = idx[q], t = tt[q]; if (t <= 0 && -t > rawUp[i]) rawUp[i] = -t; if (t >= 0 && t > rawDn[i]) rawDn[i] = t; } };
  const targets = comps.filter((cp) => cp.touch && cp.pix.length >= 3);
  if (!targets.length) return plain();
  targets.forEach((cp) => addComp(cp, 1));
  const hs = [];
  for (let i = 0; i < n; i++) if (rawUp[i] >= 0 || rawDn[i] >= 0) hs.push(Math.max(0, rawUp[i]) + Math.max(0, rawDn[i]) + 1);
  const Hc = Math.max(5, pct(hs, 0.7));
  const win = Math.max(2, Math.round(Hc * 0.55 / step));
  const fill = (arr) => {
    // 文字間の空白は近くの値で補う → 窓の上位値でならす（不揃いな高さに追従しつつ欠けを防ぐ）
    const known = []; for (let i = 0; i < n; i++) if (arr[i] >= 0) known.push(i);
    if (!known.length) return Array.from({ length: n }, () => Hc / 2);
    const f = Array.from(arr, (v, i) => { if (v >= 0) return v; let best = known[0]; for (const j of known) if (Math.abs(j - i) < Math.abs(best - i)) best = j; return arr[best]; });
    const q = f.map((_, i) => pct(f.slice(Math.max(0, i - win), Math.min(n, i + win + 1)), 0.8));
    return q.map((_, i) => { let s = 0, cnt = 0; for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { s += q[j]; cnt++; } return s / cnt; });
  };
  // 3) 同じ字の離れた画（「三」の上の線、濁点など）を取り込む: 行の帯＋少しの余裕に「丸ごと」収まる小さな成分だけ
  const sizes = [];
  for (const cp of comps) { let i0 = Infinity, i1 = -Infinity; for (const q of cp.pix) { const i = idx[q]; if (i < i0) i0 = i; if (i > i1) i1 = i; } const sz = Math.max(cp.maxT - cp.minT + 1, (i1 - i0 + 1) * step); if (sz >= 6 && Math.abs(cp.minT + cp.maxT) / 2 < R * 0.7) sizes.push(sz); }
  const Tl = sizes.length >= 3 ? Math.min(pct(sizes, 0.75), Hc * 2.2) : Hc;
  const margin = Math.max(Hc * 0.32, Tl * 0.3), capExt = Math.max(Hc * 1.15, Tl * 0.72);
  for (let round = 0; round < 3; round++) {
    const U0 = fill(rawUp), D0 = fill(rawDn); let added = false;
    for (const cp of comps) {
      if (cp.role || cp.maxT - cp.minT > Hc * 1.2) continue;
      let ok = true;
      for (const q of cp.pix) { const i = idx[q], t = tt[q]; if (t < 0 ? -t > Math.min(U0[i] + margin, capExt) : t > Math.min(D0[i] + margin, capExt)) { ok = false; break; } }
      if (ok) { addComp(cp, 2); added = true; }
    }
    if (!added) break;
  }
  const pad = Math.max(1.5, Hc * 0.1);
  const up = fill(rawUp).map((v) => v + pad), dn = fill(rawDn).map((v) => v + pad);
  // 4) となりの行のインク（対象外の成分）には入らない。どうしても両立しない所は「不確か」として正直に示す
  const fUp = new Float32Array(n).fill(Infinity), fDn = new Float32Array(n).fill(Infinity);
  for (const cp of comps) if (!cp.role) for (const q of cp.pix) { const i = idx[q], t = tt[q]; for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 1); j++) { if (t < 0) { if (-t < fUp[j]) fUp[j] = -t; } else if (t < fDn[j]) fDn[j] = t; } }
  let conflicts = 0;
  for (let i = 0; i < n; i++) {
    if (fUp[i] - 1.5 < up[i]) { if (rawUp[i] > fUp[i] - 1.5) conflicts++; up[i] = Math.max(1, Math.min(up[i], fUp[i] - 1.5), Math.min(rawUp[i] + 1, up[i])); }
    if (fDn[i] - 1.5 < dn[i]) { if (rawDn[i] > fDn[i] - 1.5) conflicts++; dn[i] = Math.max(1, Math.min(dn[i], fDn[i] - 1.5), Math.min(rawDn[i] + 1, dn[i])); }
  }
  // 端の処理: 途中まで触れた文字は最後まで覆う（文字の切れ目＝インクの無い列まで延ばす）
  const colInk = (x, y, i) => {
    const nx = -tang[i][1], ny = tang[i][0];
    for (let t = -Math.round(up[i]); t <= Math.round(dn[i]); t++) { const px = Math.round(x + nx * t), py = Math.round(y + ny * t); if (px >= 0 && py >= 0 && px < m.W && py < m.H && m.ink[py * m.W + px]) return true; }
    return false;
  };
  const ext = (i, sgn) => {
    const maxExt = Math.round(Hc * 0.75), gapStop = Math.max(2, Math.round(Hc * 0.09)); let last = 0, blank = 0;
    if (colInk(c[i][0], c[i][1], i)) for (let d = 1; d <= maxExt; d++) { if (colInk(c[i][0] + tang[i][0] * d * sgn, c[i][1] + tang[i][1] * d * sgn, i)) { last = d; blank = 0; } else if (++blank >= gapStop) break; }
    const d = last + pad; return [c[i][0] + tang[i][0] * d * sgn, c[i][1] + tang[i][1] * d * sgn];
  };
  c[0] = ext(0, -1); c[n - 1] = ext(n - 1, 1);
  // 点を間引いて多角形へ
  const keep = Math.max(1, Math.round(Hc * 0.35 / step));
  const C = [], U = [], D = [];
  for (let i = 0; i < n; i++) if (i % keep === 0 || i === n - 1) { C.push([c[i][0] / k, c[i][1] / k]); U.push(up[i] / k); D.push(dn[i] / k); }
  const uncertain = conflicts > Math.max(2, n * 0.05); // 両立しない点が約5%を超えたら「不確か」
  let angle = st.angle;
  if (snap && Math.abs(Math.sin(angle)) < 0.07) angle = Math.cos(angle) > 0 ? 0 : Math.PI;
  return { mask: polyMask(ribbonPoly(C, U, D), flipUp(angle)), fitted: true, uncertain };
}
// 枠の角度は -90°〜90° に正規化（ハンドルの上下が逆さにならないように）
function flipUp(a) { while (a > Math.PI / 2) a -= Math.PI; while (a <= -Math.PI / 2) a += Math.PI; return a; }

// 箱(ページ座標)を中のインクにぴったり合わせ、文字サイズに比例した余白を付ける（④自動調整）
export function tightenBox(m, b, padRatio = 0.12) {
  if (!m) return b;
  const { W, H, ink, k } = m;
  const x0 = Math.max(0, Math.floor(b.x0 * k)), y0 = Math.max(0, Math.floor(b.y0 * k)), x1 = Math.min(W - 1, Math.ceil(b.x1 * k)), y1 = Math.min(H - 1, Math.ceil(b.y1 * k));
  let ax0 = Infinity, ay0 = Infinity, ax1 = -1, ay1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * W + x]) { if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; if (y < ay0) ay0 = y; if (y > ay1) ay1 = y; }
  if (ax1 < 0) return b;
  const hgt = ay1 - ay0 + 1, pad = Math.max(1.5, hgt * padRatio);
  return { x0: (ax0 - pad) / k, y0: (ay0 - pad) / k, x1: (ax1 + 1 + pad) / k, y1: (ay1 + 1 + pad) / k };
}

// 色クラスの領域を箱として抽出（赤字だけ・マーカー部分だけ）
export const colorRegions = (m, wanted) => oriented(m, (fr) => colorRegionsH(fr, wanted));
function colorRegionsH(m, wanted) {
  const { W, H, cls, ink, k, textH } = m;
  const set = new Set(wanted);
  const isText = wanted.some((w) => w <= 3);
  const bin = new Uint8Array(W * H);
  let any = 0;
  for (let i = 0; i < W * H; i++) if (set.has(cls[i]) && (!isText || ink[i])) { bin[i] = 1; any++; }
  if (any < 20) return [];
  // 横方向に文字間をつなぐ（ランレングス平滑化）
  const gx = Math.max(3, Math.round(textH * 0.9)), gy = Math.max(1, Math.round(textH * 0.18));
  const sm = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -9999;
    for (let x = 0; x < W; x++) if (bin[y * W + x]) { if (x - last <= gx) for (let j = last + 1; j < x; j++) sm[y * W + j] = 1; sm[y * W + x] = 1; last = x; }
  }
  for (let x = 0; x < W; x++) {
    let last = -9999;
    for (let y = 0; y < H; y++) if (sm[y * W + x]) { if (y - last <= gy && y - last > 1) for (let j = last + 1; j < y; j++) sm[j * W + x] = 1; last = y; }
  }
  // 連結成分
  const boxes = [], stack = [];
  for (let s = 0; s < W * H; s++) {
    if (!sm[s]) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, cnt = 0;
    stack.push(s); sm[s] = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0;
      if (bin[p]) cnt++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && sm[p - 1]) { sm[p - 1] = 0; stack.push(p - 1); }
      if (x < W - 1 && sm[p + 1]) { sm[p + 1] = 0; stack.push(p + 1); }
      if (y > 0 && sm[p - W]) { sm[p - W] = 0; stack.push(p - W); }
      if (y < H - 1 && sm[p + W]) { sm[p + W] = 0; stack.push(p + W); }
    }
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (cnt < Math.max(14, textH) || hh < Math.max(4, textH * 0.35) || w < 4) continue;
    // 蛍光マーカーは「面」で塗られている。色文字のふちのにじみ（細い線）は除く
    if (!isText && (cnt < textH * textH * 0.8 || cnt / (w * hh) < 0.4 || hh < textH * 0.6)) continue;
    const pad = Math.max(1.5, hh * 0.1);
    boxes.push({ x0: (x0 - pad) / k, y0: (y0 - pad) / k, x1: (x1 + 1 + pad) / k, y1: (y1 + 1 + pad) / k });
  }
  // 同じ行で、すき間が半文字未満の箱は1語としてつなぐ（カタカナなど字間の広い語が割れないように）
  // 手書きは字間が広いので、すき間が1文字ぶん程度まででも「間にほかの色の字が無ければ」同じ語としてつなぐ
  const lim = (textH * 0.5) / k;
  const foreignBetween = (a, b) => {
    const gx0 = Math.round(Math.min(a.x1, b.x1) * k), gx1 = Math.round(Math.max(a.x0, b.x0) * k), gy0 = Math.round(Math.max(a.y0, b.y0) * k), gy1 = Math.round(Math.min(a.y1, b.y1) * k);
    let n = 0;
    for (let x = Math.max(0, gx0); x <= Math.min(W - 1, gx1); x++) {
      let c = 0; for (let y = Math.max(0, gy0); y <= Math.min(H - 1, gy1); y++) if (ink[y * W + x] && !set.has(cls[y * W + x])) c++;
      if (c >= (gy1 - gy0 + 1) * 0.6) return true; // 間に仕切りの線（表の罫線など）がある
      if (c >= 3) n += c; // ノートの罫線（横に1〜2画素）が通っているだけなら、間に字があるとは数えない
    }
    return n > Math.max(6, (gx1 - gx0 + 1) * (gy1 - gy0 + 1) * 0.04);
  };
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      const hmin = Math.min(a.y1 - a.y0, b.y1 - b.y0);
      if (oy > hmin * 0.5 && (gap < lim || (isText && gap < Math.min(hmin * 1.7, (textH * 2.2) / k) && !foreignBetween(a, b)))) {
        boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
        boxes.splice(j, 1); merged = true; break outer;
      }
    }
  }
  boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < (a.y1 - a.y0) * 0.6 ? a.x0 - b.x0 : a.y0 - b.y0));
  return boxes;
}

// 下線（縦書きでは傍線）を引いた語と、丸や四角で囲んだ語を見つける。色は問わない（鉛筆でも可）。
// 返り値: { under: [箱], boxed: [箱] }（ページ座標）
export function markedRegions(m) {
  if (m.marks) return m.marks;
  const get = (fr) => fr.fm || (fr.fm = findMarks(fr));
  const under = oriented(m, (fr) => get(fr).under);
  // 囲みは向きに関係ない形なので、横向きの枠で1回だけ探す
  const boxed = get(m).boxed;
  const inBox = (u) => boxed.some((b) => { const ox = Math.min(u.x1, b.x1) - Math.max(u.x0, b.x0), oy = Math.min(u.y1, b.y1) - Math.max(u.y0, b.y0); return ox > 0 && oy > 0 && ox * oy > (u.x1 - u.x0) * (u.y1 - u.y0) * 0.5; });
  return (m.marks = { under: under.filter((u) => !inBox(u)), boxed });
}
function findMarks(m) {
  const { W, H, ink, dark, cls, k } = m, T = m.textH;
  const toPage = (b) => ({ x0: b.x0 / k, y0: b.y0 / k, x1: (b.x1 + 1) / k, y1: (b.y1 + 1) / k });
  // --- 下線: 「細くて横に長い線」を探す ---
  const thinMax = Math.max(3, Math.round(T * 0.2)), thin = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H;) {
    if (!ink[y * W + x]) { y++; continue; }
    const y0 = y; while (y < H && ink[y * W + x]) y++;
    if (y - y0 <= thinMax) for (let j = y0; j < y; j++) thin[j * W + x] = 1;
  }
  // ページの字の濃さの代表値。ノートの罫線は字よりずっと薄いので、これと比べて除く
  const dsamp = []; for (let i = 0; i < W * H; i += 7) if (ink[i]) dsamp.push(dark[i]);
  const minDark = Math.max(40, (dsamp.length ? pct(dsamp, 0.5) : 60) * 0.6);
  // ノートの罫線がある行: 薄くて細い画素が、その行に横に広くたまっている
  const ruleRow = new Uint8Array(H);
  for (let y = 0; y < H; y++) { let c = 0; for (let x = 0; x < W; x++) { const i = y * W + x; if (thin[i] && dark[i] < minDark * 1.15) c++; } if (c > W * 0.07) for (let j = Math.max(0, y - 2); j <= Math.min(H - 1, y + 2); j++) ruleRow[j] = 1; }
  let segs = []; const stack = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (thin[s0] !== 1) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0, dsum = 0, col = 0; const pix = [];
    stack.push(s0); thin[s0] = 2;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0; n++; dsum += dark[p]; if (cls[p]) col++; pix.push(p);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const z = Y * W + X; if (thin[z] === 1) { thin[z] = 2; stack.push(z); }
      }
    }
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (w < T * 0.6 || w > W * 0.6 || hh > Math.max(T * 0.4, w * 0.1)) continue;
    // うすい罫線は除く。罫線の上に字が乗っていると平均は濃くなるので、線の中の「薄い方の4分の1」で見る
    if (col / n < 0.5 && (dsum / n < minDark || pct(pix.map((p) => dark[p]), 0.25) < minDark * 0.8)) continue;
    if (col / n < 0.5 && ruleRow[(y0 + y1) >> 1] && dsum / n < minDark * 1.4) continue; // 罫線の上にある線は、はっきり濃いものだけ下線とみなす
    const cols = new Uint8Array(w); let cov = 0; for (const p of pix) { const c = (p % W) - x0; if (!cols[c]) { cols[c] = 1; cov++; } }
    if (cov / w < 0.85) continue;
    segs.push({ x0, y0, x1, y1, d: Math.round(dsum / n), q: pct(pix.map((p) => dark[p]), 0.25), c: +(col / n).toFixed(2) });
  }
  // 途切れた線をつなぐ（字の払いと交わった所など）
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i], b = segs[j];
      if (Math.abs((a.y0 + a.y1) - (b.y0 + b.y1)) / 2 < T * 0.3 && Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) < T * 0.8) {
        segs[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), d: Math.min(a.d, b.d), q: Math.min(a.q, b.q), c: a.c }; segs.splice(j, 1); merged = true; break outer;
      }
    }
  }
  const under = [], comp = components(m);
  for (const sg of segs) {
    const w = sg.x1 - sg.x0 + 1; if (w < T * 1.3) continue;
    // 表の罫線や大きな枠の一部は下線ではない（線が属するかたまりが縦にも横にも大きい）
    // 字の画の一部（大きな漢字の横線など）も下線ではない（かたまりが線の長さに比べて縦に大きい）
    let big = false;
    for (let x = sg.x0; x <= sg.x1 && !big; x += 3) for (let y = sg.y0; y <= sg.y1; y++) { const id = comp.lab[y * W + x]; if (id) { const cb = comp.boxes[id - 1], ch = cb.y1 - cb.y0 + 1; if ((ch > T * 4 && cb.x1 - cb.x0 > T * 4) || (ch > w * 0.55 && cb.x1 - cb.x0 < w * 1.6)) big = true; break; } }
    if (big) continue;
    // その場所の字の大きさ（ページの中で字の大きさが違っても合うように、線の上にあるかたまりから見積もる）
    const near = [];
    for (const cb of comp.boxes) {
      if (cb.x1 < sg.x0 || cb.x0 > sg.x1 || cb.y1 > sg.y0 + 1 || cb.y1 < sg.y0 - T * 3.5) continue;
      const cw = cb.x1 - cb.x0 + 1, ch = cb.y1 - cb.y0 + 1; if (Math.max(cw, ch) >= 6 && cw / ch < 3 && ch / cw < 3) near.push(Math.max(cw, ch));
    }
    const Tl = Math.min(T * 3, Math.max(T, near.length ? pct(near, 0.75) : T));
    if (w < Tl * 1.1) continue; // 1文字より短い線は、字の画（「土」の下の線など）のことが多い
    // 字の一部（口・土の下の線など）は、上の画とつながっている。つながりが多い線は下線ではない
    let attached = 0;
    for (let x = sg.x0; x <= sg.x1; x++) {
      let top = -1; for (let y = sg.y0; y <= sg.y1; y++) if (thin[y * W + x]) { top = y; break; }
      if (top < 1) continue;
      let run = 0; for (let y = top - 1; y >= 0 && ink[y * W + x] && run < thinMax * 3; y--) run++;
      if (run >= thinMax * 2) attached++;
    }
    if (attached / w > 0.15) continue;
    // 線のすぐ上にある文字の帯を探す
    const cap = Math.round(Tl * 1.7), startMax = Tl * 0.6, gapMax = Math.max(2, Tl * 0.22);
    let bot = -1, topY = -1, gap = 0, inkSum = 0;
    for (let d = 1; d <= cap; d++) {
      const y = sg.y0 - d; if (y < 0) break;
      let c = 0; for (let x = sg.x0; x <= sg.x1; x++) c += ink[y * W + x];
      if (c > 0) { if (bot < 0) bot = y; topY = y; gap = 0; inkSum += c; if (bot - topY > Tl * 1.5) break; }
      else if (bot < 0) { if (d > startMax) break; } else if (++gap > gapMax) break;
    }
    if (bot < 0 || bot - topY + 1 < Tl * 0.45 || inkSum < w * (bot - topY + 1) * 0.04) continue;
    // 横は、帯の中のインクに合わせて少しだけ広げる／せばめる
    let ax0 = sg.x1, ax1 = sg.x0; const ex = Math.round(T * 0.25);
    for (let y = topY; y <= bot; y++) for (let x = Math.max(0, sg.x0 - ex); x <= Math.min(W - 1, sg.x1 + ex); x++) if (ink[y * W + x]) { if (x < ax0) ax0 = x; if (x > ax1) ax1 = x; }
    const pad = Math.max(1.5, (bot - topY) * 0.08);
    under.push({ x0: Math.min(ax0, sg.x0) - pad, y0: topY - pad, x1: Math.max(ax1, sg.x1) + pad, y1: bot + pad });
  }
  // 二重下線などで重なった箱は1つに
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < under.length; i++) for (let j = i + 1; j < under.length; j++) {
      const a = under[i], b = under[j];
      const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      if (oy > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 && ox > -T * 0.3) {
        under[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }; under.splice(j, 1); merged = true; break outer;
      }
    }
  }
  // --- 囲み: 輪になっていて、中に字がある成分 ---
  const { lab, boxes } = components(m), boxed = [], sw = Math.max(2, T * 0.09);
  boxes.forEach((b, bi) => {
    const w = b.x1 - b.x0 + 1, hh = b.y1 - b.y0 + 1, id = bi + 1;
    if (Math.min(w, hh) < T * 1.1 || !(Math.min(w, hh) >= T * 1.3 || Math.max(w, hh) >= T * 2) || hh > T * 4.5 || w > W * 0.45 || w > hh * 9 || b.n / (w * hh) > 0.5) return;
    // 輪の外から塗りつぶして、届かなかった所＝囲まれた内側
    const gw = w + 2, gh = hh + 2, g = new Uint8Array(gw * gh); // 1 = 壁（成分を1画素ふとらせたもの）, 2 = 外側
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (lab[(b.y0 + y) * W + b.x0 + x] === id) for (let dy = 0; dy <= 2; dy++) for (let dx = 0; dx <= 2; dx++) g[(y + dy) * gw + x + dx] = 1;
    const st = [];
    for (let x = 0; x < gw; x++) { st.push(x, (gh - 1) * gw + x); } for (let y = 0; y < gh; y++) { st.push(y * gw, y * gw + gw - 1); }
    while (st.length) { const p = st.pop(); if (g[p]) continue; g[p] = 2; const x = p % gw, y = (p / gw) | 0; if (x > 0) st.push(p - 1); if (x < gw - 1) st.push(p + 1); if (y > 0) st.push(p - gw); if (y < gh - 1) st.push(p + gw); }
    let enclosed = 0, other = 0;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) if (g[(y + 1) * gw + x + 1] !== 2) { const p = (b.y0 + y) * W + b.x0 + x; if (g[(y + 1) * gw + x + 1] === 0) enclosed++; if (ink[p] && lab[p] !== id) other++; }
    const inside = other + Math.max(0, b.n - 2 * (w + hh) * sw * 1.3);
    if (enclosed / (w * hh) < 0.3 || inside < Math.max(8, w * hh * 0.015)) return;
    boxed.push({ x0: b.x0 - 1, y0: b.y0 - 1, x1: b.x1 + 1, y1: b.y1 + 1 });
  });
  const order = (a, b) => (Math.abs(a.y0 - b.y0) < (a.y1 - a.y0) * 0.6 ? a.x0 - b.x0 : a.y0 - b.y0);
  return { under: under.sort(order).map(toPage), boxed: boxed.sort(order).map(toPage) };
}

// 表のマスの中や、図に添えた短いことば（ラベル）を見つける。文章の行は対象外。
// 返り値: 箱の配列（ページ座標）。表や図が無いページでは空
export function labelRegions(m) {
  if (m.labels) return m.labels;
  return (m.labels = findLabels(m));
}
// 細くて長い横線（表の罫線・図の線）を画素の集まりとして取り出す。返り値: [{ x0, y0, x1, y1, pix }]
function thinLines(m, minLen) {
  const { W, H, ink } = m, T = m.textH, thinMax = Math.max(3, Math.round(T * 0.22)), thin = new Uint8Array(W * H);
  for (let x = 0; x < W; x++) for (let y = 0; y < H;) {
    if (!ink[y * W + x]) { y++; continue; }
    const y0 = y; while (y < H && ink[y * W + x]) y++;
    if (y - y0 <= thinMax) for (let j = y0; j < y; j++) thin[j * W + x] = 1;
  }
  const out = [], stack = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (thin[s0] !== 1) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0; const pix = []; stack.push(s0); thin[s0] = 2;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0; pix.push(p);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= W || Y >= H) continue; const z = Y * W + X; if (thin[z] === 1) { thin[z] = 2; stack.push(z); } }
    }
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (w < Math.min(minLen, T * 0.8) || hh > Math.max(T * 0.5, w * 0.08)) continue;
    const cols = new Uint8Array(w); let cov = 0, yl = 0, nl = 0, yr = 0, nr = 0;
    for (const p of pix) { const x = p % W, c = x - x0; if (!cols[c]) { cols[c] = 1; cov++; } if (x - x0 < 3) { yl += (p / W) | 0; nl++; } if (x1 - x < 3) { yr += (p / W) | 0; nr++; } }
    if (cov / w >= 0.8) out.push({ x0, y0, x1, y1, pix, yl: yl / nl, yr: yr / nr });
  }
  // 交わる線のところで途切れた線（表の縦線が行ごとに切れる等）を、一直線に並んでいればつなぐ
  out.sort((p, q) => p.x0 - q.x0);
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) {
      const p = out[i], q = out[j], gap = q.x0 - p.x1;
      if (gap > T * 0.7) break; if (gap < -2 || Math.abs(p.yr - q.yl) > T * 0.25) continue;
      out[i] = { x0: p.x0, y0: Math.min(p.y0, q.y0), x1: q.x1, y1: Math.max(p.y1, q.y1), pix: p.pix.concat(q.pix), yl: p.yl, yr: q.yr }; out.splice(j, 1); merged = true; break outer;
    }
  }
  return out.filter((l) => l.x1 - l.x0 + 1 >= minLen);
}
function findLabels(m) {
  const { W, H, ink, k } = m, T = m.textH;
  // 1) 表の罫線・図の線（横と縦）を取りのぞく。字が線に触れていても、字の方は残る
  const line = new Uint8Array(W * H), graphics = [];
  let nh = 0, nv = 0; // 表や図らしさ: 長い横線と長い縦線の両方が2本以上あること（下線だけのページは対象外）
  for (const l of thinLines(m, T * 2)) { for (const p of l.pix) line[p] = 1; graphics.push(l); if (l.x1 - l.x0 > T * 4) nh++; }
  const tr = Object.assign(transposed(m), { textH: T });
  for (const l of thinLines(tr, T * 2)) { for (const p of l.pix) line[(p % tr.W) * W + ((p / tr.W) | 0)] = 1; graphics.push({ x0: l.y0, y0: l.x0, x1: l.y1, y1: l.x1 }); if (l.x1 - l.x0 > T * 4) nv++; }
  if (nh < 2 || nv < 2) return [];
  const ink2 = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) ink2[i] = ink[i] && !line[i] ? 1 : 0;
  const { lab, boxes } = components({ W, H, ink: ink2 });
  // 2) 残ったかたまりのうち、字ではないもの（枠・かっこ・矢印・パンチ穴の影・ごみ）を外す
  const kind = new Uint8Array(boxes.length); // 1 = 図形, 2 = ごみ
  boxes.forEach((bx, i) => {
    const w = bx.x1 - bx.x0 + 1, hh = bx.y1 - bx.y0 + 1, big = Math.max(w, hh), small = Math.min(w, hh);
    if (bx.n < 4) kind[i] = 2;
    else if ((w > T * 4 && hh > T * 2.6) || (big > T * 5 && small < T * 0.6) || (big > T * 3.2 && small > T * 1.2 && bx.n / (w * hh) < 0.06)) { kind[i] = 1; graphics.push(bx); }
    else if (small > T * 0.9 && bx.n / (w * hh) > 0.62) kind[i] = 2;
  });
  // 3) 字の画素を横につなぐ。間に線や図形があれば、そこではつながない（表のマスをまたがない）
  const gx = Math.max(3, Math.round(T * 1.4)), sm = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -9999, blocked = false;
    for (let x = 0; x < W; x++) {
      const i = y * W + x; if (line[i]) { blocked = true; continue; }
      const id = lab[i]; if (!id) continue;
      const kd = kind[id - 1]; if (kd === 1) { blocked = true; continue; } if (kd === 2) continue;
      if (!blocked && x - last <= gx) for (let j = last + 1; j < x; j++) sm[y * W + j] = 1;
      sm[i] = 1; last = x; blocked = false;
    }
  }
  const gy = Math.max(1, Math.round(T * 0.2));
  for (let x = 0; x < W; x++) { let last = -9999; for (let y = 0; y < H; y++) if (sm[y * W + x]) { if (y - last <= gy && y - last > 1) { let cut = false; for (let j = last + 1; j < y; j++) if (line[j * W + x]) { cut = true; break; } if (!cut) for (let j = last + 1; j < y; j++) sm[j * W + x] = 1; } last = y; } }
  const out = [], stack = [];
  for (let s0 = 0; s0 < W * H; s0++) {
    if (sm[s0] !== 1) continue;
    let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0; stack.push(s0); sm[s0] = 2;
    while (stack.length) {
      const p = stack.pop(), x = p % W, y = (p / W) | 0; if (ink2[p]) n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && sm[p - 1] === 1) { sm[p - 1] = 2; stack.push(p - 1); } if (x < W - 1 && sm[p + 1] === 1) { sm[p + 1] = 2; stack.push(p + 1); }
      if (y > 0 && sm[p - W] === 1) { sm[p - W] = 2; stack.push(p - W); } if (y < H - 1 && sm[p + W] === 1) { sm[p + W] = 2; stack.push(p + W); }
    }
    const w = x1 - x0 + 1, hh = y1 - y0 + 1;
    if (hh < T * 0.5 || hh > T * 3.4 || w < T * 0.6 || w > T * 14 || n < Math.max(12, T)) continue; // 小さすぎ・文章の行は対象外
    // 表や図のそば（線や図形の外接枠の中か、すぐ近く）にあるものだけ
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, near = T * 1.5;
    if (!graphics.some((g) => cx >= g.x0 - near && cx <= g.x1 + near && cy >= g.y0 - near && cy <= g.y1 + near)) continue;
    const pad = Math.max(1.5, hh * 0.1);
    out.push({ x0: (x0 - pad) / k, y0: (y0 - pad) / k, x1: (x1 + 1 + pad) / k, y1: (y1 + 1 + pad) / k });
  }
  return out.sort((p, q) => (Math.abs(p.y0 - q.y0) < (p.y1 - p.y0) * 0.6 ? p.x0 - q.x0 : p.y0 - q.y0));
}

// ページにどの色がどれだけあるか（取込直後の「ワンタップ提案」用）
export function colorSummary(m) {
  const out = [];
  for (const [name, ids] of [['赤字', [1]], ['青字', [2]], ['緑字', [3]], ['マーカー部分', [4, 5, 6, 7]]]) {
    const n = colorRegions(m, ids).length;
    if (n) out.push({ name, ids, count: n });
  }
  const mk = markedRegions(m);
  if (mk.under.length) out.push({ name: m.vertical ? '傍線の語' : '下線の語', ids: ['under'], count: mk.under.length });
  if (mk.boxed.length) out.push({ name: '囲みの語', ids: ['boxed'], count: mk.boxed.length });
  const lb = labelRegions(m); if (lb.length >= 3) out.push({ name: '表・図のラベル', ids: ['labels'], count: lb.length });
  return out;
}
