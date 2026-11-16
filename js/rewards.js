// ごほうび: 勉強で貯めたコインを、壁紙やマーカーのデザインに交換する。
// 購入・換金・ガチャ・「途切れたら没収」は無し。コインは自己評価の良し悪しでなく「取り組んだ量」に対して出す
// （「覚えた」を押す方が得、という嘘の動機を作らないため）。
import { db } from './db.js';
import { makeCanvas, todayKey } from './util.js';

export const WALLPAPERS = [
  { id: 'paper', name: 'しろい紙', price: 0, css: 'linear-gradient(180deg,#f6f5f1,#efeee8)' },
  { id: 'sky', name: 'あおぞら', price: 40, css: 'linear-gradient(180deg,#cfe9ff 0%,#eaf6ff 55%,#fff7e8 100%)' },
  { id: 'sakura', name: 'さくら', price: 60, css: 'radial-gradient(circle at 20% 15%,#ffd9e6 0,transparent 42%),radial-gradient(circle at 85% 80%,#ffe9c9 0,transparent 45%),linear-gradient(180deg,#fff5f8,#fdeef3)' },
  { id: 'mint', name: 'ミントソーダ', price: 60, css: 'linear-gradient(135deg,#d7f5e9,#e6f3ff 60%,#f3ecff)' },
  { id: 'sunset', name: 'ゆうやけ', price: 90, css: 'linear-gradient(180deg,#ffd1a8 0%,#ffb3b3 45%,#c9b6ff 100%)' },
  { id: 'grid', name: 'ほうがんノート', price: 90, css: 'linear-gradient(#dfe7f3 1px,transparent 1px) 0 0/24px 24px,linear-gradient(90deg,#dfe7f3 1px,transparent 1px) 0 0/24px 24px,#f8fafd' },
  { id: 'night', name: 'よぞら', price: 140, dark: true, css: 'radial-gradient(circle at 18% 22%,rgba(255,255,255,.9) 0 1px,transparent 2px),radial-gradient(circle at 72% 12%,rgba(255,255,255,.8) 0 1px,transparent 2px),radial-gradient(circle at 44% 68%,rgba(255,255,255,.7) 0 1px,transparent 2px),radial-gradient(circle at 88% 58%,rgba(255,255,255,.8) 0 1.5px,transparent 2.5px),linear-gradient(180deg,#141a3a,#2a2458 60%,#4b2f6b)' },
  { id: 'aurora', name: 'オーロラ', price: 200, dark: true, css: 'radial-gradient(ellipse at 30% 0%,rgba(77,255,190,.55),transparent 55%),radial-gradient(ellipse at 80% 10%,rgba(137,120,255,.6),transparent 55%),linear-gradient(180deg,#0d1b2a,#1b2a4a)' },
];

