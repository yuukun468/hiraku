// 「ひらく」の自動採点。正解の分かっている見本を作り、各機能の成績を数えて、合格ラインと比べる。
// 使い方: PC で「テストを実行.bat」（または app フォルダで node tests/run.mjs）。ブラウザで tests/ を開いても見られる。
// アプリ本体のデータには触れない（テスト専用のデータベース名を使う）。
globalThis.__HIRAKU_DB__ = 'hiraku-test-db';
const results = [];
const add = (group, name, pass, detail) => { results.push({ group, name, pass: pass === null ? null : !!pass, detail: String(detail ?? '') }); };
const skip = (group, name, why) => add(group, name, null, why);
async function group(name, fn) { try { await fn((n, pass, detail) => add(name, n, pass, detail), (n, why) => skip(name, n, why)); } catch (e) { add(name, '（この項目の実行に失敗）', false, e && (e.stack || e.message) || e); } }

const G = await import('../js/geom.js');
const ink = await import('../js/ink.js');
const search = await import('../js/search.js');
const study = await import('../js/study.js');

// ---------- 見本づくりの道具 ----------
const W = 1240, H = 1754, FONT = '"Yu Gothic","Meiryo","Hiragino Sans",sans-serif';
function page(bg = '#fffefb', w = W, h = H) { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = bg; x.fillRect(0, 0, w, h); x.fillStyle = '#222'; x.strokeStyle = '#333'; x.textBaseline = 'middle'; return [c, x]; }
function put(x, gt, text, px, py, size = 30, color = '#222', align = 'left') {
  x.font = `600 ${size}px ${FONT}`; x.fillStyle = color; x.textAlign = align; x.fillText(text, px, py);
  const w = x.measureText(text).width, x0 = align === 'center' ? px - w / 2 : px, b = { x0, y0: py - size * 0.55, x1: x0 + w, y1: py + size * 0.55, text };
  if (gt) gt.push(b); return b;
}
let n0 = 0;
async function analyze(c) { return ink.analyze('t' + (n0++), await createImageBitmap(c), c.width, c.height); }
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const inter = (a, b) => area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
// 正解の箱の6割以上をおおい、大きすぎない（面積3.5倍まで）検出があれば「拾えた」
function score(gt, det) {
  const used = new Set(), missed = []; let hit = 0;
  for (const g of gt) { const i = det.findIndex((d, k) => !used.has(k) && inter(g, d) >= area(g) * 0.6 && area(d) <= area(g) * 3.5); if (i >= 0) { used.add(i); hit++; } else missed.push(g.text); }
  const R = (b) => `${Math.round(b.x0)},${Math.round(b.y0)} ${Math.round(b.x1 - b.x0)}x${Math.round(b.y1 - b.y0)}`, ex = det.filter((_, k) => !used.has(k));
  return { hit, total: gt.length, extra: ex.length, missed, text: `${hit}/${gt.length} 余計${ex.length}` + (missed.length ? ` 逃:${missed.join('・')}` : '') + (ex.length ? ` ［余計の場所 ${ex.slice(0, 3).map(R).join(' / ')}］` : '') + (missed.length ? ` ［逃した場所 ${gt.filter((g) => missed.includes(g.text)).slice(0, 2).map(R).join(' / ')}］` : '') };
}
const ok = (s, minHit, maxExtra) => s.hit >= minHit && s.extra <= maxExtra;

// ---------- 1) 図形（基準点つきの拡縮・回転） ----------
await group('図形（基準点・回転）', async (t) => {
  let worst = 0, worstH = 0;
  for (let i = 0; i < 200; i++) {
    const m0 = { ...G.rectMask(100, 100, 300, 160), angle: (Math.random() - 0.5) * 3, cx: 400 + Math.random() * 200, cy: 500 + Math.random() * 200 };
    const hs = [[-0.5, -0.5], [0, -0.5], [0.5, -0.5], [0.5, 0], [0.5, 0.5], [0, 0.5], [-0.5, 0.5], [-0.5, 0]], hd = hs[i % 8], anchor = [-hd[0], -hd[1]];
    const A = G.localToPage(m0, ...anchor), P0 = G.localToPage(m0, ...hd), P = [P0[0] + (Math.random() - 0.3) * 120 * (hd[0] || 0.3), P0[1] + (Math.random() - 0.3) * 80 * (hd[1] || 0.3)];
    const m1 = { ...m0, ...G.resizeAboutAnchor(m0, hd, anchor, P[0], P[1], 6) }, A1 = G.localToPage(m1, ...anchor);
    worst = Math.max(worst, Math.hypot(A1[0] - A[0], A1[1] - A[1]));
    if (hd[0] && hd[1]) { const Hn = G.localToPage(m1, ...hd); if (m1.w > 7 && m1.h > 7) worstH = Math.max(worstH, Math.hypot(Hn[0] - P[0], Hn[1] - P[1])); }
  }
  t('大きさを変えても基準点が動かない（200通り）', worst < 1e-6, `ずれ最大 ${worst.toExponential(1)}px`);
  t('つかんだ角が指の位置に来る', worstH < 1e-6, `ずれ最大 ${worstH.toExponential(1)}px`);
  let wr = 0;
  for (let i = 0; i < 100; i++) { const m0 = { ...G.rectMask(0, 0, 200, 50), cx: 500, cy: 500, angle: Math.random() }, piv = [(i % 3 - 1) * 0.5, ((i / 3 | 0) % 3 - 1) * 0.5], A = G.localToPage(m0, ...piv), a = (Math.random() - 0.5) * 6;
    const m1 = { ...m0, ...G.rotateAbout(m0, piv, a) }, A1 = G.localToPage(m1, ...piv); wr = Math.max(wr, Math.hypot(A1[0] - A[0], A1[1] - A[1]), Math.abs(Math.sin(m1.angle - a))); }
  t('回しても回転の中心が動かず、角度が指定どおり（100通り）', wr < 1e-6, `ずれ最大 ${wr.toExponential(1)}`);
});

