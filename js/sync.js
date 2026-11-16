// 端末間の同期。保管場所は「自分の GitHub の非公開リポジトリ」（設定で 場所 と 鍵 を入れた場合だけ動く）。
// 置き方:  decks/<教材ID>.json … 教材・ページの情報・隠し・学習記録（画像は含まない）
//          pages/<ページID>[.<版>].jpg … ページ画像（取り込み後は変わらないので1回だけ送る）
//          wallet.json … コインと持ち物 ／ deleted.json … 消した教材のID（ほかの端末でも消すため）
// 方針: どちらの端末の記録も失わない。両方で変わっていたら「合わせる」（隠しは両方を残し、学習記録は進んでいる方を採る）。
import { db, getSettings, saveSettings } from './db.js';
import { getWallet, mergeWallet, applyWallpaper } from './rewards.js';

export const syncReady = (s) => !!(s.syncOn && s.syncRepo && s.syncToken);
const imgPath = (p) => `pages/${p.id}${p.imgRev ? '.' + p.imgRev : ''}.jpg`;
const deckPath = (id) => `decks/${id}.json`;

// 変わったかどうかを見るための軽いハッシュ（暗号用ではない）
function hash(str) {
  let a = 0x811c9dc5, b = 0x1b873593;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b) + i; }
  return (a >>> 0).toString(16) + (b >>> 0).toString(16) + str.length.toString(16);
}
const metaOf = ({ blob, ...rest }) => rest;
const docOf = (deck, pages) => ({ v: 1, deck, pages: pages.slice().sort((x, y) => x.index - y.index).map((p) => ({ ...metaOf(p), img: imgPath(p) })) });
const hashDoc = (doc) => hash(JSON.stringify(doc));

const toB64 = (blob) => new Promise((r, j) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1] || ''); fr.onerror = () => j(fr.error); fr.readAsDataURL(blob); });

