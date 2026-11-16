// 画面の切替とホーム・教材・ごほうび・設定
import { db, getSettings, saveSettings } from './db.js';
import { h, toast, sheet, confirmSheet, busy, DAY, todayKey, makeCanvas } from './util.js';
import { icon } from './icons.js';
import { importFiles, createSampleDeck, warmOcr } from './importer.js';
import { openEditor } from './editor.js';
import { openStudy, openQuiz, dueItems, strength, GRADES } from './study.js';
import { getWallet, applyWallpaper, WALLPAPERS, MARKERS, COIN_RULES, buy, equip, markerFill, mergeWallet, owns } from './rewards.js';
import { env, initPwa, onPwaChange, canInstall, promptInstall, swState, offlineInfo, saveOffline } from './pwa.js';
import { aiTest } from './ai.js';
import { outline } from './geom.js';

const root = document.getElementById('app');
let cleanup = null;
const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
const nav = {
  home: () => go('#/'), deck: (id) => go(`#/deck/${id}`), edit: (d, p) => go(`#/edit/${d}/${p}`),
  study: (d, p) => go(`#/study/${d}/${p}`), studyDeck: (d, mode) => go(`#/study/${d}/-/${mode}`), review: (d) => go(d ? `#/review/${d}` : '#/review'),
  quiz: (d) => go(`#/quiz/${d}`), shop: () => go('#/shop'), settings: () => go('#/settings'),
};

async function route() {
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  const [, name, a, b, c] = (location.hash || '#/').split('/');
  document.body.dataset.screen = name || 'home';
  document.getElementById('toast')?.classList.remove('show');
  document.querySelectorAll('.sheet-back').forEach((s) => s.remove());
  try {
    if (name === 'deck') await deckScreen(a);
    else if (name === 'edit') cleanup = await openEditor(root, { deckId: a, pageId: b, nav });
    else if (name === 'study') cleanup = await openStudy(root, { deckId: a, pageId: b === '-' ? null : b, mode: c || 'page', nav });
    else if (name === 'review') cleanup = await openStudy(root, { deckId: a || null, mode: 'review', nav });
    else if (name === 'quiz') cleanup = await openQuiz(root, { deckId: a, nav });
    else if (name === 'shop') await shopScreen();
    else if (name === 'settings') await settingsScreen();
    else await homeScreen();
  } catch (e) { console.error(e); toast('画面を開けませんでした: ' + (e.message || e)); if (name) nav.home(); }
}
window.addEventListener('hashchange', route);

const coinPill = (w) => h('button.coin-pill', { onclick: nav.shop, 'aria-label': `コイン ${w.coins}枚。ごほうびショップへ` }, h('span.coin'), h('b', String(w.coins)));
function tabs(active) {
  const t = (id, label, ic, fn) => h('button.tab' + (active === id ? '.on' : ''), { onclick: fn, 'aria-current': active === id ? 'page' : null }, icon(ic, 22), h('span', label));
  return h('nav.tabs', { 'aria-label': 'メニュー' }, t('home', 'ホーム', 'home', nav.home), t('shop', 'ごほうび', 'shop', nav.shop), t('settings', '設定', 'gear', nav.settings));
}
function filePicker(deck, onDone) {
  const inp = h('input', { type: 'file', accept: 'image/*,application/pdf', multiple: true, hidden: true,
    onchange: async () => { const files = [...inp.files]; inp.value = ''; if (!files.length) return; const d = await importFiles(files, deck); if (d) onDone(d); } });
  return inp;
}
// カメラで撮る: 撮影 → 四隅を合わせる（台形補正） → 取り込み → 「続けて撮る／隠しはじめる」。何枚撮っても1つの教材にまとまる。
function cameraPicker(deck, onIdle) {
  const inp = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true,
    onchange: async () => {
      const files = [...inp.files]; inp.value = ''; if (!files.length) return;
      const d = await importFiles(files, deck, { adjust: true }); if (!d) return;
      deck = d; const ps = await db.pagesOf(d.id); let acted = false;
      const close = sheet(`${ps.length}ページ目を取り込みました`, h('div', h('p.muted', '続けて次のページを撮るか、隠す作業に進みます。'),
        h('div.row.end.wrap',
          h('button.btn', { onclick: () => { acted = true; close(); inp.click(); } }, icon('camera', 16), '続けて撮る'),
          h('button.btn.primary', { onclick: () => { acted = true; close(); nav.edit(d.id, ps[ps.length - 1].id); } }, '隠しはじめる'))),
      { onClose: () => { if (!acted) onIdle(d); } });
    } });
  return inp;
}
const afterImport = async (d) => { const ps = await db.pagesOf(d.id); toast('取り込みました。隠したい所をなぞってみましょう'); nav.edit(d.id, ps[0].id); };