// ---------- 2) ことばの指示の解釈 ----------
await group('指示の解釈', async (t) => {
  const sel = [['全部', 5, [1, 2, 3, 4, 5]], ['3番だけ', 5, [3]], ['1と4', 5, [1, 4]], ['2から5', 6, [2, 3, 4, 5]], ['3番以外', 5, [1, 2, 4, 5]], ['①と③', 4, [1, 3]], ['三番', 5, [3]], ['最後', 4, [4]]];
  const bad = sel.filter(([s, n, want]) => JSON.stringify(search.parseSelection(s, n)) !== JSON.stringify(want)).map(([s]) => s);
  t('番号の選び方（全部／3番だけ／1と4／2から5／3番以外 など8通り）', !bad.length, bad.length ? `ちがう: ${bad.join('、')}` : '8/8');
  const cmd = [['赤字だけ隠して', (c) => c.kind === 'color' && c.ids[0] === 1], ['青字を隠して', (c) => c.kind === 'color' && c.ids[0] === 2], ['蛍光マーカーの所', (c) => c.kind === 'color' && c.ids.includes(4)], ['英単語だけ', (c) => c.kind === 'english'],
    ['重要語句を隠して', (c) => c.kind === 'important'], ['試験に出そうなところを問題にして', (c) => c.kind === 'questions'], ['元に戻す', (c) => c.kind === 'undo'], ['隠しを全部消して', (c) => c.kind === 'clear'],
    ['下線の語だけ隠して', (c) => c.kind === 'color' && c.ids[0] === 'under'], ['囲みの語だけ隠して', (c) => c.kind === 'color' && c.ids[0] === 'boxed'], ['表・図のラベルだけ隠して', (c) => c.kind === 'color' && c.ids[0] === 'labels'], ['光合成を隠して', (c) => c.kind === 'search']];
  const badc = cmd.filter(([s, f]) => { try { return !f(search.parseCommand(s)); } catch { return true; } }).map(([s]) => s);
  t('指示文の種類（12通り）', !badc.length, badc.length ? `ちがう: ${badc.join('、')}` : '12/12');
});

// ---------- 3) 復習の計算 ----------
await group('復習の計算', async (t, sk) => {
  const DAY = 86400000, now = 1.8e12;
  let s = null, last = 0, mono = true, tt = now; const ivs = [];
  for (let i = 0; i < 6; i++) { s = study.schedule(s, 2, null, tt); const iv = (s.due - tt) / DAY; ivs.push(iv.toFixed(1)); if (iv <= last) mono = false; last = iv; tt = s.due; }
  t('「覚えた」が続くと、次の復習までの間隔が毎回のびる', mono, `間隔(日): ${ivs.join(' → ')}`);
  const lapse = study.schedule(s, 0, null, tt); t('「まだ」を押すと15分以内にもう一度出る', (lapse.due - tt) / 60000 <= 15, `${((lapse.due - tt) / 60000).toFixed(0)}分後`);
  const exam = now + 4 * DAY; let e = null, te = now, capped = true; for (let i = 0; i < 4; i++) { e = study.schedule(e, 2, exam, te); if (te < exam && e.due > exam) capped = false; te = Math.min(e.due, exam - 1); }
  t('試験日があると、試験の前に必ずもう一度回ってくる', capped, capped ? '4回とも試験日より前' : '試験日を越えた');
  if (!study.recallAt || !study.forecast) return sk('見込みと今日の目安', 'この版には無い機能');
  const srs = study.schedule(null, 2, null, now), r = [0, 1, 3, 10, 30].map((d) => study.recallAt(srs, now + d * DAY));
  t('思い出せる見込みは、日がたつほど下がる（0〜1の範囲）', r.every((v, i) => v >= 0 && v <= 1 && (!i || v < r[i - 1])) && study.recallAt(null, now) === 0, r.map((v) => Math.round(v * 100) + '%').join(' → '));
  const masks = Array.from({ length: 20 }, (_, i) => ({ srs: i < 5 ? srs : null })), f = study.forecast(masks, now + 12 * DAY, now + DAY);
  t('今日の目安＝未学習を「残り日数−2日」で割った数', f.fresh === 15 && f.days === 11 && f.perDay === Math.ceil(15 / 9) && f.nowPct > 0 && f.nowPct <= 25 && f.examPct < f.nowPct, `未学習${f.fresh}・あと${f.days}日・1日${f.perDay}か所・いま${f.nowPct}%→試験日${f.examPct}%`);
});