class SyncError extends Error {}
function client(s) {
  const base = `${(s.syncApi || 'https://api.github.com').replace(/\/$/, '')}/repos/${s.syncRepo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '')}`;
  const call = async (method, path, body, raw) => {
    let res;
    try {
      res = await fetch(base + path, { method, cache: 'no-store', body: body ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${s.syncToken.trim()}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch { throw new SyncError('保管場所につながりませんでした（電波の状態を確かめてください）'); }
    if (res.status === 401) throw new SyncError('鍵（トークン）が正しくないか、期限が切れています');
    if (res.status === 403 || res.status === 429) throw new SyncError('保管場所に断られました（鍵の権限が足りないか、短時間に使いすぎです。少し待ってからもう一度）');
    return res;
  };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  return {
    async info() { const r = await call('GET', ''); if (r.status === 404) throw new SyncError('保管場所が見つかりません（「ユーザー名/リポジトリ名」と、鍵の対象を確かめてください）'); if (!r.ok) throw new SyncError(`保管場所を開けませんでした (${r.status})`); return r.json(); },
    // 保管場所にある全ファイルの一覧（path → sha）
    async tree(branch) {
      const r = await call('GET', `/git/trees/${encodeURIComponent(branch)}?recursive=1`);
      if (r.status === 404 || r.status === 409) return new Map(); // まだ空
      if (!r.ok) throw new SyncError(`一覧を取れませんでした (${r.status})`);
      const j = await r.json(); return new Map((j.tree || []).filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));
    },
    async put(path, blob, sha, msg) {
      const r = await call('PUT', `/contents/${enc(path)}`, { message: msg, content: await toB64(blob), ...(sha ? { sha } : {}) });
      if (r.status === 409 || r.status === 422) throw new SyncError('ほかの端末と同時に書き込みました。もう一度同期してください');
      if (!r.ok) throw new SyncError(`保存できませんでした (${r.status})`);
      return (await r.json()).content.sha;
    },
    async get(path) { const r = await call('GET', `/contents/${enc(path)}`, null, true); if (!r.ok) throw new SyncError(`読み込めませんでした: ${path} (${r.status})`); return r.blob(); },
    async json(path) { return JSON.parse(await (await this.get(path)).text()); },
    async del(path, sha, msg) { const r = await call('DELETE', `/contents/${enc(path)}`, { message: msg, sha }); if (!r.ok && r.status !== 404) throw new SyncError(`消せませんでした (${r.status})`); },
  };
}

// ---- 2つの端末で別々に変わった教材を合わせる ----
const later = (a, b) => ((b?.last || 0) > (a?.last || 0) ? b : a);
function betterStudy(a, b) { // 学習記録は、たくさん取り組んだ方（同じなら新しい方）
  const la = (a.log || []).length, lb = (b.log || []).length;
  if (la !== lb) return la > lb ? a : b;
  return (b.srs?.last || 0) > (a.srs?.last || 0) ? b : a;
}
export function mergeDocs(local, remote) {
  const newer = (local.deck.updated || 0) >= (remote.deck.updated || 0) ? local : remote, older = newer === local ? remote : local;
  const deck = { ...older.deck, ...newer.deck };
  const qs = new Map(); for (const q of [...(older.deck.questions || []), ...(newer.deck.questions || [])]) { const o = qs.get(q.id); qs.set(q.id, o ? { ...q, srs: later(o.srs, q.srs) } : q); }
  if (qs.size) deck.questions = [...qs.values()];
  const lp = new Map(local.pages.map((p) => [p.id, p])), rp = new Map(remote.pages.map((p) => [p.id, p])), pages = [];
  for (const id of new Set([...lp.keys(), ...rp.keys()])) {
    const a = lp.get(id), b = rp.get(id);
    if (!a || !b) { pages.push({ ...(a || b), from: a ? 'local' : 'remote' }); continue; }
    const base = (a.updated || 0) >= (b.updated || 0) ? a : b, other = base === a ? b : a;
    const om = new Map(other.masks.map((m) => [m.id, m]));
    const masks = base.masks.map((m) => { const o = om.get(m.id); if (!o) return m; om.delete(m.id); const st = betterStudy(m, o); return { ...m, srs: st.srs, log: st.log }; });
    masks.push(...om.values()); // 片方にしか無い隠しは残す（消したものが戻ることはあるが、失うことはない）
    pages.push({ ...base, masks, from: base === a ? 'local' : 'remote' });
  }
  const order = new Map(newer.pages.map((p, i) => [p.id, i]));
  pages.sort((x, y) => (order.has(x.id) ? order.get(x.id) : 1e6 + x.index) - (order.has(y.id) ? order.get(y.id) : 1e6 + y.index)).forEach((p, i) => { p.index = i; });
  return { deck, pages };
}

let running = null;
export const syncBusy = () => !!running;
// 同期を1回行う。返り値 { up, down, merged, removed }（件数）
export function syncNow(onProgress) {
  if (running) return running;
  running = run(onProgress || (() => {})).finally(() => { running = null; });
  return running;
}
async function run(progress) {
  const s = await getSettings();
  if (!s.syncRepo || !s.syncToken) throw new SyncError('保管場所と鍵を設定してください');
  const gh = client(s), res = { up: 0, down: 0, merged: 0, removed: 0 };
  progress('保管場所を確かめています…', 0);
  const info = await gh.info();
  if (info.private === false) throw new SyncError('この保管場所は「公開」になっています。ノートが誰でも見られてしまうので、非公開（Private）のリポジトリを使ってください');
  const tree = await gh.tree(info.default_branch || 'main');
  const state = await db.get('syncState', {}), tomb = await db.get('syncTomb', {});
  const gone = tree.has('deleted.json') ? await gh.json('deleted.json').catch(() => ({ ids: {} })) : { ids: {} }; let goneChanged = false;
  const localDoc = async (d) => docOf(d, await db.pagesOf(d.id));

  const upload = async (doc, why) => {
    const pages = await db.pagesOf(doc.deck.id);
    for (const p of pages) { const path = imgPath(p); if (!tree.has(path)) { tree.set(path, await gh.put(path, p.blob, null, `page ${p.index + 1}: ${doc.deck.title}`)); } }
    const path = deckPath(doc.deck.id), sha = await gh.put(path, new Blob([JSON.stringify(doc)], { type: 'application/json' }), tree.get(path), `${why}: ${doc.deck.title}`);
    tree.set(path, sha); state[doc.deck.id] = { sha, hash: hashDoc(doc) };
  };
  // 保管場所の内容（doc）をこの端末に書き込む。画像は、持っていなければ取りに行く
  const writeLocal = async (doc) => {
    const have = new Map((await db.pagesOf(doc.deck.id)).map((p) => [p.id, p]));
    for (const meta of doc.pages) {
      const { img, from, ...rest } = meta, old = have.get(meta.id); have.delete(meta.id);
      const blob = old && (old.imgRev || 0) === (meta.imgRev || 0) ? old.blob : await gh.get(img || imgPath(meta));
      await db.putPageRaw({ ...rest, blob: /^image\//.test(blob.type) ? blob : new Blob([blob], { type: 'image/jpeg' }) });
    }
    for (const id of have.keys()) await db.delPage(id);
    await db.putDeckRaw(doc.deck);
  };

  // 1) この端末で消した教材を、保管場所からも消す
  for (const id of Object.keys(tomb)) {
    const path = deckPath(id);
    if (tree.has(path)) {
      const doc = await gh.json(path).catch(() => null);
      for (const p of doc?.pages || []) { const ip = p.img || imgPath(p); if (tree.has(ip)) { await gh.del(ip, tree.get(ip), 'remove page'); tree.delete(ip); } }
      await gh.del(path, tree.get(path), `remove: ${doc?.deck?.title || id}`); tree.delete(path); res.removed++;
    }
    gone.ids[id] = tomb[id]; goneChanged = true; delete state[id]; delete tomb[id];
    await db.set('syncTomb', tomb);
  }
  // 2) ほかの端末で消された教材を、この端末からも消す（この端末で手を入れていなければ）
  let decks = await db.decks();
  for (const d of decks) {
    if (!gone.ids[d.id] || tree.has(deckPath(d.id))) continue;
    if (state[d.id] && hashDoc(await localDoc(d)) === state[d.id].hash) { await db.delDeckRaw(d.id); delete state[d.id]; res.removed++; }
    else { delete gone.ids[d.id]; goneChanged = true; delete state[d.id]; } // 手を入れてあるので残し、もう一度保管場所へ送る
  }
  decks = await db.decks();
  // 3) この端末にある教材
  let n = 0;
  for (const d of decks) {
    progress(`「${d.title}」を合わせています…`, 0.1 + 0.7 * (n++ / Math.max(1, decks.length)));
    const doc = await localDoc(d), h = hashDoc(doc), rsha = tree.get(deckPath(d.id)), st = state[d.id];
    if (!rsha) { await upload(doc, 'add'); res.up++; }
    else if (st && st.hash === h && st.sha === rsha) { /* どちらも変わっていない */ }
    else if (st && st.sha === rsha) { await upload(doc, 'update'); res.up++; }
    else if (st && st.hash === h) { const r = await gh.json(deckPath(d.id)); await writeLocal(r); state[d.id] = { sha: rsha, hash: hashDoc(await localDoc(r.deck)) }; res.down++; }
    else { // 両方で変わった（または、この端末では初めて合わせる）
      const m = mergeDocs(doc, await gh.json(deckPath(d.id)));
      await writeLocal(m); await upload(await localDoc(m.deck), 'merge'); res.merged++;
    }
    await db.set('syncState', state);
  }
  // 4) 保管場所にだけある教材を受け取る
  const mine = new Set(decks.map((d) => d.id)), todo = [...tree.keys()].filter((p) => /^decks\/[^/]+\.json$/.test(p) && !mine.has(p.slice(6, -5)));
  for (let i = 0; i < todo.length; i++) {
    const r = await gh.json(todo[i]); progress(`「${r.deck.title}」を受け取っています…`, 0.8 + 0.15 * (i / todo.length));
    await writeLocal(r); state[r.deck.id] = { sha: tree.get(todo[i]), hash: hashDoc(await localDoc(r.deck)) }; res.down++;
    await db.set('syncState', state);
  }
  // 5) コインと持ち物（減ることはない）
  progress('コインを合わせています…', 0.96);
  if (tree.has('wallet.json')) { await mergeWallet(await gh.json('wallet.json').catch(() => null)); await applyWallpaper(); }
  const w = JSON.stringify(await getWallet()), wh = hash(w);
  if (!tree.has('wallet.json') || state._wallet?.hash !== wh || state._wallet?.sha !== tree.get('wallet.json')) { const sha = await gh.put('wallet.json', new Blob([w]), tree.get('wallet.json'), 'wallet'); state._wallet = { sha, hash: wh }; }
  if (goneChanged) await gh.put('deleted.json', new Blob([JSON.stringify(gone)]), tree.get('deleted.json'), 'deleted list');
  await db.set('syncState', state);
  await saveSettings({ syncLast: Date.now(), syncNote: `送信 ${res.up}・受信 ${res.down}・統合 ${res.merged}・削除 ${res.removed}` });
  progress('', 1);
  return res;
}

// 自動同期: 設定済みで、前回から2分以上たっていれば裏で1回行う。変化があれば onChange を呼ぶ
let lastAuto = 0;
export async function autoSync(onChange) {
  const s = await getSettings();
  if (!syncReady(s) || running || !navigator.onLine || Date.now() - lastAuto < 120000) return;
  lastAuto = Date.now();
  try { const r = await syncNow(); if (r.down || r.merged || r.removed) onChange && onChange(r); }
  catch (e) { console.warn('自動同期に失敗:', e.message || e); await saveSettings({ syncNote: '前回の自動同期は失敗: ' + (e.message || e) }); }
}
