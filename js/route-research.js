/**
 * Gemini + Google Search grounding for chargers and tolls.
 * Numbers without a source URL are dropped. A second call only structures
 * the research text; it is not allowed to add facts.
 */

import { buildEnergyProfile, chargeWindows, pointAlong } from './route-model.js';
import { generateContent, generateSearch } from './gemini-api.js';
import {
  answerText,
  collectSourceUrls,
  describeNetError,
  mergeChargerPrices,
  parseModelJson,
  sampleRoutePoints
} from './charger-lookup.js';

const CHARGER_FIELDS = {
  name: { type: 'string' },
  address: { type: 'string' },
  lat: { type: 'number' },
  lon: { type: 'number' },
  hasPoint: { type: 'boolean' },
  powerKw: { type: 'number' },
  powerKnown: { type: 'boolean' },
  priceType: { type: 'string', enum: ['per_min', 'per_kwh', 'per_session', 'unknown'] },
  unitPrice: { type: 'number' },
  priceKnown: { type: 'boolean' },
  priceNote: { type: 'string' },
  operatorClass: { type: 'string', enum: ['emp_operated', 'emp_partner', 'other', 'unknown'] },
  operatorName: { type: 'string' },
  apps: { type: 'string' },
  hours: { type: 'string' },
  hoursConflict: { type: 'string' },
  locationType: { type: 'string', enum: ['highway', 'general', 'unknown'] },
  sources: { type: 'array', items: { type: 'string' } },
  routeId: { type: 'string' }
};

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    tolls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          tollKnown: { type: 'boolean' },
          tollYen: { type: 'number' },
          note: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } }
        },
        required: ['routeId', 'tollKnown']
      }
    },
    chargers: {
      type: 'array',
      items: { type: 'object', properties: CHARGER_FIELDS, required: ['name', 'priceKnown', 'operatorClass'] }
    },
    notes: { type: 'string' }
  },
  required: ['tolls', 'chargers']
};

const NEARBY_SCHEMA = {
  type: 'object',
  properties: {
    chargers: {
      type: 'array',
      items: { type: 'object', properties: CHARGER_FIELDS, required: ['name', 'priceKnown', 'operatorClass'] }
    },
    notes: { type: 'string' }
  },
  required: ['chargers']
};

async function generate(apiKey, model, body, options = {}) {
  if (body.tools) return generateSearch(apiKey, model, body, '調査失敗', options);
  const data = await generateContent(apiKey, model, body, {
    actionLabel: '調査失敗',
    allowRetry: false,
    timeoutMs: options.timeoutMs || 0
  });
  return { data, modelUsed: model, fallback: false, notice: '' };
}

function collectText(data) {
  const text = answerText(data);
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new Error(reason ? `AIからの応答がありません（${reason}）` : 'AIからの応答が空です');
  }
  return text;
}