// ---------- 4) 色の検出 ----------
await group('色の検出（印刷）', async (t) => {
  const [c, x] = page(), red = [], blue = [], hl = [];
  const lines = [['植物は、光のエネルギーを使って', '光合成', 'を行い、'], ['水と', '二酸化炭素', 'から', 'デンプン', 'などの養分をつくる。'], ['このとき、', '酸素', 'も同時につくられる。'], ['葉の細胞の中にある', '葉緑体', 'で行われる。'], ['気体は、葉の裏側に多い', '気孔', 'から出入りする。']];
  lines.forEach((parts, li) => { let px = 100; parts.forEach((p, i) => { const b = put(x, i % 2 ? red : null, p, px, 200 + li * 70, 32, i % 2 ? '#d62828' : '#222'); px = b.x1; }); });
  let px = 100; ['葉緑体には', 'クロロフィル', 'という緑色の色素がふくまれる。'].forEach((p, i) => { const b = put(x, i === 1 ? blue : null, p, px, 620, 32, i === 1 ? '#1d4ed8' : '#222'); px = b.x1; });
  ['光合成の材料は「水」と「二酸化炭素」、', 'できるものは「デンプン」と「酸素」。'].forEach((s, i) => { x.font = `600 32px ${FONT}`; const w = x.measureText(s).width; x.fillStyle = '#fff275'; x.fillRect(96, 760 + i * 60 - 22, w + 8, 44); hl.push({ x0: 96, y0: 738 + i * 60, x1: 104 + w, y1: 782 + i * 60, text: 'マーカー' + (i + 1) }); put(x, null, s, 100, 760 + i * 60, 32); });
  const m = await analyze(c);
  const r = score(red, ink.colorRegions(m, [1])), b = score(blue, ink.colorRegions(m, [2])), y = score(hl, ink.colorRegions(m, [4, 5, 6, 7]));
  t('赤字の語（6か所）', ok(r, 6, 0), r.text); t('青字の語（1か所）', ok(b, 1, 0), b.text); t('蛍光マーカーの行（2か所）', ok(y, 2, 0), y.text);
  t('文字の大きさの見積り（32pxの字）', m.textH >= 22 && m.textH <= 42, `見積り ${m.textH}px`);
});

// ---------- 5) 下線・囲み ----------
await group('下線・囲みの検出', async (t, sk) => {
  if (!ink.markedRegions) return sk('下線・囲み', 'この版には無い機能');
  const [c, x] = page(), under = [], boxed = []; x.lineWidth = 3;
  const line = (b, dy = 8, wavy = false, col = '#222') => { x.strokeStyle = col; x.beginPath(); for (let px = b.x0; px <= b.x1; px += 4) { const py = b.y1 + dy + (wavy ? Math.sin((px - b.x0) / 6) * 3 : 0); px === b.x0 ? x.moveTo(px, py) : x.lineTo(px, py); } x.stroke(); };
  let b = put(x, null, '縄文時代には', 100, 200, 32); b = put(x, under, '竪穴住居', b.x1, 200, 32); line(b); put(x, null, 'に住み、', b.x1, 200, 32);
  b = put(x, null, '弥生時代に', 100, 320, 32); b = put(x, under, '水田稲作', b.x1, 320, 32); line(b, 8, true, '#d62828'); put(x, null, 'が広まった。', b.x1, 320, 32);
  b = put(x, null, '古墳時代の', 100, 440, 32); b = put(x, under, '前方後円墳', b.x1, 440, 32); line(b, 7); line(b, 14); put(x, null, 'が有名である。', b.x1, 440, 32);
  b = put(x, null, '飛鳥時代、', 100, 560, 32); b = put(x, under, '聖徳太子', b.x1, 560, 32); line(b, 8, false, '#1d4ed8'); put(x, null, 'が政治を行った。', b.x1, 560, 32);
  b = put(x, null, '奈良時代の都は ', 100, 700, 32); b = put(x, boxed, '平城京', b.x1 + 14, 700, 32); x.strokeStyle = '#222'; x.strokeRect(b.x0 - 12, b.y0 - 10, b.x1 - b.x0 + 24, b.y1 - b.y0 + 20); put(x, null, ' である。', b.x1 + 14, 700, 32);
  b = put(x, null, '平安時代の都は ', 100, 840, 32); b = put(x, boxed, '平安京', b.x1 + 20, 840, 32); x.strokeStyle = '#d62828'; x.beginPath(); x.ellipse((b.x0 + b.x1) / 2, 840, (b.x1 - b.x0) / 2 + 22, 34, 0, 0, 7); x.stroke(); put(x, null, ' である。', b.x1 + 22, 840, 32);
  // まぎらわしいもの: 横画の多い字、区切りの線、分数
  put(x, null, '三国　口上　土曜　工事　王国　二十三', 100, 1000, 40); x.strokeStyle = '#222'; x.beginPath(); x.moveTo(100, 1120); x.lineTo(1100, 1120); x.stroke();
  put(x, null, '下線も囲みも無い、ふつうの文がここに続く。', 100, 1220, 32);
  const m = await analyze(c), r = ink.markedRegions(m), u = score(under, r.under), bx = score(boxed, r.boxed);
  t('下線の語（直線・波線・二重線・色つき、4か所）', ok(u, 4, 0), u.text); t('囲みの語（四角・丸、2か所）', ok(bx, 2, 0), bx.text);
});

