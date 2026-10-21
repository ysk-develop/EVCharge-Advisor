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

export function isGemmaModel(id) {
  return /^gemma-/i.test(String(id || '').trim());
}

export const GEMMA_SEARCH_MESSAGE =
  'Gemma 4 は Google 検索に対応していません。料金の調査（料金マスター・ルート比較・近くの充電器）では使いません。' +
  '検索しない回答は出典が取れず、金額を作ってしまうためです。' +
  '設定で Gemini 2.5 Flash または Gemini 2.5 Flash-Lite を選んでください。スクショの解析はこのモデルのまま使えます。';

const FREE_TIER_SEARCH_FLASH = 'gemini-2.5-flash';
const FREE_TIER_SEARCH_LITE = 'gemini-2.5-flash-lite';

export function hasFreeTierGrounding(model) {
  const id = String(model || '').trim().toLowerCase();
  return id === FREE_TIER_SEARCH_FLASH || id === FREE_TIER_SEARCH_LITE;
}

export function freeTierSearchModel(model) {
  const id = String(model || '').trim().toLowerCase();
  if (id === FREE_TIER_SEARCH_LITE || /flash-lite/.test(id)) return FREE_TIER_SEARCH_LITE;
  return FREE_TIER_SEARCH_FLASH;
}

export function searchSwitchNote(selected, used, reason) {
  if (!used || used === selected) return '';
  if (reason === 'overload') return `混雑のため、検索は ${used} で行いました。`;
  if (isGemmaModel(selected)) {
    return `Gemma 4 は Google 検索に対応していないため、検索は ${used} で行いました。スクショ解析は選択中の Gemma のままです。`;
  }
  if (reason === 'limit-zero') {
    return `検索モデルの無料枠が 0 だったため、${used} でやり直しました。`;
  }
  return (
    `選択中の「${selected}」は無料枠で Google 検索が使えません。` +
    'Gemini 3 以降と Flash latest は、検索の無料枠がありません（上限 0）。' +
    `検索は無料枠のある ${used} で行いました。スクショ解析は選択中のモデルのままです。`
  );
}

function parseRetryDelay(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  if (typeof value === 'string') {
    const matched = value.trim().match(/^(\d+(?:\.\d+)?)s$/i);
    if (matched) return Math.round(parseFloat(matched[1]) * 1000);
  }
  if (value && typeof value === 'object') {
    const seconds = Number(value.seconds || 0);
    const nanos = Number(value.nanos || 0);
    if (Number.isFinite(seconds) && Number.isFinite(nanos)) return Math.max(0, Math.round(seconds * 1000 + nanos / 1e6));
  }
  return null;
}

function classifyViolation(violation) {
  const metric = String(violation?.quotaMetric || '');
  const id = String(violation?.quotaId || '');
  const blob = `${metric} ${id}`.toLowerCase();
  const raw = violation?.quotaValue ?? violation?.quota_value;
  const quotaValue = raw == null ? '' : String(raw);
  let kind = 'unknown';
  if (/search|grounding|google_search/.test(blob)) kind = 'grounding';
  else if (/per.?minute|perminute|\brpm\b/.test(blob)) kind = 'rpm';
  else if (/per.?day|perday|\brpd\b|daily/.test(blob)) kind = 'rpd';
  return {
    metric,
    id,
    quotaValue,
    limitZero: quotaValue === '0',
    kind
  };
}

function pickQuota(violations) {
  const rank = (item) => {
    if (item.kind === 'grounding' && item.limitZero) return 0;
    if (item.kind === 'grounding') return 1;
    if (item.limitZero) return 2;
    if (item.kind === 'rpd') return 3;
    if (item.kind === 'rpm') return 4;
    return 5;
  };
  return [...violations].sort((a, b) => rank(a) - rank(b))[0] || null;
}

