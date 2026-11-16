// 取込: 写真・画像・PDF → ページ。文字認識(OCR)は端末内（Tesseract）。PDFに文字情報があればそれを使う（OCR不要で正確）。
import { db, getSettings } from './db.js';
import { uid, makeCanvas, canvasToBlob, blobToImage, busy, toast } from './util.js';
import { adjustPhoto } from './scan.js';

const MAX_PAGE = 2200;
let pdfjs = null, ocrWorker = null, ocrLang = null;

async function loadPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

function thumbOf(canvas) {
  const k = 360 / canvas.width, t = makeCanvas(360, Math.round(canvas.height * k));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

async function pageFromCanvas(deckId, index, canvas, lines, ocrState) {
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  return { id: uid(), deckId, index, w: canvas.width, h: canvas.height, blob, thumb: thumbOf(canvas), lines: lines || null, ocrState, masks: [] };
}

async function imageFileToCanvas(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { bmp = await blobToImage(file); }
  const k = Math.min(1, MAX_PAGE / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

const isWide = (ch) => ch.charCodeAt(0) > 0x2e7f || (ch.charCodeAt(0) >= 0xff00 && ch.charCodeAt(0) <= 0xff60);

let measureCtx = null; const widthCache = new Map();
function charWidth(ch) {
  if (!widthCache.has(ch)) {
    if (!measureCtx) { measureCtx = makeCanvas(4, 4).getContext('2d'); measureCtx.font = '100px Arial, Helvetica, sans-serif'; }
    widthCache.set(ch, Math.max(0.2, measureCtx.measureText(ch).width / 100));
  }
  return widthCache.get(ch);
}

// PDFの文字情報 → 行と文字枠
function linesFromPdfText(items, viewport, Util) {
  const frags = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = Util.transform(viewport.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (Math.abs(tx[1]) > Math.abs(tx[0]) * 0.3) continue; // 回転文字は対象外
    const x = tx[4], yb = tx[5], w = it.width * viewport.scale;
    const units = [...it.str].map((ch) => (isWide(ch) ? 1 : charWidth(ch))); // 欧文は実際の字幅の比で割り振る
    const total = units.reduce((a, b) => a + b, 0) || 1;
    let cx = x; const chars = [];
    [...it.str].forEach((ch, i) => {
      const cw = w * units[i] / total;
      chars.push(ch.trim() ? { c: ch, x0: cx, y0: yb - fh * 0.88, x1: cx + cw, y1: yb + fh * 0.14 } : { c: ' ', sp: true, x0: cx, y0: yb, x1: cx + cw, y1: yb });
      cx += cw;
    });
    frags.push({ x, yb, fh, chars });
  }
  frags.sort((a, b) => a.yb - b.yb || a.x - b.x);
  const lines = [];
  for (const f of frags) {
    const L = lines.find((l) => Math.abs(l.yb - f.yb) < Math.max(l.fh, f.fh) * 0.45);
    if (L) { L.frags.push(f); } else lines.push({ yb: f.yb, fh: f.fh, frags: [f] });
  }
  return lines.map((l) => {
    l.frags.sort((a, b) => a.x - b.x);
    const chars = [];
    l.frags.forEach((f, i) => {
      if (i > 0) { const prev = chars[chars.length - 1]; if (prev && !prev.sp && f.x - prev.x1 > f.fh * 0.3) chars.push({ c: ' ', sp: true, x0: prev.x1, y0: prev.y0, x1: f.x, y1: prev.y1 }); }
      chars.push(...f.chars);
    });
    return { chars };
  }).filter((l) => l.chars.some((c) => !c.sp));
}

async function importPdf(file, deckId, startIndex, prog) {
  const lib = await loadPdfjs();
  const base = new URL('../vendor/pdfjs/', import.meta.url).href;
  const doc = await lib.getDocument({ data: await file.arrayBuffer(), cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/' }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    prog(`PDFを読み込み中… ${i}/${doc.numPages}ページ`, i / doc.numPages);
    const pg = await doc.getPage(i);
    const v1 = pg.getViewport({ scale: 1 });
    const viewport = pg.getViewport({ scale: Math.min(3, 1700 / v1.width) });
    const canvas = makeCanvas(Math.round(viewport.width), Math.round(viewport.height));
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, canvas, viewport, intent: 'print' }).promise; // print: 画面が裏にあっても止まらない
    let lines = null;
    try { const tc = await pg.getTextContent(); lines = linesFromPdfText(tc.items, viewport, lib.Util); } catch { lines = null; }
    const enough = lines && lines.reduce((n, l) => n + l.chars.length, 0) >= 8;
    pages.push(await pageFromCanvas(deckId, startIndex + pages.length, canvas, enough ? lines : null, enough ? 'pdf' : 'none'));
  }
  return pages;
}

// ---- OCR (端末内) ----
async function getOcr(lang, logger) {
  if (ocrWorker && ocrLang === lang) return ocrWorker;
  if (ocrWorker) { try { await ocrWorker.terminate(); } catch { /* 既に終了 */ } ocrWorker = null; }
  const T = await import('../vendor/tesseract/tesseract.esm.min.js');
  const createWorker = T.createWorker || T.default.createWorker;
  const u = (p) => new URL(p, import.meta.url).href;
  ocrWorker = await createWorker(lang.split('+'), 1, {
    workerPath: u('../vendor/tesseract/worker.min.js'), corePath: u('../vendor/tesseract/'), langPath: u('../vendor/tessdata/'), gzip: true,
    workerBlobURL: false, // ワーカーを同じ場所から直接読み込む（Service Worker がオフライン用に保存できるように）
    logger: (m) => logger && logger(m),
  });
  ocrLang = lang;
  return ocrWorker;
}
const ascii = (ch) => /[A-Za-z0-9]/.test(ch);

function linesFromOcr(data) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const chars = [];
    for (const w of l.words || []) {
      const syms = (w.symbols && w.symbols.length) ? w.symbols : [{ text: w.text, bbox: w.bbox }];
      const first = syms[0] && syms[0].text ? syms[0].text[0] : '';
      const prev = chars[chars.length - 1];
      if (prev && !prev.sp && ascii(prev.c) && ascii(first)) chars.push({ c: ' ', sp: true, x0: prev.x1, y0: prev.y0, x1: w.bbox.x0, y1: prev.y1 });
      for (const s of syms) {
        const t = (s.text || '').trim(); if (!t) continue;
        const bb = s.bbox, cs = [...t], cw = (bb.x1 - bb.x0) / cs.length;
        cs.forEach((ch, i) => chars.push({ c: ch, x0: bb.x0 + cw * i, y0: bb.y0, x1: bb.x0 + cw * (i + 1), y1: bb.y1 }));
      }
    }
    if (chars.some((c) => !c.sp)) out.push({ chars });
  }
  return out;
}