// ---------- 6) 表・図のラベル ----------
await group('表・図のラベル検出', async (t, sk) => {
  if (!ink.labelRegions) return sk('表・図のラベル', 'この版には無い機能');
  { const [c, x] = page(), gt = []; put(x, null, '表1 ヒトの消化酵素とはたらき', 100, 110, 38);
    const cols = [100, 330, 600, 880, 1140], rows = Array.from({ length: 8 }, (_, i) => 180 + i * 84); x.lineWidth = 2.5;
    for (const cx of cols) { x.beginPath(); x.moveTo(cx, rows[0]); x.lineTo(cx, rows[7]); x.stroke(); } for (const ry of rows) { x.beginPath(); x.moveTo(cols[0], ry); x.lineTo(cols[4], ry); x.stroke(); }
    [['器官', '消化液', '酵素', '分解するもの'], ['口', 'だ液', 'アミラーゼ', 'デンプン'], ['胃', '胃液', 'ペプシン', 'タンパク質'], ['すい臓', 'すい液', 'トリプシン', 'タンパク質'], ['すい臓', 'すい液', 'リパーゼ', '脂肪'], ['小腸', '腸液', 'マルターゼ', '麦芽糖'], ['肝臓', '胆汁', '（酵素なし）', '脂肪を乳化']]
      .forEach((r, i) => r.forEach((s, j) => put(x, gt, s, (cols[j] + cols[j + 1]) / 2, rows[i] + 42, 30, i === 0 ? '#222' : j === 2 ? '#d33' : '#222', 'center')));
    put(x, null, '消化酵素は、それぞれ決まった物質だけにはたらく。この性質を基質特異性という。', 100, 860, 28); put(x, null, '体温に近い温度でもっともよくはたらき、高温では形が変わってはたらきを失う。', 100, 910, 28);
    const s = score(gt, ink.labelRegions(await analyze(c))); t('印刷の表（28マス）', ok(s, 27, 1), s.text); }
  { const [c, x] = page(), gt = []; put(x, null, '図2 血液の循環', 100, 110, 38); x.lineWidth = 3;
    const box = (bx, by, bw, bh, s) => { x.strokeRect(bx, by, bw, bh); put(x, gt, s, bx + bw / 2, by + bh / 2, 30, '#222', 'center'); }; box(500, 220, 240, 80, '肺'); box(470, 520, 300, 100, '心臓'); box(480, 860, 280, 80, '全身の細胞');
    [[540, 300, 540, 520], [700, 300, 700, 520], [540, 620, 540, 860], [700, 620, 700, 860], [300, 570, 470, 570], [770, 570, 940, 570]].forEach(([a, b, c2, d]) => { x.beginPath(); x.moveTo(a, b); x.lineTo(c2, d); x.stroke(); });
    put(x, gt, '肺動脈', 400, 410, 28, '#d33'); put(x, gt, '肺静脈', 720, 410, 28, '#d33'); put(x, gt, '大静脈', 400, 740, 28, '#d33'); put(x, gt, '大動脈', 720, 740, 28, '#d33'); put(x, gt, '右心房', 180, 570, 28); put(x, gt, '左心室', 960, 570, 28);
    put(x, null, '心臓から出た血液は肺で酸素を受け取り、ふたたび心臓へ戻ってから全身へ送られる。', 100, 1080, 28);
    const s = score(gt, ink.labelRegions(await analyze(c))); t('図（箱と線、線に添えた語、9か所）', ok(s, 8, 1), s.text); }
  { const [c, x] = page(), gt = []; put(x, null, '図3 架空の島の地方区分', 100, 110, 38);
    const blob = (pts, fill) => { x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); x.closePath(); x.fillStyle = fill; x.fill(); x.lineWidth = 2.5; x.strokeStyle = '#555'; x.stroke(); };
    blob([[200, 300], [520, 240], [640, 420], [560, 640], [260, 600], [160, 450]], '#dff0d8'); blob([[640, 420], [520, 240], [860, 220], [1040, 380], [960, 620], [560, 640]], '#fbeed5'); blob([[260, 600], [560, 640], [960, 620], [900, 900], [620, 1000], [320, 880]], '#d9e8f7'); blob([[320, 880], [620, 1000], [560, 1220], [360, 1180]], '#f3dfe8');
    put(x, gt, '北嶺地方', 300, 440, 30); put(x, gt, '東浜地方', 740, 420, 30); put(x, gt, '中原地方', 540, 780, 30); put(x, gt, '南岬', 420, 1080, 28);
    x.strokeStyle = '#333'; x.lineWidth = 2; const lead = (a, b, c2, d) => { x.beginPath(); x.moveTo(a, b); x.lineTo(c2, d); x.stroke(); x.beginPath(); x.arc(a, b, 6, 0, 7); x.fillStyle = '#d33'; x.fill(); };
    lead(880, 520, 1060, 700); put(x, gt, '港町ミナト', 1010, 730, 26, '#d33'); lead(380, 720, 150, 800); put(x, gt, '白根山', 90, 830, 26, '#d33'); lead(660, 880, 1000, 1000); put(x, gt, '中央駅', 960, 1030, 26, '#d33');
    put(x, null, 'この島は4つの地方に分かれ、東浜地方の港町が交通の中心になっている。', 100, 1400, 28);
    const s = score(gt, ink.labelRegions(await analyze(c))); t('地図ふう（色分けの区画と引き出し線、7か所）', ok(s, 6, 1), s.text); }
  { const [c, x] = page(); put(x, null, '光合成のしくみ', 100, 110, 38);
    ['植物は、光のエネルギーを使って光合成を行い、', '水と二酸化炭素からデンプンなどの養分をつくる。', 'このとき、酸素も同時につくられる。', '光合成は、葉の細胞の中にある葉緑体で行われる。', '葉緑体にはクロロフィルという緑色の色素がふくまれる。', '気体は、葉の裏側に多い気孔から出入りする。'].forEach((s, i) => put(x, null, s, 100, 220 + i * 62, 30));
    x.strokeStyle = '#d33'; x.lineWidth = 3; x.beginPath(); x.moveTo(420, 242); x.lineTo(560, 242); x.stroke();
    const n = ink.labelRegions(await analyze(c)).length; t('表も図も無い文章では、何も出さない', n === 0, `${n}か所`); }
  { const [c, x] = page('#b9b3a6'); let sd = 7; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647; const id = x.getImageData(0, 0, W, H); for (let i = 0; i < id.data.length; i += 4) { const n = (rnd() - 0.5) * 60 + Math.sin(i / 9000) * 20; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; } x.putImageData(id, 0, 0);
    const n = ink.labelRegions(await analyze(c)).length; t('写真のようにざらざらした画像で、でたらめに拾わない', n <= 2, `${n}か所`); }
});