// マーカー: fill(ctx, path, {alpha}) で描く。pattern は初回に生成。
function pat(draw, size = 24) { let p = null; return (ctx) => { if (!p) { const c = makeCanvas(size, size); draw(c.getContext('2d'), size); p = c; } return ctx.createPattern(p, 'repeat'); }; }
export const MARKERS = [
  // いつでも使える基本の色（コインは要りません）
  { id: 'orange', name: 'オレンジ', price: 0, color: '#ff8a3d' },
  { id: 'red', name: 'あか', price: 0, color: '#e5484d' },
  { id: 'ocean', name: 'あお', price: 0, color: '#2f7fe0' },
  { id: 'green', name: 'みどり', price: 0, color: '#1fa971' },
  { id: 'yellow', name: 'きいろ', price: 0, color: '#f2c200' },
  { id: 'ink', name: 'すみ色', price: 0, color: '#2b2f3a' },
  // コインと交換するデザイン
  { id: 'berry', name: 'ベリー', price: 30, color: '#d6457c' },
  { id: 'purple', name: 'むらさき', price: 30, color: '#7a5af0' },
  { id: 'aqua', name: 'そらいろ', price: 30, color: '#19b5c9' },
  { id: 'cocoa', name: 'ココア', price: 30, color: '#8a5a44' },
  { id: 'stripe', name: 'しましまテープ', price: 80, pattern: pat((c, s) => { c.fillStyle = '#ffd166'; c.fillRect(0, 0, s, s); c.strokeStyle = '#f29e4c'; c.lineWidth = 6; for (let i = -s; i < s * 2; i += 12) { c.beginPath(); c.moveTo(i, s); c.lineTo(i + s, 0); c.stroke(); } }), color: '#f2b24c' },
  { id: 'dots', name: 'みずたま', price: 80, pattern: pat((c, s) => { c.fillStyle = '#7cc6f2'; c.fillRect(0, 0, s, s); c.fillStyle = '#fff'; for (const [x, y] of [[6, 6], [18, 18]]) { c.beginPath(); c.arc(x, y, 3.2, 0, 7); c.fill(); } }), color: '#7cc6f2' },
  { id: 'washi', name: 'マスキングテープ', price: 80, pattern: pat((c, s) => { ['#ffd6e0', '#fff1c1', '#d4f1e4', '#d6e6ff'].forEach((col, i) => { c.fillStyle = col; c.fillRect(i * s / 4, 0, s / 4, s); }); }), color: '#f3b7c6' },
  { id: 'check', name: 'ギンガムチェック', price: 100, pattern: pat((c, s) => { c.fillStyle = '#fff'; c.fillRect(0, 0, s, s); c.fillStyle = 'rgba(226,84,112,.55)'; c.fillRect(0, 0, s / 2, s); c.fillRect(0, 0, s, s / 2); }), color: '#e25470' },
  { id: 'mintchoco', name: 'チョコミント', price: 100, pattern: pat((c, s) => { c.fillStyle = '#9fe3cf'; c.fillRect(0, 0, s, s); c.fillStyle = '#5a3a2e'; for (const [x, y, w] of [[3, 5, 5], [14, 9, 4], [8, 17, 5], [19, 20, 3], [20, 2, 3]]) c.fillRect(x, y, w, 2.4); }), color: '#6fcfb4' },
  { id: 'heart', name: 'ハート', price: 120, pattern: pat((c, s) => { c.fillStyle = '#ffe3ec'; c.fillRect(0, 0, s, s); c.fillStyle = '#f0608c'; for (const [x, y] of [[6, 7], [18, 19]]) { c.beginPath(); c.moveTo(x, y + 3.6); c.bezierCurveTo(x - 6, y - 1, x - 2.5, y - 5, x, y - 1.6); c.bezierCurveTo(x + 2.5, y - 5, x + 6, y - 1, x, y + 3.6); c.fill(); } }), color: '#f0608c' },
  { id: 'mk-sakura', name: 'さくらふぶき', price: 120, pattern: pat((c, s) => { c.fillStyle = '#fff5f8'; c.fillRect(0, 0, s, s); c.fillStyle = '#ff9db8'; for (const [x, y, a] of [[5, 6, 0.4], [17, 5, 2], [11, 15, 1.1], [21, 19, 2.6], [3, 20, 3.5]]) { c.save(); c.translate(x, y); c.rotate(a); c.beginPath(); c.ellipse(0, 0, 3.4, 1.9, 0, 0, 7); c.fill(); c.restore(); } }), color: '#ff9db8' },
  { id: 'stars', name: 'ほしぞら', price: 150, pattern: pat((c, s) => { c.fillStyle = '#27295c'; c.fillRect(0, 0, s, s); c.fillStyle = '#ffe98a'; for (const [x, y, r] of [[5, 7, 1.6], [17, 4, 1], [12, 16, 2], [21, 20, 1.2], [3, 20, 1]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); } }, 24), color: '#27295c' },
  { id: 'pastel', name: 'パステル', price: 150, gradient: ['#ffc9de', '#ffe7b8', '#c9f2dc', '#c9defc', '#e2d1ff'], color: '#c9defc' },
  { id: 'mk-sunset', name: 'ゆうやけ', price: 150, gradient: ['#ff9a6b', '#ff6f91', '#a76bff'], color: '#ff6f91' },
  { id: 'gold', name: 'きんいろ', price: 180, gradient: ['#b8860b', '#ffd95e', '#fff3b0', '#ffd95e', '#b8860b'], color: '#e0b030' },
  { id: 'rainbow', name: 'にじ', price: 200, gradient: ['#ff7a7a', '#ffc46b', '#f5ee7a', '#7ddc9a', '#7ab8ff', '#b49bff'], color: '#7ab8ff' },
  { id: 'galaxy', name: 'ぎんが', price: 240, gradient: ['#1b1f5e', '#5b2a86', '#c2408f', '#ff9b6a'], color: '#5b2a86' },
];
export const markerById = (id) => MARKERS.find((m) => m.id === id) || MARKERS[0];
// 持っているか（値段0のものは最初から全員が使える）
export const owns = (w, it) => !it.price || w.owned.includes(it.id);
// 隠し1つぶんのマーカー。色を持たない昔の隠しは「いま選んでいる色」で表示する
export const maskMarkerId = (m, w) => m.mk || w.marker;
// 丸い色見本
export function markerSwatch(mk, size = 28) {
  const c = makeCanvas(size * 2, size * 2), ctx = c.getContext('2d');
  ctx.beginPath(); ctx.arc(size, size, size - 1, 0, 7); ctx.fillStyle = markerFill(ctx, mk, { x0: 0, x1: size * 2 }); ctx.fill();
  c.style.width = c.style.height = size + 'px'; c.className = 'mk-sw'; return c;
}
export const wallpaperById = (id) => WALLPAPERS.find((w) => w.id === id) || WALLPAPERS[0];