export async function ocrPage(page, onProgress) {
  const s = await getSettings();
  const worker = await getOcr(s.ocrLang, (m) => { if (m.status === 'recognizing text' && onProgress) onProgress(m.progress); });
  const { data } = await worker.recognize(page.blob, {}, { blocks: true });
  page.lines = linesFromOcr(data);
  page.ocrState = 'done';
  await db.putPage(page);
  return page;
}

// オフライン用の準備: OCRを小さな画像で1回動かし、この端末が実際に使うファイル一式を読み込ませる
export async function warmOcr(onProgress) {
  const s = await getSettings();
  const worker = await getOcr(s.ocrLang, (m) => { if (onProgress && typeof m.progress === 'number') onProgress(m.status === 'recognizing text' ? 0.9 + m.progress * 0.1 : m.progress * 0.9); });
  const c = makeCanvas(240, 80), ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 240, 80); ctx.fillStyle = '#000'; ctx.font = '40px sans-serif'; ctx.fillText('ABC 123', 20, 55);
  await worker.recognize(c);
  // 言語データは OCR ライブラリが自前でも保存するが、Service Worker 側にも確実に置く（保存状況の表示もこれを見る）
  for (const l of s.ocrLang.split('+')) await fetch(new URL(`../vendor/tessdata/${l}.traineddata.gz`, import.meta.url)).then((r) => r.arrayBuffer()).catch(() => {});
  const lib = await loadPdfjs(); await fetch(lib.GlobalWorkerOptions.workerSrc).then((r) => r.arrayBuffer()).catch(() => {});
}