// ---------- 7) 縦書き ----------
await group('縦書き', async (t, sk) => {
  const [c, x] = page('#fffefb', 1754, 1240), cols = ['抽象から具体へ進むのが演繹である', '具体から抽象へ進むのが帰納である', '多くの人に反論されることを主張する', '主張するためには論証責任が伴う', '対立関係を意識して文章を読むこと'];
  const side = []; x.font = `600 40px ${FONT}`; x.textAlign = 'center';
  cols.forEach((s, ci) => { const cx = 1500 - ci * 170; [...s].forEach((ch, i) => { x.fillStyle = '#222'; x.fillText(ch, cx, 150 + i * 52); }); });
  // 3列目の3〜9文字目に傍線（字の右）
  { const cx = 1500 - 2 * 170; x.strokeStyle = '#d62828'; x.lineWidth = 3; x.beginPath(); x.moveTo(cx + 30, 150 + 2 * 52 - 24); x.lineTo(cx + 30, 150 + 8 * 52 + 24); x.stroke(); side.push({ x0: cx - 22, y0: 150 + 2 * 52 - 24, x1: cx + 22, y1: 150 + 8 * 52 + 24, text: '傍線の語' }); }
  const m = await analyze(c);
  if (!('vertical' in m)) return sk('縦書きの判定', 'この版には無い機能');
  t('縦書きのページを縦書きと判定する', m.vertical === true, `判定: ${m.vertical ? '縦書き' : '横書き'}（上下${m.orient?.ver}・左右${m.orient?.hor}）`);
  const s = score(side, ink.markedRegions(m).under); t('傍線（縦の下線）を引いた語', ok(s, 1, 1), s.text);
  const [c2, x2] = page(); ['植物は、光のエネルギーを使って光合成を行い、', '水と二酸化炭素からデンプンなどの養分をつくる。', 'このとき、酸素も同時につくられる。', '光合成は、葉の細胞の中にある葉緑体で行われる。'].forEach((s2, i) => put(x2, null, s2, 100, 220 + i * 62, 30));
  const m2 = await analyze(c2); t('横書きのページを横書きと判定する', m2.vertical === false, `判定: ${m2.vertical ? '縦書き' : '横書き'}`);
});