export function parseGeminiHttpError(status, bodyText, model = '') {
  let message = String(bodyText || '');
  let code = status;
  let statusName = '';
  let violations = [];
  let retryDelayMs = null;
  try {
    const parsed = JSON.parse(bodyText);
    const error = parsed?.error || {};
    message = error.message || message;
    code = error.code || status;
    statusName = error.status || '';
    const details = Array.isArray(error.details) ? error.details : [];
    for (const detail of details) {
      const type = String(detail?.['@type'] || '');
      if (type.includes('QuotaFailure') && Array.isArray(detail.violations)) {
        violations = violations.concat(detail.violations.map(classifyViolation));
      }
      if (type.includes('RetryInfo') && detail.retryDelay != null && retryDelayMs == null) {
        retryDelayMs = parseRetryDelay(detail.retryDelay);
      }
    }
  } catch {
    /* 本文がJSONでなければ、そのまま表示する */
  }
  const quota = pickQuota(violations);
  const limitZero = Boolean(quota?.limitZero) || /limit:\s*0\b/i.test(message);
  const quotaKind = quota?.kind && quota.kind !== 'unknown' ? quota.kind : '';
  const rateLimited = status === 429 || statusName === 'RESOURCE_EXHAUSTED';
  const highDemand = !rateLimited && (
    status === 503 ||
    statusName === 'UNAVAILABLE' ||
    /high demand|overloaded/i.test(message)
  );
  const unsupportedSearch =
    /google_search|tools? (?:is|are) not supported|function calling is not/i.test(message) ||
    (isGemmaModel(model) && (status === 400 || status === 500));
  return {
    highDemand,
    rateLimited,
    unsupportedSearch,
    message,
    code,
    statusName,
    violations,
    quotaKind,
    limitZero,
    retryDelayMs
  };
}

function redactSecrets(text) {
  return String(text || '')
    .replace(/AIza[0-9A-Za-z\-_]{10,}/g, 'AIza…（キーは表示しません）')
    .replace(/([?&]key=)[^&\s]+/gi, '$1（非表示）');
}

function quotaDetailText(info) {
  if (!info.violations?.length) return '';
  return info.violations.map((item) => {
    const value = item.quotaValue === '' ? '不明' : item.quotaValue;
    return `quotaMetric: ${item.metric || '不明'} / quotaId: ${item.id || '不明'} / 上限: ${value}`;
  }).join('\n');
}

export function formatGeminiUserError(info, model, actionLabel = 'Gemini API') {
  const modelNote = model ? `（モデル: ${model}）` : '';
  let lead = '';
  if (info.unsupportedSearch) {
    lead = isGemmaModel(model)
      ? GEMMA_SEARCH_MESSAGE
      : `このモデルは Google 検索に対応していません${modelNote}。Gemini 2.5 Flash または Gemini 2.5 Flash-Lite に切り替えてください。`;
  } else if (info.highDemand) {
    lead =
      `Gemini「${model}」が混雑しています（503）。` +
      'APIキーやレート制限の問題ではありません。' +
      '設定で別のFlashモデルに切り替えるか、しばらくして再試行してください。';
  } else if (info.limitZero && info.quotaKind === 'grounding') {
    lead = hasFreeTierGrounding(model)
      ? `Gemini 2.5 の Google検索グラウンディングも上限が 0 です${modelNote}。このプロジェクトでは無料の検索枠が使えません。AI Studio の課金設定を確認してください。`
      : (
        `Google検索グラウンディングの上限が 0 です${modelNote}。` +
        '無料枠では Gemini 3 以降の検索が使えないことがあります。通常の1日のリクエスト回数とは別の枠です。' +
        'Gemini 2.5 Flash または Gemini 2.5 Flash-Lite に切り替えるか、AI Studio で課金を有効にしてください。'
      );
  } else if (info.limitZero) {
    lead =
      `このモデルの利用上限が 0 です${modelNote}。` +
      '無料枠に入っていないモデルか、プロジェクトの課金が未設定のときに起きます。' +
      'Gemini 2.5 Flash に切り替えるか、AI Studio の課金設定を確認してください。';
  } else if (info.quotaKind === 'grounding') {
    lead =
      `Google検索グラウンディングの上限に達しました${modelNote}。` +
      'Flash と Flash-Lite の無料枠は1日500回の共有です。通常のリクエスト回数とは別枠なので、リクエスト数が残っていても検索は止まります。' +
      '日付が変わるまで待つか、課金プランを確認してください。';
  } else if (info.quotaKind === 'rpd') {
    lead = `1日あたりのリクエスト上限に達しました${modelNote}。日付が変わるまで待つか、AI Studio の利用量を確認してください。`;
  } else if (info.quotaKind === 'rpm') {
    const wait = info.retryDelayMs
      ? `APIは約${Math.ceil(info.retryDelayMs / 1000)}秒待ってから再試行するよう示しています。`
      : '1分ほど待ってから再試行してください。';
    lead = `1分あたりのリクエスト上限に達しました${modelNote}。${wait}`;
  } else if (info.rateLimited) {
    lead =
      `Gemini の利用上限に達しました${modelNote}。` +
      '応答に上限の種類（分あたり・日あたり・検索枠）が含まれていなかったため、どちらに達したかは特定できません。' +
      '少し待って再試行するか、AI Studio の利用量を確認してください。';
  }
  const apiMessage = redactSecrets(info.message).slice(0, 1500);
  const details = quotaDetailText(info);
  if (!lead) {
    return [`${actionLabel} (${info.code}): ${apiMessage}`, details].filter(Boolean).join('\n\n');
  }
  const extra = [`APIのメッセージ: ${apiMessage}`, details].filter(Boolean).join('\n');
  return `${lead}\n\n${extra}`;
}