export function markerFill(ctx, marker, box) {
  if (marker.pattern) return marker.pattern(ctx);
  if (marker.gradient) { const g = ctx.createLinearGradient(box.x0, 0, box.x1, 0); marker.gradient.forEach((c, i, a) => g.addColorStop(i / (a.length - 1), c)); return g; }
  return marker.color;
}

// ---- お財布（追記型の台帳） ----
const EMPTY = { coins: 0, ledger: [], owned: ['paper', 'ink', 'orange'], wallpaper: 'paper', marker: 'orange', streak: 0, lastDay: null, days: {} };
let wallet = null;
export async function getWallet() { if (!wallet) wallet = { ...EMPTY, ...(await db.get('wallet', {})) }; return wallet; }
async function save() { await db.set('wallet', wallet); document.dispatchEvent(new CustomEvent('wallet')); }

// バックアップの読み込み: ほかの端末のお財布と合わせる（減ることはない。コインは多い方、持ち物は両方）
export async function mergeWallet(o) {
  if (!o || typeof o !== 'object') return;
  const w = await getWallet();
  w.coins = Math.max(w.coins, Number(o.coins) || 0);
  w.owned = [...new Set([...w.owned, ...(Array.isArray(o.owned) ? o.owned : [])])];
  w.streak = Math.max(w.streak || 0, Number(o.streak) || 0);
  if (o.lastDay && (!w.lastDay || o.lastDay > w.lastDay)) w.lastDay = o.lastDay;
  for (const [d, n] of Object.entries(o.days || {})) w.days[d] = Math.max(w.days[d] || 0, Number(n) || 0);
  await save();
}

export const COIN_RULES = [
  ['めくって自己評価する（1か所）', 2], ['学習セッションをやりきる（5か所以上）', 10], ['その日はじめての学習', 5],
];

export async function earn(amount, reason) {
  const w = await getWallet();
  w.coins += amount; w.ledger.push({ t: Date.now(), amount, reason }); if (w.ledger.length > 500) w.ledger.shift();
  await save(); return w.coins;
}

// 学習1セッションぶんの記録。返り値 { coins, firstToday }
export async function recordSession(gradedCount) {
  const w = await getWallet(); const today = todayKey();
  let coins = gradedCount * 2; const parts = [`自己評価 ${gradedCount}か所`];
  if (gradedCount >= 5) { coins += 10; parts.push('やりきりボーナス'); }
  const firstToday = w.lastDay !== today;
  if (firstToday && gradedCount > 0) {
    coins += 5; parts.push('今日はじめての学習');
    const y = todayKey(Date.now() - 86400000);
    w.streak = w.lastDay === y ? w.streak + 1 : 1; // 途切れても没収はしない（数え直すだけ）
    w.lastDay = today;
  }
  w.days[today] = (w.days[today] || 0) + gradedCount;
  if (coins > 0) await earn(coins, parts.join('・')); else await save();
  return { coins, firstToday, streak: w.streak };
}

export async function buy(item) {
  const w = await getWallet();
  if (owns(w, item)) return true;
  if (w.coins < item.price) return false;
  w.coins -= item.price; w.owned.push(item.id); w.ledger.push({ t: Date.now(), amount: -item.price, reason: `${item.name} と交換` });
  await save(); return true;
}
export async function equip(kind, id) { const w = await getWallet(); w[kind] = id; await save(); applyWallpaper(); }

export async function applyWallpaper() {
  const w = await getWallet(), wp = wallpaperById(w.wallpaper);
  document.documentElement.style.setProperty('--wallpaper', wp.css);
  document.documentElement.classList.toggle('dark-wall', !!wp.dark);
}