// ---------- 8) なぞって隠す ----------
await group('なぞって隠す', async (t) => {
  // 目当ての語のインクをどれだけおおえたか／上下の行のインクにどれだけ入り込んだか
  const cover = (m, mask, b) => { let n = 0, inn = 0; for (let y = Math.floor(b.y0 * m.k); y <= b.y1 * m.k; y++) for (let x = Math.floor(b.x0 * m.k); x <= b.x1 * m.k; x++) if (m.ink[y * m.W + x]) { n++; if (G.hit(mask, x / m.k, y / m.k, 0)) inn++; } return n ? inn / n : 0; };
  const mk = async (rotDeg) => { const [c, x] = page(); if (rotDeg) { x.translate(W / 2, 500); x.rotate(rotDeg * Math.PI / 180); x.translate(-W / 2, -500); }
    const up = put(x, null, '水と二酸化炭素からデンプンなどの養分をつくる。', 100, 440, 32); let b = put(x, null, 'このとき、葉の細胞の中にある', 100, 500, 32); const tg = put(x, null, '葉緑体', b.x1, 500, 32); put(x, null, 'で光合成が行われる。', tg.x1, 500, 32); const dn = put(x, null, '気体は、葉の裏側に多い気孔から出入りする。', 100, 560, 32);
    return { c, up, tg, dn }; };
  { const { c, up, tg, dn } = await mk(0), m = await analyze(c), y = (tg.y0 + tg.y1) / 2;
    const r = ink.fitStroke(m, Array.from({ length: 21 }, (_, i) => [tg.x0 + 4 + (tg.x1 - tg.x0 - 8) * i / 20, y + Math.sin(i) * 3]), { fallbackHalf: 16 });
    const cv = cover(m, r.mask, tg), lk = Math.max(cover(m, r.mask, up), cover(m, r.mask, dn));
    t('横書き: なぞった語をおおう', r.fitted && cv >= 0.97, `おおえた割合 ${(cv * 100).toFixed(0)}%`); t('横書き: 上下の行に入り込まない', lk <= 0.01, `入り込み ${(lk * 100).toFixed(1)}%`);
    const bb = G.bounds(r.mask), hh = bb.y1 - bb.y0; t('太さが字の高さに合う（32pxの字）', hh >= 30 && hh <= 52, `高さ ${hh.toFixed(0)}px`); }
  { const { c, tg } = await mk(9), m = await analyze(c), a = 9 * Math.PI / 180, R = (px, py) => { const dx = px - W / 2, dy = py - 500; return [W / 2 + dx * Math.cos(a) - dy * Math.sin(a), 500 + dx * Math.sin(a) + dy * Math.cos(a)]; };
    const y = (tg.y0 + tg.y1) / 2, pts = Array.from({ length: 21 }, (_, i) => R(tg.x0 + 4 + (tg.x1 - tg.x0 - 8) * i / 20, y)), r = ink.fitStroke(m, pts, { fallbackHalf: 16 });
    let n = 0, inn = 0; for (let i = 0; i <= 40; i++) for (let j = 0; j <= 10; j++) { const [px, py] = R(tg.x0 + (tg.x1 - tg.x0) * i / 40, tg.y0 + 6 + (tg.y1 - tg.y0 - 12) * j / 10); if (m.ink[Math.round(py * m.k) * m.W + Math.round(px * m.k)]) { n++; if (G.hit(r.mask, px, py, 0)) inn++; } }
    t('ななめ（9度）の行でも語をおおう', r.fitted && n > 20 && inn / n >= 0.95, `おおえた割合 ${n ? (inn / n * 100).toFixed(0) : 0}%・角度 ${(r.mask.angle * 180 / Math.PI).toFixed(1)}度`); }
});

