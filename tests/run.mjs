// 自動採点の実行役: アプリを一時的に配信し、画面なしのブラウザ（Edge か Chrome）で tests/ を開いて、結果を表にして出す。
// 使い方:  node tests/run.mjs            … いまの app フォルダを採点
//          node tests/run.mjs --root <フォルダ>  … 別の版（古い版の写しなど）を、いまのテストで採点
//          node tests/run.mjs --json      … 結果を JSON で出す（ほかの道具から使うとき）
// 合格ラインに届かない項目が1つでもあれば、終了コード 1 で終わる。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const ROOT = path.resolve(arg('--root') || path.join(here, '..')), asJson = process.argv.includes('--json');
const TESTS = here; // テストは常に「いまの tests フォルダ」のものを使う（古い版にも同じ採点をするため）
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const base = p.startsWith('/tests/') ? path.join(TESTS, p.slice(7)) : p.startsWith('/_samples/') ? path.join(here, '..', p) : path.join(ROOT, p);
  fs.readFile(base, (e, buf) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(base).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(buf); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const exe = [process.env.HIRAKU_BROWSER, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && fs.existsSync(p));
if (!exe) { console.error('Edge か Chrome が見つかりません。ブラウザで tests/index.html を開いて確かめるか、HIRAKU_BROWSER にブラウザの場所を入れてください。'); process.exit(2); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hiraku-test-')), dbgPort = 9300 + Math.floor(Math.random() * 500);
const br = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${dbgPort}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = async (code) => { try { br.kill(); } catch { /* すでに終了 */ } server.close(); await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 使用中なら残す */ } process.exit(code); };

try {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${dbgPort}/json`)).json()).find((t) => t.type === 'page'); } catch { /* 起動待ち */ } }
  if (!target) throw new Error('ブラウザを起動できませんでした');
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ブラウザにつながりませんでした')); });
  let id = 0; const wait = new Map(); ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } };
  const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value;
  await cdp('Page.enable'); await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/tests/index.html` });
  let out = null;
  for (let i = 0; i < 600; i++) { await sleep(300); const st = await evalJs('JSON.stringify({ d: !!globalThis.__done, e: globalThis.__err || null })'); if (!st) continue; const s = JSON.parse(st); if (s.d) { out = JSON.parse(await evalJs('JSON.stringify(globalThis.__results)')); break; } if (s.e && i > 20) throw new Error('テストの途中で止まりました: ' + s.e); }
  if (!out) throw new Error('時間内に終わりませんでした');
  if (asJson) console.log(JSON.stringify(out));
  else {
    let g = ''; console.log(`\n  ひらく 自動採点（対象: ${ROOT}）\n`);
    for (const r of out.results) { if (r.group !== g) { g = r.group; console.log(`  ■ ${g}`); } console.log(`    ${r.pass === null ? '－' : r.pass ? '◯' : '✕'} ${r.name}${r.detail ? `  …  ${r.detail.split('\n')[0].slice(0, 110)}` : ''}`); }
    console.log(`\n  合格 ${out.pass}・不合格 ${out.fail}・対象外 ${out.skip}\n  ${out.fail ? '✕ 合格ラインに届いていない項目があります。' : '◯ すべて合格です。'}\n`);
  }
  await done(out.fail ? 1 : 0);
} catch (e) { console.error('\n  採点を実行できませんでした: ' + (e.message || e) + '\n'); await done(2); }
