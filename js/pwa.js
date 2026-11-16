// スマホ対応まわり: Service Worker の登録、ホーム画面への追加、オフライン用の保存、
// ソフトキーボードに合わせた高さ調整、ページ全体の拡大・引っ張り更新の抑止。
export const env = {
  secure: window.isSecureContext,
  swSupported: 'serviceWorker' in navigator,
  local: ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
  ios: /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  standalone: () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  // いま開いているアドレスが「同じWi‑Fiの中に公開されたPC」かどうか
  lan: location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname),
};

let installEvt = null;
const listeners = new Set();
export const onPwaChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(); } catch { /* 画面が閉じていても無視 */ } });

export const canInstall = () => !!installEvt;
export async function promptInstall() {
  if (!installEvt) return false;
  const e = installEvt; installEvt = null; e.prompt();
  const { outcome } = await e.userChoice; emit();
  return outcome === 'accepted';
}

export async function swState() {
  if (!env.secure || !env.swSupported) return 'unavailable';
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return 'none';
  return reg.active ? 'active' : 'installing';
}

// オフライン用の保存状況（保存済みのファイル数）
export async function offlineInfo() {
  if (!('caches' in window)) return null;
  try {
    const [shell, vendor] = await Promise.all(['hiraku-shell-v1', 'hiraku-vendor-v1'].map(async (n) => (await (await caches.open(n)).keys()).map((r) => r.url)));
    return { shell: shell.length, vendor: vendor.length, ocr: vendor.some((u) => /tesseract-core/.test(u)) && vendor.some((u) => /traineddata/.test(u)), pdf: vendor.some((u) => /pdf\.worker/.test(u)) };
  } catch { return null; }
}

// いま必要なファイルを全部取りに行き、Service Worker に保存させる。warm() は OCR を1回動かして、この端末が実際に使うファイルを読み込ませる。
export async function saveOffline(onProgress, warm) {
  if ((await swState()) === 'unavailable') throw new Error('このアドレス(http)では、オフライン用の保存は使えません');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((r) => { navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }); setTimeout(r, 3000); });
  const list = await (await fetch('offline-files.json', { cache: 'no-cache' })).json();
  const urls = [...list.shell, ...list.pdf];
  let done = 0, failed = 0;
  const queue = urls.slice();
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      try { const r = await fetch(u); if (!r.ok) failed++; else await r.arrayBuffer(); } catch { failed++; }
      onProgress && onProgress(`アプリを保存しています… ${++done}/${urls.length}`, (done / urls.length) * 0.6);
    }
  }));
  if (warm) { onProgress && onProgress('文字の読み取り（OCR）を保存しています…', 0.65); await warm((p) => onProgress && onProgress(null, 0.65 + p * 0.35)); }
  emit();
  return { total: urls.length, failed };
}

export function initPwa() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; emit(); });
  window.addEventListener('appinstalled', () => { installEvt = null; emit(); });
  if (env.secure && env.swSupported) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').then(emit).catch((e) => console.warn('Service Worker を登録できませんでした', e)); });
  }

  // ---- ソフトキーボード: 見えている範囲（visualViewport）にアプリの高さを合わせ、入力欄が隠れないようにする ----
  const vv = window.visualViewport, de = document.documentElement;
  if (vv) {
    const sync = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return; // ページ自体を拡大している間は触らない
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      if (kb > 80) { // キーボードが出ている
        de.style.setProperty('--vvh', `${vv.height}px`); de.style.setProperty('--vvt', `${vv.offsetTop}px`); de.style.setProperty('--kb', `${kb}px`);
        de.classList.add('kb-open');
      } else { de.style.removeProperty('--vvh'); de.style.removeProperty('--vvt'); de.style.removeProperty('--kb'); de.classList.remove('kb-open'); }
    };
    vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync);
    // iOS は入力欄にフォーカスするとページ全体を勝手にずらすので、元に戻す
    window.addEventListener('focusin', () => setTimeout(() => { sync(); if (de.classList.contains('kb-open')) window.scrollTo(0, 0); }, 250));
    window.addEventListener('focusout', () => setTimeout(sync, 250));
  }

  // ---- ページ全体の拡大（Safariの2本指ジェスチャー）を、ページを触っている画面では止める。教材の拡大はキャンバス側で行う ----
  const noZoom = (e) => { if (['edit', 'study', 'review'].includes(document.body.dataset.screen) || document.querySelector('.scan')) e.preventDefault(); };
  document.addEventListener('gesturestart', noZoom, { passive: false });
  document.addEventListener('gesturechange', noZoom, { passive: false });
}
