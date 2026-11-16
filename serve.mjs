// ひらく 暗記マーカー: 静的サーバー（Node標準ライブラリのみ）。
// ふつうに起動すると、このPCの中だけ(127.0.0.1)で動き、外部には何も公開しません。
// `--lan` を付けたときだけ、同じWi‑Fi(LAN)内の端末（スマホなど）からも開けるようにします。
//   ・公開されるのは app/ フォルダの中のファイル（アプリ本体）だけ。教材や学習記録は各端末のブラウザの中にあり、ここからは見えません。
//   ・インターネットには公開しません（ルーターの外からは届きません）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { exec } from 'node:child_process';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const LAN = process.argv.includes('--lan');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm',
  '.gz': 'application/gzip', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  if (p === '/') p = '/index.html';
  const abs = path.join(ROOT, path.normalize(p));
  if (!abs.startsWith(ROOT + path.sep) || p.includes('_npm')) { res.writeHead(403); res.end(); return; }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': p.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-cache',
    });
    fs.createReadStream(abs).pipe(res);
  });
});

// オフライン用に保存するファイルの一覧（Service Worker と「オフライン用に保存」ボタンが使う）。起動のたびに作り直す。
function writeOfflineList() {
  const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  try {
    const shell = ['./', 'index.html', 'manifest.webmanifest', 'icon.svg', ...walk('css'), ...walk('js'), ...walk('icons')];
    const pdf = walk('vendor/pdfjs');
    const json = JSON.stringify({ shell, pdf }, null, 0);
    const file = path.join(ROOT, 'offline-files.json');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== json) fs.writeFileSync(file, json);
  } catch (e) { console.warn('  offline-files.json を更新できませんでした:', e.message); }
}
writeOfflineList();
if (process.argv.includes('--make-list')) process.exit(0); // 一覧だけ作って終わる（公開用の準備など）

const lanAddrs = () => Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address)
  .sort((a, b) => Number(/^192\.168\./.test(b)) - Number(/^192\.168\./.test(a)));

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `\n  ポート ${PORT} は使用中です。すでに「ひらく」が起動していないか確かめてください（起動中の黒いウィンドウを閉じてから、もう一度）。\n` : e);
  process.exit(1);
});
server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  if (LAN) {
    const ips = lanAddrs();
    console.log('\n  ひらく 暗記マーカー を「スマホから開ける」モードで起動しました');
    console.log('  ─────────────────────────────────────────────');
    if (ips.length) {
      console.log('  スマホを このPCと同じWi‑Fi につなぎ、ブラウザで次のアドレスを開いてください:\n');
      for (const ip of ips) console.log(`      http://${ip}:${PORT}/`);
      if (ips.length > 1) console.log('\n  （複数あるときは、上から順に試してください）');
    } else console.log('  ネットワークにつながっていないようです。Wi‑Fi を確かめてください。');
    console.log(`\n  このPCでは ${url}`);
    console.log('  ─────────────────────────────────────────────');
    console.log('  ! いま、同じWi‑Fi(LAN)内の端末からこのアプリを開けます。公開されるのはアプリ本体だけで、');
    console.log('    教材や学習記録は見えません。インターネットには公開されません。');
    console.log('    カフェや学校など、知らない人も使うWi‑Fiでは使わないでください。');
    console.log('  ! 初回に Windows の「ファイアウォール」の確認が出たら「プライベート ネットワーク」を許可してください。');
    console.log('  ! このウィンドウを閉じると終了し、スマホからも開けなくなります。\n');
  } else console.log(`\n  ひらく 暗記マーカー を起動しました → ${url}\n  （このウィンドウを閉じるとアプリも終了します）\n`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