// 教材内でまだ文字を読んでいないページをOCRする
export async function ensureText(pages) {
  const todo = pages.filter((p) => !p.lines);
  if (!todo.length) return true;
  const b = busy('文字を読み取っています…（端末内で処理・初回は少し時間がかかります）');
  try {
    for (let i = 0; i < todo.length; i++) {
      await ocrPage(todo[i], (p) => b.set(`文字を読み取っています… ${i + 1}/${todo.length}ページ`, (i + p) / todo.length));
    }
    return true;
  } catch (e) {
    console.error(e); toast('文字の読み取りに失敗しました。なぞって隠す操作はそのまま使えます');
    return false;
  } finally { b.done(); }
}

// ---- ファイル取込 ----
// opts.adjust: 写真を取り込む前に「四隅を合わせる」画面を出す（カメラで撮ったとき）
export async function importFiles(files, deck, opts = {}) {
  const b = busy('取り込んでいます…');
  try {
    let isNew = false, cancelled = 0;
    if (!deck) {
      const name = files[0].name.replace(/\.[^.]+$/, '') || '新しい教材';
      deck = { id: uid(), title: name, created: Date.now(), examDate: null, questions: [] };
      isNew = true;
    }
    const existing = isNew ? [] : await db.pagesOf(deck.id);
    let index = existing.length, added = 0;
    for (let f = 0; f < files.length; f++) {
      const file = files[f];
      const prog = (t, p) => b.set(t, (f + (p || 0)) / files.length);
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const pages = await importPdf(file, deck.id, index, prog);
        for (const p of pages) await db.putPage(p);
        index += pages.length; added += pages.length;
      } else if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|heic)$/i.test(file.name)) {
        prog(`画像を取り込み中… ${f + 1}/${files.length}`, 0.5);
        let canvas = await imageFileToCanvas(file);
        if (opts.adjust) { b.show(false); const fixed = await adjustPhoto(canvas); b.show(true); if (!fixed) { cancelled++; continue; } canvas = fixed; }
        await db.putPage(await pageFromCanvas(deck.id, index++, canvas, null, 'none')); added++;
      }
    }
    if (!added) { toast(cancelled ? '取り込みをやめました' : '取り込める画像・PDFが見つかりませんでした'); return null; }
    await db.putDeck(deck);
    return deck;
  } catch (e) {
    console.error(e); toast('取り込みに失敗しました: ' + (e.message || e)); return null;
  } finally { b.done(); }
}

// ページの画像を差し替える（ゆがみ補正のあと）。文字の位置が変わるので、読み取り結果と隠しは作り直しになる。
export async function replacePageImage(page, canvas) {
  page.blob = await canvasToBlob(canvas, 'image/jpeg', 0.92);
  page.w = canvas.width; page.h = canvas.height; page.thumb = thumbOf(canvas);
  page.lines = null; page.ocrState = 'none'; page.masks = [];
  await db.putPage(page);
  return page;
}

