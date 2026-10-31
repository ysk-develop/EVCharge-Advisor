/**
 * Usable apps and per-app prices.
 * Order for each app: saved price, then a price on the charger's EVsmart /
 * GoGoEV page, then (only if that page has no price) the eMP visitor table
 * or the price master, tagged 想定. Non-member prices unless the user is a member.
 */
import { empVisitorPerMin, estimateSessionCost, findUserPrice } from './charger-price.js';

export const APP_CATALOG = [
  { id: 'emp', masterId: 'emp', label: 'eMP' },
  { id: 'eneos', masterId: 'eneos-charge-plus', label: 'ENEOS' },
  { id: 'terra', masterId: 'terra-charge', label: 'Terra' },
  { id: 'dmm', masterId: 'dmm-ev-on', label: 'DMM' },
  { id: 'enechange', masterId: 'ev-enechange', label: 'エネチェンジ' },
  { id: 'powerx', masterId: 'powerx', label: 'PowerX' },
  { id: 'nissan', masterId: 'nissan-zesp', label: 'ZESP3' },
  { id: 'flash', masterId: '', label: 'FLASH' },
  { id: 'piyo', masterId: '', label: 'PIYO' },
  { id: 'direct', masterId: '', label: 'カード/QR' }
];

const APP_MATCH = [
  ['eneos', /eneos|エネオス|eneke/i],
  ['terra', /terra\s*charge|テラチャージ/i],
  ['dmm', /dmm/i],
  ['enechange', /エネチェンジ|enechange/i],
  ['powerx', /power\s*x|パワーエックス/i],
  ['nissan', /zesp/i],
  ['flash', /\bflash\b|フラッシュ/i],
  ['piyo', /piyo|ピヨ/i],
  ['emp', /e-?mobility\s*power|イーモビリティ|(^|[^a-z])emp([^a-z]|$)|ｅｍｐ|empスポット/i]
];

export function appLabel(appId) {
  return APP_CATALOG.find((app) => app.id === appId)?.label || appId || '';
}

export function normalizeAppId(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (APP_CATALOG.some((app) => app.id === text)) return text;
  const hit = APP_MATCH.find(([, re]) => re.test(text));
  return hit ? hit[0] : '';
}

function pushApp(list, appId, source, evidence) {
  if (!appId) return;
  if (list.some((row) => row.appId === appId)) return;
  list.push({ appId, source: source || '', evidence: evidence || '' });
}

