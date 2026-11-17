// 学習: 覚える(タイマー) → 自動で隠す → 思い出す → めくる → 自己評価 → 次回の復習日を決める。
import { db, getSettings, saveSettings } from './db.js';
import { h, toast, DAY, fmtDue, clamp } from './util.js';
import { icon } from './icons.js';
import { PageView, drawMask, bindPointers, zoomControls } from './view.js';
import * as G from './geom.js';
import { getWallet, markerById, recordSession, maskMarkerId, markerSwatch } from './rewards.js';
import { speechAvailable, listenOnce } from './speech.js';
import { norm } from './search.js';

// ---------- 間隔反復（忘れかけた頃にもう一度）。試験日があれば、その前に必ずもう一度回ってくるよう間隔を詰める ----------
// grade: 0=まだ / 1=あいまい / 2=覚えた
export function schedule(srs, grade, examDate, now = Date.now()) {
  const s = srs ? { ...srs } : { stab: 0, diff: 5, reps: 0, lapses: 0, due: now, last: now };
  const elapsed = Math.max(0, (now - (s.last || now)) / DAY);
  let interval;
  if (!s.reps || !s.stab) {
    s.stab = [0.2, 1, 3][grade]; interval = [10 / 1440, 1, 3][grade];
  } else {
    const R = 1 / (1 + elapsed / (9 * s.stab)); // 思い出せる見込み
    if (grade === 0) { s.stab = Math.max(0.2, s.stab * 0.35); s.diff = clamp(s.diff + 1, 1, 10); s.lapses++; interval = 10 / 1440; }
    else if (grade === 1) { s.stab = s.stab * (1.15 + (1 - R) * 0.4); s.diff = clamp(s.diff + 0.3, 1, 10); interval = Math.max(1, s.stab * 0.8); }
    else { s.stab = s.stab * (1.5 + (10 - s.diff) * 0.13 + (1 - R) * 1.6); s.diff = clamp(s.diff - 0.3, 1, 10); interval = s.stab; }
  }
  if (grade === 0 && !srs) s.lapses = 1;
  if (examDate && examDate > now && grade > 0) interval = Math.min(interval, Math.max(0.5, ((examDate - now) / DAY) * 0.45));
  s.reps++; s.last = now; s.grade = grade; s.due = now + interval * DAY;
  return s;
}
export const GRADES = [{ label: 'まだ', sub: 'すぐもう一度', color: '#f03e3e', sym: '✕' }, { label: 'あいまい', sub: '近いうちに', color: '#f59f00', sym: '△' }, { label: '覚えた', sub: '間をあけて', color: '#2f9e44', sym: '◯' }];

// いま（または指定の時刻に）思い出せる見込み 0〜1。未学習は 0
export const recallAt = (srs, t) => (!srs || !srs.stab ? 0 : 1 / (1 + Math.max(0, (t - (srs.last || t)) / DAY) / (9 * srs.stab)));
// 試験日からの逆算。masks: 隠しの配列。返り値は表示用の数字
export function forecast(masks, examDate, now = Date.now()) {
  const total = masks.length; if (!total) return null;
  const days = Math.max(0, Math.ceil((examDate - now) / DAY));
  const fresh = masks.filter((m) => !m.srs).length, due = masks.filter((m) => m.srs && m.srs.due <= now).length;
  const avg = (t) => Math.round((masks.reduce((n, m) => n + recallAt(m.srs, t), 0) / total) * 100);
  // 新しく覚える分は、最後の2日を総復習に空けて、残りの日数で均等に割る
  const perDay = fresh ? Math.ceil(fresh / Math.max(1, days - 2)) : 0;
  return { total, days, fresh, due, nowPct: avg(now), examPct: avg(examDate), perDay, tight: fresh > 0 && days <= 2 };
}

// 弱点の度合い: new / weak / mid / good
export function strength(srs) {
  if (!srs) return 'new';
  if (srs.grade === 0 || srs.lapses >= 2) return 'weak';
  if (srs.grade === 1) return 'mid';
  return 'good';
}

const readingOrder = (masks) => masks.slice().sort((a, b) => (Math.abs(a.cy - b.cy) < Math.max(a.h, b.h) * 0.6 ? a.cx - b.cx : a.cy - b.cy));