// ---- お試し用のサンプル教材（架空の内容。文字位置が正確に分かるのでOCR不要） ----
const SAMPLE = [
  [
    { t: '理科プリント  光合成のしくみ', size: 54, bold: true, gap: 50 },
    { t: '植物は、光のエネルギーを使って{r:光合成}を行い、', size: 36 },
    { t: '水と{r:二酸化炭素}から{r:デンプン}などの養分をつくる。', size: 36 },
    { t: 'このとき、{r:酸素}も同時につくられる。', size: 36, gap: 34 },
    { t: '光合成は、葉の細胞の中にある{r:葉緑体}で行われる。', size: 36 },
    { t: '葉緑体には{b:クロロフィル}という緑色の色素がふくまれる。', size: 36, gap: 34 },
    { t: '気体は、葉の裏側に多い{r:気孔}から出入りする。', size: 36 },
    { t: '根から吸った水は{r:道管}を、葉でつくった養分は{r:師管}を通る。', size: 36, gap: 50 },
    { t: '■ 英単語チェック', size: 40, bold: true, gap: 18 },
    { t: 'photosynthesis   光合成', size: 34, mono: true },
    { t: 'chlorophyll      葉緑素（クロロフィル）', size: 34, mono: true },
    { t: 'carbon dioxide   二酸化炭素', size: 34, mono: true },
    { t: 'oxygen           酸素', size: 34, mono: true, gap: 50 },
    { t: '■ まとめ', size: 40, bold: true, gap: 18 },
    { t: '{y:光合成の材料は「水」と「二酸化炭素」、}', size: 34 },
    { t: '{y:できるものは「デンプン」と「酸素」。}', size: 34 },
  ],
  [
    { t: '歴史プリント  江戸時代のできごと', size: 54, bold: true, gap: 50 },
    { t: '{r:1603}年  {r:徳川家康}が征夷大将軍となり、江戸幕府を開く。', size: 34 },
    { t: '{r:1635}年  {r:参勤交代}の制度が定められる。', size: 34 },
    { t: '{r:1641}年  オランダ商館を長崎の{r:出島}に移す。', size: 34 },
    { t: '{r:1716}年  {r:徳川吉宗}が{b:享保の改革}を始める。', size: 34 },
    { t: '{r:1787}年  {r:松平定信}が{b:寛政の改革}を始める。', size: 34 },
    { t: '{r:1853}年  {r:ペリー}が浦賀に来航する。', size: 34 },
    { t: '{r:1867}年  {r:大政奉還}が行われる。', size: 34, gap: 50 },
    { t: '■ 理科の復習メモ', size: 40, bold: true, gap: 18 },
    { t: '江戸時代の本草学者も植物を観察していたが、', size: 34 },
    { t: '光合成のしくみが分かったのは18世紀以降のこと。', size: 34 },
    { t: '光合成で酸素が出ることは、のちの実験で確かめられた。', size: 34 },
  ],
];
const INK = { r: '#d92b2b', b: '#1f5fd0', k: '#22252b', y: '#22252b' };

function drawSamplePage(spec) {
  const W = 1240, H = 1754, c = makeCanvas(W, H), ctx = c.getContext('2d');
  ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'alphabetic';
  const lines = []; let y = 150;
  for (const row of spec) {
    const fam = row.mono ? '"BIZ UDGothic","MS Gothic",monospace' : '"Yu Gothic","Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif';
    ctx.font = `${row.bold ? 700 : 500} ${row.size}px ${fam}`;
    const segs = []; const re = /\{(\w):([^}]*)\}|([^{]+)/g; let mm;
    while ((mm = re.exec(row.t))) segs.push(mm[1] ? { col: mm[1], t: mm[2] } : { col: 'k', t: mm[3] });
    let x = 110; const chars = []; y += row.size;
    for (const s of segs) {
      const w = ctx.measureText(s.t).width;
      if (s.col === 'y') { ctx.fillStyle = '#fff27a'; ctx.fillRect(x - 4, y - row.size * 0.9, w + 8, row.size * 1.15); }
      ctx.fillStyle = INK[s.col];
      for (const ch of [...s.t]) {
        const cw = ctx.measureText(ch).width;
        if (ch.trim()) { ctx.fillText(ch, x, y); chars.push({ c: ch, x0: x, y0: y - row.size * 0.9, x1: x + cw, y1: y + row.size * 0.16 }); }
        else chars.push({ c: ' ', sp: true, x0: x, y0: y, x1: x + cw, y1: y });
        x += cw;
      }
    }
    lines.push({ chars });
    y += row.size * 0.55 + (row.gap || 0);
  }
  return { canvas: c, lines };
}

export async function createSampleDeck() {
  const deck = { id: uid(), title: 'サンプル教材（理科・歴史）', created: Date.now(), examDate: null, questions: [], sample: true };
  for (let i = 0; i < SAMPLE.length; i++) {
    const { canvas, lines } = drawSamplePage(SAMPLE[i]);
    await db.putPage(await pageFromCanvas(deck.id, i, canvas, lines, 'pdf'));
  }
  await db.putDeck(deck);
  return deck;
}