const MAX_RETRY_WAIT_MS = 12000;

export function retryPlan(info) {
  if (!info) return { retry: false, delayMs: 0 };
  if (info.unsupportedSearch || info.limitZero) return { retry: false, delayMs: 0 };
  if (info.quotaKind === 'grounding' || info.quotaKind === 'rpd') return { retry: false, delayMs: 0 };
  if (info.quotaKind === 'rpm') {
    const delay = info.retryDelayMs == null ? 5000 : info.retryDelayMs;
    if (delay > MAX_RETRY_WAIT_MS) return { retry: false, delayMs: delay };
    return { retry: true, delayMs: Math.max(delay, 1000) };
  }
  if (info.highDemand) {
    const delay = info.retryDelayMs != null && info.retryDelayMs <= MAX_RETRY_WAIT_MS ? info.retryDelayMs : 2000;
    return { retry: true, delayMs: Math.max(delay, 1000) };
  }
  if (info.rateLimited && info.retryDelayMs != null && info.retryDelayMs <= MAX_RETRY_WAIT_MS) {
    return { retry: true, delayMs: Math.max(info.retryDelayMs, 1000) };
  }
  return { retry: false, delayMs: 0 };
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

export async function generateContent(apiKey, model, body, { actionLabel = 'Gemini API', allowRetry = true, timeoutMs = 0 } = {}) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  let lastInfo = null;
  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    let aborted = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      aborted = true;
      controller.abort();
    }, timeoutMs) : null;
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (aborted || err?.name === 'AbortError') {
        const error = new Error('Geminiの応答が時間内に返りませんでした。');
        error.gemini = { timeout: true, message: error.message, code: 0 };
        error.aborted = true;
        throw error;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.ok) return res.json();
    const errText = await res.text();
    lastInfo = parseGeminiHttpError(res.status, errText, model);
    const plan = retryPlan(lastInfo);
    if (allowRetry && plan.retry && attempt < 1) {
      await sleep(plan.delayMs);
      attempt += 1;
      continue;
    }
    const error = new Error(formatGeminiUserError(lastInfo, model, actionLabel));
    error.gemini = lastInfo;
    throw error;
  }
}

function otherFreeTierSearchModel(model) {
  return model === FREE_TIER_SEARCH_FLASH ? FREE_TIER_SEARCH_LITE : FREE_TIER_SEARCH_FLASH;
}

function modelUnavailable(info) {
  if (!info || info.code === 401 || info.code === 403) return false;
  if (info.code === 404 || info.statusName === 'NOT_FOUND') return true;
  return /not found|no longer available|is not supported|has not used/i.test(info.message || '');
}

