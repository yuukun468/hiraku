// 音声入力（ブラウザ内蔵の音声認識）。使えない環境ではボタンを出さず、文字入力だけで同じことができる。
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechAvailable = !!SR;
let current = null;

// 1回ぶん聞き取る。onState(true/false) で録音中表示を切り替える。
export function listenOnce(onState) {
  return new Promise((resolve) => {
    if (!SR) return resolve(null);
    if (current) { try { current.abort(); } catch { /* 無視 */ } }
    const r = new SR(); current = r;
    r.lang = 'ja-JP'; r.interimResults = false; r.maxAlternatives = 3;
    let text = null;
    r.onresult = (e) => { text = e.results[0][0].transcript; };
    r.onerror = () => {};
    r.onend = () => { onState && onState(false); if (current === r) current = null; resolve(text); };
    onState && onState(true);
    try { r.start(); } catch { onState && onState(false); resolve(null); }
  });
}
export function stopListening() { if (current) { try { current.stop(); } catch { /* 無視 */ } } }