export function extractSpotFacts(text, sourceUrl = '') {
  const raw = String(text || '');
  const empSpot = /eMPスポット/.test(raw);
  const authSystems = [];
  for (const match of raw.matchAll(/認証システム\s*[:：]\s*([^\n。]+)/g)) {
    authSystems.push(...match[1].split(/[、,／/]/).map((part) => part.trim()).filter(Boolean));
  }
  const appPrices = [];
  const directPay = /認証不要/.test(raw)
    || /クレジットカード|二次元コード|QRコード|ＱＲコード/.test(raw);
  const sessionMatch = raw.match(/1回\s*(\d{1,3})\s*分/);
  const sessionMaxMin = sessionMatch ? Number(sessionMatch[1]) : null;
  const addPrice = (appId, member, priceType, unitPrice) => {
    const amount = Number(unitPrice);
    if (!appId || !Number.isFinite(amount) || amount < 0) return;
    if (amount === 0 && priceType !== 'free') return;
    const exists = appPrices.some((row) => row.appId === appId && row.member === member && row.priceType === priceType && row.unitPrice === amount);
    if (exists) return;
    const row = { appId, member, priceType, unitPrice: amount, source: sourceUrl };
    if (sessionMaxMin) row.sessionMaxMin = sessionMaxMin;
    appPrices.push(row);
  };
  const chunks = raw.matchAll(/(ENEOS Charge Plus|ENEOS|エネオス|Terra Charge|テラチャージ|DMM EV CHARGE|DMM|エネチェンジ|PowerX|FLASH|PIYO CHARGE|PIYO|ZESP3|eMP)([^。\n]{0,80})/gi);
  for (const chunk of chunks) {
    const appId = normalizeAppId(chunk[1]);
    if (!appId) continue;
    const body = chunk[2];
    const add = (member, amount, unit) => {
      const priceType = unit === 'kWh' ? 'per_kwh' : unit === '回' ? 'per_session' : 'per_min';
      addPrice(appId, member, priceType, amount);
    };
    const member = body.match(/(?:^|[^非])会員\s*(\d+(?:\.\d+)?)\s*円\s*\/\s*(分|kWh|回)/);
    const nonMember = body.match(/非会員\s*(\d+(?:\.\d+)?)\s*円\s*\/\s*(分|kWh|回)/);
    if (member) add(true, member[1], member[2]);
    if (nonMember) add(false, nonMember[1], nonMember[2]);
    if (!member && !nonMember) {
      const plain = body.match(/(\d+(?:\.\d+)?)\s*円\s*\/\s*(分|kWh|回)/);
      if (plain) add(null, plain[1], plain[2]);
    }
    const colon = body.match(/[:：]\s*1分\s*\/\s*(\d+(?:\.\d+)?)円\s*[（(]\s*(会員|非会員)/);
    if (colon) addPrice(appId, colon[2] === '会員', 'per_min', colon[1]);
  }
  for (const colon of raw.matchAll(/([^\n:：]{2,40})[:：]\s*1分\s*\/\s*(\d+(?:\.\d+)?)円\s*[（(]\s*(会員|非会員)/g)) {
    addPrice(normalizeAppId(colon[1]), colon[3] === '会員', 'per_min', colon[2]);
  }
  const namedAuth = [...new Set(authSystems.map((name) => normalizeAppId(name)).filter(Boolean))];
  const bareApp = empSpot ? 'emp' : (namedAuth.length === 1 ? namedAuth[0] : '');
  if (bareApp) {
    for (const row of raw.matchAll(/1分(?:あたり)?\s*(\d+(?:\.\d+)?)円/g)) addPrice(bareApp, false, 'per_min', row[1]);
    for (const row of raw.matchAll(/(?:充電\s*)?(\d+(?:\.\d+)?)円\s*\/\s*kWh/g)) addPrice(bareApp, false, 'per_kwh', row[1]);
    for (const row of raw.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,5})\s*円\s*\/\s*(?:回|30分)/g)) {
      addPrice(bareApp, false, 'per_session', row[1].replace(/,/g, ''));
    }
  }
  if (directPay) {
    for (const row of raw.matchAll(/(\d+(?:\.\d+)?)\s*円\s*\/\s*(kWh|分|回)/g)) {
      const priceType = row[2] === 'kWh' ? 'per_kwh' : row[2] === '回' ? 'per_session' : 'per_min';
      const amount = Number(row[1]);
      const ownedByApp = appPrices.some((price) => price.appId !== 'direct' && price.priceType === priceType && price.unitPrice === amount);
      if (!ownedByApp) addPrice('direct', null, priceType, amount);
    }
    const chargeFree = /(?:充電|急速|利用)(?:料金)?(?:は|が)?無料|無料で(?:充電|利用)/.test(raw);
    if (chargeFree && !appPrices.some((price) => price.appId === 'direct' && price.unitPrice > 0)) {
      addPrice('direct', null, 'free', 0);
    }
  }
  const usableApps = [];
  if (empSpot && !directPay) {
    pushApp(usableApps, 'emp', sourceUrl, 'eMPスポット');
    pushApp(usableApps, 'nissan', sourceUrl, 'eMPスポット');
  }
  for (const name of authSystems) pushApp(usableApps, normalizeAppId(name), sourceUrl, `認証システム:${name}`);
  for (const price of appPrices) {
    pushApp(usableApps, price.appId, price.source, price.appId === 'direct' ? '認証不要・カード/QR' : 'ページの料金');
  }
  return { empSpot: empSpot && !directPay, authSystems, usableApps, appPrices, directPay, sessionMaxMin };
}

