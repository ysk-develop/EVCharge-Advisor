/**
 * Gemini API client
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function fetchModels(apiKey) {
  const url = `${API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`モデル一覧取得失敗 (${res.status}): ${err}`);
  }
  const data = await res.json();
  const models = (data.models || [])
    .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
      description: m.description || ''
    }))
    .filter((m) => /gemini/i.test(m.id));
  return models;
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

export async function analyzeImage(apiKey, model, base64Data, mimeType) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`画像解析失敗 (${res.status}): ${err}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AIからの応答が空です');

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON解析失敗: ${text.slice(0, 200)}`);
  }
}

export async function researchPrices(apiKey, model) {
  const today = new Date().toISOString().slice(0, 10);
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`料金調査失敗 (${res.status}): ${err}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textParts = parts.filter((p) => p.text).map((p) => p.text);
  if (textParts.length === 0) throw new Error('料金調査の応答が空です');

  const grounding = data.candidates?.[0]?.groundingMetadata;
  let sources = [];
  if (grounding?.groundingChunks) {
    sources = grounding.groundingChunks
      .filter((c) => c.web?.uri)
      .map((c) => ({ title: c.web.title, uri: c.web.uri }));
  }

  return { text: textParts.join('\n'), sources };
}
