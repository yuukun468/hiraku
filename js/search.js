// ことばの指示（端末内・確定的）: 検索、番号選択の文法、指示文の解釈、候補の抽出。
// AIが無くてもここだけで ①③⑦ の大半が動く。AIは「候補を増やす係」。

const KANJI_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
export const norm = (s) => s.normalize('NFKC').toLowerCase().replace(/[\s　]/g, '');

function lineIndex(line) {
  // 正規化文字列と、各正規化文字 → 元の chars 添字 の対応
  let text = ''; const map = [];
  line.chars.forEach((ch, i) => { if (ch.sp) return; for (const c of norm(ch.c)) { text += c; map.push(i); } });
  return { text, map };
}
export const lineText = (line) => line.chars.map((c) => c.c).join('');

function boxOf(chars) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of chars) { if (c.sp) continue; x0 = Math.min(x0, c.x0); y0 = Math.min(y0, c.y0); x1 = Math.max(x1, c.x1); y1 = Math.max(y1, c.y1); }
  return { x0, y0, x1, y1 };
}

function makeHit(page, li, i0, i1, why) {
  const line = page.lines[li], chars = line.chars.slice(i0, i1 + 1);
  const raw = lineText(line);
  const pre = line.chars.slice(Math.max(0, i0 - 12), i0).map((c) => c.c).join('');
  const post = line.chars.slice(i1 + 1, i1 + 13).map((c) => c.c).join('');
  return { pageId: page.id, pageIndex: page.index, line: li, box: boxOf(chars), text: chars.map((c) => c.c).join('').trim(), pre, post, lineText: raw, why: why || null };
}

// 教材全体から同じ語を探す。読み順（ページ→行→位置）で番号が決まる。
export function searchTerm(pages, term, why) {
  const q = norm(term); const hits = [];
  if (!q) return hits;
  for (const page of pages) {
    if (!page.lines) continue;
    page.lines.forEach((line, li) => {
      const { text, map } = lineIndex(line);
      let from = 0, at;
      while ((at = text.indexOf(q, from)) >= 0) {
        hits.push(makeHit(page, li, map[at], map[at + q.length - 1], why));
        from = at + q.length;
      }
    });
  }
  return hits;
}

// 正規表現で拾う（英単語・数字など）
function searchRegex(pages, re, why, filter) {
  const hits = [];
  for (const page of pages) {
    if (!page.lines) continue;
    page.lines.forEach((line, li) => {
      // chars を1文字ずつ並べた文字列（空白は ' '）
      const idx = []; let s = '';
      line.chars.forEach((ch, i) => { const t = ch.sp ? ' ' : ch.c.normalize('NFKC'); for (const c of t) { s += c; idx.push(i); } });
      let m; re.lastIndex = 0;
      while ((m = re.exec(s))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const g = m[1] !== undefined ? m[1] : m[0], off = m.index + m[0].indexOf(g);
        if (filter && !filter(g)) continue;
        hits.push(makeHit(page, li, idx[off], idx[off + g.length - 1], why));
      }
    });
  }
  return hits;
}