async function structureJson(apiKey, model, schema, researchText, sourceUrls) {
  const prompt = `次の調査メモだけをJSONにしてください。メモに書いていない数値は作らないでください。
ルール:
- 金額・出力kWがメモに明示されていない、または出典URLが無い場合は priceKnown=false / powerKnown=false / tollKnown=false
- 出典URLはメモか「グラウンディングURL」にある http(s) のみ。無ければ sources は空配列
- 営業時間がソースで食い違う場合は hours に一方、hoursConflict にもう一方を書く
- operatorClass は emp_operated（eMP自社）/ emp_partner（ディーラー等の提携）/ other / unknown
- 課金は per_min（円/分）/ per_kwh（円/kWh）/ per_session（円/回）/ unknown
- eMPの標準料金表を、提携充電器やディーラーの単価として書かない

グラウンディングURL:
${sourceUrls.length ? sourceUrls.join('\n') : '（なし）'}

調査メモ:
${researchText}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: schema
    }
  };
  try {
    const { data } = await generate(apiKey, model, body, { timeoutMs: 12000 });
    const parsed = parseModelJson(collectText(data));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  } catch {
    const loose = await generate(apiKey, model, {
      contents: body.contents,
      generationConfig: { temperature: 0.1 }
    }, { timeoutMs: 12000 });
    const parsed = parseModelJson(collectText(loose.data));
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  }
}

function todayIso() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function normalizeResearchedCharger(raw, checkedAt) {
  if (!raw || !raw.name) return null;
  const sources = (raw.sources || []).map(String).filter((u) => /^https?:\/\//i.test(u));
  const priceKnown = Boolean(raw.priceKnown) && sources.length > 0 && Number.isFinite(Number(raw.unitPrice));
  const powerKnown = Boolean(raw.powerKnown) && Number.isFinite(Number(raw.powerKw)) && Number(raw.powerKw) > 0;
  const hasPoint = Boolean(raw.hasPoint) && Number.isFinite(Number(raw.lat)) && Number.isFinite(Number(raw.lon));
  const lat = hasPoint ? Number(raw.lat) : null;
  const lon = hasPoint ? Number(raw.lon) : null;
  const inJapan = lat != null && lat >= 20 && lat <= 50 && lon >= 122 && lon <= 154;
  return {
    name: String(raw.name).slice(0, 80),
    address: String(raw.address || '').slice(0, 120),
    lat: inJapan ? lat : null,
    lon: inJapan ? lon : null,
    powerKw: powerKnown ? Number(raw.powerKw) : null,
    locationType: raw.locationType === 'highway' || raw.locationType === 'general' ? raw.locationType : 'unknown',
    operatorClass: ['emp_operated', 'emp_partner', 'other', 'unknown'].includes(raw.operatorClass) ? raw.operatorClass : 'unknown',
    operatorName: String(raw.operatorName || '').slice(0, 80),
    apps: String(raw.apps || '').slice(0, 160),
    hours: String(raw.hours || '').slice(0, 200),
    hoursConflict: String(raw.hoursConflict || '').slice(0, 200),
    routeId: String(raw.routeId || ''),
    ai: {
      priceKnown: priceKnown && raw.priceType && raw.priceType !== 'unknown',
      priceType: raw.priceType || 'unknown',
      unitPrice: priceKnown ? Number(raw.unitPrice) : null,
      priceNote: String(raw.priceNote || '').slice(0, 240),
      sources,
      hours: String(raw.hours || '').slice(0, 200),
      hoursConflict: String(raw.hoursConflict || '').slice(0, 200),
      checkedAt: checkedAt || todayIso()
    }
  };
}

const TOLL_URL_HINT = /driveplaza|c-nexco|e-nexco|w-nexco|nexco|highway\.go\.jp|ドラぷら|高速料金/i;

function tollSourceUrls(raw, grounding = []) {
  const fromRow = (raw?.sources || []).map(String).filter((u) => /^https?:\/\//i.test(u));
  if (fromRow.length) return [...new Set(fromRow)];
  return [...new Set(
    (grounding || []).map(String).filter((u) => /^https?:\/\//i.test(u) && TOLL_URL_HINT.test(u))
  )];
}

export function normalizeToll(raw, grounding = []) {
  if (!raw) return null;
  const sources = tollSourceUrls(raw, grounding);
  const yen = Number(raw.tollYen);
  const claimed = raw.tollKnown != null ? Boolean(raw.tollKnown) : Number.isFinite(yen);
  const known = claimed && sources.length > 0 && Number.isFinite(yen) && yen >= 0;
  return {
    routeId: String(raw.routeId || ''),
    tollKnown: known,
    tollYen: known ? Math.round(yen) : null,
    note: String(raw.note || '').slice(0, 300),
    sources
  };
}

/** Prefer exact routeId, then requestKey, then prefix (fast-alt-1 ↔ fast). */
export function matchToll(tolls, route) {
  if (!tolls?.length || !route) return null;
  const key = String(route.key || '');
  const requestKey = String(route.requestKey || key);
  return tolls.find((t) => t.routeId === key)
    || tolls.find((t) => t.routeId === requestKey)
    || tolls.find((t) => t.routeId && (key.startsWith(t.routeId) || t.routeId.startsWith(requestKey)))
    || null;
}

const RESEARCH_RULES = `あなたは日本のEV充電と高速道路料金の調査係です。必ず検索し、見たページのURLを付けてください。
禁止:
- 出典の無い数値を書かない。分からなければ「不明」
- e-Mobility Powerの標準ビジター料金（一般道 55/77/99円/分、高速 77/99/121円/分、kWh課金 110/143円）を、提携充電器・カーディーラー・運営が違う充電器に当てはめない
- 営業時間がソースで食い違うときは両方書き、一つに決めない
- 通行料金の割引率を、その出発日時に適用されると公式に確認できないまま掛けない

eMP自社機と提携機を分けてください。
- emp_operated: e-Mobility Powerが運営する自社充電器（SA/PAやeMP名義など）
- emp_partner: カーディーラー、販売店、提携スポット。料金は充電器ごと。アプリでQRを読まないと分からないことが多く、1回定額（例: 2,970円/回）の場合があります
- other: ENEOS Charge Plus、Terra Charge、FLASH、e-OASIS、エネチェンジ、PowerX、自治体など
- unknown: 断定できない

検索の例: e-Mobility Power公式料金、ENEOS Charge Plus公式料金、GoGoEV (ev.gogo.gs)、EVsmart (evsmart.net)、Terra Charge、FLASH、e-OASIS、自治体のページ。
各充電器について: 名称、住所、緯度経度（ページにあれば）、出力kW、料金タイプ（円/分・円/kWh・円/回）と単価、使えるアプリ、営業時間、高速SAか一般道か、運営区分、出典URL。
ユーザーが使えるアプリの料金を優先。会員料金とビジター料金が違うときは、ユーザーの加入状況に合う方を書き、違えば注記する。`;

export function departureLabel(datetimeLocal) {
  if (!datetimeLocal) return '未指定';
  const d = new Date(datetimeLocal);
  if (Number.isNaN(d.getTime())) return datetimeLocal;
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${days[d.getDay()]}）`;
}

