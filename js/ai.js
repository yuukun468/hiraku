// 外部AI（Claude）連携。既定はオフ。設定で本人がオンにして自分のAPIキーを入れた場合だけ動く。
// 送るのは「教材から読み取った文字」と「指示文」だけ（画像は送らない）。AIは候補を出す係で、適用前に必ず人が確認する。
import Anthropic from '../vendor/anthropic-sdk.mjs';
import { getSettings } from './db.js';
import { lineText } from './search.js';

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2']);

export async function aiReady() { const s = await getSettings(); return !!(s.aiEnabled && s.aiKey); }

function materialText(pages, limit = 60000) {
  let out = '';
  for (const p of pages) {
    if (!p.lines) continue;
    out += `\n=== ${p.index + 1}ページ ===\n` + p.lines.map(lineText).join('\n');
  }
  if (out.length > limit) throw new Error('教材の文字量が多すぎます。ページを絞って試してください。');
  return out.trim();
}

async function callJson(system, user, schema) {
  const s = await getSettings();
  const client = new Anthropic({ apiKey: s.aiKey, dangerouslyAllowBrowser: true });
  const params = {
    model: s.aiModel, max_tokens: 16000, system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
  };
  let res;
  try {
    res = FALLBACK_MODELS.has(s.aiModel)
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('APIキーが正しくないようです（設定で確認してください）');
    if (e instanceof Anthropic.RateLimitError) throw new Error('AIが混み合っています。少し待ってからもう一度お試しください');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('AIに接続できませんでした（オフラインかもしれません）');
    throw new Error('AIの呼び出しに失敗しました: ' + (e.message || e));
  }
  if (res.stop_reason === 'refusal') throw new Error('AIがこの依頼には応じられませんでした');
  if (res.stop_reason === 'max_tokens') throw new Error('AIの回答が長すぎて途中で切れました。ページを絞ってください');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

const SYSTEM = `あなたは日本の学習者の暗記を手伝うアシスタントです。利用者が自分の教材（プリントやノート）から読み取った文字を渡します。文字認識の誤りが混ざることがあります。
教材に実際に書かれている語句だけを扱い、教材にない知識を足さないでください。語句は教材の表記のまま、1つの行に収まる短い単位（単語〜短い句）で抜き出してください。
「試験に出る」と断定せず、なぜ重要と考えたかを教材の記述にもとづいて短く説明してください。`;

// 自由な指示 → 隠す語句の候補（根拠つき）
export async function aiTerms(pages, instruction) {
  const out = await callJson(SYSTEM,
    `【教材】\n${materialText(pages)}\n\n【利用者の指示】\n${instruction}\n\n指示に合う「隠すと暗記の練習になる語句」を挙げてください。多くても40個まで。`,
    { type: 'object', additionalProperties: false, required: ['terms'], properties: { terms: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'reason'], properties: { text: { type: 'string', description: '教材の表記どおりの語句' }, reason: { type: 'string', description: '選んだ理由（教材のどの記述が根拠か）を20字程度で' } } } } } });
  return out.terms || [];
}

// 一問一答の生成（問題文・答え・形式・教材の根拠）
export async function aiQuestions(pages, instruction) {
  const out = await callJson(SYSTEM,
    `【教材】\n${materialText(pages)}\n\n【利用者の指示】\n${instruction}\n\n教材の内容から、答えが教材に書かれている一問一答を作ってください（多くても20問）。教材から答えられない問題は作らないでください。evidence には根拠となる教材の文をそのまま引用し、page にはそのページ番号を入れてください。`,
    { type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer', 'evidence', 'page', 'reason'], properties: { question: { type: 'string' }, answer: { type: 'string', description: '教材の表記どおりの短い答え' }, evidence: { type: 'string' }, page: { type: 'integer' }, reason: { type: 'string', description: 'なぜ大事と考えたか（短く）' } } } } } });
  return out.questions || [];
}

export async function aiTest() {
  const out = await callJson('短く答えてください。', '接続テストです。ok に true を入れてください。', { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } });
  return !!out.ok;
}
