// 端末内保存 (IndexedDB)。教材の原本画像は変更せず、マスクと学習履歴を別に持つ。
const NAME = globalThis.__HIRAKU_DB__ || 'hiraku-db', VER = 1; // 自動採点（tests/）は別の名前を使い、本物のデータに触れない
let dbp = null;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('decks')) db.createObjectStore('decks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('deck', 'deckId');
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function store(name, mode = 'readonly') { return (await open()).transaction(name, mode).objectStore(name); }

export const db = {
  async decks() { return (await req((await store('decks')).getAll())).sort((a, b) => b.updated - a.updated); },
  async deck(id) { return req((await store('decks')).get(id)); },
  async putDeck(d) { d.updated = Date.now(); return req((await store('decks', 'readwrite')).put(d)); },
  async putDeckRaw(d) { return req((await store('decks', 'readwrite')).put(d)); }, // 同期用: 更新時刻を書き換えない
  async page(id) { return req((await store('pages')).get(id)); },
  async pagesOf(deckId) { return (await req((await store('pages')).index('deck').getAll(deckId))).sort((a, b) => a.index - b.index); },
  async allPages() { return req((await store('pages')).getAll()); },
  async putPage(p) { p.updated = Date.now(); return req((await store('pages', 'readwrite')).put(p)); },
  async putPageRaw(p) { return req((await store('pages', 'readwrite')).put(p)); },
  async delPage(id) { return req((await store('pages', 'readwrite')).delete(id)); },
  async delDeck(id) {
    // 同期している教材を消したら、ほかの端末と保管場所からも消すための印を残す
    if ((await this.get('syncState', {}))[id]) { const t = await this.get('syncTomb', {}); t[id] = Date.now(); await this.set('syncTomb', t); }
    return this.delDeckRaw(id);
  },
  async delDeckRaw(id) {
    for (const p of await this.pagesOf(id)) await this.delPage(p.id);
    return req((await store('decks', 'readwrite')).delete(id));
  },
  async get(key, def) { const v = await req((await store('kv')).get(key)); return v === undefined ? def : v; },
  async set(key, val) { return req((await store('kv', 'readwrite')).put(val, key)); },
  async wipe() { (await open()).close(); dbp = null; return req(indexedDB.deleteDatabase(NAME)); },
};

// ---- 設定 ----
export const DEFAULT_SETTINGS = {
  timer: 60, fingerDraws: true, autoFit: true, snap: true, markerSize: 'M', loupe: true, penPalm: true,
  syncOn: false, syncRepo: '', syncToken: '', syncApi: '',
  aiEnabled: false, aiKey: '', aiModel: 'claude-opus-5-5', ocrLang: 'jpn+eng', sound: true,
};
let settings = null;
export async function getSettings() { if (!settings) settings = { ...DEFAULT_SETTINGS, ...(await db.get('settings', {})) }; return settings; }
export async function saveSettings(patch) { settings = { ...(await getSettings()), ...patch }; await db.set('settings', settings); return settings; }