function vehicleBlurb(vehicle, appsLabel) {
  return `車両: 電池${vehicle.batteryKwh}kWh、開始SOC ${vehicle.socPercent}%、保守満充電航続 ${vehicle.conservativeRangeKm}km、最大受入 ${vehicle.maxDcKw}kW、コネクタ ${vehicle.connector}、到着時に残す距離 ${vehicle.safetyMarginKm}km
ETC: ${vehicle.hasEtc ? 'あり（ETC料金。休日・深夜割引は公式で確認できた場合のみ）' : 'なし（現金料金）'}
使える充電アプリ・会員: ${appsLabel || '指定なし'}`;
}

function aiChargerFromJson(raw, checkedAt) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  return normalizeResearchedCharger({
    name: raw.name,
    address: raw.address,
    lat,
    lon,
    hasPoint: Number.isFinite(lat) && Number.isFinite(lon),
    powerKw: raw.powerKw,
    powerKnown: Number(raw.powerKw) > 0,
    priceType: raw.priceType,
    unitPrice: raw.unitPrice,
    priceKnown: raw.unitPrice != null && raw.unitPrice !== '',
    priceNote: raw.priceNote,
    operatorClass: raw.operatorClass,
    operatorName: raw.operatorName,
    sources: raw.sources,
    routeId: raw.routeId || ''
  }, checkedAt);
}

function routeLines(routes) {
  return (routes || []).map((route) => {
    const tollKm = Number(route.tollKm || 0);
    const tollBit = route.hasToll || tollKm > 0.4
      ? `有料道路あり（有料区間の目安 ${tollKm.toFixed(0)} km）`
      : '有料道路なし';
    return `- routeId 「${route.key}」: 約${Number(route.distanceKm || 0).toFixed(0)} km、${tollBit}、主な道路: ${route.roadSummary || '不明'}`;
  }).join('\n');
}

const TOLL_SCHEMA = {
  type: 'object',
  properties: {
    tolls: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          routeId: { type: 'string' },
          tollKnown: { type: 'boolean' },
          tollYen: { type: 'number' },
          note: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } }
        },
        required: ['routeId', 'tollKnown']
      }
    }
  },
  required: ['tolls']
};

function tollPrompt(routes, vehicle, datetimeLocal, trip = {}) {
  const origin = trip.origin || '（未指定）';
  const destination = trip.destination || '（未指定）';
  return `${RESEARCH_RULES}

調査日: ${todayIso()}
出発日時: ${departureLabel(datetimeLocal)}
ETC: ${vehicle?.hasEtc ? 'あり（通常のETC料金。休日・深夜割引は公式で確認できたときだけ適用）' : 'なし（現金・一般料金）'}

出発地: ${origin}
目的地: ${destination}

上記の出発地→目的地について、各ルート案の片道通行料金だけを調べてください（高速道路のETC／現金料金）。
優先して参照するサイト:
- ドラぷら https://www.driveplaza.com/
- NEXCO各社の料金案内

ルール:
- routeId は下の「routeId」の文字列をそのまま返す（例: fast / local / mixed / fast-alt-1）
- 有料道路なしのルートは tollKnown=true, tollYen=0, sources=[] でよい
- 有料道路ありで金額が分かったら tollYen に整数（円）、sources に公式ページのURLを付ける
- 出典URLが無い金額は tollYen=null / tollKnown=false
- 確認できない割引は掛けない

回答はJSONだけ。
{"tolls":[{"routeId":"fast","tollKnown":true,"tollYen":0,"note":"","sources":[]}]}

ルート案:
${routeLines(routes) || '（なし）'}`;
}