// 名前などを1つ入力してもらう小窓。キャンセルは null
function askText(title, value = '', placeholder = '') {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (done) return; done = true; close(); res(v); };
    const inp = h('input.text-in', { type: 'text', value, placeholder, maxlength: 30, 'aria-label': title });
    const close = sheet(title, h('form', { onsubmit: (e) => { e.preventDefault(); fin(inp.value.trim()); } }, inp,
      h('div.row.end', { style: { marginTop: '12px' } }, h('button.btn', { type: 'button', onclick: () => fin(null) }, 'やめる'), h('button.btn.primary', { type: 'submit' }, '決定'))), { onClose: () => fin(null) });
    setTimeout(() => inp.focus(), 50);
  });
}
// フォルダは教材の「folder」に名前を持たせるだけ（教材が1つも無くなったフォルダは自然に消える）
// フォルダは教材の「folder」にパス（例: 英語/文法/時制）を持たせるだけ。教材が1つも無くなったフォルダは自然に消える
const foldersOf = (decks) => { const set = new Set(); for (const d of decks) if (d.folder) d.folder.split('/').forEach((_, k, a) => set.add(a.slice(0, k + 1).join('/'))); return [...set].sort((a, b) => a.localeCompare(b, 'ja')); };
const inFolder = (d, f) => d.folder === f || (d.folder || '').startsWith(f + '/');
const folderLabel = (f) => f.split('/').join(' › ');
const cleanName = (n) => (n || '').trim().replace(/\//g, '／');
// 新しいフォルダをどこに作るか選んでもらう。'' = いちばん上、null = やめる
function askParent(folders) {
  return new Promise((res) => {
    let done = false; const fin = (v) => { if (done) return; done = true; close(); res(v); };
    const close = sheet('どこに作りますか？', h('div.col.gap', h('button.choice', { onclick: () => fin('') }, h('strong', 'いちばん上に作る')),
      folders.map((p) => h('button.choice', { onclick: () => fin(p) }, h('strong', `「${folderLabel(p)}」の中に作る`)))), { onClose: () => fin(null) });
  });
}

// ---------------- ホーム ----------------
async function homeScreen() {
  const [decks, w, pages] = [await db.decks(), await getWallet(), await db.allPages()];
  const now = Date.now();
  const stat = new Map(decks.map((d) => [d.id, { pages: 0, masks: 0, due: 0, thumb: null, first: null }]));
  let dueAll = 0;
  for (const p of pages.sort((a, b) => a.index - b.index)) {
    const s = stat.get(p.deckId); if (!s) continue;
    s.pages++; s.masks += p.masks.length; if (!s.thumb) { s.thumb = p.thumb; s.first = p.id; }
    for (const m of p.masks) if (m.srs && m.srs.due <= now) { s.due++; dueAll++; }
  }
  const folders = foldersOf(decks), closed = (await getSettings()).closedFolders || [];
  const exam = decks.filter((d) => d.examDate && d.examDate > now - DAY).sort((a, b) => a.examDate - b.examDate)[0];
  const todayN = w.days[todayKey()] || 0;
  const pick = filePicker(null, afterImport), cam = cameraPicker(null, () => homeScreen());

  const hero = h('section.hero',
    h('div.hero-main', h('p.hero-cap', dueAll ? '今日の復習' : '今日の復習はありません'),
      h('p.hero-num', dueAll ? h('b', String(dueAll)) : h('b.small', '◎'), dueAll ? 'か所' : ''),
      h('p.hero-sub', dueAll ? '忘れかけた頃が、いちばん覚えやすいタイミングです。' : decks.length ? '新しいページを隠して、覚える所を増やしましょう。' : 'プリントやノートを取り込んで、はじめましょう。')),
    dueAll ? h('button.btn.white.big', { onclick: () => nav.review() }, icon('play', 18), '復習をはじめる') : null,
    h('div.hero-stats',
      h('span', icon('flame', 16), `${w.streak || 0}日つづけて学習`), h('span', icon('check', 16), `今日 ${todayN}か所`),
      exam ? h('span', icon('cal', 16), `「${exam.title}」の試験まで あと${Math.max(0, Math.ceil((exam.examDate - now) / DAY))}日`) : null));

  const cards = decks.map((d) => { const s = stat.get(d.id); return h('button.deck-card', { onclick: () => nav.deck(d.id) },
    h('div.deck-thumb', s.thumb ? h('img', { src: s.thumb, alt: '' }) : null, s.due ? h('span.badge', `復習 ${s.due}`) : null),
    h('div.deck-info', h('strong', d.title), h('span.muted', `${s.pages}ページ・隠し ${s.masks}か所`))); });
  const add = h('div.deck-card.add',
    h('button.add-main', { onclick: () => pick.click() }, icon('plus', 28), h('strong', '教材を追加'), h('span.muted', '写真・画像・PDF')),
    h('button.add-sub', { onclick: () => cam.click() }, icon('camera', 16), 'カメラで撮る'));

  root.replaceChildren(h('div.screen',
    h('header.app-head', h('div.brand', h('span.logo'), h('div', h('h1', 'ひらく'), h('span.muted', '暗記マーカー'))), coinPill(w)),
    h('main.content', hero,
      h('div.sec-head', h('h2', '教材'), decks.length ? null : h('button.btn', { onclick: async () => { const b = busy('サンプル教材を用意しています…'); try { const d = await createSampleDeck(); const ps = await db.pagesOf(d.id); nav.edit(d.id, ps[0].id); } finally { b.done(); } } }, icon('sparkle', 16), 'サンプルで試す')),
      h('div.deck-grid', add, decks.map((d, i) => (d.folder ? null : cards[i]))),
      folders.filter((f) => !f.includes('/')).map(function renderFolder(f) {
        const name = f.split('/').pop(), parent = f.split('/').slice(0, -1).join('/');
        const direct = decks.map((d, k) => (d.folder === f ? cards[k] : null)).filter(Boolean), all = decks.filter((d) => inFolder(d, f)), due = all.reduce((n, d) => n + stat.get(d.id).due, 0);
        const kids = folders.filter((x) => x.startsWith(f + '/') && !x.slice(f.length + 1).includes('/'));
        const rename = async (e) => {
          e.preventDefault(); const raw = await askText('フォルダの名前', name); if (raw == null) return; const n = cleanName(raw); if (n === name) return;
          const np = n ? (parent ? parent + '/' + n : n) : parent; // 名前を空にしたら、この段だけなくして中身を1つ上へ
          for (const d of all) { d.folder = (np + d.folder.slice(f.length)).replace(/^\//, ''); await db.putDeck(d); }
          toast(n ? `「${n}」に変えました` : 'フォルダをなくしました（中の教材は残っています）'); homeScreen();
        };
        return h('details.folder', { open: !closed.includes(f), ontoggle: async (e) => { if (e.target !== e.currentTarget) return; const c = (await getSettings()).closedFolders || []; await saveSettings({ closedFolders: e.target.open ? c.filter((x) => x !== f) : [...new Set([...c, f])] }); } },
          h('summary', icon('folder', 18), h('strong', name), h('span.muted', `${all.length}件`), due ? h('span.badge.inline', `復習 ${due}`) : null,
            h('button.icon-btn.sm', { 'aria-label': `フォルダ「${name}」の名前を変える`, title: '名前を変える', onclick: rename }, icon('edit', 15))),
          direct.length ? h('div.deck-grid', direct) : null, kids.map(renderFolder));
      }),
      decks.length ? null : h('div.empty', h('p', 'いつもの教材を「答えの所だけ隠せる教材」に変えて、そのまま暗記・復習までできます。'),
        h('ol.steps', h('li', h('b', '取り込む'), '写真・画像・PDF'), h('li', h('b', '隠す'), 'なぞる／「光合成を隠して」と頼む'), h('li', h('b', '覚える'), 'タイマー → 自動で隠れてテスト'), h('li', h('b', '続ける'), '忘れかけた頃に復習・コインでごほうび'))),
      pick, cam),
    tabs('home')));

  // ドラッグ&ドロップ・貼り付けでも取り込める
  const over = (e) => { e.preventDefault(); };
  const drop = async (e) => { e.preventDefault(); const files = [...(e.dataTransfer?.files || [])]; if (files.length) { const d = await importFiles(files, null); if (d) afterImport(d); } };
  const paste = async (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { const d = await importFiles(files, null); if (d) afterImport(d); } };
  window.addEventListener('dragover', over); window.addEventListener('drop', drop); window.addEventListener('paste', paste);
  cleanup = () => { window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); window.removeEventListener('paste', paste); };
}

// ---------------- 教材（ページ一覧＝弱点マップ） ----------------
const SCOL = { new: '#868e96', weak: '#f03e3e', mid: '#f59f00', good: '#2f9e44' };
function maskOverlay(p) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${p.w} ${p.h}`); svg.setAttribute('class', 'thumb-ov'); svg.setAttribute('aria-hidden', 'true');
  for (const m of p.masks) {
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', outline(m).map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' '));
    poly.setAttribute('fill', SCOL[strength(m.srs)]); poly.setAttribute('fill-opacity', '.78'); svg.append(poly);
  }
  return svg;
}
async function deckScreen(id) {
  const deck = await db.deck(id); if (!deck) return nav.home();
  const pages = await db.pagesOf(id); const w = await getWallet(); const now = Date.now();
  const all = pages.flatMap((p) => p.masks); const due = (await dueItems(id)).length;
  const cnt = { new: 0, weak: 0, mid: 0, good: 0 }; all.forEach((m) => cnt[strength(m.srs)]++);
  const nq = (deck.questions || []).length;
  const pick = filePicker(deck, () => deckScreen(id)), cam = cameraPicker(deck, () => deckScreen(id));
  const title = h('input.title-in', { value: deck.title, 'aria-label': '教材の名前', onchange: async (e) => { deck.title = e.target.value.trim() || '名前のない教材'; await db.putDeck(deck); } });
  const exam = h('input.date-in', { type: 'date', value: deck.examDate ? todayKey(deck.examDate) : '', 'aria-label': '試験日', onchange: async (e) => { deck.examDate = e.target.value ? new Date(e.target.value + 'T09:00').getTime() : null; await db.putDeck(deck); toast(deck.examDate ? '試験日に間に合うよう、復習の間隔を調整します' : '試験日を外しました'); deckScreen(id); } });
  const left = deck.examDate ? Math.ceil((deck.examDate - now) / DAY) : null;
  const allFolders = foldersOf(await db.decks());
  const folderSel = h('select.text-in.folder-in', { 'aria-label': 'フォルダ', onchange: async (e) => {
    let v = e.target.value;
    if (v === '\u0000new') {
      const name = cleanName(await askText('新しいフォルダの名前', '', '例: 英語、文法')); if (!name) return deckScreen(id);
      const parent = allFolders.length ? await askParent(allFolders) : ''; if (parent == null) return deckScreen(id);
      v = parent ? parent + '/' + name : name;
    }
    deck.folder = v; await db.putDeck(deck); toast(v ? `フォルダ「${folderLabel(v)}」に入れました` : 'フォルダから出しました'); deckScreen(id);
  } }, h('option', { value: '', selected: !deck.folder }, 'フォルダなし'), allFolders.map((p) => h('option', { value: p, selected: deck.folder === p }, '\u3000'.repeat(p.split('/').length - 1) + (p.includes('/') ? '└ ' : '') + p.split('/').pop())), h('option', { value: '\u0000new' }, '＋ 新しいフォルダ…'));

  const pageCards = pages.map((p) => h('div.page-card',
    h('button.page-thumb', { onclick: () => nav.edit(id, p.id), 'aria-label': `${p.index + 1}ページ目を編集` }, h('img', { src: p.thumb, alt: '' }), maskOverlay(p)),
    h('div.page-meta', h('span.pm-label', `${p.index + 1}ページ`, h('small.muted', `隠し ${p.masks.length}か所`)),
      h('div.row.tight',
        h('button.btn.sm.primary', { disabled: !p.masks.length, onclick: () => nav.study(id, p.id) }, icon('play', 14), '学習'),
        h('button.icon-btn.sm', { 'aria-label': 'このページを削除', onclick: async () => { if (await confirmSheet('このページを削除しますか？', '隠した場所と学習の記録も一緒に消えます。', '削除する', true)) { await db.delPage(p.id); const rest = (await db.pagesOf(id)); for (let i = 0; i < rest.length; i++) if (rest[i].index !== i) { rest[i].index = i; await db.putPage(rest[i]); } deckScreen(id); } } }, icon('trash', 15))))));

  root.replaceChildren(h('div.screen',
    h('header.app-head', h('button.icon-btn', { 'aria-label': 'ホームへ', onclick: nav.home }, icon('back')), title, coinPill(w)),
    h('main.content',
      h('section.panel',
        h('div.act-grid',
          h('button.act.primary', { disabled: !all.length, onclick: () => nav.studyDeck(id, 'deck') }, icon('play', 22), h('b', 'ぜんぶ学習'), h('small', `${all.length}か所`)),
          h('button.act', { disabled: !due, onclick: () => nav.review(id) }, icon('cal', 22), h('b', '今日の復習'), h('small', due ? `${due}か所` : 'なし')),
          h('button.act', { disabled: !(cnt.weak + cnt.mid), onclick: () => nav.studyDeck(id, 'weak') }, icon('map', 22), h('b', '苦手を集中'), h('small', `${cnt.weak + cnt.mid}か所`)),
          h('button.act', { disabled: !nq, onclick: () => nav.quiz(id) }, icon('cards', 22), h('b', '一問一答'), h('small', nq ? `${nq}問` : 'エディタで作成'))),
        h('div.row.between.wrap',
          h('label.exam', icon('folder', 16), 'フォルダ', folderSel),
          h('label.exam', icon('cal', 16), '試験日', exam, left != null ? h('b.left', left >= 0 ? `あと${left}日` : '終了') : h('span.muted', '入れると復習計画が試験日に合わせて変わります')),
          h('div.legend', ['good', 'mid', 'weak', 'new'].map((k) => h('span', h('i', { style: { background: SCOL[k] } }), `${{ good: '◯ 覚えた', mid: '△ あいまい', weak: '✕ 苦手', new: '・ 未学習' }[k]} ${cnt[k]}`))))),
      h('div.sec-head.wrap', h('h2', 'ページ（色は覚え具合）'), h('div.row', h('button.btn', { onclick: () => cam.click() }, icon('camera', 16), '撮る'), h('button.btn', { onclick: () => pick.click() }, icon('plus', 16), 'ページを追加'))),
      h('div.page-grid', pageCards), pick, cam,
      h('div.row.end.wrap', h('button.btn', { onclick: () => exportFlow(id) }, 'この教材を書き出す（バックアップ）'), h('button.btn.danger.ghost', { onclick: async () => { if (await confirmSheet(`「${deck.title}」を削除しますか？`, '全ページと学習の記録が消えます。元には戻せません。', '削除する', true)) { await db.delDeck(id); nav.home(); } } }, icon('trash', 16), 'この教材を削除')))));
}

// ---------------- ごほうびショップ ----------------
async function shopScreen() {
  const w = await getWallet();
  const item = (it, kind, preview) => {
    const owned = owns(w, it), on = w[kind] === it.id;
    return h('div.shop-item' + (on ? '.on' : ''), preview,
      h('div.shop-info', h('strong', it.name),
        on ? h('span.tag', '使用中') : owned ? h('button.btn.sm', { onclick: async () => { await equip(kind, it.id); shopScreen(); } }, '使う')
          : h('button.btn.sm.primary', { disabled: w.coins < it.price, onclick: async () => { if (await buy(it)) { await equip(kind, it.id); toast(`「${it.name}」を手に入れました！`); shopScreen(); } } }, h('span.coin.sm'), String(it.price))));
  };
  const swatch = (mk) => { const c = makeCanvas(220, 70), ctx = c.getContext('2d'); ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, 220, 70); ctx.fillStyle = '#333'; ctx.font = '600 20px sans-serif'; ctx.fillText('光合成は葉緑体で', 14, 43);
    ctx.fillStyle = markerFill(ctx, mk, { x0: 14, x1: 110 }); ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.roundRect(12, 20, 64, 32, 6); ctx.fill(); c.className = 'swatch'; return c; };
  root.replaceChildren(h('div.screen',
    h('header.app-head', h('div.brand', h('h1', 'ごほうび')), coinPill(w)),
    h('main.content',
      h('section.panel.rules', h('h3', 'コインのもらい方'), h('ul', COIN_RULES.map(([t, n]) => h('li', t, h('b', `+${n}`)))),
        h('p.muted.small', 'コインは勉強した量でもらえます（「覚えた」でも「まだ」でも同じ）。買ったりお金に換えたりはできません。')),
      h('div.sec-head', h('h2', 'マーカーのデザイン')), h('p.muted.small', 'あか・あお・みどり などの基本の色は、コインなしで最初から使えます。エディタの色ボタンで、色を切り替えながら何色でも同時に使えます。'), h('div.shop-grid', MARKERS.map((m) => item(m, 'marker', swatch(m)))),
      h('div.sec-head', h('h2', '壁紙')), h('div.shop-grid', WALLPAPERS.map((x) => item(x, 'wallpaper', h('div.wall-prev', { style: { background: x.css } }))))),
    tabs('shop')));
}

// ---------------- 設定 ----------------
async function settingsScreen() {
  const s = await getSettings(); const w = await getWallet();
  const phonePanel = h('section.panel'), storeBox = h('div.store');
  const tog = (label, key, desc) => h('label.opt-row', h('span', h('strong', label), desc ? h('small', desc) : null), h('input.switch', { type: 'checkbox', checked: s[key], onchange: async (e) => { await saveSettings({ [key]: e.target.checked }); settingsScreen(); } }));
  const key = h('input.text-in', { type: 'password', value: s.aiKey, placeholder: 'sk-ant-…', autocomplete: 'off', 'aria-label': 'Anthropic APIキー', onchange: async (e) => { await saveSettings({ aiKey: e.target.value.trim() }); } });
  const model = h('select.text-in', { onchange: async (e) => { await saveSettings({ aiModel: e.target.value }); } },
    [['claude-opus-5-5', 'Claude Opus 5.5（おすすめ）'], ['claude-fable-5-2', 'Claude Fable 5.2（最も高性能）'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5（速い）'], ['claude-haiku-5-5', 'Claude Haiku 5.5（最も安い）']].map(([v, l]) => h('option', { value: v, selected: s.aiModel === v }, l)));
  root.replaceChildren(h('div.screen',
    h('header.app-head', h('div.brand', h('h1', '設定')), coinPill(w)),
    h('main.content',
      h('section.panel', h('h3', '操作'),
        tog('文字に自動フィット', 'autoFit', 'なぞった行の文字の高さに合わせ、となりの行を巻き込まない形にします'),
        tog('角度の吸着', 'snap', 'ほぼ水平・垂直のときにぴったり揃えます。オフで完全に自由な角度'),
        tog('指でも描く', 'fingerDraws', 'オフにすると指1本は移動になり、ペンやマウスだけで描きます'),
        tog('ペンを使ったら指は移動にする', 'penPalm', 'Apple Pencil などで書きはじめたら、その後は指で線を引きません（手を置いて書けます）'),
        tog('拡大鏡', 'loupe', '指でなぞっている間、指の下を上の隅に大きく映します')),
      h('section.panel', h('h3', 'AIアシスト（任意）'),
        h('p.muted', 'オフのままでも、検索・赤字・英単語・重要語句の候補・穴埋め問題は端末の中だけで動きます。オンにすると「重要語句」「問題を作る」や自由な言い回しの指示を、AIが教材の内容を読んで提案します。'),
        tog('外部AI（Claude）を使う', 'aiEnabled', 'オンのとき、指示を出したタイミングで「教材から読み取った文字」と「指示文」を Anthropic のAPIに送ります。画像・学習記録は送りません'),
        s.aiEnabled ? h('div.col.gap',
          h('label.field', h('span', 'APIキー（この端末の中だけに保存）'), key),
          h('label.field', h('span', 'モデル'), model),
          h('div.row', h('button.btn', { onclick: async () => { const b = busy('接続を確認しています…'); try { await aiTest(); toast('接続できました'); } catch (e) { toast(e.message); } finally { b.done(); } } }, '接続テスト'),
            h('span.muted.small', 'キーは console.anthropic.com で発行できます。利用料は自分のアカウントにかかります。'))) : null),
      h('section.panel', h('h3', '文字の読み取り'),
        h('label.field', h('span', '読み取る言語（端末内で処理）'), h('select.text-in', { onchange: async (e) => { await saveSettings({ ocrLang: e.target.value }); } },
          [['jpn+eng', '日本語＋英語'], ['jpn', '日本語のみ'], ['eng', '英語のみ']].map(([v, l]) => h('option', { value: v, selected: s.ocrLang === v }, l))))),
      phonePanel,
      h('section.panel', h('h3', 'データ・容量（端末の引っ越しもここから）'),
        storeBox,
        h('p.muted', '教材・隠した場所・学習記録は、このブラウザの中だけに保存されます。別の端末へ移すとき・容量を空けたいときは「書き出す」→ できたファイルを保存（または相手の端末へ送る）→ 使うときに「読み込む」。引いたマーカーも学習記録も、そのまま戻ります。'),
        h('div.row.wrap',
          h('button.btn', { onclick: () => exportFlow() }, 'バックアップを書き出す'),
          h('button.btn', { onclick: () => imp.click() }, 'バックアップを読み込む'),
          h('button.btn.danger.ghost', { onclick: async () => { if (await confirmSheet('すべてのデータを消しますか？', '教材・学習記録・コインがすべて消えます。元には戻せません。', 'すべて消す', true)) { await db.wipe(); location.hash = '#/'; location.reload(); } } }, 'すべて消す'))),
      h('p.muted.small.center', 'ひらく 暗記マーカー — 教材の原本は変更しません。隠しはいつでも消せます。')),
    tabs('settings')));
  // 端末によっては .json が選べない（灰色になる）ことがあるので、種類はゆるく受ける。中身は読み込み時に確かめる
  const imp = h('input', { type: 'file', hidden: true, onchange: async () => { const f = imp.files[0]; imp.value = ''; if (f) await importAll(f); } });
  root.firstChild.append(imp);
  const mySeq = ++settingsSeq; unsubPwa?.();
  unsubPwa = onPwaChange(() => { if (settingsSeq === mySeq && document.body.dataset.screen === 'settings') fillPhonePanel(phonePanel); });
  fillPhonePanel(phonePanel); fillStorage(storeBox);
}
let settingsSeq = 0, unsubPwa = null;

// 「スマホで使う・オフライン」: いまの状態を正直に見せ、できる操作だけをボタンにする
async function fillPhonePanel(panel) {
  const [sw, off] = [await swState(), await offlineInfo()];
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const li = (ok, text, sub) => h('li' + (ok ? '.ok' : ok === false ? '.ng' : ''), h('span.st-mark', { 'aria-hidden': 'true' }, ok ? '✓' : ok === false ? '—' : '・'), h('span', h('strong', text), sub ? h('small', sub) : null));
  const rows = [];
  if (env.lan) rows.push(li(null, `いま ${location.host} で開いています`, 'PCの「スマホから開く」で、同じWi‑Fiの中にだけ公開されているアドレスです。PC側のウィンドウを閉じると開けなくなります。'));
  if (sw === 'unavailable') rows.push(li(false, 'オフライン起動・ホーム画面アプリ化・声の入力は、このアドレスでは使えません', env.secure ? 'このブラウザは対応していません。' : 'ブラウザの決まりで、https のアドレス（または PC 自身の localhost）でしか動きません。なぞる・隠す・学習・カメラ取込・バックアップは、このままで使えます。'));
  else {
    rows.push(li(sw === 'active', sw === 'active' ? 'オフラインでも起動できます' : 'オフライン起動の準備中…', off ? `保存済み: アプリ本体 ${off.shell}件／文字の読み取り ${off.ocr ? '○' : '未保存'}／PDF ${off.pdf ? '○' : '未保存'}` : null));
    rows.push(li(env.standalone(), env.standalone() ? 'ホーム画面のアプリとして開いています' : 'ホーム画面に追加すると、アプリのように全画面で開けます', env.standalone() ? null : env.ios ? 'Safari の共有ボタン（□に↑）→「ホーム画面に追加」。' : canInstall() ? null : 'ブラウザのメニュー（︙）→「アプリをインストール」または「ホーム画面に追加」。'));
  }
  rows.push(li(persisted, persisted ? 'この端末のデータは、消えにくい設定になっています' : 'データはこのブラウザの中にあります（大事な教材はバックアップを）', persisted ? null : 'ブラウザの「サイトデータを消去」や、長く使わなかった場合（とくに iPhone の Safari）に消えることがあります。'));
  const btns = [];
  if (sw !== 'unavailable') btns.push(h('button.btn', { onclick: async () => {
    const b = busy('オフライン用に保存しています…');
    try { const r = await saveOffline((t, p) => b.set(t, p), warmOcr); toast(r.failed ? `保存しましたが、${r.failed}件は取れませんでした。通信のよい所でもう一度お試しください` : 'オフライン用に保存しました。電波がなくても、取り込み・文字の読み取りまで使えます'); }
    catch (e) { console.error(e); toast('保存できませんでした: ' + (e.message || e)); } finally { b.done(); fillPhonePanel(panel); }
  } }, 'オフライン用に全部保存する'));
  if (canInstall()) btns.push(h('button.btn.primary', { onclick: async () => { await promptInstall(); fillPhonePanel(panel); } }, icon('phone', 16), 'ホーム画面に追加'));
  panel.replaceChildren(h('h3', 'スマホで使う・オフライン'), h('ul.status-list', rows), btns.length ? h('div.row.wrap', btns) : null,
    env.local ? h('p.muted.small', 'スマホから開くには、PCで「スマホから開く.bat」を起動し、表示されたアドレスをスマホのブラウザで開きます（同じWi‑Fiの中だけ）。') : null);
}

function dataUrlToBlob(u) {
  const i = u.indexOf(','), mime = (u.slice(5, i).split(';')[0]) || 'image/jpeg', bin = atob(u.slice(i + 1)), a = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k);
  return new Blob([a], { type: mime });
}
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const pageBytes = (p) => (p.blob?.size || 0) + (p.thumb?.length || 0);

// バックアップ（1つの .hiraku ファイル）。
// 形: 「HIRAKU2\n」+ 見出しの長さ(4バイト) + 見出し(JSON: 教材・隠し・学習記録) + ページ画像をそのまま連結。
// 画像を文字に変換しないので、ファイルは元の画像とほぼ同じ大きさで済み、読み込みも1ページずつなので大きくても固まらない。
// opts.deckId: その教材だけ／opts.light: 画像を入れず「隠し（マーカー）と学習記録だけ」
const MAGIC = 'HIRAKU2\n';
export async function buildBackup(opts = {}) {
  const { deckId = null, light = false } = opts;
  const decks = deckId ? [await db.deck(deckId)].filter(Boolean) : await db.decks();
  const pages = deckId ? await db.pagesOf(deckId) : await db.allPages();
  const blobs = [], metas = [];
  for (const { blob, thumb, lines, ...rest } of pages) {
    if (light) metas.push(rest);
    else { metas.push({ ...rest, thumb, lines, size: blob.size, type: blob.type || 'image/jpeg' }); blobs.push(blob); }
  }
  const head = new TextEncoder().encode(JSON.stringify({ app: 'hiraku', v: 2, kind: light ? 'light' : 'full', at: Date.now(), decks, wallet: deckId ? null : await getWallet(), pages: metas }));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length, true);
  const safe = deckId && decks[0] ? '-' + decks[0].title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 24) : '';
  return new File([MAGIC, len, head, ...blobs], `hiraku-${light ? 'markers' : 'backup'}${safe}-${todayKey()}.hiraku`, { type: 'application/octet-stream' });
}
function downloadFile(file) {
  const a = h('a', { href: URL.createObjectURL(file), download: file.name, hidden: true });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}
// 書き出し: まず「教材ごと」か「マーカーと記録だけ」かを選ぶ → できたファイルを保存／共有
async function exportFlow(deckId = null) {
  const pages = deckId ? await db.pagesOf(deckId) : await db.allPages();
  if (!pages.length) return toast('書き出す教材がありません');
  const full = pages.reduce((n, p) => n + pageBytes(p), 0), nm = pages.reduce((n, p) => n + p.masks.length, 0);
  const pickKind = (light) => async () => { close(); await makeAndOffer(deckId, light); };
  const close = sheet(deckId ? 'この教材を書き出す' : 'バックアップを書き出す', h('div.col.gap',
    h('button.choice', { onclick: pickKind(false) }, h('strong', '教材ごと（画像つき）'), h('small', `約 ${fmtSize(full)}。これ1つで、別の端末でも、消したあとでも、そのまま元どおりに戻せます。`)),
    h('button.choice', { onclick: pickKind(true) }, h('strong', 'マーカーと学習記録だけ（軽い）'), h('small', `隠し ${nm}か所ぶんの小さなファイルです。戻すときは、同じ教材（同じ名前・同じページ数）がその端末に入っている必要があります。`))));
}
async function makeAndOffer(deckId, light) {
  const b = busy('書き出しています…'); let file;
  try { file = await buildBackup({ deckId, light }); } catch (e) { console.error(e); toast('書き出せませんでした: ' + (e.message || e)); return; } finally { b.done(); }
  const canShare = !!navigator.canShare && (() => { try { return navigator.canShare({ files: [file] }); } catch { return false; } })();
  // 共有（AirDrop・LINE・メール・ドライブなどでそのまま別の端末へ）は、ボタンを押した直後にしか呼べないので、できあがってから選んでもらう
  const close = sheet('書き出せました', h('div',
    h('p.muted', `${file.name}（${fmtSize(file.size)}）。設定の「バックアップを読み込む」でこのファイルを選ぶと、${light ? '隠した場所と学習記録' : '教材・隠した場所・学習記録'}が戻ります。`),
    light ? null : h('p.note', '端末の容量を空けたいときは、このファイルがちゃんと保存できたのを確かめてから、教材を削除してください。読み込めばいつでも元に戻せます。'),
    h('div.row.end.wrap',
      canShare ? h('button.btn', { onclick: async () => { try { await navigator.share({ files: [file], title: 'ひらく のバックアップ' }); close(); } catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした。「端末に保存」をお試しください'); } } }, '共有して送る') : null,
      h('button.btn.primary', { onclick: () => { downloadFile(file); close(); toast('保存しました（ダウンロード／ファイル に入ります）'); } }, '端末に保存'))));
}

const badFile = () => new Error('ファイルを読めませんでした（途中で切れているか、別の種類のファイルです）');
const notOurs = () => new Error('このアプリのバックアップではありません');
export async function restoreBackup(file, onProgress) {
  if ((await file.slice(0, 8).text()) !== MAGIC) return restoreV1(file, onProgress);
  let data, off;
  try { const len = new DataView(await file.slice(8, 12).arrayBuffer()).getUint32(0, true); off = 12 + len; data = JSON.parse(await file.slice(12, off).text()); } catch { throw badFile(); }
  if (!data || data.app !== 'hiraku' || !Array.isArray(data.decks) || !Array.isArray(data.pages)) throw notOurs();
  if (data.kind === 'light') return applyLight(data);
  if (file.size < off + data.pages.reduce((n, p) => n + (p.size || 0), 0)) throw badFile(); // 画像が最後まで入っているのを確かめてから書き込む
  for (const d of data.decks) await db.putDeck(d);
  for (let i = 0; i < data.pages.length; i++) {
    onProgress && onProgress(i / data.pages.length);
    const { size, type, ...rest } = data.pages[i];
    await db.putPage({ ...rest, blob: new Blob([await file.slice(off, off + size).arrayBuffer()], { type }) }); off += size;
  }
  if (data.wallet) { await mergeWallet(data.wallet); await applyWallpaper(); }
  return { decks: data.decks.length, pages: data.pages.length, skipped: 0 };
}
// 以前の形（.json・画像を文字にして入れたもの）も読める
async function restoreV1(file, onProgress) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { throw badFile(); }
  if (!data || data.app !== 'hiraku' || !Array.isArray(data.decks) || !Array.isArray(data.pages)) throw notOurs();
  for (const d of data.decks) await db.putDeck(d);
  for (let i = 0; i < data.pages.length; i++) {
    onProgress && onProgress(i / data.pages.length);
    const { image, ...rest } = data.pages[i]; await db.putPage({ ...rest, blob: dataUrlToBlob(image) });
  }
  if (data.wallet) { await mergeWallet(data.wallet); await applyWallpaper(); }
  return { decks: data.decks.length, pages: data.pages.length, skipped: 0 };
}
// 「マーカーと記録だけ」を、この端末にある教材に当てる。
// 同じ教材（ID一致）が無ければ、同じ名前・同じページ数の教材（＝取り込み直したもの）を探し、ページの大きさが違えば隠しの位置を比率で合わせる。
async function applyLight(data) {
  const mine = await db.decks(); const res = { decks: 0, pages: 0, skipped: 0, light: true };
  for (const d of data.decks) {
    const src = data.pages.filter((p) => p.deckId === d.id).sort((a, b) => a.index - b.index);
    let target = mine.find((x) => x.id === d.id), tp = target ? await db.pagesOf(target.id) : null;
    if (!target) for (const c of mine.filter((x) => x.title === d.title)) { const ps = await db.pagesOf(c.id); if (ps.length === src.length) { target = c; tp = ps; break; } }
    if (!target) { res.skipped += src.length; continue; }
    let hit = 0;
    for (const sp of src) {
      const p = tp.find((x) => x.id === sp.id) || tp[sp.index];
      if (!p || Math.abs((sp.w / sp.h) / (p.w / p.h) - 1) > 0.03) { res.skipped++; continue; } // 形が違うページには当てない
      const k = p.w / sp.w;
      p.masks = sp.masks.map((m) => (Math.abs(k - 1) < 1e-6 ? m : { ...m, cx: m.cx * k, cy: m.cy * k, w: m.w * k, h: m.h * k }));
      await db.putPage(p); hit++;
    }
    if (hit) {
      res.decks++; res.pages += hit;
      if (d.examDate) target.examDate = d.examDate;
      if (target.id === d.id && d.questions) target.questions = d.questions;
      await db.putDeck(target);
    }
  }
  if (data.wallet) { await mergeWallet(data.wallet); await applyWallpaper(); }
  return res;
}
async function importAll(file) {
  const have = (await db.decks()).length;
  if (have && !(await confirmSheet('バックアップを読み込みますか？', `「${file.name}」を読み込みます。この端末にある同じ教材は、バックアップの内容（隠し・学習記録）で置きかわります。ほかの教材はそのまま残ります。`, '読み込む'))) return;
  const b = busy('バックアップを読み込んでいます…');
  try {
    const r = await restoreBackup(file, (p) => b.set(null, p));
    if (r.light) toast(r.pages ? `${r.pages}ページぶんの隠しと記録を戻しました` + (r.skipped ? `（${r.skipped}ページは、合う教材がこの端末に無く、戻せませんでした）` : '') : '戻せませんでした。このファイルは「マーカーと記録だけ」なので、先に同じ教材（同じ名前・同じページ数）を取り込んでください');
    else toast(`${r.decks}件の教材を読み込みました`);
    if (r.pages) nav.home();
  } catch (e) { console.error(e); toast('読み込めませんでした: ' + (e.message || e)); } finally { b.done(); }
}

// 設定の「この端末で使っている容量」
async function fillStorage(box) {
  const [decks, pages] = [await db.decks(), await db.allPages()];
  const by = new Map(decks.map((d) => [d.id, 0])); let total = 0;
  for (const p of pages) { const n = pageBytes(p); total += n; if (by.has(p.deckId)) by.set(p.deckId, by.get(p.deckId) + n); }
  let est = null; try { est = await navigator.storage?.estimate?.(); } catch { /* 対応していないブラウザ */ }
  const rows = decks.map((d) => [d, by.get(d.id)]).sort((a, b) => b[1] - a[1]);
  box.replaceChildren(
    h('p.store-sum', h('strong', `教材の合計 ${fmtSize(total)}`), est?.quota ? h('span.muted', `このブラウザで使える上限のめやす: 約 ${est.quota > 1073741824 ? (est.quota / 1073741824).toFixed(1) + 'GB' : fmtSize(est.quota)}`) : null),
    rows.length ? h('ul.store-list', rows.map(([d, n]) => h('li', h('button.store-name', { onclick: () => nav.deck(d.id) }, d.title), h('span.muted', fmtSize(n)), h('button.btn.sm', { onclick: () => exportFlow(d.id) }, '書き出す')))) : null);
}

(async () => {
  initPwa();
  await applyWallpaper();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  route();
})();
export { GRADES };
