/**
 * Gemini + Google Search grounding for chargers and tolls.
 * Numbers without a source URL are dropped. A second call only structures
 * the research text; it is not allowed to add facts.
 */

import { buildEnergyProfile, chargeWindows, pointAlong } from './route-model.js';
import { generateContent, generateSearch } from './gemini-api.js';

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

async function generate(apiKey, model, body) {
  if (body.tools) return generateSearch(apiKey, model, body, '調査失敗');
  const data = await generateContent(apiKey, model, body, { actionLabel: '調査失敗' });
  return { data, modelUsed: model, fallback: false, notice: '' };
}

function collectText(data) {
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
  if (!text) {
    const reason = data.promptFeedback?.blockReason || data.candidates?.[0]?.finishReason;
    throw new Error(reason ? `AIからの応答がありません（${reason}）` : 'AIからの応答が空です');
  }
  return text;
}

function collectSources(data) {
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const urls = [];
  for (const chunk of chunks) {
    if (chunk.web?.uri) urls.push(chunk.web.uri);
  }
  return [...new Set(urls)];
}

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSONが見つかりません');
  return JSON.parse(raw.slice(start, end + 1));
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
    const { data } = await generate(apiKey, model, body);
    return extractJson(collectText(data));
  } catch {
    const loose = await generate(apiKey, model, {
      contents: body.contents,
      generationConfig: { temperature: 0.1 }
    });
    return extractJson(collectText(loose.data));
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

export function normalizeToll(raw) {
  if (!raw) return null;
  const sources = (raw.sources || []).map(String).filter((u) => /^https?:\/\//i.test(u));
  const known = Boolean(raw.tollKnown) && sources.length > 0 && Number.isFinite(Number(raw.tollYen));
  return {
    routeId: String(raw.routeId || ''),
    tollKnown: known,
    tollYen: known ? Math.round(Number(raw.tollYen)) : null,
    note: String(raw.note || '').slice(0, 300),
    sources
  };
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

export async function researchRoutes(apiKey, model, routes, vehicle, appsLabel, datetimeLocal) {
  const blocks = routes.map((route) => {
    const profile = buildEnergyProfile(route, vehicle);
    const windows = chargeWindows(profile, vehicle);
    const spots = windows.length
      ? windows.map((w) => `約${w.km}km地点 (${w.lat ?? '?'}, ${w.lon ?? '?'})`).join('、')
      : '途中充電は不要そう。通過地の確認だけ';
    return `### routeId: ${route.key}
距離 ${route.distanceKm.toFixed(1)} km、運転 ${Math.round(route.durationSec / 60)} 分、高速比率 ${Math.round(route.highwayRatio * 100)}%、有料道路 ${route.hasToll ? 'あり' : 'なし'}
道路: ${route.roadSummary}
充電を探したい地点: ${spots}`;
  }).join('\n\n');

  const prompt = `${RESEARCH_RULES}

調査日: ${todayIso()}
出発日時: ${departureLabel(datetimeLocal)}
${vehicleBlurb(vehicle, appsLabel)}

各ルートの通行料金（往復ではなくこの片道。ETCの有無と出発日時を考慮）と、充電地点付近の急速充電器を調べてください。
routeId を必ず書いてください。1地点あたり最大3件、全体で20件まで。

${blocks}`;

  const searched = await generate(apiKey, model, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  });
  const text = collectText(searched.data);
  const grounding = collectSources(searched.data);
  const structured = await structureJson(apiKey, searched.modelUsed, ROUTE_SCHEMA, text, grounding);
  const checkedAt = todayIso();
  return {
    checkedAt,
    notes: structured.notes || '',
    researchText: text,
    grounding,
    modelUsed: searched.modelUsed,
    modelNotice: searched.notice || '',
    tolls: (structured.tolls || []).map(normalizeToll).filter(Boolean),
    chargers: (structured.chargers || []).map((c) => normalizeResearchedCharger(c, checkedAt)).filter(Boolean)
  };
}

export async function researchNearby(apiKey, model, query, vehicle, appsLabel, point) {
  const where = point
    ? `場所の目安: ${point.label}（緯度 ${point.lat.toFixed(4)}、経度 ${point.lon.toFixed(4)}）`
    : '地名として特定できていなくても、名称で検索してください。';
  const prompt = `${RESEARCH_RULES}

調査日: ${todayIso()}
${vehicleBlurb(vehicle, appsLabel)}

ユーザーの入力: 「${query}」
${where}

この充電器、またはこの場所からおおむね15km以内の急速充電器を最大6件調べてください。
入力が特定の充電器名なら、その充電器を最初に、料金が不明でも名称と運営区分は書いてください（単価は不明のまま）。
近くに代替があればそれも。`;

  const searched = await generate(apiKey, model, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }]
  });
  const text = collectText(searched.data);
  const grounding = collectSources(searched.data);
  const structured = await structureJson(apiKey, searched.modelUsed, NEARBY_SCHEMA, text, grounding);
  const checkedAt = todayIso();
  return {
    checkedAt,
    notes: structured.notes || '',
    researchText: text,
    grounding,
    modelUsed: searched.modelUsed,
    modelNotice: searched.notice || '',
    chargers: (structured.chargers || []).map((c) => normalizeResearchedCharger(c, checkedAt)).filter(Boolean)
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
    researchText: '',
    grounding: [],
    tolls,
    chargers
  };
}

export const APP_OPTIONS = [
  { id: 'emp', label: 'e-Mobility Power（アプリ・ビジター）' },
  { id: 'eneos', label: 'ENEOS Charge Plus' },
  { id: 'terra', label: 'Terra Charge' },
  { id: 'dmm', label: 'DMM EV ON' },
  { id: 'enechange', label: 'EV充電エネチェンジ' },
  { id: 'powerx', label: 'PowerX' },
  { id: 'nissan', label: '日産 ZESP3' }
];