function pricePrompt(routes, vehicle, appsLabel, datetimeLocal, points) {
  const spots = points.map((point, index) => `${index + 1}. ${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`).join('\n');
  return `${RESEARCH_RULES}

調査日: ${todayIso()}
出発日時: ${departureLabel(datetimeLocal)}
${vehicleBlurb(vehicle, appsLabel)}

次の地点は、電池が少なくなる付近か経路上の地点です。各地点からおおむね5km以内の急速充電器（CHAdeMOまたはCCS）を、地点あたり最大2件、全体で8件まで調べてください。
料金だけを答えてください。回答はJSONだけ。不明な数値は null。出典URLが無い単価は null。
{"chargers":[{"name":"","address":"","lat":0,"lon":0,"powerKw":null,"priceType":"unknown","unitPrice":null,"operatorClass":"unknown","operatorName":"","priceNote":"","sources":[]}]}

地点:
${spots || '（地点なし）'}

経路の目安:
${routeLines(routes) || '（なし）'}`;
}

async function runSearch(apiKey, model, prompt, step) {
  try {
    const value = await generate(apiKey, model, {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
    }, { timeoutMs: 28000, allowRetry: false });
    return {
      rawText: answerText(value.data),
      grounding: collectSourceUrls(value.data),
      error: '',
      raw: '',
      notice: value.notice || '',
      modelUsed: value.modelUsed || model
    };
  } catch (err) {
    return {
      rawText: '',
      grounding: [],
      error: describeNetError(err, step),
      raw: String(err?.message || ''),
      notice: '',
      modelUsed: model
    };
  }
}

export function assembleLookup({ osmChargers, grounded, tollResult = null, checkedAt }) {
  const rawText = grounded?.rawText || '';
  const parsed = parseModelJson(rawText);
  const aiChargers = ((parsed.value && parsed.value.chargers) || [])
    .map((row) => aiChargerFromJson(row, checkedAt))
    .filter(Boolean);
  const tollText = tollResult?.rawText || '';
  const tollParsed = tollResult ? parseModelJson(tollText) : null;
  const tollRows = (tollParsed?.ok && tollParsed.value?.tolls?.length)
    ? tollParsed.value.tolls
    : ((parsed.value && parsed.value.tolls) || []);
  const tollGrounding = [
    ...(tollResult?.grounding || []),
    ...(grounded?.grounding || [])
  ];
  const tolls = tollRows.map((row) => normalizeToll({
    ...row,
    tollKnown: row.tollKnown != null ? row.tollKnown : row.tollYen != null
  }, tollGrounding)).filter(Boolean);
  const chargers = mergeChargerPrices(osmChargers || [], aiChargers);
  const pricedCount = chargers.filter((charger) => charger.ai?.priceKnown).length;
  let emptyMessage = '';
  let priceMessage = '';
  const tollMessage = tolls.length ? '' : (tollResult?.error || '');
  if (!chargers.length) {
    const bits = [grounded?.osmError, grounded?.error].filter(Boolean);
    if (!bits.length) {
      emptyMessage = rawText || (grounded?.grounding || []).length
        ? '検索は成功したが充電器を読み取れませんでした。'
        : '充電器を読み取れませんでした。';
    } else if ((rawText || (grounded?.grounding || []).length) && !grounded?.error) {
      emptyMessage = ['検索は成功したが充電器を読み取れませんでした。', grounded.osmError].filter(Boolean).join('');
    } else {
      emptyMessage = bits.join('');
    }
  } else if (!pricedCount) {
    priceMessage = grounded?.error
      ? `${grounded.error}位置は地図データです。`
      : (rawText || (grounded?.grounding || []).length)
        ? '検索は成功したが充電器の料金を読み取れませんでした。位置はOpenStreetMapの充電スポットです。'
        : '料金の検索結果が空でした。位置はOpenStreetMapの充電スポットです。';
  }
  return {
    chargers,
    tolls,
    notes: parsed.value?.notes || '',
    researchText: rawText,
    grounding: grounded?.grounding || [],
    emptyMessage,
    priceMessage,
    tollMessage,
    debug: {
      rawText,
      groundingCount: (grounded?.grounding || []).length,
      osmCount: (osmChargers || []).length,
      parsedCount: aiChargers.length,
      pricedCount,
      chargerCount: chargers.length,
      parseNote: [
        parsed.ok ? '料金JSONを読み取りました。' : `料金JSONは読めませんでした（${parsed.error}）。`,
        grounded?.error || '',
        grounded?.osmError || ''
      ].filter(Boolean).join(' ')
    }
  };
}

