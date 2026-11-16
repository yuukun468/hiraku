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
  const ink = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
      const sum = integ[y1 * (W + 1) + x1] - integ[y0 * (W + 1) + x1] - integ[y1 * (W + 1) + x0] + integ[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const g = gray[y * W + x];
      if (g < mean - 22 || g < 70) ink[y * W + x] = 1;
    }
  }
  const map = { W, H, k, ink, cls, textH: 0 };
  map.textH = estimateTextHeight(map);
  cache.set(pageId, map);
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return map;
}
export const dropInk = (pageId) => cache.delete(pageId);

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
  const margin = Hc * 0.32, capExt = Hc * 1.15;
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
export function colorRegions(m, wanted) {
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
  const lim = (textH * 0.5) / k;
  for (let merged = true; merged;) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0), gap = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
      if (oy > Math.min(a.y1 - a.y0, b.y1 - b.y0) * 0.5 && gap < lim) {
        boxes[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
        boxes.splice(j, 1); merged = true; break outer;
      }
    }
  }
  boxes.sort((a, b) => (Math.abs(a.y0 - b.y0) < (a.y1 - a.y0) * 0.6 ? a.x0 - b.x0 : a.y0 - b.y0));
  return boxes;
}

// ページにどの色がどれだけあるか（取込直後の「ワンタップ提案」用）
export function colorSummary(m) {
  const out = [];
  for (const [name, ids] of [['赤字', [1]], ['青字', [2]], ['緑字', [3]], ['マーカー部分', [4, 5, 6, 7]]]) {
    const n = colorRegions(m, ids).length;
    if (n) out.push({ name, ids, count: n });
  }
  return out;
}
