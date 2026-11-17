// 隠しエディタ: なぞる／四角／語タップ／選択（移動・基準点つき拡縮・自由回転）／消す。
// 必須操作に長押しは無い。すべて「見えているボタン＋タップ／ドラッグ」で完結する。
import { db, getSettings, saveSettings } from './db.js';
import { h, uid, toast, sheet, confirmSheet, busy, clamp, makeCanvas } from './util.js';
import { icon } from './icons.js';
import { PageView, drawMask, bindPointers, zoomControls } from './view.js';
import * as G from './geom.js';
import { analyze, fitStroke, tightenBox, colorRegions, colorSummary, markedRegions, labelRegions, dropInk } from './ink.js';
import { ensureText, ocrPage, replacePageImage } from './importer.js';
import { adjustPhoto } from './scan.js';
import { searchTerm, findEnglish, findNumbers, findImportantLocal, boxesToHits, parseSelection, parseCommand, clozeQuestions, norm } from './search.js';
import { aiReady, aiTerms, aiQuestions } from './ai.js';
import { getWallet, markerById, MARKERS, owns, equip, markerSwatch, maskMarkerId } from './rewards.js';
import { speechAvailable, listenOnce } from './speech.js';

const HANDLES = [[-0.5, -0.5], [0, -0.5], [0.5, -0.5], [0.5, 0], [0.5, 0.5], [0, 0.5], [-0.5, 0.5], [-0.5, 0]];
const TOOLS = [['marker', 'なぞる', 'marker'], ['box', 'しかく', 'box'], ['word', '語タップ', 'word'], ['select', '選択', 'select'], ['erase', '消す', 'erase'], ['pan', '移動', 'pan']];
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const numLabel = (n) => CIRCLED[n - 1] || `(${n})`;

