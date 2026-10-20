/**
 * Gemini API client.
 * Model allow-list matches ReceiptAI (Flash / Flash-Lite / Gemma 4 26B・31B).
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * 解析とルート調査で使うモデルのみ許可。
 * - Gemini x.x Flash / Flash-Lite
 * - Gemma 4 26B / 31B
 * Pro・TTS・画像生成・Omni・Robotics・Computer Use 等は除外。
 */
export function isAllowedModel(id) {
  const m = String(id || '').toLowerCase();
  if (!m) return false;
  if (/^gemma-4-26b\b/.test(m) || /^gemma-4-31b\b/.test(m)) return true;
  if (!m.startsWith('gemini-')) return false;
  if (!m.includes('flash')) return false;
  if (
    /(?:^|[-_.])pro(?:[-_.]|$)/.test(m) ||
    /tts|imagen|banana|omni|robotics|computer[-_]?use|thinking|embedding|aqa|learnlm|image|audio|live|native[-_]?audio/i.test(
      m
    )
  ) {
    return false;
  }
  return /flash-lite|flash(?:-|$)/.test(m);
}

function sortModels(a, b) {
  const rank = (id) => {
    const m = String(id || '').toLowerCase();
    if (/flash-lite/.test(m)) return 20;
    if (/flash/.test(m)) return 10;
    if (/gemma-4-31b/.test(m)) return 30;
    if (/gemma-4-26b/.test(m)) return 31;
    return 50;
  };
  const d = rank(a.id) - rank(b.id);
  return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
}

