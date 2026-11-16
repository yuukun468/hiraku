// マスクの幾何。
// マスク = 向きつき枠 {cx,cy,w,h,angle} + 任意の自由形状 local（枠内の正規化座標 [-0.5,0.5]² の多角形）。
// 移動・回転・拡縮は枠だけを変えるので、四角もリボン(手書きに沿う形)も同じ操作で扱える。
// アンカー拡縮は設計書 §4.6 の式  p′ = A + R(θ) S R(−θ)(p − A),  S = diag(s_u, s_v)  に従う（Aは動かない）。

export const rot = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; };

export function localToPage(m, lx, ly) {
  const [x, y] = rot(lx * m.w, ly * m.h, m.angle);
  return [m.cx + x, m.cy + y];
}
export function pageToLocal(m, px, py) {
  const [x, y] = rot(px - m.cx, py - m.cy, -m.angle);
  return [x / m.w, y / m.h];
}

// マスク外形（ページ座標の点列）
export function outline(m) {
  const pts = m.local || [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  return pts.map(([x, y]) => localToPage(m, x, y));
}

export function pathOf(m, pad = 0) {
  const p = new Path2D();
  if (!m.local) {
    // 角丸の回転矩形
    const r = Math.min(m.h, m.w) * 0.18;
    const w = m.w + pad * 2, hh = m.h + pad * 2;
    const tr = new DOMMatrix().translate(m.cx, m.cy).rotate(m.angle * 180 / Math.PI);
    const q = new Path2D(); q.roundRect(-w / 2, -hh / 2, w, hh, Math.max(0, r));
    p.addPath(q, tr);
    return p;
  }
  const pts = outline(m);
  // なめらかな閉曲線（中点を通る二次ベジエ）
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let s = mid(pts[n - 1], pts[0]);
  p.moveTo(s[0], s[1]);
  for (let i = 0; i < n; i++) { const a = pts[i], b = mid(pts[i], pts[(i + 1) % n]); p.quadraticCurveTo(a[0], a[1], b[0], b[1]); }
  p.closePath();
  return p;
}

export function pointInPoly(pts, x, y) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 当たり判定。細いマスクも触れるよう tol(ページ単位) の余裕を持つ。
export function hit(m, x, y, tol = 0) {
  const [lx, ly] = pageToLocal(m, x, y);
  const tx = tol / m.w, ty = tol / m.h;
  if (lx < -0.5 - tx || lx > 0.5 + tx || ly < -0.5 - ty || ly > 0.5 + ty) return false;
  if (!m.local) return true;
  if (pointInPoly(m.local, lx, ly)) return true;
  if (tol <= 0) return false;
  for (const [dx, dy] of [[tx, 0], [-tx, 0], [0, ty], [0, -ty]]) if (pointInPoly(m.local, lx + dx, ly + dy)) return true;
  return false;
}

export function bounds(m) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of outline(m)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}

// 9点アンカー。handle=(hx,hy), anchor=(ax,ay) は local 座標(-0.5/0/0.5)。pointer はページ座標。
// 掴んだハンドルが pointer に来るように、アンカー固定で w,h を変える。
export function resizeAboutAnchor(m0, handle, anchor, px, py, minSize = 6) {
  const [hx, hy] = handle;
  let [ax, ay] = anchor;
  if (hx !== 0 && ax === hx) ax = -hx; // 掴んだ辺そのものは固定できないので対辺へ
  if (hy !== 0 && ay === hy) ay = -hy;
  const A = localToPage(m0, ax, ay);
  const [du, dv] = rot(px - A[0], py - A[1], -m0.angle);
  let w = m0.w, hh = m0.h;
  if (hx !== 0) w = Math.max(minSize, du / (hx - ax));
  if (hy !== 0) hh = Math.max(minSize, dv / (hy - ay));
  // アンカー点 A が動かないよう中心を再計算: c = A − R(θ)·(ax·w, ay·h)
  const [ox, oy] = rot(ax * w, ay * hh, m0.angle);
  return { ...m0, w, h: hh, cx: A[0] - ox, cy: A[1] - oy };
}

// anchor(local) を中心に回転
export function rotateAbout(m0, anchor, angle) {
  const A = localToPage(m0, anchor[0], anchor[1]);
  const [ox, oy] = rot(anchor[0] * m0.w, anchor[1] * m0.h, angle);
  return { ...m0, angle, cx: A[0] - ox, cy: A[1] - oy };
}

const SNAPS = [0, 45, 90, 135, 180, -45, -90, -135, -180].map((d) => d * Math.PI / 180);
export function snapAngle(a, tolDeg = 4) {
  const tol = tolDeg * Math.PI / 180;
  for (const s of SNAPS) if (Math.abs(a - s) < tol) return { angle: s, snapped: true };
  return { angle: a, snapped: false };
}
export const normAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a <= -Math.PI) a += 2 * Math.PI; return a; };

// 軸平行の箱 → マスク
export function rectMask(x0, y0, x1, y1, angle = 0) {
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), angle, local: null };
}

// ページ座標の多角形 → 枠(angle) + local
export function polyMask(pts, angle = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const r = pts.map(([x, y]) => rot(x, y, -angle));
  for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const w = Math.max(1, x1 - x0), hh = Math.max(1, y1 - y0);
  const [cx, cy] = rot((x0 + x1) / 2, (y0 + y1) / 2, angle);
  return { cx, cy, w, h: hh, angle, local: r.map(([x, y]) => [(x - (x0 + x1) / 2) / w, (y - (y0 + y1) / 2) / hh]) };
}

// 中心線 + 上下の幅 → リボン多角形（ページ座標）
export function ribbonPoly(center, up, dn) {
  const n = center.length, top = [], bot = [];
  for (let i = 0; i < n; i++) {
    const a = center[Math.max(0, i - 1)], b = center[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
    const nx = -ty, ny = tx; // 進行方向の右手側（画面では下）
    top.push([center[i][0] - nx * up[i], center[i][1] - ny * up[i]]);
    bot.push([center[i][0] + nx * dn[i], center[i][1] + ny * dn[i]]);
  }
  return top.concat(bot.reverse());
}

export function resample(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]]; let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i];
    let d = Math.hypot(x1 - x0, y1 - y0);
    while (acc + d >= step) {
      const t = (step - acc) / d; x0 += (x1 - x0) * t; y0 += (y1 - y0) * t; out.push([x0, y0]);
      d = Math.hypot(x1 - x0, y1 - y0); acc = 0;
    }
    acc += d;
  }
  const last = pts[pts.length - 1], o = out[out.length - 1];
  if (Math.hypot(last[0] - o[0], last[1] - o[1]) > step * 0.3) out.push(last);
  return out;
}

export function smooth(pts, win = 2) {
  return pts.map((_, i) => {
    let sx = 0, sy = 0, c = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(pts.length - 1, i + win); j++) { sx += pts[j][0]; sy += pts[j][1]; c++; }
    return [sx / c, sy / c];
  });
}

// 点列がほぼ直線か（弦からの最大ずれ）
export function straightness(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  let max = 0;
  for (const p of pts) max = Math.max(max, Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L);
  return { len: L, dev: max, angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}