export const findEnglish = (pages) => searchRegex(pages, /[A-Za-z][A-Za-z'’-]*[A-Za-z]|[A-Za-z]{2,}/g, '英単語');
export const findNumbers = (pages) => searchRegex(pages, /\d[\d,.]*(?:年|世紀|月|日|%|％|円|人|km|kg|cm|m|g|℃|度)?/g, '数字・年号');

// 重要語句の候補（端末内の手がかりだけ。根拠を必ず添える。当たる保証はしない）
export function findImportantLocal(pages, colorHits) {
  const out = new Map(); // key: page|line|x0
  const add = (h, why, score) => {
    const k = `${h.pageId}|${h.line}|${Math.round(h.box.x0)}`;
    const cur = out.get(k);
    if (cur) { cur.score += score; if (!cur.why.includes(why)) cur.why += '・' + why; } else out.set(k, { ...h, why, score });
  };
  // 1) 「」『』で囲まれた語
  for (const h of searchRegex(pages, /[「『]([^」』]{2,14})[」』]/g, 'かぎかっこで強調')) add(h, 'かぎかっこで強調', 2);
  // 2) 定義の形: 「〜を◯◯という」「◯◯とは」
  for (const h of searchRegex(pages, /(?:を|は)([一-龠ァ-ヶー]{2,10})(?:という|とよぶ|と呼ぶ)/g, '定義の文（〜という）')) add(h, '定義の文（〜という）', 3);
  for (const h of searchRegex(pages, /([一-龠ァ-ヶー]{2,10})とは/g, '定義の文（〜とは）')) add(h, '定義の文（〜とは）', 3);
  // 3) くり返し出てくる専門語（漢字2字以上・カタカナ3字以上で、教材内に2回以上）
  const freq = new Map(); const cands = searchRegex(pages, /[一-龠]{2,8}|[ァ-ヶー]{3,12}/g, '');
  for (const h of cands) freq.set(norm(h.text), (freq.get(norm(h.text)) || 0) + 1);
  const STOP = new Set(['今日', '以下', '以上', '場合', '時代', '問題', '確認', '復習', '同時', '裏側', 'プリント', 'チェック', 'メモ', 'まとめ']);
  for (const h of cands) { const n = freq.get(norm(h.text)); if (n >= 2 && !STOP.has(h.text)) add(h, `教材内に${n}回登場`, n >= 3 ? 2.2 : 1); }
  // 4) 色付き（赤字・青字）
  for (const h of colorHits || []) add(h, h.why, 3);
  // 5) 年号
  for (const h of searchRegex(pages, /(\d{3,4})年/g, '年号')) add(h, '年号', 2);
  // 同じ場所に重なる候補は1つにまとめる（点数の高い方を残し、根拠は合わせる）
  const arr = [...out.values()].sort((a, b) => b.score - a.score), kept = [];
  for (const h of arr) {
    const o = kept.find((k) => k.pageId === h.pageId && Math.min(k.box.y1, h.box.y1) - Math.max(k.box.y0, h.box.y0) > 0 && Math.min(k.box.x1, h.box.x1) - Math.max(k.box.x0, h.box.x0) > 0);
    if (o) { o.score += h.score * 0.5; for (const w of h.why.split('・')) if (w && !o.why.includes(w)) o.why += '・' + w; if (!o.text && h.text) o.text = h.text; } else kept.push(h);
  }
  return kept.filter((h) => h.score >= 2).sort((a, b) => a.pageIndex - b.pageIndex || a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
}

// 色の箱(ink.colorRegions) を、文字情報があれば語つきの hit に変換
export function boxesToHits(page, boxes, why) {
  return boxes.map((b) => {
    let text = '', line = -1, pre = '', post = '';
    if (page.lines) page.lines.forEach((ln, li) => {
      if (text) return;
      const isIn = (c) => !c.sp && (c.x0 + c.x1) / 2 > b.x0 && (c.x0 + c.x1) / 2 < b.x1 && (c.y0 + c.y1) / 2 > b.y0 && (c.y0 + c.y1) / 2 < b.y1;
      const i0 = ln.chars.findIndex(isIn); if (i0 < 0) return;
      let i1 = i0; ln.chars.forEach((c, i) => { if (isIn(c)) i1 = i; });
      text = ln.chars.slice(i0, i1 + 1).map((c) => c.c).join(''); line = li;
      pre = ln.chars.slice(Math.max(0, i0 - 12), i0).map((c) => c.c).join(''); post = ln.chars.slice(i1 + 1, i1 + 13).map((c) => c.c).join('');
    });
    return { pageId: page.id, pageIndex: page.index, line, box: b, text, pre, post, lineText: line >= 0 ? lineText(page.lines[line]) : '', why, tight: true };
  });
}

// ---- 番号選択の文法:「全部」「3番だけ」「1と4」「2から5」「3番以外」----
function toNum(s) {
  s = s.normalize('NFKC');
  if (/^\d+$/.test(s)) return Number(s);
  if (s.length === 1 && KANJI_NUM[s]) return KANJI_NUM[s];
  if (s.startsWith('十')) return 10 + (KANJI_NUM[s[1]] || 0);
  if (s.endsWith('十')) return (KANJI_NUM[s[0]] || 1) * 10;
  const m = s.match(/^(.)十(.)$/); if (m) return KANJI_NUM[m[1]] * 10 + KANJI_NUM[m[2]];
  return NaN;
}
const NUM = '(\\d+|[一二三四五六七八九十]{1,3})';
export function parseSelection(input, total) {
  const s = input.normalize('NFKC').replace(/[\s　]/g, '').replace(/①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩/g, (c) => '①②③④⑤⑥⑦⑧⑨⑩'.indexOf(c) + 1);
  if (!s) return null;
  const all = Array.from({ length: total }, (_, i) => i + 1);
  if (/^(全部|すべて|全て|ぜんぶ|全件|みんな|all)/i.test(s)) return all;
  if (/(なし|やめ|キャンセル|いらない)/.test(s)) return [];
  const picked = new Set();
  let rest = s.replace(new RegExp(`${NUM}番?(?:目)?(?:から|〜|~|-)${NUM}番?(?:目)?(?:まで)?`, 'g'), (_, a, b) => { const x = toNum(a), y = toNum(b); for (let i = Math.min(x, y); i <= Math.max(x, y); i++) picked.add(i); return ','; });
  for (const m of rest.matchAll(new RegExp(NUM, 'g'))) { const n = toNum(m[1]); if (!Number.isNaN(n)) picked.add(n); }
  if (!picked.size) { if (/(最初|はじめ)/.test(s)) picked.add(1); else if (/(最後|さいご)/.test(s)) picked.add(total); else return null; }
  let res = [...picked].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  if (/(以外|除|のぞ)/.test(s)) res = all.filter((n) => !picked.has(n));
  return res;
}

// ---- 指示文の解釈 ----
// 返り値: { kind, ... }  kind: color | english | numbers | important | questions | search | clear | undo | redo | unknown
export function parseCommand(input) {
  const raw = input.trim(); const s = raw.normalize('NFKC');
  if (!s) return { kind: 'empty' };
  if (/^(元に戻|もとにもど|取り消|とりけし|アンドゥ|undo)/i.test(s)) return { kind: 'undo' };
  if (/^(やり直|やりなお|リドゥ|redo)/i.test(s)) return { kind: 'redo' };
  if (/(隠し|マスク|マーカー|かくし)を?(全部|すべて|全て)?(消|削除|クリア|外|はず)/.test(s) || /^(全部|すべて|全て)(消|削除|クリア)/.test(s)) return { kind: 'clear' };
  if (/(試験|テスト|出そう|でそう|問題に|問題を|クイズ|一問一答)/.test(s)) return { kind: 'questions', raw };
  if (/(重要|大事|だいじ|キーワード|大切|ポイント)/.test(s)) return { kind: 'important', raw };
  if (/(下線|傍線|波線|アンダーライン|線を引いた語|線の引いてある)/.test(s)) return { kind: 'color', ids: ['under'], label: '下線の語' };
  if (/(囲み|囲った|囲んだ|丸で囲|四角で囲|枠で囲|丸をつけた)/.test(s)) return { kind: 'color', ids: ['boxed'], label: '囲みの語' };
  if (/(赤字|赤い字|赤文字|赤色|赤いところ|赤の|オレンジ)/.test(s)) return { kind: 'color', ids: [1], label: '赤字' };
  if (/(青字|青い字|青文字|青色)/.test(s)) return { kind: 'color', ids: [2], label: '青字' };
  if (/(緑字|緑の字|緑文字)/.test(s)) return { kind: 'color', ids: [3], label: '緑字' };
  if (/(色付き|色つき|色の付いた|カラー)/.test(s)) return { kind: 'color', ids: [1, 2, 3], label: '色付きの文字' };
  if (/(蛍光|マーカー|ハイライト|線を引いた|塗ってある)/.test(s)) return { kind: 'color', ids: [4, 5, 6, 7], label: 'マーカー部分' };
  if (/(英単語|英語|アルファベット|えいたんご)/.test(s)) return { kind: 'english' };
  if (/(数字|年号|年代|数値|すうじ)/.test(s)) return { kind: 'numbers' };
  // 「光合成を隠して」「光合成と葉緑体を全部隠して」「『酸素』」
  const quoted = [...s.matchAll(/[「『"]([^」』"]+)[」』"]/g)].map((m) => m[1]);
  const all = /(全部|すべて|全て|ぜんぶ)/.test(s);
  let terms = quoted;
  if (!terms.length) {
    const m = s.match(/^(.+?)(?:という(?:言葉|語|単語|用語))?(?:を|は|って)?(?:全部|すべて|全て|ぜんぶ|だけ)?(?:隠|かく|消し|マーク|塗|ぬ|探|さが|検索|見つけ|みつけ)/);
    const body = (m ? m[1] : s).replace(/(を|は)$/, '');
    terms = body.split(/[、,・]|(?<=[^\s])と(?=[^\s])/).map((t) => t.trim()).filter(Boolean);
    // 「と」を含む語そのもの（例: ペリーと…）を壊さないよう、分割前の全体も候補に持つ
    if (terms.length > 1) return { kind: 'search', terms, whole: body, all };
  }
  return { kind: 'search', terms, all };
}

// ---- 端末内の一問一答づくり（穴埋め）。文そのものが根拠になる ----
export function clozeQuestions(hits, limit = 30) {
  const seen = new Set(), qs = [];
  for (const h of hits) {
    if (!h.text || h.text.length < 2 || !h.lineText) continue;
    const key = norm(h.text) + '|' + h.pageId + '|' + h.line;
    if (seen.has(key)) continue; seen.add(key);
    const blank = '＿'.repeat(Math.min(6, Math.max(2, [...h.text].length)));
    const q = (h.pre + '【' + blank + '】' + h.post).trim();
    qs.push({ q: `（　）に入る語は？\n${h.lineText.replace(h.text, '（　　）')}`, a: h.text, evidence: h.lineText, pageId: h.pageId, pageIndex: h.pageIndex, why: h.why || '', short: q });
    if (qs.length >= limit) break;
  }
  return qs;
}