export async function fetchModels(apiKey) {
  const url = `${API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    const info = parseGeminiHttpError(res.status, err);
    throw new Error(formatGeminiUserError(info, 'models', 'モデル一覧取得失敗'));
  }
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
      description: m.description || ''
    }))
    .filter((m) => isAllowedModel(m.id))
    .sort(sortModels);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseGeminiHttpError(status, bodyText) {
  let message = String(bodyText || '');
  let code = status;
  let statusName = '';
  try {
    const j = JSON.parse(bodyText);
    message = j?.error?.message || message;
    code = j?.error?.code || status;
    statusName = j?.error?.status || '';
  } catch {
    /* keep raw */
  }
  const highDemand =
    status === 503 ||
    statusName === 'UNAVAILABLE' ||
    /high demand|overloaded|unavailable/i.test(message);
  const rateLimited =
    status === 429 || /rate limit|quota|resource.?exhausted/i.test(message);
  return { highDemand, rateLimited, message, code, statusName };
}

export function formatGeminiUserError(info, model, actionLabel = 'Gemini API') {
  if (info.highDemand) {
    return (
      `Gemini「${model}」が混雑しています（503）。` +
      'APIキーやレート制限の問題ではありません。' +
      '設定で別のFlashモデルに切り替えるか、しばらくして再試行してください。'
    );
  }
  if (info.rateLimited) {
    return `Gemini の利用上限に達した可能性があります（${info.code}）。しばらく待ってから再試行してください。`;
  }
  const detail = String(info.message || '').slice(0, 280);
  return `${actionLabel} (${info.code}): ${detail}`;
}

export function isModelOverloadError(err) {
  const s = String(err?.message || err || '');
  return /混雑|503|UNAVAILABLE|high demand/i.test(s);
}

const FALLBACK_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it'
];

export function modelCandidates(preferred) {
  const p = String(preferred || '').trim();
  const out = [];
  if (p && isAllowedModel(p)) out.push(p);
  if (p && /lite/i.test(p)) {
    const base = p.replace(/-?lite(-latest)?$/i, '').replace(/-+$/, '');
    if (base && isAllowedModel(base) && !out.includes(base)) out.push(base);
  }
  for (const m of FALLBACK_MODELS) {
    if (isAllowedModel(m) && !out.includes(m)) out.push(m);
  }
  return out;
}

export async function generateContent(apiKey, model, body, { retries = 3, actionLabel = 'Gemini API' } = {}) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let lastInfo = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (res.ok) return res.json();
    const errText = await res.text();
    lastInfo = parseGeminiHttpError(res.status, errText);
    if ((lastInfo.highDemand || lastInfo.rateLimited) && attempt < retries) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    throw new Error(formatGeminiUserError(lastInfo, model, actionLabel));
  }
  throw new Error(formatGeminiUserError(lastInfo || { message: '不明なエラー', code: 503 }, model, actionLabel));
}

export async function generateContentWithFallback(apiKey, model, body, options = {}) {
  const candidates = modelCandidates(model);
  let lastErr = null;
  for (const m of candidates) {
    try {
      const data = await generateContent(apiKey, m, body, options);
      return { data, modelUsed: m, fallback: m !== model };
    } catch (err) {
      lastErr = err;
      if (!isModelOverloadError(err)) throw err;
    }
  }
  throw lastErr || new Error('Gemini APIに失敗しました');
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    connector: { type: 'string', description: 'CHAdeMO, CCS, 普通充電など' },
    power_kw: { type: 'number', description: '充電器の出力kW。不明ならnull' },
    location: {
      type: 'string',
      enum: ['highway', 'general', 'unknown'],
      description: '高速道路か一般道か'
    },
    services: {
      type: 'array',
      items: { type: 'string' },
      description: '対応認証システム・充電サービス名の一覧'
    },
    raw_text: { type: 'string', description: '読み取れた関連テキスト' }
  },
  required: ['connector', 'services']
};

function textFromCandidate(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
}

export async function analyzeImage(apiKey, model, base64Data, mimeType) {
  const body = {
    contents: [
      {
        parts: [
          {
            text: `この画像はEV充電器の情報画面（EVカーナビ by NAVITIME等）のスクリーンショットです。
以下を抽出してJSONで返してください：
- connector: コネクタ種別（CHAdeMO, CCS, 普通充電など）
- power_kw: 出力（kW）。数値のみ。不明ならnull
- location: "highway"（高速SA/PA等）, "general"（一般道）, "unknown"
- services: 対応認証システム・充電サービス名の配列（画像に表示されているものをすべて）
- raw_text: 読み取れた主要テキスト

サービス名は画像に表示されている表記をそのまま使ってください。
例: "eMP 急速・普通併用", "DMM EV ON", "日産 ZESP3", "三菱自動車 電動車両サポート"`
          },
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ANALYSIS_SCHEMA
    }
  };

  const { data, modelUsed, fallback } = await generateContentWithFallback(apiKey, model, body, {
    actionLabel: '画像解析失敗'
  });
  const text = textFromCandidate(data);
  if (!text) throw new Error('AIからの応答が空です');

  try {
    const parsed = JSON.parse(text);
    parsed.model_used = modelUsed;
    parsed.model_fallback = fallback;
    return parsed;
  } catch {
    throw new Error(`JSON解析失敗: ${text.slice(0, 200)}`);
  }
}

export async function researchPrices(apiKey, model) {
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `${today}現在の情報として、以下のEV充電サービスの最新料金を公式サイトを優先して調査してください。

対象サービス:
- DMM EV ON
- ENEOS Charge Plus
- Honda Charge
- e-Mobility Power（ビジター料金含む）
- PowerX
- EV充電エネチェンジ
- Terra Charge

各サービスについて以下を調査:
- 月額基本料金
- 急速充電料金（出力別があれば記載）
- 普通充電料金
- 時間課金かkWh課金か
- ビジター利用の可否
- 料金改定日（わかれば）
- 公式情報URL

結果は読みやすい日本語のテキストで、サービスごとに箇条書きで出力してください。
最後に「※AIによる調査結果です。必ず公式情報を確認してください。」と添えてください。`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  };

  const { data, modelUsed, fallback } = await generateContentWithFallback(apiKey, model, body, {
    actionLabel: '料金調査失敗'
  });
  const text = textFromCandidate(data);
  if (!text) throw new Error('料金調査の応答が空です');

  const grounding = data.candidates?.[0]?.groundingMetadata;
  let sources = [];
  if (grounding?.groundingChunks) {
    sources = grounding.groundingChunks
      .filter((c) => c.web?.uri)
      .map((c) => ({ title: c.web.title, uri: c.web.uri }));
  }

  return { text, sources, modelUsed, modelFallback: fallback };
}