function stepDetail(result) {
  const raw = result?.raw || '';
  const message = result?.error || '';
  if (!message) return '';
  if (!raw || message.includes(raw)) return message;
  return `${message}（${raw}）`;
}

function stopPricePrompt(chargers, vehicle, appsLabel) {
  const lines = (chargers || []).map((charger, index) => (
    `${index + 1}. ${charger.name} / ${charger.operatorName || '運営不明'} / ${Number(charger.lat).toFixed(4)}, ${Number(charger.lon).toFixed(4)} / ${charger.powerKw || '出力不明'}kW`
  )).join('\n');
  return `${RESEARCH_RULES}

${vehicleBlurb(vehicle, appsLabel)}

次に挙げる充電器だけの料金を調べてください。一覧に無い充電器は足さないでください。
回答はJSONだけ。出典URLが無い単価は null。eMPの標準料金を提携充電器に当てはめない。
{"chargers":[{"name":"","lat":0,"lon":0,"powerKw":null,"priceType":"unknown","unitPrice":null,"operatorClass":"unknown","operatorName":"","priceNote":"","sources":[]}]}

${lines || '（なし）'}`;
}

export async function researchTollsAndStopPrices(apiKey, model, routes, chargers, vehicle, appsLabel, datetimeLocal, onStatus, trip = {}) {
  if (onStatus) onStatus('選んだ充電ストップの料金と通行料金を調べています');
  const targets = (chargers || []).slice(0, 8);
  const [prices, tolls] = await Promise.all([
    targets.length
      ? runSearch(apiKey, model, stopPricePrompt(targets, vehicle, appsLabel), '料金検索')
      : Promise.resolve({ rawText: '', grounding: [], error: '', raw: '', notice: '', modelUsed: model }),
    (routes || []).length
      ? runSearch(apiKey, model, tollPrompt(routes, vehicle, datetimeLocal, trip), '通行料金検索')
      : Promise.resolve({ rawText: '', grounding: [], error: '', raw: '', notice: '', modelUsed: model })
  ]);
  const assembled = assembleLookup({
    osmChargers: [],
    grounded: prices,
    tollResult: tolls,
    checkedAt: todayIso()
  });
  return {
    priced: assembled.chargers,
    tolls: assembled.tolls,
    priceMessage: prices.error
      ? `${prices.error}充電時間は車両と充電器の出力から計算しています。`
      : (assembled.priceMessage || ''),
    tollMessage: assembled.tollMessage || '',
    grounding: [...new Set([...(prices.grounding || []), ...(tolls.grounding || [])])],
    notes: assembled.notes || '',
    researchText: [prices.rawText, tolls.rawText].filter(Boolean).join('\n\n'),
    modelNotice: prices.notice || tolls.notice || '',
    modelUsed: prices.modelUsed || tolls.modelUsed,
    debugSteps: [
      { name: '料金検索', ok: !prices.error, detail: prices.error ? `${prices.error}${prices.raw ? `（${prices.raw}）` : ''}` : `${assembled.debug.pricedCount}件` },
      { name: '通行料金検索', ok: !tolls.error, detail: tolls.error ? `${tolls.error}${tolls.raw ? `（${tolls.raw}）` : ''}` : `${assembled.tolls.length}件` }
    ]
  };
}