export async function dueItems(deckId, now = Date.now()) {
  const pages = deckId ? await db.pagesOf(deckId) : await db.allPages();
  const out = [];
  for (const p of pages) for (const m of p.masks) if (m.srs && m.srs.due <= now) out.push({ pageId: p.id, maskId: m.id, due: m.srs.due });
  return out.sort((a, b) => a.due - b.due);
}

function confetti() {
  const c = h('canvas.confetti'); document.body.append(c); c.width = innerWidth; c.height = innerHeight;
  const ctx = c.getContext('2d'), cols = ['#ff8a3d', '#4c6ef5', '#2f9e44', '#f783ac', '#ffd43b'];
  const ps = Array.from({ length: 90 }, () => ({ x: innerWidth / 2, y: innerHeight * 0.35, vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 3, r: Math.random() * 5 + 3, c: cols[(Math.random() * cols.length) | 0], a: Math.random() * 6 }));
  let t = 0; (function step() { ctx.clearRect(0, 0, c.width, c.height); for (const p of ps) { p.x += p.vx; p.y += p.vy; p.vy += 0.4; p.a += 0.2; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); ctx.restore(); } if (++t < 120) requestAnimationFrame(step); else c.remove(); })();
}

// mode: 'page'（このページ） / 'deck'（教材全体） / 'review'（今日の復習。deckId無しなら全教材） / 'weak'（苦手だけ）
export async function openStudy(root, { deckId, pageId, mode = 'page', nav }) {
  const settings = await getSettings(); const wallet = await getWallet(); const marker = markerById(wallet.marker);
  const allPages = deckId ? await db.pagesOf(deckId) : await db.allPages();
  const decks = new Map((await db.decks()).map((d) => [d.id, d]));
  const pageById = new Map(allPages.map((p) => [p.id, p]));
  let items = [];
  if (mode === 'review') items = (await dueItems(deckId)).slice(0, 40).map(({ pageId: p, maskId }) => ({ pageId: p, maskId }));
  else {
    const src = mode === 'page' ? allPages.filter((p) => p.id === pageId) : allPages.slice().sort((a, b) => a.index - b.index);
    for (const p of src) for (const m of readingOrder(p.masks)) if (mode !== 'weak' || strength(m.srs) === 'weak' || strength(m.srs) === 'mid') items.push({ pageId: p.id, maskId: m.id });
  }
  const back = () => (deckId ? nav.deck(deckId) : nav.home());
  if (!items.length) { toast(mode === 'review' ? '今日の復習はありません。おつかれさま！' : 'まだ隠した所がありません。まず隠す場所を作りましょう'); back(); return () => {}; }
  items.forEach((it) => { it.state = 'hidden'; it.grade = null; it.hint = 0; });
  const maskOf = (it) => pageById.get(it.pageId).masks.find((m) => m.id === it.maskId);
  // 色で選ぶ: 何色かのマーカーを使い分けているとき、「この色だけ隠す／この色は隠さない」を選べる（このページ・教材ぜんぶ の学習で）
  const allItems = items, mkId = (m) => maskMarkerId(m, wallet);
  const colorCount = new Map(); for (const it of allItems) { const id = mkId(maskOf(it)); colorCount.set(id, (colorCount.get(id) || 0) + 1); }
  const canFilter = (mode === 'page' || mode === 'deck') && colorCount.size > 1;
  const colorsOn = new Set([...colorCount.keys()].filter((id) => !(settings.offColors || []).includes(id)));
  if (!colorsOn.size) for (const id of colorCount.keys()) colorsOn.add(id);
  const applyColors = () => { if (canFilter) items = allItems.filter((it) => colorsOn.has(mkId(maskOf(it)))); };
  applyColors();
  const shown = (m) => !canFilter || colorsOn.has(mkId(m)); // false = この色は今回は隠さない（そのまま見せる）
  // 場所で覚えてしまうのを防ぐ出し方: 順番をばらばらにし、出題している所のまわりだけを見せる（ページのどこにあるかを手がかりにできない）
  let mix = !!settings.studyMix && mode !== 'review';
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const windowOf = (m) => { const b = G.bounds(m), w = b.x1 - b.x0, hh = b.y1 - b.y0;
    return hh > w * 1.5 ? { x0: b.x0 - w * 3, y0: -1e5, x1: b.x1 + w * 3, y1: 1e5 } : { x0: -1e5, y0: b.y0 - hh * 2.3, x1: 1e5, y1: b.y1 + hh * 2.3 }; };

  let phase = mode === 'review' || mode === 'weak' ? 'test' : 'setup'; // setup → memorize → test → done
  let cur = 0, page = null, endAt = 0, paused = 0, timerId = 0, graded = 0, total = settings.timer;
  const imgs = new Map();
  const getImg = async (p) => { if (!imgs.has(p.id)) imgs.set(p.id, await createImageBitmap(p.blob)); return imgs.get(p.id); };

  const canvas = h('canvas.page-canvas'); const stage = h('div.ed-stage', canvas);
  const prog = h('span.st-prog'); const bar = h('div.st-bar', h('i'));
  const sheetBtn = h('button.chip', { title: '赤シート／緑シートを重ねる', onclick: () => { view.sheet = view.sheet === null ? 'red' : view.sheet === 'red' ? 'green' : null; sheetBtn.textContent = view.sheet === 'red' ? '赤シート' : view.sheet === 'green' ? '緑シート' : 'シートなし'; sheetBtn.classList.toggle('on', !!view.sheet); view.draw(); } }, 'シートなし');
  const top = h('header.ed-top', h('button.icon-btn', { 'aria-label': '戻る', onclick: () => finishEarly() }, icon('back')),
    h('div.ed-title', h('strong', { review: '今日の復習', weak: '苦手を集中', deck: '教材ぜんぶ', page: 'このページ' }[mode]), prog), sheetBtn);
  const panel = h('div.st-panel');
  root.replaceChildren(h('div.editor.study', top, bar, stage, panel));
  const view = new PageView(canvas, stage);
  stage.append(zoomControls(view));

  view.paint = (ctx, v) => {
    if (!page) return;
    const byId = new Map(items.filter((it) => it.pageId === page.id).map((it) => [it.maskId, it]));
    for (const m of page.masks) {
      if (!shown(m)) continue;
      const it = byId.get(m.id), isCur = it && items[cur] === it && phase === 'test';
      if (phase === 'memorize' || phase === 'setup') { drawMask(ctx, m, marker, 'peek', v); continue; }
      if (it && it.state === 'open') { drawMask(ctx, m, marker, 'open', v, { color: it.grade != null ? GRADES[it.grade].color : '#4c6ef5', ring: isCur ? 'rgba(76,110,245,.85)' : null }); continue; }
      if (it && it.hint >= 1 && !m.text) { // 文字が分からない隠しのヒント: 左から少しだけ見せる
        const f = Math.min(0.6, it.hint * 0.25); const clip = new Path2D();
        [[-0.5 + f, -0.6], [0.6, -0.6], [0.6, 0.6], [-0.5 + f, 0.6]].forEach(([x, y], i) => { const p = G.localToPage(m, x, y); i ? clip.lineTo(...p) : clip.moveTo(...p); });
        ctx.save(); ctx.clip(clip); drawMask(ctx, m, marker, 'hidden', v); ctx.restore();
        if (isCur) drawMask(ctx, { ...m }, marker, 'open', v, { color: 'transparent', ring: 'rgba(76,110,245,.85)' });
        continue;
      }
      drawMask(ctx, m, marker, 'hidden', v, { ring: isCur ? 'rgba(76,110,245,.85)' : null });
    }
    if (mix && phase === 'test' && items[cur] && items[cur].pageId === page.id) { // まわり以外は紙の色でおおう
      const wn = windowOf(maskOf(items[cur])), p = new Path2D();
      p.rect(-1e5, -1e5, 2e5 + page.w, 2e5 + page.h); p.rect(wn.x0, wn.y0, wn.x1 - wn.x0, wn.y1 - wn.y0);
      ctx.save(); ctx.fillStyle = '#f1f0ea'; ctx.fill(p, 'evenodd'); ctx.restore();
    }
  };

  bindPointers(view, (() => { let g = null; return {
    down(x, y) { g = { x, y, lx: x, ly: y, moved: false }; },
    move(x, y) { if (!g) return; if (Math.hypot(x - g.x, y - g.y) > 7) g.moved = true; if (g.moved) { view.panBy(x - g.lx, y - g.ly); g.lx = x; g.ly = y; } },
    up(x, y) {
      const was = g; g = null; if (!was || was.moved || phase !== 'test') return;
      const [px, py] = view.toPage(x, y); const m = page.masks.filter((q) => G.hit(q, px, py, 8 / view.s)).pop(); if (!m) return;
      const i = items.findIndex((it) => it.maskId === m.id); if (i < 0) return;
      if (i !== cur) { cur = i; render(); if (items[i].state === 'hidden') return; }
      if (items[cur].state === 'hidden') reveal();
    },
    cancel() { g = null; },
  }; })());

  async function showPageOf(it, zoom) {
    const p = pageById.get(it.pageId);
    if (page !== p) { page = p; view.setPage(p, await getImg(p)); }
    if (phase === 'test') view.focus(maskOf(it), zoom);
  }
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function render() {
    const done = items.filter((it) => it.grade != null).length;
    prog.textContent = phase === 'test' || phase === 'done' ? `${done} / ${items.length}` : `隠した所 ${items.length}か所`;
    bar.firstChild.style.width = `${(done / items.length) * 100}%`;
    clearInterval(timerId);
    if (phase === 'setup') {
      const opts = [[30, '30秒'], [60, '1分'], [180, '3分'], [0, 'タイマーなし']];
      const custom = h('input.num', { type: 'number', min: 5, max: 3600, step: 5, value: [30, 60, 180, 0].includes(total) ? '' : total, placeholder: '秒', 'aria-label': '秒数を自分で決める', oninput: (e) => { const v = Number(e.target.value); if (v >= 5) { total = v; render0(); } } });
      const seg = h('div.seg.wide');
      const render0 = () => seg.replaceChildren(...opts.map(([v, l]) => h('button.tool.only' + (total === v ? '.on' : ''), { onclick: () => { total = v; custom.value = ''; render0(); } }, l)));
      render0();
      const colorRow = canFilter ? h('div.color-pick', h('span.cp-cap', '隠す色'), [...colorCount].map(([id, n]) => h('button.cp-chip', { 'aria-pressed': String(colorsOn.has(id)),
        onclick: async () => {
          if (colorsOn.has(id)) { if (colorsOn.size === 1) return toast('少なくとも1色は隠してください'); colorsOn.delete(id); } else colorsOn.add(id);
          await saveSettings({ offColors: [...new Set([...(settings.offColors || []).filter((x) => !colorCount.has(x)), ...[...colorCount.keys()].filter((x) => !colorsOn.has(x))])] });
          applyColors(); cur = 0; render();
        } }, markerSwatch(markerById(id), 20), h('span', markerById(id).name), h('small', colorsOn.has(id) ? `${n}か所・隠す` : '隠さない')))) : null;
      const mixRow = mode === 'review' ? null : h('div.color-pick', h('span.cp-cap', '出し方'),
        [[false, 'ページの順', '上から順に'], [true, 'ばらばら', 'まわりだけ見せて、順番もまぜる']].map(([v, l, sub]) => h('button.cp-chip', { 'aria-pressed': String(mix === v), onclick: async () => { mix = v; await saveSettings({ studyMix: v }); render(); } }, h('span', l), h('small', sub))));
      panel.replaceChildren(h('div.st-card', h('h3', 'まず、答えを見ながら覚えよう'), h('p.muted', '時間になると自動で隠れて、テストが始まります。'),
        colorRow, mixRow, seg, h('div.row.center', h('span.muted', '自分で決める'), custom, h('span.muted', '秒')),
        h('div.row.center', h('button.btn', { onclick: () => { phase = 'test'; start(); } }, 'すぐテストする'),
          h('button.btn.primary.big', { onclick: async () => { await saveSettings({ timer: total }); phase = 'memorize'; endAt = total ? Date.now() + total * 1000 : 0; paused = 0; render(); } }, icon('play', 18), '覚えるスタート'))));
      showPageOf(items[0]); view.draw(); return;
    }
    if (phase === 'memorize') {
      const clock = h('div.clock'); const ring = h('div.ring', clock);
      const tick = () => {
        if (!endAt) { clock.textContent = '∞'; return; }
        const left = paused || endAt - Date.now(); clock.textContent = fmt(left);
        ring.style.setProperty('--p', String(1 - left / (total * 1000)));
        if (left <= 0) { phase = 'test'; toast('時間です。答えを隠しました — テスト開始！'); start(); }
      };
      panel.replaceChildren(h('div.st-card.row.between', ring,
        h('div.col', h('strong', '覚える時間'), h('span.muted', 'マーカーの所が、あとで隠れます')),
        h('div.row', endAt ? h('button.btn', { onclick: () => { if (paused) { endAt = Date.now() + paused; paused = 0; } else paused = endAt - Date.now(); render(); } }, paused ? '再開' : '一時停止') : null,
          endAt ? h('button.btn', { onclick: () => { if (paused) paused += 30000; else endAt += 30000; total += 30; tick(); } }, '+30秒') : null,
          h('button.btn.primary', { onclick: () => { phase = 'test'; start(); } }, 'テスト開始'))));
      tick(); timerId = setInterval(tick, 200); view.draw(); return;
    }
    if (phase === 'test') {
      const it = items[cur], m = maskOf(it);
      if (it.state === 'hidden') {
        const hintTxt = !m.text || !it.hint ? '' : it.hint === 1 ? `ヒント: ${[...m.text].length}文字` : `ヒント: ${[...m.text][0]}${'●'.repeat(Math.max(0, [...m.text].length - 1))}`;
        panel.replaceChildren(h('div.st-card.row.between',
          h('div.col', h('strong', '思い出してみよう'), h('span.muted', hintTxt || '頭の中で答えてから、めくって確かめます')),
          h('div.row',
            h('button.btn', { onclick: () => { it.hint = Math.min(3, it.hint + 1); if (m.text && it.hint > 2) return reveal(); render(); } }, icon('bulb', 16), 'ヒント'),
            speechAvailable && m.text ? h('button.btn.mic-btn', { onclick: async (e) => { const btn = e.currentTarget; const t = await listenOnce((on) => btn.classList.toggle('rec', on)); if (!t) return; const a = norm(t), b = norm(m.text); if (a && (a.includes(b) || (a.length >= 2 && b.includes(a)))) { toast(`「${t}」— 正解！`); reveal(); } else toast(`「${t}」… ちがうかも。めくって確かめよう`); } }, icon('mic', 16), '声で答える') : null,
            h('button.btn.primary.big', { onclick: () => reveal() }, icon('eye', 18), 'めくる'))));
      } else {
        panel.replaceChildren(h('div.st-card',
          h('div.row.between', h('div.col', h('span.muted', it.hint ? 'ヒントを使いました' : 'どうだった？'), m.text ? h('strong.answer', m.text) : null),
            h('div.grades', GRADES.map((g, i) => h('button.grade', { style: { '--g': g.color }, onclick: () => grade(i) }, h('b', `${g.sym} ${g.label}`), h('small', g.sub)))))));
      }
      view.draw(); return;
    }
  }

  let mixed = false;
  async function start() { if (mix && !mixed) { mixed = true; items = shuffle(items.slice()); } cur = items.findIndex((it) => it.grade == null); if (cur < 0) cur = 0; await showPageOf(items[cur], mix || mode !== 'page' || view.cw < 560); render(); }
  function reveal() { items[cur].state = 'open'; render(); }
  async function grade(g) {
    const it = items[cur], p = pageById.get(it.pageId), m = maskOf(it);
    if (it.grade == null) graded++;
    it.grade = g; m.srs = schedule(m.srs, g, decks.get(p.deckId)?.examDate); (m.log = m.log || []).push({ t: Date.now(), g }); if (m.log.length > 30) m.log.shift();
    db.putPage(p);
    let next = -1;
    for (let k = 1; k <= items.length; k++) { const j = (cur + k) % items.length; if (items[j].grade == null) { next = j; break; } }
    if (next < 0) return finish();
    cur = next; await showPageOf(items[cur], mix || mode !== 'page' || view.cw < 560); render();
  }
  async function finishEarly() { if (graded && phase === 'test') return finish(); back(); }
  async function finish() {
    phase = 'done'; clearInterval(timerId);
    const r = await recordSession(graded);
    const cnt = [0, 1, 2].map((g) => items.filter((it) => it.grade === g).length);
    const retry = items.filter((it) => it.grade === 0 || it.grade === 1);
    const soon = items.filter((it) => it.grade != null).map((it) => maskOf(it).srs.due).sort((a, b) => a - b)[0];
    if (cnt[2] >= items.length * 0.6) confetti();
    prog.textContent = `${graded} / ${items.length}`; bar.firstChild.style.width = `${(graded / items.length) * 100}%`;
    items.forEach((it) => { if (it.grade != null) it.state = 'open'; }); view.draw();
    panel.replaceChildren(h('div.st-card.result',
      h('h3', 'おつかれさま！'),
      h('div.res-row', GRADES.map((g, i) => h('div.res', { style: { '--g': g.color } }, h('b', String(cnt[i])), h('span', `${g.sym} ${g.label}`))).reverse()),
      h('div.coin-get', h('span.coin'), `+${r.coins} コイン`, r.firstToday ? h('small', `今日はじめての学習！ ${r.streak}日目`) : null),
      soon ? h('p.muted', `次の復習は ${fmtDue(soon)}。忘れかけた頃に「今日の復習」に出てきます。`) : null,
      h('div.row.center',
        retry.length ? h('button.btn', { onclick: () => { items = retry; items.forEach((it) => { it.state = 'hidden'; it.grade = null; it.hint = 0; }); graded = 0; phase = 'test'; start(); } }, `まだ・あいまいの ${retry.length}か所をもう一度`) : null,
        h('button.btn.primary', { onclick: back }, 'おわる'))));
  }

  if (phase === 'test') await start(); else render();
  return () => { clearInterval(timerId); view.destroy(); imgs.forEach((b) => b.close?.()); };
}