export async function openEditor(root, { deckId, pageId, nav }) {
  const settings = await getSettings();
  const wallet = await getWallet();
  const deck = await db.deck(deckId);
  const pages = await db.pagesOf(deckId);
  if (!deck || !pages.length) { nav.home(); return () => {}; }
  let pi = Math.max(0, pages.findIndex((p) => p.id === pageId));
  let page = pages[pi];
  const imgs = new Map();
  const getImg = async (p) => { if (!imgs.has(p.id)) imgs.set(p.id, await createImageBitmap(p.blob)); return imgs.get(p.id); };
  const inkOf = async (p) => analyze(p.id, await getImg(p), p.w, p.h);

  let tool = 'marker', sel = null, anchor = 'auto', gesture = null, lastHits = null, spaceDown = false, snapNote = null;
  // 指で操作しているか（最後に触れたのが指なら true）。ハンドルを外側へ離して大きく描き、触りやすくする
  const hasTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  let touchUI = matchMedia('(pointer: coarse)').matches, anchorOpen = false, penSeen = false;
  const hist = { undo: [], redo: [] };
  const marker = () => markerById(wallet.marker);
  const selMask = () => page.masks.find((m) => m.id === sel) || null;

  // ---------- 画面 ----------
  const canvas = h('canvas.page-canvas', { 'aria-label': '教材ページ' });
  const stage = h('div.ed-stage', canvas);
  const pageLabel = h('span.page-label');
  const undoBtn = h('button.icon-btn', { 'aria-label': '元に戻す', title: '元に戻す (Ctrl+Z)', onclick: () => undo() }, icon('undo'));
  const redoBtn = h('button.icon-btn', { 'aria-label': 'やり直す', title: 'やり直す (Ctrl+Y)', onclick: () => redo() }, icon('redo'));
  const top = h('header.ed-top',
    h('button.icon-btn', { 'aria-label': '教材へ戻る', onclick: () => nav.deck(deck.id) }, icon('back')),
    h('div.ed-title', h('strong', deck.title), h('div.page-nav',
      h('button.icon-btn.sm', { 'aria-label': '前のページ', onclick: () => gotoPage(pi - 1) }, icon('back', 16)), pageLabel,
      h('button.icon-btn.sm', { 'aria-label': '次のページ', onclick: () => gotoPage(pi + 1) }, icon('next', 16)))),
    undoBtn, redoBtn,
    h('button.btn.primary.study-btn', { onclick: () => nav.study(deck.id, page.id) }, icon('play', 16), h('span', '学習する')));

  const toolBtns = {};
  // マーカーの色: ここで選んだ色で、次から引く。隠しを選んでいるときは、その隠しの色も変える。色は何色でも同時に使える
  const mkBtn = h('button.mk-btn', { 'aria-label': 'マーカーの色を選ぶ', title: 'マーカーの色', 'aria-expanded': 'false', onclick: () => toggleMkPop() });
  const mkPop = h('div.mk-pop', { hidden: true });
  function renderMk() { mkBtn.replaceChildren(markerSwatch(marker(), 26), h('span', '色')); }
  function toggleMkPop(open = mkPop.hidden) {
    mkPop.hidden = !open; mkBtn.setAttribute('aria-expanded', String(open)); if (!open) return;
    const m = selMask(), curId = m ? maskMarkerId(m, wallet) : wallet.marker;
    mkPop.replaceChildren(h('strong', m ? 'この隠しの色' : 'マーカーの色（次に引く色）'),
      h('div.mk-grid', MARKERS.filter((x) => owns(wallet, x)).map((x) => h('button.mk-item', { 'aria-pressed': String(x.id === curId), onclick: () => pickMarker(x.id) }, markerSwatch(x, 34), h('small', x.name)))),
      h('button.link', { onclick: () => nav.shop() }, 'デザインを増やす（ごほうび）'));
  }
  async function pickMarker(id) {
    const m = selMask();
    if (m && maskMarkerId(m, wallet) !== id) transact('色を変える', [page], () => { m.mk = id; });
    await equip('marker', id); toggleMkPop(false); renderMk(); refresh();
  }
  const toolbar = h('div.ed-tools', { role: 'toolbar', 'aria-label': 'ツール' },
    h('div.seg', TOOLS.map(([id, label, ic]) => (toolBtns[id] = h('button.tool', { 'aria-pressed': 'false', title: label, onclick: () => setTool(id) }, icon(ic), h('span', label))))),
    mkBtn,
    h('button.tool.only.more', { 'aria-label': 'そのほかの設定', title: 'そのほかの設定', onclick: () => openOptions() }, icon('more')));

  const selBar = h('div.sel-bar', { hidden: true });
  const hint = h('div.ed-hint');
  stage.append(selBar, hint, mkPop); renderMk();

  const chips = h('div.cmd-chips');
  const input = h('input.cmd-input', { type: 'text', placeholder: '例:「光合成を隠して」「赤字だけ」「下線の語」', 'aria-label': 'ことばで指示', enterKeyHint: 'send' });
  const micBtn = speechAvailable ? h('button.icon-btn.mic', { 'aria-label': '声で指示する', onclick: () => voice() }, icon('mic')) : null;
  const cmdBar = h('footer.cmd-bar', chips, h('form.cmd-row', { onsubmit: (e) => { e.preventDefault(); const v = input.value; input.value = ''; input.blur(); runCommand(v); } },
    icon('sparkle'), input, micBtn, h('button.icon-btn.send', { type: 'submit', 'aria-label': '実行' }, icon('send'))));

  const el = h('div.editor', top, toolbar, stage, cmdBar);
  root.replaceChildren(el);
  const view = new PageView(canvas, stage);
  // 拡大鏡: 指でなぞっている間、指の下を上の隅に大きく映す（長押しではなく、このボタンでオン／オフ）
  const loupeBtn = h('button.zf-btn.toggle', { hidden: !hasTouch, 'aria-label': '拡大鏡（指でなぞる所を大きく映す）', title: '拡大鏡', 'aria-pressed': String(!!settings.loupe),
    onclick: async () => { settings.loupe = !settings.loupe; await saveSettings({ loupe: settings.loupe }); loupeBtn.setAttribute('aria-pressed', String(settings.loupe)); toast(settings.loupe ? '拡大鏡オン: 指でなぞる所を、上に大きく映します' : '拡大鏡オフ'); } }, icon('loupe'));
  stage.append(zoomControls(view, [loupeBtn]));

  // ---------- 描画 ----------
  view.paint = (ctx, v) => {
    for (const m of page.masks) drawMask(ctx, m, marker(), 'edit', v, { ring: m.id === sel ? 'rgba(76,110,245,.9)' : null });
    if (gesture?.type === 'stroke' && gesture.pts.length > 1) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = marker().color; ctx.globalAlpha = 0.45;
      ctx.lineWidth = Math.max(markerHalf() * 1.2, 6 / v.s); ctx.beginPath();
      gesture.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.restore();
    }
    if ((gesture?.type === 'box' || gesture?.type === 'wordDrag') && gesture.cur) {
      const [x0, y0] = gesture.p0, [x1, y1] = gesture.cur;
      ctx.save(); ctx.fillStyle = marker().color; ctx.globalAlpha = gesture.type === 'box' ? 0.45 : 0.2;
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)); ctx.restore();
    }
  };
  view.paintScreen = (ctx, v) => {
    const m = selMask(); if (!m) return;
    const pts = HANDLES.map(([x, y]) => handleScreen(m, x, y)), hs = touchUI ? 8 : 6;
    ctx.save();
    ctx.strokeStyle = '#4c6ef5'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.beginPath();
    [0, 2, 4, 6].forEach((i, k) => (k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i]))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    const k = knobPos(m); ctx.beginPath(); ctx.moveTo(...pts[1]); ctx.lineTo(...k); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.lineWidth = 2;
    for (const [x, y] of pts) { ctx.beginPath(); ctx.roundRect(x - hs, y - hs, hs * 2, hs * 2, 3); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(k[0], k[1], touchUI ? 11 : 8, 0, 7); ctx.fillStyle = '#4c6ef5'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.stroke();
    if (anchor !== 'auto') { // 基準点（動かない点）のピン
      const [ax, ay] = v.toScreen(...G.localToPage(m, anchor[0], anchor[1]));
      ctx.beginPath(); ctx.arc(ax, ay, 9, 0, 7); ctx.fillStyle = '#f03e3e'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax - 4, ay); ctx.lineTo(ax + 4, ay); ctx.moveTo(ax, ay - 4); ctx.lineTo(ax, ay + 4); ctx.stroke();
    }
    if (snapNote) { ctx.font = '600 13px system-ui'; ctx.fillStyle = '#4c6ef5'; ctx.fillText(snapNote, k[0] + 14, k[1] + 4); }
    ctx.restore();
  };
  // ハンドルの画面上の位置。指のときは枠の外側へ少し離す（小さな隠しでも、本体＝移動 と ハンドル＝拡縮 を触り分けられる）
  function handleScreen(m, hx, hy) {
    const [sx, sy] = view.toScreen(...G.localToPage(m, hx, hy)); if (!touchUI) return [sx, sy];
    const [ux, uy] = G.rot(Math.sign(hx), Math.sign(hy), m.angle);
    return [sx + ux * 14, sy + uy * 14];
  }
  function knobPos(m) {
    const [tx, ty] = view.toScreen(...G.localToPage(m, 0, -0.5)); const [ux, uy] = G.rot(0, -1, m.angle), d = touchUI ? 54 : 30;
    return [tx + ux * d, ty + uy * d];
  }
  // 選んだ隠しが下の操作バーに隠れていたら、見える所まで動かす
  function ensureSelVisible() {
    const m = selMask(); if (!m) return;
    const b = G.bounds(m), [, y1] = view.toScreen(b.x1, b.y1), [, y0] = view.toScreen(b.x0, b.y0);
    const limit = view.ch - (selBar.offsetHeight || 0) - 34, topLimit = touchUI ? 70 : 20;
    if (y1 > limit) view.panBy(0, Math.max(limit - y1, topLimit - y0));
  }

  // ---------- 履歴（1ジェスチャー=1取引。ページをまたぐ一括操作も1回で戻る） ----------
  const snapOf = (ps) => ps.map((p) => [p.id, JSON.stringify(p.masks)]);
  function pushHistory(label, before, ps) {
    const after = snapOf(ps);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    hist.undo.push({ label, before, after }); hist.redo = []; if (hist.undo.length > 100) hist.undo.shift();
    ps.forEach((p) => db.putPage(p)); refresh();
  }
  function transact(label, ps, fn) { const before = snapOf(ps); fn(); pushHistory(label, before, ps); }
  function restore(list) { for (const [id, json] of list) { const p = pages.find((x) => x.id === id); if (p) { p.masks = JSON.parse(json); db.putPage(p); } } if (!selMask()) sel = null; refresh(); }
  function undo() { const e = hist.undo.pop(); if (!e) return toast('これ以上戻せません'); restore(e.before); hist.redo.push(e); toast(`取り消しました: ${e.label}`); refresh(); }
  function redo() { const e = hist.redo.pop(); if (!e) return; restore(e.after); hist.undo.push(e); toast(`やり直しました: ${e.label}`); refresh(); }

  // ---------- 状態の反映 ----------
  function refresh() {
    undoBtn.disabled = !hist.undo.length; redoBtn.disabled = !hist.redo.length;
    pageLabel.textContent = `${pi + 1} / ${pages.length}`;
    for (const [id, b] of Object.entries(toolBtns)) b.setAttribute('aria-pressed', String(id === tool));
    canvas.dataset.tool = tool;
    renderSelBar(); view.draw();
    hint.textContent = page.masks.length ? '' : ({ marker: '隠したい文字をなぞってください。文字の高さに合わせて自動で形が決まります', box: 'ドラッグして四角で隠します', word: '隠したい語をタップ（ドラッグで範囲指定）', select: '', erase: '消したい隠しをタップ', pan: '' }[tool] || '');
    hint.hidden = !hint.textContent;
  }
  function setTool(t) {
    tool = t; if (t !== 'select') sel = null;
    if (t === 'word' && !page.lines) ensureText([page]).then(() => refresh());
    refresh();
  }
  function renderSelBar() {
    const m = selMask(); selBar.hidden = !m; if (!m) { anchorOpen = false; return; }
    const deg = Math.round(m.angle * 1800 / Math.PI) / 10;
    const compact = touchUI || stage.clientWidth < 520; // 指・せまい画面: 基準点は大きなボタンの小窓で選ぶ
    selBar.classList.toggle('compact', compact);
    const isOn = (ax, ay) => anchor !== 'auto' && anchor[0] === ax && anchor[1] === ay;
    const cells = (fn) => [-0.5, 0, 0.5].flatMap((ay) => [-0.5, 0, 0.5].map((ax) => fn(ax, ay)));
    const grid = h('div.anchor-grid' + (compact ? '.big' : ''), { role: 'group', 'aria-label': '大きさを変えるときに動かさない点' },
      cells((ax, ay) => h('button.anchor-dot', {
        'aria-pressed': String(isOn(ax, ay)), 'aria-label': `基準点 ${ay < 0 ? '上' : ay > 0 ? '下' : '中'}${ax < 0 ? '左' : ax > 0 ? '右' : '央'}`,
        onclick: () => { anchor = [ax, ay]; anchorOpen = false; refresh(); },
      })));
    const autoChip = h('button.chip' + (anchor === 'auto' ? '.on' : ''), { onclick: () => { anchor = 'auto'; anchorOpen = false; refresh(); }, title: '掴んだ所の反対側を固定' }, compact ? '自動（つかんだ所の反対側）' : '自動');
    const anchorUi = !compact ? h('div.sel-group', h('span.sel-cap', '基準点'), grid, autoChip)
      : h('div.sel-group', h('button.anchor-open', { 'aria-expanded': String(anchorOpen), 'aria-label': `基準点（大きさを変えるとき動かさない点）: ${anchor === 'auto' ? '自動' : '指定中'}。タップで選ぶ`, onclick: () => { anchorOpen = !anchorOpen; renderSelBar(); } },
        h('span.anchor-mini', { 'aria-hidden': 'true' }, cells((ax, ay) => h('i' + (isOn(ax, ay) ? '.on' : '')))), h('span', '基準点')),
      anchorOpen ? h('div.anchor-pop', h('strong', '大きさを変えるとき、動かさない点'), grid, autoChip) : null);
    selBar.replaceChildren(...[
      h('div.sel-group', h('span.sel-cap', '色'), h('button.mk-dot', { 'aria-label': 'この隠しの色を変える', title: '色を変える', onclick: () => toggleMkPop() }, markerSwatch(markerById(maskMarkerId(m, wallet)), 24))),
      anchorUi,
      h('div.sel-group', h('span.sel-cap', '角度'),
        h('button.icon-btn.sm', { 'aria-label': '左に1度回す', onclick: () => rotateSel(-1) }, icon('rotl', 16)),
        h('button.chip.deg', { title: 'タップで水平に戻す', onclick: () => rotateSel(null) }, `${deg}°`),
        h('button.icon-btn.sm', { 'aria-label': '右に1度回す', onclick: () => rotateSel(1) }, icon('rotr', 16)),
        h('button.chip' + (settings.snap ? '.on' : ''), { 'aria-pressed': String(settings.snap), onclick: async () => { await saveSettings({ snap: !settings.snap }); settings.snap = !settings.snap; refresh(); } }, settings.snap ? '吸着オン' : '吸着オフ')),
      h('div.sel-group',
        h('button.icon-btn.sm', { 'aria-label': '複製', title: '複製', onclick: () => duplicateSel() }, icon('copy', 16)),
        h('button.icon-btn.sm.danger', { 'aria-label': '削除', title: '削除 (Delete)', onclick: () => deleteSel() }, icon('trash', 16))),
      m.uncertain ? h('div.sel-warn', '⚠ となりの行と近く、きれいに分けきれていないかもしれません。四隅や辺をドラッグして手直しできます。',
        h('button.link', { onclick: () => transact('注意マークを外す', [page], () => { m.uncertain = false; }) }, 'これでOK')) : null].filter(Boolean));
  }
  const pivot = () => (anchor === 'auto' ? [0, 0] : anchor);
  function rotateSel(d) { const m = selMask(); if (!m) return; transact('回転', [page], () => Object.assign(m, G.rotateAbout(m, pivot(), d == null ? 0 : G.normAngle(m.angle + d * Math.PI / 180)))); }
  function deleteSel() { const m = selMask(); if (!m) return; transact('隠しを1つ削除', [page], () => { page.masks = page.masks.filter((x) => x.id !== m.id); sel = null; }); }
  function duplicateSel() { const m = selMask(); if (!m) return; transact('複製', [page], () => { const c = { ...JSON.parse(JSON.stringify(m)), id: uid(), cy: m.cy + m.h * 1.3, srs: null, log: [] }; page.masks.push(c); sel = c.id; }); }

  const markerHalf = () => page.w * ({ S: 0.008, M: 0.013, L: 0.02 }[settings.markerSize] || 0.013);
  const newMask = (geom, extra = {}) => ({ id: uid(), ...geom, text: '', src: 'manual', uncertain: false, srs: null, log: [], mk: wallet.marker, ...extra });
  const hitsAt = (px, py, tol) => page.masks.filter((m) => G.hit(m, px, py, tol)).reverse();

  // ---------- 入力 ----------
  bindPointers(view, {
    down(x, y, e) {
      hint.hidden = true; if (!mkPop.hidden) toggleMkPop(false);
      const [px, py] = view.toPage(x, y), touch = e.pointerType === 'touch';
      if (e.pointerType && touchUI !== touch && e.pointerType !== 'pen') { touchUI = touch; view.draw(); }
      if (anchorOpen) { anchorOpen = false; renderSelBar(); }
      if (e.pointerType === 'pen' && !penSeen) { penSeen = true; if (settings.penPalm && settings.fingerDraws) toast('ペンを使っている間は、指は「移動」になります（2本指で拡大）。手を画面に置いて書けます'); }
      const g = { sx: x, sy: y, p0: [px, py], moved: false, touch };
      const wantPan = tool === 'pan' || spaceDown || e.button === 1 || (touch && (!settings.fingerDraws || (penSeen && settings.penPalm)) && tool !== 'select');
      if (wantPan) { gesture = { ...g, type: 'pan', lx: x, ly: y }; return; }
      if (tool === 'select') {
        const m = selMask(), r = touch ? 24 : 14;
        if (m) {
          const k = knobPos(m);
          if (Math.hypot(k[0] - x, k[1] - y) < r + 2) { gesture = { ...g, type: 'rotate', m0: { ...m }, before: snapOf([page]) }; return; }
          let best = -1, bd = r;
          const inside = touch && G.hit(m, px, py, 0); // 指: 本体の中は「移動」、外側のハンドルが「拡縮」
          if (!inside) HANDLES.forEach(([hx, hy], i) => { const [sx, sy] = handleScreen(m, hx, hy); const d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = i; } });
          if (best >= 0) {
            const hp = G.localToPage(m, ...HANDLES[best]), [hsx, hsy] = view.toScreen(...hp); // 掴んだ位置とハンドルのずれを覚えて、動かし始めに飛ばないようにする
            gesture = { ...g, type: 'resize', handle: HANDLES[best], off: [hp[0] - px, hp[1] - py], m0: { ...m }, before: snapOf([page]) };
            if (touch && settings.loupe) { gesture.lo = [hsx - x, hsy - y]; view.loupe = { x: hsx, y: hsy }; view.draw(); }
            return;
          }
        }
        const hs = hitsAt(px, py, (touch ? 10 : 4) / view.s);
        if (hs.length) {
          const wasSel = hs.some((q) => q.id === sel); const target = wasSel ? selMask() : hs[0];
          sel = target.id; gesture = { ...g, type: 'move', m0: { ...target }, hs, wasSel, before: snapOf([page]) }; refresh(); return;
        }
        gesture = { ...g, type: 'pan', lx: x, ly: y, deselect: true }; return;
      }
      if (tool === 'marker') gesture = { ...g, type: 'stroke', pts: [[px, py]] };
      else if (tool === 'box') gesture = { ...g, type: 'box', cur: null };
      else if (tool === 'word') gesture = { ...g, type: 'wordDrag', cur: null };
      else if (tool === 'erase') { gesture = { ...g, type: 'erase', before: snapOf([page]) }; eraseAt(px, py); }
      if (gesture && touch && settings.loupe) { gesture.lo = [0, 0]; view.loupe = { x, y }; view.draw(); }
    },
    move(x, y, e) {
      const g = gesture; if (!g) return;
      if (Math.hypot(x - g.sx, y - g.sy) > (g.touch ? 9 : 5)) g.moved = true;
      const [px, py] = view.toPage(x, y);
      if (g.lo) { view.loupe = { x: x + g.lo[0], y: y + g.lo[1] }; if (g.type === 'erase') view.draw(); }
      if (g.type === 'pan') { view.panBy(x - g.lx, y - g.ly); g.lx = x; g.ly = y; return; }
      if (g.type === 'stroke') { const l = g.pts[g.pts.length - 1]; if (Math.hypot(px - l[0], py - l[1]) > 1.2 / view.s) g.pts.push([px, py]); view.draw(); return; }
      if (g.type === 'box' || g.type === 'wordDrag') { g.cur = [px, py]; view.draw(); return; }
      if (g.type === 'erase') { eraseAt(px, py); return; }
      const m = selMask(); if (!m || !g.moved) return;
      if (g.type === 'move') { m.cx = g.m0.cx + px - g.p0[0]; m.cy = g.m0.cy + py - g.p0[1]; }
      else if (g.type === 'resize') Object.assign(m, G.resizeAboutAnchor(g.m0, g.handle, anchor === 'auto' ? [-g.handle[0], -g.handle[1]] : anchor, px + g.off[0], py + g.off[1], 8 / view.s));
      else if (g.type === 'rotate') {
        const P = G.localToPage(g.m0, ...pivot());
        if (g.a0 == null) g.a0 = Math.atan2(g.p0[1] - P[1], g.p0[0] - P[0]);
        let a = G.normAngle(g.m0.angle + Math.atan2(py - P[1], px - P[0]) - g.a0);
        snapNote = null;
        if (settings.snap && !e.altKey) { const s = G.snapAngle(a); if (s.snapped) { a = s.angle; snapNote = `${Math.round(a * 180 / Math.PI)}° に吸着`; } }
        Object.assign(m, G.rotateAbout(g.m0, pivot(), a));
      }
      renderSelBar(); view.draw();
    },
    up(x, y) {
      const g = gesture; gesture = null; snapNote = null; view.loupe = null; if (!g) return;
      const [px, py] = view.toPage(x, y);
      if (g.type === 'pan') { if (g.deselect && !g.moved) { sel = null; refresh(); } return; }
      if (g.type === 'move' || g.type === 'resize' || g.type === 'rotate') {
        if (g.type === 'move' && !g.moved && g.wasSel && g.hs.length > 1) { const i = g.hs.findIndex((q) => q.id === sel); sel = g.hs[(i + 1) % g.hs.length].id; } // 同じ所をもう一度タップ → 下の隠しへ
        pushHistory({ move: '移動', resize: '大きさを変更', rotate: '回転' }[g.type], g.before, [page]); refresh(); if (!g.moved) ensureSelVisible(); return;
      }
      if (g.type === 'erase') { pushHistory('隠しを消す', g.before, [page]); refresh(); return; }
      if (!g.moved) { // タップ: 既存の隠しがあれば選択へ
        const hs = hitsAt(px, py, (g.touch ? 10 : 4) / view.s);
        if (hs.length) { tool = 'select'; sel = hs[0].id; refresh(); ensureSelVisible(); return; }
        if (g.type === 'wordDrag') wordAt(px, py);
        view.draw(); return;
      }
      if (g.type === 'stroke') finishStroke(g.pts);
      else if (g.type === 'box') { const [x0, y0] = g.p0; if (Math.abs(px - x0) > 3 && Math.abs(py - y0) > 3) transact('四角で隠す', [page], () => page.masks.push(newMask(G.rectMask(Math.min(x0, px), Math.min(y0, py), Math.max(x0, px), Math.max(y0, py))))); }
      else if (g.type === 'wordDrag') wordRange(g.p0, [px, py]);
      view.draw();
    },
    cancel() { if (gesture?.before) restore(gesture.before); gesture = null; view.loupe = null; snapNote = null; view.draw(); },
  });
  function eraseAt(px, py) { const hs = hitsAt(px, py, 6 / view.s); if (hs.length) { const ids = new Set(hs.map((m) => m.id)); page.masks = page.masks.filter((m) => !ids.has(m.id)); view.draw(); } }

  async function finishStroke(pts) {
    const ink = settings.autoFit ? await inkOf(page) : null;
    const r = fitStroke(ink, pts, { fallbackHalf: markerHalf(), snap: settings.snap });
    const text = r.fitted ? textUnder(r.mask) : '';
    transact('なぞって隠す', [page], () => page.masks.push(newMask(r.mask, { uncertain: r.uncertain, text, src: r.fitted ? 'fit' : 'manual' })));
    if (r.uncertain) toast('⚠ となりの行と近い所があります。タップして手直しできます');
  }
  // マスクの下にある文字（読み取り済みなら）→ ヒントや声での答え合わせに使う
  function textUnder(m) {
    if (!page.lines) return '';
    let out = '';
    for (const ln of page.lines) for (const c of ln.chars) if (!c.sp && G.hit(m, (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2)) out += c.c;
    return out;
  }
  const cls = (c) => (/[一-龠々]/.test(c) ? 'k' : /[ァ-ヶー]/.test(c) ? 't' : /[ぁ-ん]/.test(c) ? 'h' : /[A-Za-z'’-]/.test(c) ? 'a' : /[0-9０-９.,]/.test(c) ? 'd' : 'o');
  async function wordAt(px, py) {
    if (!page.lines && !(await ensureText([page]))) return;
    for (const ln of page.lines || []) {
      const i = ln.chars.findIndex((c) => !c.sp && px >= c.x0 - 2 && px <= c.x1 + 2 && py >= c.y0 - 4 && py <= c.y1 + 4);
      if (i < 0) continue;
      const k = cls(ln.chars[i].c); let a = i, b = i;
      if (k !== 'o') { while (a > 0 && !ln.chars[a - 1].sp && cls(ln.chars[a - 1].c) === k) a--; while (b < ln.chars.length - 1 && !ln.chars[b + 1].sp && cls(ln.chars[b + 1].c) === k) b++; }
      return addCharsMask(ln.chars.slice(a, b + 1), '語を隠す');
    }
    toast('ここには読み取れた文字がありません。「なぞる」で隠せます');
  }
  async function wordRange(p0, p1) {
    if (!page.lines && !(await ensureText([page]))) return;
    const x0 = Math.min(p0[0], p1[0]), x1 = Math.max(p0[0], p1[0]), y0 = Math.min(p0[1], p1[1]), y1 = Math.max(p0[1], p1[1]);
    const groups = (page.lines || []).map((ln) => ln.chars.filter((c) => !c.sp && (c.x0 + c.x1) / 2 >= x0 && (c.x0 + c.x1) / 2 <= x1 && c.y1 >= y0 && c.y0 <= y1)).filter((g) => g.length);
    if (!groups.length) return toast('範囲に読み取れた文字がありません');
    const ink = await inkOf(page);
    transact('範囲の語を隠す', [page], () => groups.forEach((cs) => page.masks.push(maskFromChars(cs, ink))));
  }
  function maskFromChars(cs, ink) {
    const b = { x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)), x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)) };
    const t = tightenBox(ink, b);
    return newMask(G.rectMask(t.x0, t.y0, t.x1, t.y1), { text: cs.map((c) => c.c).join(''), src: 'word' });
  }
  async function addCharsMask(cs, label) { const ink = await inkOf(page); transact(label, [page], () => page.masks.push(maskFromChars(cs, ink))); }

  // ---------- ことばで指示 ----------
  async function voice() {
    const t = await listenOnce((on) => { micBtn.classList.toggle('rec', on); input.placeholder = on ? '聞いています…' : '例:「光合成を隠して」「赤字だけ」「重要語句」'; });
    if (t) { toast(`「${t}」`); runCommand(t); }
  }
  async function colorHits(ids, label) {
    const out = [];
    for (const p of pages) { const m = await inkOf(p); out.push(...boxesToHits(p, ids[0] === 'under' ? markedRegions(m).under : ids[0] === 'boxed' ? markedRegions(m).boxed : ids[0] === 'labels' ? labelRegions(m) : colorRegions(m, ids), label)); }
    return out;
  }
  async function runCommand(text) {
    text = (text || '').trim(); if (!text) return;
    if (lastHits) { const pick = parseSelection(text, lastHits.hits.length); if (pick) { lastHits.close?.(); return applyHits(pick.map((n) => lastHits.hits[n - 1]), lastHits.label); } }
    const cmd = parseCommand(text);
    try {
      if (cmd.kind === 'undo') return undo();
      if (cmd.kind === 'redo') return redo();
      if (cmd.kind === 'clear') {
        if (!page.masks.length) return toast('このページに隠しはありません');
        if (await confirmSheet('このページの隠しを全部消しますか？', `${page.masks.length}件の隠しを消します（「元に戻す」で戻せます）。`, '全部消す', true)) transact('ページの隠しを全消去', [page], () => { page.masks = []; sel = null; });
        return;
      }
      if (cmd.kind === 'color') {
        const b = busy(`${cmd.label}を探しています…`); let hits; try { hits = await colorHits(cmd.ids, cmd.label); } finally { b.done(); }
        if (!hits.length) return toast(`${cmd.label}は見つかりませんでした`);
        return showHits(`${cmd.label}が ${hits.length}か所 見つかりました`, hits, `${cmd.label}を隠す`);
      }
      if (!(await ensureText(pages))) return;
      if (cmd.kind === 'english') { const hits = findEnglish(pages); return hits.length ? showHits(`英単語が ${hits.length}個 見つかりました`, hits, '英単語を隠す') : toast('英単語は見つかりませんでした'); }
      if (cmd.kind === 'numbers') { const hits = findNumbers(pages); return hits.length ? showHits(`数字・年号が ${hits.length}か所 見つかりました`, hits, '数字を隠す') : toast('数字は見つかりませんでした'); }
      if (cmd.kind === 'important' || cmd.kind === 'questions') return suggest(cmd);
      // 語の検索
      let hits = []; let terms = cmd.terms;
      if (cmd.whole) { const parts = terms.map((t) => searchTerm(pages, t)); if (parts.some((p) => !p.length)) { const w = searchTerm(pages, cmd.whole); if (w.length) { terms = [cmd.whole]; hits = w; } } }
      if (!hits.length) for (const t of terms) hits.push(...searchTerm(pages, t));
      hits.sort((a, b) => a.pageIndex - b.pageIndex || a.line - b.line || a.box.x0 - b.box.x0);
      const name = terms.map((t) => `「${t}」`).join('');
      if (!hits.length) {
        if (await aiReady()) return suggest({ kind: 'free', raw: text });
        return toast(`${name}は見つかりませんでした。「なぞる」で直接隠すこともできます`);
      }
      if (cmd.all) return applyHits(hits, `${name}を全部隠す`);
      showHits(`${name}は ${hits.length}か所 見つかりました`, hits, `${name}を隠す`);
    } catch (e) { console.error(e); toast(e.message || 'うまく処理できませんでした'); }
  }

  // 重要語句・問題づくり・自由な指示（AIがあればAI＋端末内、無ければ端末内の手がかりだけ）
  async function suggest(cmd) {
    const useAi = await aiReady();
    const b = busy(useAi ? 'AIが教材を読んで候補を考えています…' : '教材から候補を探しています…');
    try {
      if (cmd.kind === 'questions') {
        let qs;
        if (useAi) {
          const out = await aiQuestions(pages, cmd.raw);
          qs = out.map((q) => ({ q: q.question, a: q.answer, evidence: q.evidence, pageIndex: clamp((q.page || 1) - 1, 0, pages.length - 1), why: q.reason }));
          qs.forEach((q) => { q.pageId = pages[q.pageIndex].id; });
        } else qs = clozeQuestions(findImportantLocal(pages, await colorHits([1, 2], '色付きの文字')));
        b.done();
        if (!qs.length) return toast('問題にできそうな箇所が見つかりませんでした');
        return showQuestions(qs, useAi);
      }
      let hits;
      if (useAi) {
        const terms = await aiTerms(pages, cmd.raw);
        hits = terms.flatMap((t) => searchTerm(pages, t.text, t.reason));
        if (cmd.kind === 'important') { const local = findImportantLocal(pages, await colorHits([1, 2], '色付きの文字')); for (const l of local) if (!hits.some((x) => x.pageId === l.pageId && x.line === l.line && Math.abs(x.box.x0 - l.box.x0) < 4)) hits.push(l); }
      } else hits = findImportantLocal(pages, await colorHits([1, 2], '色付きの文字'));
      hits.sort((a, b2) => a.pageIndex - b2.pageIndex || a.line - b2.line || a.box.x0 - b2.box.x0);
      b.done();
      if (!hits.length) return toast('候補が見つかりませんでした');
      showHits(`候補が ${hits.length}か所 あります`, hits, '提案された語句を隠す',
        (useAi ? 'AIの提案です。' : '色・かぎかっこ・くり返しなどの手がかりから選んだ候補です。') + '試験に出ることを保証するものではありません。不要なものは外してください。');
    } catch (e) { console.error(e); toast(e.message || '候補を作れませんでした'); } finally { b.done(); }
  }

  // 番号付きの一覧（③）。「全部」「3番だけ」「1と4」を、タップ・入力・声のどれでも選べる。
  // 文字として読めていない所（手書きなど）は、その場所の切り抜きを見せて選べるようにする
  function cropOf(ht) {
    const b = ht.box, bw = b.x1 - b.x0, bh = b.y1 - b.y0, tall = bh > bw * 1.6;
    const mx = tall ? bw * 0.5 : Math.min(bh * 1.2, 60), my = tall ? Math.min(bw * 0.6, 40) : bh * 0.25;
    const sx = Math.max(0, b.x0 - mx), sy = Math.max(0, b.y0 - my), sw = bw + mx * 2, sh = bh + my * 2;
    const k = Math.min((tall ? 96 : 44) / sh, 230 / sw), cw = Math.max(24, Math.round(sw * k)), chh = Math.max(20, Math.round(sh * k));
    const c = h('canvas.hit-crop', { width: cw * 2, height: chh * 2, style: { width: cw + 'px', height: chh + 'px' } });
    const p = pages.find((x) => x.id === ht.pageId);
    if (p) getImg(p).then((img) => { const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
      ctx.fillStyle = 'rgba(255, 200, 0, .28)'; ctx.fillRect((b.x0 - sx) * k * 2, (b.y0 - sy) * k * 2, bw * k * 2, bh * k * 2); }).catch(() => {});
    return c;
  }
  function showHits(title, hits, label, note) {
    const checked = hits.map(() => true);
    const rows = hits.map((ht, i) => {
      const cb = h('input', { type: 'checkbox', checked: true, onchange: () => { checked[i] = cb.checked; sync(); } });
      return h('label.hit-row', cb, h('span.hit-num', numLabel(i + 1)),
        h('span.hit-main', ht.text ? h('span.hit-ctx', ht.pre, h('mark', ht.text), ht.post) : cropOf(ht),
          h('span.hit-meta', `${ht.pageIndex + 1}ページ目${ht.line >= 0 ? `・${ht.line + 1}行目` : ''}`, ht.why ? h('span.why', `根拠: ${ht.why}`) : null)));
    });
    const applyBtn = h('button.btn.primary', { onclick: () => { close(); applyHits(hits.filter((_, i) => checked[i]), label); } });
    const sync = () => { const n = checked.filter(Boolean).length; applyBtn.textContent = `選んだ ${n}件を隠す`; applyBtn.disabled = !n; };
    const setAll = (v) => { checked.fill(v); rows.forEach((r) => { r.querySelector('input').checked = v; }); sync(); };
    const pickIn = h('input.cmd-input', { type: 'text', placeholder: '「全部」「3番だけ」「1と4」「2から5」' });
    const doPick = (t) => { const pick = parseSelection(t, hits.length); if (!pick) return toast('番号が読み取れませんでした'); checked.fill(false); pick.forEach((n) => { checked[n - 1] = true; }); rows.forEach((r, i) => { r.querySelector('input').checked = checked[i]; }); sync(); if (pick.length) { close(); applyHits(pick.map((n) => hits[n - 1]), label); } };
    const body = h('div.hits', note ? h('p.note', note) : null,
      h('div.row', h('button.chip', { onclick: () => setAll(true) }, '全部えらぶ'), h('button.chip', { onclick: () => setAll(false) }, '全部はずす')),
      h('div.hit-list', rows),
      h('form.cmd-row.inset', { onsubmit: (e) => { e.preventDefault(); doPick(pickIn.value); } }, pickIn,
        speechAvailable ? h('button.icon-btn.mic', { type: 'button', 'aria-label': '声で番号を選ぶ', onclick: async (e) => { const btn = e.currentTarget; const t = await listenOnce((on) => btn.classList.toggle('rec', on)); if (t) { pickIn.value = t; doPick(t); } } }, icon('mic')) : null,
        h('button.icon-btn.send', { type: 'submit', 'aria-label': '番号で選ぶ' }, icon('send'))),
      h('div.row.end', applyBtn));
    const close = sheet(title, body, { onClose: () => { if (lastHits?.hits === hits) lastHits = null; } });
    lastHits = { hits, label, close }; sync();
  }

  async function applyHits(hits, label) {
    if (!hits.length) return;
    const byPage = new Map(); for (const ht of hits) { if (!byPage.has(ht.pageId)) byPage.set(ht.pageId, []); byPage.get(ht.pageId).push(ht); }
    const ps = pages.filter((p) => byPage.has(p.id)); const inks = new Map();
    for (const p of ps) inks.set(p.id, await inkOf(p));
    let added = 0;
    transact(label, ps, () => {
      for (const p of ps) for (const ht of byPage.get(p.id)) {
        const b = ht.tight ? ht.box : tightenBox(inks.get(p.id), ht.box); // ④ 文字の大きさに合わせて幅・長さを自動調整
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        if (p.masks.some((m) => G.hit(m, cx, cy) && Math.abs(m.w - (b.x1 - b.x0)) < (b.x1 - b.x0) * 0.5)) continue; // 既に隠してある
        p.masks.push(newMask(G.rectMask(b.x0, b.y0, b.x1, b.y1), { text: ht.text || '', src: 'auto', why: ht.why || '' })); added++;
      }
    });
    const other = ps.filter((p) => p.id !== page.id).length;
    toast(added ? `${added}件を隠しました${other ? `（ほかのページ ${other}枚を含む）` : ''}` : 'すでに隠してありました', added ? { label: '元に戻す', fn: undo } : null);
  }

  // 問題の確認・編集（保存してから学習に使う）
  function showQuestions(qs, fromAi) {
    const items = qs.map((q) => ({ ...q, on: true }));
    const rows = items.map((it) => {
      const qa = h('textarea.q-in', { rows: 2, value: it.q, oninput: (e) => { it.q = e.target.value; } });
      const an = h('input.q-in', { type: 'text', value: it.a, oninput: (e) => { it.a = e.target.value; } });
      return h('div.q-row', h('label.q-check', h('input', { type: 'checkbox', checked: true, onchange: (e) => { it.on = e.target.checked; } }), h('span', `${it.pageIndex + 1}ページ目`)),
        h('div.q-fields', h('span.q-cap', '問題'), qa, h('span.q-cap', '答え'), an, h('div.q-ev', '根拠: ', h('q', it.evidence), it.why ? ` ／ ${it.why}` : '')));
    });
    const close = sheet(`問題の候補 ${qs.length}問`, h('div.hits',
      h('p.note', (fromAi ? 'AIが教材の記述から作った候補です。' : '教材の文から作った穴埋め問題の候補です。') + '試験に出ることを保証するものではありません。内容を確かめ、必要なら直してから保存してください。'),
      h('div.hit-list', rows),
      h('div.row.end', h('button.btn.primary', { onclick: async () => {
        const keep = items.filter((it) => it.on && it.q.trim() && it.a.trim());
        deck.questions = (deck.questions || []).concat(keep.map((it) => ({ id: uid(), q: it.q.trim(), a: it.a.trim(), evidence: it.evidence, pageId: it.pageId, srs: null, log: [] })));
        await db.putDeck(deck); close();
        toast(`${keep.length}問を保存しました`, { label: '一問一答をはじめる', fn: () => nav.quiz(deck.id) });
      } }, '保存する'))), { wide: true });
  }

  // ---------- そのほかの設定 ----------
  function openOptions() {
    const tog = (label, key, desc) => h('label.opt-row', h('span', h('strong', label), desc ? h('small', desc) : null),
      h('input.switch', { type: 'checkbox', checked: settings[key], onchange: async (e) => { settings[key] = e.target.checked; await saveSettings({ [key]: e.target.checked }); refresh(); } }));
    const close = sheet('エディタの設定', h('div.opts',
      tog('文字に自動フィット', 'autoFit', 'なぞった行の文字の高さに合わせ、となりの行を巻き込まない形にします'),
      tog('角度の吸着', 'snap', 'ほぼ水平・垂直のときにぴったり揃えます（オフで完全に自由な角度）'),
      tog('指でも描く', 'fingerDraws', 'オフにすると指1本は移動、ペンやマウスだけで描きます'),
      tog('ペンを使ったら指は移動にする', 'penPalm', 'Apple Pencil などで書きはじめたら、その後は指で線を引きません（手を置いて書けます）'),
      tog('拡大鏡', 'loupe', '指でなぞっている間、指の下を上の隅に大きく映します（画面右上の虫めがねボタンでも切り替え）'),
      h('div.opt-row', h('span', h('strong', 'マーカーの太さ'), h('small', '文字が見つからない所・自動フィットがオフのとき')),
        h('div.seg', ['S', 'M', 'L'].map((s) => h('button.tool.only' + (settings.markerSize === s ? '.on' : ''), { onclick: async () => { settings.markerSize = s; await saveSettings({ markerSize: s }); close(); openOptions(); } }, s)))),
      h('div.row',
        h('button.btn', { onclick: async () => { close(); const b = busy('文字を読み取っています…'); try { await ocrPage(page, (p) => b.set(null, p)); toast('読み取り直しました'); } catch (e) { toast('読み取りに失敗しました'); } finally { b.done(); } } }, 'このページの文字を読み取り直す'),
        h('button.btn', { onclick: () => { close(); fixPhoto(); } }, icon('crop', 16), '写真のゆがみを直す（四隅を合わせる）'),
        h('button.btn.danger', { onclick: () => { close(); runCommand('隠しを全部消して'); } }, 'このページの隠しを全部消す'))));
  }
  // 斜めに撮れていたページを、あとから台形補正する。文字の位置が変わるので、隠しがあるページでは行わない。
  async function fixPhoto() {
    if (page.masks.length) return toast('隠しがあるページは補正できません（位置がずれるため）。先に隠しを消してください');
    const bmp = await getImg(page), c = makeCanvas(page.w, page.h); c.getContext('2d').drawImage(bmp, 0, 0, page.w, page.h);
    const out = await adjustPhoto(c, { okLabel: 'この形に直す' });
    if (!out || out === c) return;
    const b = busy('ページを差し替えています…');
    try { await replacePageImage(page, out); imgs.get(page.id)?.close?.(); imgs.delete(page.id); dropInk(page.id); hist.undo = []; hist.redo = []; await gotoPage(pi); toast('まっすぐに直しました'); } finally { b.done(); }
  }

  // ---------- ページ切替・提案チップ ----------
  async function gotoPage(i) {
    if (i < 0 || i >= pages.length) return;
    pi = i; page = pages[i]; sel = null; lastHits = null;
    view.setPage(page, await getImg(page)); refresh(); renderChips();
    history.replaceState(null, '', `#/edit/${deck.id}/${page.id}`);
  }
  function renderChips() {
    const base = [['重要語句を提案', '重要語句'], ['英単語だけ', '英単語だけ隠して'], ['問題を作る', '試験に出そうなところを問題にして']];
    const mk = ([label, cmd]) => h('button.chip', { onclick: () => runCommand(cmd) }, label);
    chips.replaceChildren(...base.map(mk));
    const pid = page.id;
    setTimeout(async () => { // 取込直後の「ワンタップ提案」: このページにある色を数えて出す
      try { const sum = colorSummary(await inkOf(page)); if (pid !== page.id) return;
        chips.replaceChildren(...sum.map((s) => h('button.chip.hot', { onclick: () => runCommand(s.name === 'マーカー部分' ? '蛍光マーカー部分を隠して' : `${s.name}だけ隠して`) }, `${s.name}を隠す（${s.count}）`)), ...base.map(mk));
      } catch { /* 提案は無くても支障なし */ }
    }, 60);
  }

  // ---------- キーボード ----------
  const onKey = (e) => {
    if (e.target.matches('input,textarea')) return;
    if (e.code === 'Space') { spaceDown = e.type === 'keydown'; if (e.type === 'keydown') e.preventDefault(); return; }
    if (e.type !== 'keydown' || document.querySelector('.sheet-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSel();
    else if (e.key === 'Escape') { sel = null; refresh(); }
    else if (e.key.startsWith('Arrow') && selMask()) {
      e.preventDefault(); const d = (e.shiftKey ? 10 : 1) / view.s, m = selMask();
      transact('移動', [page], () => { if (e.key === 'ArrowLeft') m.cx -= d; if (e.key === 'ArrowRight') m.cx += d; if (e.key === 'ArrowUp') m.cy -= d; if (e.key === 'ArrowDown') m.cy += d; });
    } else { const t = { 1: 'marker', 2: 'box', 3: 'word', 4: 'select', 5: 'erase', 6: 'pan' }[e.key]; if (t) setTool(t); }
  };
  window.addEventListener('keydown', onKey); window.addEventListener('keyup', onKey);

  await gotoPage(pi);
  return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKey); view.destroy(); imgs.forEach((b) => b.close?.()); pages.forEach((p) => dropInk(p.id)); };
}
export { norm };