export async function researchRoutes(apiKey, model, routes, vehicle, appsLabel, datetimeLocal, onStatus, trip = {}) {
  const checkedAt = todayIso();
  const points = sampleRoutePoints(routes, 25, vehicle);
  if (onStatus) onStatus('地図の充電器、料金、通行料金を別々に調べています');
  const osm = { chargers: [], error: '', attempts: [], raw: '' };
  const [prices, tolls] = await Promise.all([
    runSearch(apiKey, model, pricePrompt(routes, vehicle, appsLabel, datetimeLocal, points), '料金検索'),
    runSearch(apiKey, model, tollPrompt(routes, vehicle, datetimeLocal, trip), '通行料金検索')
  ]);
  if (!parseModelJson(prices.rawText).ok && prices.rawText) {
    if (onStatus) onStatus('料金の検索結果を読み取っています');
    try {
      const structured = await structureJson(apiKey, prices.modelUsed || model, ROUTE_SCHEMA, prices.rawText, prices.grounding);
      prices.rawText = `${prices.rawText}\n\n${JSON.stringify(structured)}`;
    } catch (err) {
      prices.raw = [prices.raw, describeNetError(err, '料金検索')].filter(Boolean).join(' ');
    }
  }
  if (!parseModelJson(tolls.rawText).ok && tolls.rawText) {
    if (onStatus) onStatus('通行料金の検索結果を読み取っています');
    try {
      const structured = await structureJson(apiKey, tolls.modelUsed || model, TOLL_SCHEMA, tolls.rawText, tolls.grounding);
      tolls.rawText = `${tolls.rawText}\n\n${JSON.stringify(structured)}`;
    } catch (err) {
      tolls.raw = [tolls.raw, describeNetError(err, '通行料金検索')].filter(Boolean).join(' ');
    }
  }
  const assembled = assembleLookup({
    osmChargers: osm.chargers,
    grounded: { ...prices, osmError: osm.error },
    tollResult: tolls,
    checkedAt
  });
  const steps = [
    {
      name: '地図の充電器検索',
      ok: !osm.error,
      detail: `${osm.error ? stepDetail(osm) : `${osm.chargers.length}件`} ${(osm.attempts || []).join(' / ')}`.trim()
    },
    { name: '料金検索', ok: !prices.error, detail: prices.error ? stepDetail(prices) : `${assembled.debug.pricedCount}件の料金` },
    { name: '通行料金検索', ok: !tolls.error, detail: tolls.error ? stepDetail(tolls) : `${assembled.tolls.length}件` }
  ];
  assembled.grounding = [...new Set([...(prices.grounding || []), ...(tolls.grounding || [])])];
  assembled.debug.groundingCount = assembled.grounding.length;
  assembled.debug.steps = steps;
  assembled.debug.parseNote = steps.map((step) => `${step.name}: ${step.ok ? '成功' : '失敗'} ${step.detail}`).join('\n');
  assembled.debug.rawText = [prices.rawText, tolls.rawText].filter(Boolean).join('\n\n');
  assembled.researchText = assembled.debug.rawText;
  return {
    ...assembled,
    checkedAt,
    modelUsed: prices.modelUsed || tolls.modelUsed,
    modelNotice: prices.notice || tolls.notice || ''
  };
}