// ---------- 一問一答（保存した問題） ----------
export async function openQuiz(root, { deckId, nav }) {
  const deck = await db.deck(deckId);
  const now = Date.now();
  let qs = (deck.questions || []).filter((q) => !q.srs || q.srs.due <= now);
  if (!qs.length) qs = (deck.questions || []).slice();
  if (!qs.length) { toast('まだ問題がありません。エディタで「問題を作る」を試してください'); nav.deck(deckId); return () => {}; }
  let i = 0, open = false, graded = 0; const marks = [];
  const body = h('div.quiz-body');
  root.replaceChildren(h('div.screen', h('header.ed-top', h('button.icon-btn', { 'aria-label': '戻る', onclick: () => end() }, icon('back')), h('div.ed-title', h('strong', '一問一答'), h('span.st-prog'))), body));
  const prog = root.querySelector('.st-prog');
  async function end() { if (graded) { const r = await recordSession(graded); toast(`+${r.coins} コイン`); } nav.deck(deckId); }
  function render() {
    if (i >= qs.length) {
      const cnt = [0, 1, 2].map((g) => marks.filter((m) => m === g).length);
      body.replaceChildren(h('div.st-card.result', h('h3', 'おつかれさま！'), h('div.res-row', GRADES.map((g, k) => h('div.res', { style: { '--g': g.color } }, h('b', String(cnt[k])), h('span', `${g.sym} ${g.label}`))).reverse()),
        h('div.row.center', h('button.btn.primary', { onclick: end }, 'おわる'))));
      if (cnt[2] >= qs.length * 0.6) confetti(); return;
    }
    const q = qs[i]; prog.textContent = `${i + 1} / ${qs.length}`;
    body.replaceChildren(h('div.quiz-card', h('div.q-label', 'Q'), h('p.q-text', q.q),
      open ? h('div.a-box', h('div.q-label.a', 'A'), h('p.a-text', q.a), q.evidence ? h('p.q-ev', '根拠: ', h('q', q.evidence)) : null) : null),
      open ? h('div.grades.center', GRADES.map((g, k) => h('button.grade', { style: { '--g': g.color }, onclick: async () => { q.srs = schedule(q.srs, k, deck.examDate); marks.push(k); graded++; await db.putDeck(deck); i++; open = false; render(); } }, h('b', `${g.sym} ${g.label}`), h('small', g.sub))))
        : h('div.row.center', h('button.btn.primary.big', { onclick: () => { open = true; render(); } }, icon('eye', 18), '答えを見る')));
  }
  render();
  return () => {};
}