// ---------- 9) 同期・バックアップ（テスト専用のデータベースで） ----------
await group('同期', async (t, sk) => {
  let sy; try { sy = await import('../js/sync.js'); } catch { return sk('同期', 'この版には無い機能'); }
  const mkPage = (id, masks, updated) => ({ id, deckId: 'd', index: 0, w: 100, h: 100, masks, updated });
  const mA = { id: 'a', cx: 1, log: [{ g: 2 }], srs: { last: 10 } }, mA2 = { id: 'a', cx: 2, log: [{ g: 2 }, { g: 1 }], srs: { last: 20 } };
  const mg = sy.mergeDocs({ deck: { id: 'd', title: 'L', updated: 5 }, pages: [mkPage('p', [mA, { id: 'l', log: [] }], 9)] }, { deck: { id: 'd', title: 'R', updated: 3 }, pages: [mkPage('p', [mA2, { id: 'r', log: [] }], 4), mkPage('q', [], 1)] });
  const pm = mg.pages.find((p) => p.id === 'p'), ids = pm.masks.map((m) => m.id).sort().join(''), a = pm.masks.find((m) => m.id === 'a');
  t('2台で別々に足した隠しは、両方残る', ids === 'alr' && mg.pages.length === 2, `隠し: ${ids}・ページ ${mg.pages.length}`);
  t('形は新しい方、学習記録は多く取り組んだ方を採る', a.cx === 1 && a.log.length === 2 && mg.deck.title === 'L', `位置${a.cx}・記録${a.log.length}回・名前${mg.deck.title}`);
  // 保管場所のまねをして、送る → この端末から消す → 受け取る、で元どおりになるか
  const { db, saveSettings } = await import('../js/db.js'), im = await import('../js/importer.js'), files = new Map(), realFetch = window.fetch; let seq = 0;
  window.fetch = async (url, o = {}) => { url = String(url); if (!url.startsWith('https://mock.test/')) return realFetch(url, o);
    const rest = url.replace('https://mock.test/repos/me/data', ''), J = (c2, b) => new Response(JSON.stringify(b), { status: c2 });
    if (rest === '') return J(200, { default_branch: 'main', private: true });
    if (rest.startsWith('/git/trees/')) return files.size ? J(200, { tree: [...files].map(([path, v]) => ({ path, sha: v.sha, type: 'blob' })) }) : J(409, {});
    const path = decodeURIComponent(rest.replace('/contents/', '')), cur = files.get(path), body = o.body ? JSON.parse(o.body) : {};
    if (o.method === 'PUT') { if (cur && body.sha !== cur.sha) return J(409, {}); const bin = atob(body.content), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const sha = 's' + (++seq); files.set(path, { buf: u, sha }); return J(201, { content: { sha } }); }
    if (o.method === 'DELETE') { files.delete(path); return J(200, {}); }
    return cur ? new Response(cur.buf, { status: 200 }) : J(404, {}); };
  try {
    await db.wipe().catch(() => {}); await saveSettings({ syncOn: true, syncRepo: 'me/data', syncToken: 'x', syncApi: 'https://mock.test' });
    const d = await im.createSampleDeck(), ps = await db.pagesOf(d.id); ps[0].masks.push({ id: 'm1', cx: 300, cy: 200, w: 120, h: 30, angle: 0.1, text: 'a', srs: { last: 5, stab: 3 }, log: [{ g: 2 }], mk: 'red' }); await db.putPage(ps[0]);
    const snap = async () => JSON.stringify((await db.pagesOf(d.id)).map((p) => [p.id, p.index, p.blob.size, p.masks]));
    const before = await snap(), r1 = await sy.syncNow(), r1b = await sy.syncNow();
    t('教材を保管場所へ送る（2回目は何も送らない）', r1.up === 1 && r1b.up + r1b.down + r1b.merged === 0 && files.size >= 4, `1回目 送信${r1.up}・2回目 送信${r1b.up}・保管場所 ${files.size}ファイル`);
    await db.delDeckRaw(d.id); await db.set('syncState', {}); const r2 = await sy.syncNow();
    t('空の端末で受け取ると、画像・隠し・記録が元どおり', r2.down === 1 && (await snap()) === before, `受信${r2.down}・一致 ${(await snap()) === before}`);
    await db.delDeck(d.id); const r3 = await sy.syncNow();
    t('教材を消すと、保管場所からも消える', r3.removed === 1 && ![...files.keys()].some((k) => k.startsWith('decks/') || k.startsWith('pages/')), `削除${r3.removed}・残り ${[...files.keys()].join(', ')}`);
  } finally { window.fetch = realFetch; await db.wipe().catch(() => {}); }
});
await group('バックアップ', async (t, sk) => {
  let app; try { app = await import('../js/app.js'); } catch (e) { return sk('バックアップ', '読み込めず: ' + e.message); }
  if (!app.buildBackup) return sk('バックアップ', 'この版には無い機能');
  const { db } = await import('../js/db.js'), im = await import('../js/importer.js');
  await new Promise((r) => setTimeout(r, 300)); await db.wipe().catch(() => {});
  const d = await im.createSampleDeck(), ps = await db.pagesOf(d.id); ps[0].masks.push({ id: 'b1', cx: 300, cy: 200, w: 120, h: 30, angle: 0.2, text: 'x', srs: { last: 5, stab: 3, due: 9 }, log: [{ g: 2 }] }); await db.putPage(ps[0]);
  const snap = async () => JSON.stringify((await db.pagesOf(d.id)).map((p) => [p.id, p.blob.size, p.masks]));
  const before = await snap();
  let full, light; try { full = await app.buildBackup({}); light = await app.buildBackup({ deckId: d.id, light: true }); } catch { full = await app.buildBackup(); }
  await db.delDeck(d.id); await app.restoreBackup(full);
  t('書き出す → 教材を消す → 読み込む、で元どおり', (await snap()) === before, `${(full.size / 1024).toFixed(0)}KB・一致 ${(await snap()) === before}`);
  if (!light) sk('マーカーだけの軽い書き出し', 'この版には無い機能');
  else { for (const p of await db.pagesOf(d.id)) { p.masks = []; await db.putPage(p); } await app.restoreBackup(light); t('マーカーだけの軽い書き出しでも、隠しと記録が戻る', (await snap()) === before && light.size < full.size / 5, `${(light.size / 1024).toFixed(0)}KB・一致 ${(await snap()) === before}`); }
  try { await app.restoreBackup(new File([await full.slice(0, full.size - 4000).arrayBuffer()], 'cut.hiraku')); t('途中で切れたファイルは読み込まない', false, '読み込んでしまった'); } catch (e) { t('途中で切れたファイルは読み込まない', (await snap()) === before, '断った: ' + e.message.slice(0, 30)); }
  await db.wipe().catch(() => {});
});