export async function researchNearby(apiKey, model, query, vehicle, appsLabel, point, onStatus) {
  const checkedAt = todayIso();
  const where = point
    ? `場所: ${point.label}（${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}）。この地点から3km以内。`
    : `場所の名前: 「${query}」。特定できなければ名称で検索。`;
  if (onStatus) onStatus('料金を検索しています');
  const osm = { chargers: [], error: '' };
  const [searched] = await Promise.all([
    generate(apiKey, model, {
      contents: [{ parts: [{ text: `${RESEARCH_RULES}\n\n${vehicleBlurb(vehicle, appsLabel)}\n${where}\n入力: 「${query}」\n急速充電器を最大6件。回答はJSONのみ。{"chargers":[{"name":"","lat":0,"lon":0,"powerKw":null,"priceType":"unknown","unitPrice":null,"operatorClass":"unknown","operatorName":"","priceNote":"","sources":[]}]}` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } }
    }, { timeoutMs: 22000, allowRetry: false }).then((value) => ({
      rawText: answerText(value.data),
      grounding: collectSourceUrls(value.data),
      error: '',
      notice: value.notice || '',
      modelUsed: value.modelUsed
    })).catch((err) => ({
      rawText: '',
      grounding: [],
      error: describeNetError(err, '料金検索'),
      raw: String(err?.message || ''),
      notice: '',
      modelUsed: model
    }))
  ]);
  const assembled = assembleLookup({
    osmChargers: osm.chargers,
    grounded: { ...searched, osmError: osm.error },
    checkedAt
  });
  return {
    ...assembled,
    checkedAt,
    modelUsed: searched.modelUsed,
    modelNotice: searched.notice || ''
  };
}

export function buildDemoResearch(routes, vehicle) {
  const checkedAt = todayIso();
  const tolls = [];
  const chargers = [];
  for (const route of routes) {
    const profile = buildEnergyProfile(route, vehicle);
    const windows = chargeWindows(profile, vehicle);
    const anchor = windows[0] || { km: Math.min(profile.distanceKm * 0.45, Math.max(profile.distanceKm - 1, 0)) };
    const pt = pointAlong(profile, anchor.km);
    tolls.push({
      routeId: route.key,
      tollKnown: false,
      tollYen: null,
      note: 'サンプルモードのため通行料金は調べていません',
      sources: []
    });
    if (pt.lat == null) continue;
    const highway = route.highwayRatio >= 0.4;
    chargers.push({
      name: highway ? 'サンプルSA 急速充電器' : 'サンプル 道の駅急速',
      address: 'サンプル（実在しません）',
      lat: pt.lat,
      lon: pt.lon,
      powerKw: 50,
      locationType: highway ? 'highway' : 'general',
      operatorClass: 'emp_operated',
      operatorName: 'e-Mobility Power',
      apps: 'e-Mobility Power',
      hours: '24時間（サンプル）',
      hoursConflict: '',
      routeId: route.key,
      demo: true,
      ai: {
        priceKnown: true,
        priceType: 'per_min',
        unitPrice: highway ? 77 : 55,
        priceNote: 'サンプル。eMP自社の公示分課金の例',
        sources: ['https://www.e-mobipower.co.jp/visitor-fee/'],
        hours: '24時間（サンプル）',
        hoursConflict: '',
        checkedAt
      }
    });
    const pt2 = pointAlong(profile, Math.max(1, anchor.km - Math.min(8, anchor.km * 0.2)));
    chargers.push({
      name: 'サンプル日産販売 東店',
      address: 'サンプル（実在しません）',
      lat: pt2.lat,
      lon: pt2.lon,
      powerKw: 90,
      locationType: 'general',
      operatorClass: 'emp_partner',
      operatorName: '日産販売店（提携）',
      apps: 'e-Mobility Power',
      hours: '10:00-19:00（サンプル）',
      hoursConflict: '別ソース: 9:30-18:30（サンプル）',
      routeId: route.key,
      demo: true,
      ai: {
        priceKnown: true,
        priceType: 'per_session',
        unitPrice: 2970,
        priceNote: 'サンプル。提携店の1回定額の例',
        sources: ['https://example.com/demo-not-a-real-price'],
        hours: '10:00-19:00（サンプル）',
        hoursConflict: '別ソース: 9:30-18:30（サンプル）',
        checkedAt
      }
    });
  }
  return {
    demo: true,
    checkedAt,
    notes: 'サンプルデータです。Geminiは呼んでいません。',
    researchText: 'サンプルモードです。Geminiは呼んでいません。',
    grounding: [],
    tolls,
    chargers,
    emptyMessage: '',
    priceMessage: '',
    debug: {
      rawText: 'サンプルモードです。Geminiは呼んでいません。',
      groundingCount: 0,
      osmCount: 0,
      parsedCount: chargers.length,
      pricedCount: chargers.filter((charger) => charger.ai?.priceKnown).length,
      chargerCount: chargers.length,
      parseNote: 'サンプルデータです。'
    }
  };
}

export const APP_OPTIONS = [
  { id: 'emp', label: 'eMP' },
  { id: 'eneos', label: 'ENEOS Charge Plus' },
  { id: 'terra', label: 'Terra Charge' },
  { id: 'dmm', label: 'DMM EV CHARGE' },
  { id: 'enechange', label: 'エネチェンジ' },
  { id: 'powerx', label: 'PowerX' },
  { id: 'nissan', label: '日産 ZESP3' },
  { id: 'flash', label: 'FLASH' },
  { id: 'piyo', label: 'PIYO CHARGE' }
];