/** eMPの公示単価は、ページが eMP スポットだと明記しているときだけ使う。 */
export function allowsEmpVisitorAssumption(charger = {}) {
  if (!charger.empSpot) return false;
  if (charger.operatorClass === 'emp_partner') return false;
  if (charger.directPay) return false;
  if ((charger.usableApps || []).some((row) => (row.appId || row) === 'direct')) return false;
  if ((charger.appPrices || []).some((row) => row.appId === 'direct')) return false;
  const blob = [
    charger.name,
    charger.operatorName,
    charger.network,
    ...(charger.authSystems || []),
    ...(charger.usableApps || []).map((row) => `${row.appId || ''} ${row.evidence || ''}`)
  ].join(' ');
  if (/認証不要/.test(blob)) return false;
  if (/e-?OASIS|PowerX|パワーエックス|Terra\s*Charge|テラチャージ|テスラ|Tesla/i.test(blob)) return false;
  return true;
}

export function usableAppsFromText(text, source = '') {
  const list = [];
  const blob = String(text || '');
  for (const [appId, re] of APP_MATCH) {
    if (re.test(blob)) pushApp(list, appId, source, '運営・ネットワーク');
  }
  if (list.some((row) => row.appId === 'emp')) pushApp(list, 'nissan', source, 'eMPネットワーク');
  return list;
}

export function collectUsableApps(charger) {
  const list = [];
  const source = (charger.appPrices || []).find((row) => row.source)?.source
    || (charger.usableApps || []).find((row) => row.source)?.source
    || '';
  if (charger.empSpot) {
    pushApp(list, 'emp', source, 'eMPスポット');
    pushApp(list, 'nissan', source, 'eMPスポット');
  }
  for (const name of charger.authSystems || []) {
    pushApp(list, normalizeAppId(name), source, `認証システム:${name}`);
  }
  for (const row of charger.usableApps || []) {
    pushApp(list, normalizeAppId(row.appId || row), row.source || source, row.evidence || '');
  }
  for (const row of charger.appPrices || []) pushApp(list, row.appId, row.source || source, 'ページの料金');
  if (!list.length) {
    for (const row of usableAppsFromText(`${charger.operatorName || ''} ${charger.network || ''} ${charger.name || ''}`, 'osm')) {
      pushApp(list, row.appId, row.source, row.evidence);
    }
  }
  return list;
}

function priceTypeOf(unit) {
  if (unit === 'JPY/kWh') return 'per_kwh';
  if (unit === 'JPY/min') return 'per_min';
  return 'unknown';
}

function masterPlan(service, powerKw, isMember) {
  let plans = (service?.plans || []).filter((plan) => plan && plan.price > 0 && (plan.type === 'DC' || !plan.type));
  if (!plans.length) return null;
  const non = plans.filter((plan) => /非会員|ビジター/.test(plan.note || ''));
  const mem = plans.filter((plan) => /会員/.test(plan.note || '') && !/非会員/.test(plan.note || ''));
  if (!isMember && non.length) plans = non;
  if (isMember && mem.length) plans = mem;
  const perMin = plans.filter((plan) => plan.unit === 'JPY/min');
  const pool = perMin.length ? perMin : plans;
  if (powerKw != null) {
    const withPower = pool.filter((plan) => plan.powerKw != null);
    if (withPower.length) {
      withPower.sort((a, b) => Math.abs(a.powerKw - powerKw) - Math.abs(b.powerKw - powerKw));
      return withPower[0];
    }
  }
  return pool.slice().sort((a, b) => a.price - b.price)[0];
}

function pagePrice(charger, appId, isMember) {
  const rows = (charger.appPrices || []).filter((row) => row.appId === appId && Number.isFinite(Number(row.unitPrice)) && row.source);
  if (!rows.length) return null;
  return rows.find((row) => row.member === isMember)
    || rows.find((row) => row.member == null)
    || rows.find((row) => row.member === false && !isMember)
    || null;
}