// ---------- 10) 手元の実物ノート（PCにあるときだけ。公開先には無い） ----------
await group('実物ノート（手元だけ）', async (t, sk) => {
  const load = async (n) => { const r = await fetch('../_samples/' + n + '.jpg'); if (!r.ok) return null; const bmp = await createImageBitmap(await r.blob()), k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height)); return ink.analyze('real' + n, bmp, Math.round(bmp.width * k), Math.round(bmp.height * k)); };
  const probe = await load('02-bio-table'); if (!probe) return sk('実物ノート', '写真が無い（公開先や別のPCでは飛ばす）');
  const rng = (v, lo, hi) => v >= lo && v <= hi, cnt = async (n) => { const m = n === '02-bio-table' ? probe : await load(n); return { m, red: ink.colorRegions(m, [1]).length, under: ink.markedRegions ? ink.markedRegions(m).under.length : -1, boxed: ink.markedRegions ? ink.markedRegions(m).boxed.length : -1, labels: ink.labelRegions ? ink.labelRegions(m).length : -1 }; };
  let a = await cnt('02-bio-table'); t('生物の表: オレンジの字 35〜60・ラベル 40〜60', rng(a.red, 35, 60) && rng(a.labels, 40, 60), `赤${a.red}・ラベル${a.labels}`);
  a = await cnt('04-hist-pencil'); t('日本史（鉛筆）: 下線 5〜9・ラベル 0（罫線を拾わない）', rng(a.under, 5, 9) && a.labels === 0, `下線${a.under}・ラベル${a.labels}`);
  a = await cnt('07-hist-color'); t('数学: 下線 5〜8・囲み 2〜4', rng(a.under, 5, 8) && rng(a.boxed, 2, 4), `下線${a.under}・囲み${a.boxed}`);
  a = await cnt('11-vert-hiyu'); t('現代文（縦書き）: 縦書きと判定・傍線 3〜6', a.m.vertical === true && rng(a.under, 3, 6), `縦書き${a.m.vertical}・傍線${a.under}`);
  a = await cnt('13-bio-tree'); t('系統図: ラベル 35〜55', rng(a.labels, 35, 55), `ラベル${a.labels}`);
  a = await cnt('01-eng-color'); t('入り組んだ英語ノート: ラベルを出さない', a.labels === 0, `ラベル${a.labels}`);
});

// ---------- 結果の表示 ----------
const fail = results.filter((r) => r.pass === false).length, passN = results.filter((r) => r.pass === true).length, skipN = results.filter((r) => r.pass === null).length;
globalThis.__results = { fail, pass: passN, skip: skipN, results };
const el = document.getElementById('out');
if (el) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  let html = `<h1>${fail ? `✕ ${fail}件が合格ラインに届いていません` : '◯ すべて合格'}</h1><p>合格 ${passN}・不合格 ${fail}・対象外 ${skipN}</p><table>`; let g = '';
  for (const r of results) { if (r.group !== g) { g = r.group; html += `<tr><th colspan="3">${esc(g)}</th></tr>`; } html += `<tr class="${r.pass === null ? 'skip' : r.pass ? 'ok' : 'ng'}"><td>${r.pass === null ? '−' : r.pass ? '◯' : '✕'}</td><td>${esc(r.name)}</td><td>${esc(r.detail)}</td></tr>`; }
  el.innerHTML = html + '</table>';
}
globalThis.__done = true;