function shouldSwitchSearchModel(err) {
  const info = err?.gemini;
  if (!info) return '';
  if (isModelOverloadError(err)) return 'overload';
  if (modelUnavailable(info)) return 'unavailable';
  if (info.limitZero && info.rateLimited) return 'limit-zero';
  return '';
}

function withoutUnsupportedSearchFields(body) {
  const next = { ...body, tools: [{ google_search: {} }] };
  delete next.systemInstruction;
  if (next.generationConfig) {
    const { responseSchema, responseMimeType, ...rest } = next.generationConfig;
    if (Object.keys(rest).length) next.generationConfig = rest;
    else delete next.generationConfig;
  }
  return next;
}

function withoutThinking(body) {
  if (!body?.generationConfig?.thinkingConfig) return null;
  const generationConfig = { ...body.generationConfig };
  delete generationConfig.thinkingConfig;
  const next = { ...body };
  if (Object.keys(generationConfig).length) next.generationConfig = generationConfig;
  else delete next.generationConfig;
  return next;
}

export async function generateSearch(apiKey, model, body, actionLabel = '調査失敗', options = {}) {
  const payload = withoutUnsupportedSearchFields(body);
  const primary = freeTierSearchModel(model);
  const pinned = primary !== String(model || '').trim();
  const call = (id, requestBody, allowRetry) => generateContent(apiKey, id, requestBody, {
    actionLabel,
    allowRetry,
    timeoutMs: options.timeoutMs || 0
  });
  try {
    let data;
    try {
      data = await call(primary, payload, options.allowRetry !== false);
    } catch (err) {
      const plain = withoutThinking(payload);
      if (!plain || !/thinking/i.test(err?.gemini?.message || err?.message || '')) throw err;
      data = await call(primary, plain, false);
    }
    return {
      data,
      modelUsed: primary,
      fallback: pinned,
      reason: pinned ? 'free-grounding' : '',
      notice: searchSwitchNote(model, primary, pinned ? 'free-grounding' : '')
    };
  } catch (err) {
    const reason = shouldSwitchSearchModel(err);
    if (!reason) throw err;
    const alt = otherFreeTierSearchModel(primary);
    try {
      const data = await call(alt, payload, false);
      const noteReason = reason === 'overload' ? 'overload' : 'limit-zero';
      return {
        data,
        modelUsed: alt,
        fallback: true,
        reason: noteReason,
        notice: searchSwitchNote(model, alt, noteReason)
      };
    } catch (second) {
      if (reason === 'unavailable' || modelUnavailable(second?.gemini)) {
        const error = new Error(
          'Gemini 2.5 Flash と 2.5 Flash-Lite のどちらも呼べませんでした。' +
          'Google は、以前に 2.5 を使ったことのあるプロジェクトへ 2.5 の利用を絞っています。' +
          '選択中の Flash latest や Gemini 3 以降は、無料枠の Google 検索が上限 0 です。' +
          '料金調査には、2.5 を使えるキーか、検索が含まれる有料枠が必要です。\n\n' +
          second.message
        );
        error.gemini = second.gemini;
        throw error;
      }
      throw second;
    }
  }
}

export async function generateContentWithFallback(apiKey, model, body, options = {}) {
  const candidates = modelCandidates(model)
    .filter((id) => !(body?.tools && isGemmaModel(id)))
    .slice(0, 3);
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
    contents: [{ parts: [{ text: prompt }] }]
  };

  const { data, modelUsed, fallback, notice } = await generateSearch(apiKey, model, body, '料金調査失敗');
  const text = textFromCandidate(data);
  if (!text) throw new Error('料金調査の応答が空です');

  const grounding = data.candidates?.[0]?.groundingMetadata;
  let sources = [];
  if (grounding?.groundingChunks) {
    sources = grounding.groundingChunks
      .filter((c) => c.web?.uri)
      .map((c) => ({ title: c.web.title, uri: c.web.uri }));
  }

  return { text, sources, modelUsed, modelFallback: fallback, notice };
}