function legacyPagePrice(charger) {
  const ai = charger.ai;
  if (!ai?.priceKnown || ai.unitPrice == null || !(ai.sources || []).length) return null;
  const appId = normalizeAppId(ai.appId) || (charger.operatorClass === 'emp_operated' ? 'emp' : '');
  return {
    appId,
    member: null,
    priceType: ai.priceType,
    unitPrice: Number(ai.unitPrice),
    source: ai.sources[0]
  };
}

function assumedPrice(charger, appId, ctx, isMember) {
  if (appId === 'emp' && allowsEmpVisitorAssumption(charger) && charger.operatorClass !== 'emp_partner') {
    const band = empVisitorPerMin(charger.powerKw, charger.locationType);
    if (!band) return null;
    return {
      priceType: band.priceType,
      unitPrice: band.unitPrice,
      source: 'https://www.e-mobipower.co.jp/visitor-fee/'
    };
  }
  const masterId = APP_CATALOG.find((app) => app.id === appId)?.masterId;
  const service = (ctx.priceMaster?.services || []).find((row) => row.id === masterId);
  const plan = masterPlan(service, charger.powerKw, isMember);
  if (!plan) return null;
  return {
    priceType: priceTypeOf(plan.unit),
    unitPrice: plan.price,
    source: ''
  };
}

export function quoteApps(charger, ctx = {}, usage = {}) {
  const minutes = usage.minutes;
  const kwhAdded = usage.kwhAdded;
  const saved = typeof findUserPrice === 'function' ? findUserPrice(charger, ctx.userPrices) : null;
  if (saved && saved.unitPrice != null && saved.priceType && saved.priceType !== 'unknown') {
    const costYen = estimateSessionCost(saved, minutes, kwhAdded);
    const chosen = {
      appId: normalizeAppId(saved.appId) || '',
      label: '保存',
      priceType: saved.priceType,
      unitPrice: Number(saved.unitPrice),
      costYen,
      assumed: false,
      sources: []
    };
    return { options: [chosen], chosen, runnerUp: null };
  }
  const usable = collectUsableApps(charger);
  const selected = ctx.selectedApps?.length ? [...ctx.selectedApps] : usable.map((row) => row.appId);
  if (usable.some((row) => row.appId === 'direct') && !selected.includes('direct')) selected.push('direct');
  const members = new Set(ctx.memberApps || []);
  const legacy = legacyPagePrice(charger);
  const options = [];
  for (const appId of selected) {
    if (!usable.some((row) => row.appId === appId) && legacy?.appId !== appId) continue;
    const isMember = members.has(appId);
    const page = pagePrice(charger, appId, isMember) || (legacy?.appId === appId ? legacy : null);
    if (page) {
      const costYen = estimateSessionCost(page, minutes, kwhAdded);
      options.push({
        appId,
        label: appLabel(appId),
        priceType: page.priceType,
        unitPrice: Number(page.unitPrice),
        costYen,
        assumed: false,
        sources: page.source ? [page.source] : []
      });
      continue;
    }
    const assumed = assumedPrice(charger, appId, ctx, isMember);
    if (assumed) {
      options.push({
        appId,
        label: appLabel(appId),
        priceType: assumed.priceType,
        unitPrice: assumed.unitPrice,
        costYen: estimateSessionCost(assumed, minutes, kwhAdded),
        assumed: true,
        sources: assumed.source ? [assumed.source] : []
      });
    }
  }
  if (!options.length && legacy && !ctx.selectedApps?.length) {
    options.push({
      appId: legacy.appId,
      label: legacy.appId ? appLabel(legacy.appId) : 'ページ',
      priceType: legacy.priceType,
      unitPrice: Number(legacy.unitPrice),
      costYen: estimateSessionCost(legacy, minutes, kwhAdded),
      assumed: false,
      sources: [legacy.source]
    });
  }
  const known = options.filter((row) => row.costYen != null).sort((a, b) => a.costYen - b.costYen);
  return { options, chosen: known[0] || null, runnerUp: known[1] || null };
}
