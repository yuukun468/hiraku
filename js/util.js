// 小さな共通部品: DOM生成、トースト、シート(モーダル)、ID、日付
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const DAY = 86400000;
export const todayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// h('div.card', {onclick}, child, ...)
export function h(sel, attrs, ...kids) {
  const [tagId, ...cls] = sel.split('.');
  const [tag, id] = tagId.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [p, val] of Object.entries(v)) (p.startsWith('--') ? el.style.setProperty(p, val) : (el.style[p] = val)); }
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : String(c)); };
  kids.forEach(add);
  return el;
}

let toastTimer = null;
export function toast(msg, action) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div#toast', { role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.replaceChildren(h('span', msg));
  if (action) el.append(h('button.toast-btn', { onclick: () => { el.classList.remove('show'); action.fn(); } }, action.label));
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 5000 : 2600);
}

// 下からのシート / 中央ダイアログ。close() を返す。
export function sheet(title, body, { wide = false, onClose } = {}) {
  const back = h('div.sheet-back');
  const close = () => { back.classList.remove('open'); setTimeout(() => back.remove(), 180); onClose && onClose(); };
  const box = h('div.sheet' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-label': title },
    h('div.sheet-head', h('h2', title), h('button.icon-btn', { 'aria-label': '閉じる', onclick: close }, '✕')),
    h('div.sheet-body', body));
  back.append(box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  requestAnimationFrame(() => back.classList.add('open'));
  return close;
}

export function confirmSheet(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const close = sheet(title, h('div', h('p.muted', message),
      h('div.row.end', h('button.btn', { onclick: () => { close(); } }, 'やめる'),
        h('button.btn' + (danger ? '.danger' : '.primary'), { onclick: () => { done = true; close(); resolve(true); } }, okLabel))),
    { onClose: () => { if (!done) resolve(false); } });
  });
}

export function busy(label) {
  const bar = h('div.busy-bar'); const txt = h('div.busy-txt', label);
  const el = h('div.busy', h('div.busy-card', h('div.spinner'), txt, h('div.busy-track', bar)));
  document.body.append(el);
  return { set(t, p) { if (t) txt.textContent = t; if (p != null) bar.style.width = Math.round(p * 100) + '%'; }, show(v) { el.hidden = !v; }, done() { el.remove(); } };
}

export const fmtDue = (ms) => {
  const d = ms - Date.now();
  if (d <= 0) return '今';
  if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + '分後';
  if (d < DAY) return Math.round(d / 3600000) + '時間後';
  return Math.round(d / DAY) + '日後';
};

export function blobToImage(blob) {
  return new Promise((res, rej) => { const url = URL.createObjectURL(blob); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); }; img.src = url; });
}
export const canvasToBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise((r) => c.toBlob(r, type, q));
export function makeCanvas(w, h2) { const c = document.createElement('canvas'); c.width = w; c.height = h2; return c; }
