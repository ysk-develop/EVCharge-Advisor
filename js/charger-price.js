/**
 * Per-charger price resolution.
 * User-confirmed prices win. AI research is next. The price master and the
 * published eMP visitor table are fallbacks, and they are never applied to
 * partner chargers (dealer etc.).
 */

export const EMP_VISITOR_FEE_URL = 'https://www.e-mobipower.co.jp/visitor-fee/';

export const PARTNER_CAUTION = '提携充電器のため料金は充電器ごと。ディーラー等は1回定額（例: 2,970円/回）の場合あり。アプリでQRを読んで単価を確認';

const EMP_TABLE_PER_MIN = new Set([55, 77, 99, 121]);
const EMP_TABLE_PER_KWH = new Set([110, 143]);

const PRICE_TYPE_LABEL = {
  per_min: '分課金',
  per_kwh: 'kWh課金',
  per_session: '1回定額',
  unknown: '不明'
};

const OPERATOR_LABEL = {
  emp_operated: 'eMP自社',
  emp_partner: 'eMP提携',
  other: 'その他事業者',
  unknown: '運営不明'
};

export function normalizeChargerName(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s　・,，.。/／\-‐−_()（）【】\[\]]/g, '');
}

export function sameCharger(a, b) {
  const na = normalizeChargerName(a?.name);
  const nb = normalizeChargerName(b?.name);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return shorter.length >= 8 && longer.includes(shorter);
}

const DEALER_RE = /日産.{0,16}(販売|店)|トヨタ.{0,16}(販売|店|カローラ)|ホンダカーズ|ホンダ.{0,10}(販売|店)|三菱.{0,10}(販売|店)|マツダ.{0,8}(販売|店)|スバル.{0,8}店|ダイハツ|ディーラー|自動車販売|販売店|提携充電/;

export function classifyOperator(charger) {
  const ai = charger?.operatorClass;
  const blob = `${charger?.name || ''} ${charger?.operatorName || ''} ${charger?.network || ''}`;
  const dealer = DEALER_RE.test(blob);
  if (dealer || ai === 'emp_partner') return 'emp_partner';
  if (ai === 'emp_operated' || ai === 'other' || ai === 'unknown') return ai;
  if (/e-?mobility\s*power|イーエムピー|eモビリティ|^emp$|ｅｍｐ/i.test(blob)) return 'emp_operated';
  return 'unknown';
}

export function operatorLabel(cls) {
  return OPERATOR_LABEL[cls] || OPERATOR_LABEL.unknown;
}

export function priceTypeLabel(type) {
  return PRICE_TYPE_LABEL[type] || PRICE_TYPE_LABEL.unknown;
}

function bandLabel(powerKw) {
  if (powerKw <= 50) return '50kW以下';
  if (powerKw <= 100) return '50kW超〜100kW以下';
  return '100kW超';
}

export function empVisitorPerMin(powerKw, locationType) {
  if (powerKw == null || !Number.isFinite(Number(powerKw))) return null;
  if (locationType !== 'highway' && locationType !== 'general') return null;
  const kw = Number(powerKw);
  const highway = locationType === 'highway';
  let unitPrice;
  if (kw <= 50) unitPrice = highway ? 77 : 55;
  else if (kw <= 100) unitPrice = highway ? 99 : 77;
  else unitPrice = highway ? 121 : 99;
  return {
    priceType: 'per_min',
    unitPrice,
    priceNote: `${highway ? '高速SA/PA' : '一般道'}・${bandLabel(kw)}の公示ビジター料金（分課金）`
  };
}

function isGenericEmpTablePrice(priceType, unitPrice) {
  const n = Number(unitPrice);
  if (!Number.isFinite(n)) return false;
  if (priceType === 'per_min' && EMP_TABLE_PER_MIN.has(n)) return true;
  if (priceType === 'per_kwh' && EMP_TABLE_PER_KWH.has(n)) return true;
  return false;
}

function httpSources(list) {
  return (list || []).filter((u) => /^https?:\/\//i.test(String(u)));
}

export function findUserPrice(charger, userPrices) {
  return (userPrices || []).find((row) => sameCharger(row, charger)) || null;
}

function findCached(charger, cache) {
  return (cache || []).find((row) => sameCharger(row, charger)) || null;
}

function matchMasterService(charger, priceMaster) {
  if (!priceMaster?.services) return null;
  const blob = `${charger.operatorName || ''} ${charger.name || ''} ${charger.apps || ''}`;
  const norm = blob.toLowerCase();
  for (const svc of priceMaster.services) {
    if (svc.id === 'emp') continue;
    const names = [svc.name, ...(svc.aliases || [])];
    if (names.some((n) => n && norm.includes(String(n).toLowerCase()))) return svc;
  }
  return null;
}

function masterPlan(service, powerKw) {
  const plans = (service.plans || []).filter((p) => p && p.price > 0 && (p.type === 'DC' || !p.type));
  if (!plans.length) return null;
  const perMin = plans.filter((p) => p.unit === 'JPY/min');
  const pool = perMin.length ? perMin : plans;
  if (powerKw != null) {
    const withPower = pool.filter((p) => p.powerKw != null);
    if (withPower.length) {
      withPower.sort((a, b) => Math.abs(a.powerKw - powerKw) - Math.abs(b.powerKw - powerKw));
      return withPower[0];
    }
  }
  return pool.slice().sort((a, b) => a.price - b.price)[0];
}

function fromAi(ai, operatorClass) {
  if (!ai || !ai.priceKnown) return null;
  const sources = httpSources(ai.sources);
  if (!sources.length || ai.unitPrice == null || !Number.isFinite(Number(ai.unitPrice))) return null;
  const priceType = ai.priceType || 'unknown';
  if (priceType === 'unknown') return null;
  if (operatorClass === 'emp_partner' && isGenericEmpTablePrice(priceType, ai.unitPrice)) {
    return null;
  }
  return {
    priceType,
    unitPrice: Number(ai.unitPrice),
    sources,
    priceNote: ai.priceNote || '',
    hours: ai.hours || '',
    hoursConflict: ai.hoursConflict || '',
    checkedAt: ai.checkedAt || null
  };
}

/**
 * @param {object} charger - name, address, powerKw, locationType, operatorClass, operatorName, apps, ai
 * @param {object} ctx - userPrices, researchCache, priceMaster
 */
export function resolveChargerPrice(charger, ctx = {}) {
  const operatorClass = classifyOperator(charger);
  const operatorName = charger.operatorName || '';
  const base = {
    operatorClass,
    operatorName,
    operatorLabel: operatorLabel(operatorClass),
    hours: charger.hours || charger.ai?.hours || '',
    hoursConflict: charger.hoursConflict || charger.ai?.hoursConflict || '',
    warnings: [],
    caution: null,
    provisional: false,
    confirmed: false,
    sources: [],
    checkedAt: null,
    priceType: 'unknown',
    unitPrice: null,
    priceNote: '',
    label: '不明'
  };

  const user = findUserPrice(charger, ctx.userPrices);
  if (user && user.unitPrice != null && user.priceType && user.priceType !== 'unknown') {
    return {
      ...base,
      source: 'user',
      priceType: user.priceType,
      unitPrice: Number(user.unitPrice),
      confirmed: true,
      provisional: false,
      checkedAt: (user.savedAt || '').slice(0, 10) || null,
      priceNote: user.note || '',
      label: 'この端末で保存した確認料金',
      caution: operatorClass === 'emp_partner'
        ? '提携充電器です。表示中の料金は、この端末に保存した確認値です。'
        : null
    };
  }

  const ai = fromAi(charger.ai, operatorClass);
  if (ai) {
    const demo = Boolean(charger.demo);
    return {
      ...base,
      source: demo ? 'demo' : 'ai',
      ...ai,
      hours: ai.hours || base.hours,
      hoursConflict: ai.hoursConflict || base.hoursConflict,
      confirmed: !demo,
      provisional: demo,
      label: demo ? 'サンプル（実料金ではない）' : 'AIのWeb調査（出典あり）',
      caution: operatorClass === 'emp_partner' ? PARTNER_CAUTION : null,
      warnings: operatorClass === 'emp_partner'
        ? ['提携充電器の料金は店舗ごとに違います。出典の金額でも、出発前にアプリのQR表示を見てください。']
        : []
    };
  }

  const cached = fromAi(findCached(charger, ctx.researchCache), operatorClass);
  if (cached) {
    return {
      ...base,
      source: 'cache',
      ...cached,
      hours: cached.hours || base.hours,
      hoursConflict: cached.hoursConflict || base.hoursConflict,
      confirmed: false,
      provisional: true,
      label: '以前のAI調査キャッシュ',
      caution: operatorClass === 'emp_partner' ? PARTNER_CAUTION : null
    };
  }

  if (operatorClass === 'emp_operated') {
    const band = empVisitorPerMin(charger.powerKw, charger.locationType);
    if (band) {
      return {
        ...base,
        source: 'emp_table',
        priceType: band.priceType,
        unitPrice: band.unitPrice,
        provisional: true,
        confirmed: false,
        sources: [EMP_VISITOR_FEE_URL],
        priceNote: band.priceNote,
        label: 'eMP公示ビジター料金での試算',
        caution: null,
        warnings: [
          'eMP自社充電器向けの公示分課金です。kWh課金の機械は別料金（一般道110円/kWh、高速143円/kWh）です。この充電器の課金方式は未確認なので、試算として扱ってください。',
          '最大30分などの制限があります。公式ページで最新額を確認してください。'
        ]
      };
    }
    return {
      ...base,
      source: 'unknown',
      sources: [EMP_VISITOR_FEE_URL],
      label: '不明',
      priceNote: '出力または一般道/高速が不明なため、公示料金表の帯を特定できません。',
      caution: 'eMP自社機でも出力・場所・分課金かkWh課金かで単価が違います。特定できないため不明です。',
      warnings: ['一般道の分課金目安: 50kW以下55円、〜100kW 77円、100kW超99円。高速は77/99/121円。kWh課金は110/143円。出典: eMPビジター料金。']
    };
  }

  if (operatorClass === 'emp_partner') {
    return {
      ...base,
      source: 'unknown',
      label: '不明',
      caution: PARTNER_CAUTION,
      warnings: ['eMPの標準料金（55円/分など）は提携充電器には当てはめていません。']
    };
  }

  const service = matchMasterService(charger, ctx.priceMaster);
  const plan = service ? masterPlan(service, charger.powerKw) : null;
  if (plan) {
    const priceType = plan.unit === 'JPY/kWh' ? 'per_kwh' : plan.unit === 'JPY/min' ? 'per_min' : 'unknown';
    return {
      ...base,
      source: 'master',
      priceType,
      unitPrice: plan.price,
      provisional: true,
      confirmed: false,
      priceNote: plan.note || '',
      checkedAt: ctx.priceMaster?.updatedAt || null,
      label: `料金マスターの参考値（${service.name}）`,
      caution: 'この充電器個別の確認ではありません。料金マスターのサービス一律の参考値です。',
      warnings: []
    };
  }

  return {
    ...base,
    source: 'unknown',
    label: '不明',
    caution: operatorClass === 'unknown' ? PARTNER_CAUTION : 'この充電器の料金は確認できませんでした（不明）。標準料金表は当てはめていません。'
  };
}

export function estimateSessionCost(resolved, minutes, kwhAdded) {
  if (!resolved || resolved.priceType === 'unknown') return null;
  if (resolved.priceType === 'free') return 0;
  if (resolved.unitPrice == null) return null;
  if (resolved.priceType === 'per_min') {
    if (minutes == null) return null;
    return Math.round(resolved.unitPrice * minutes);
  }
  if (resolved.priceType === 'per_kwh') {
    if (kwhAdded == null) return null;
    return Math.round(resolved.unitPrice * kwhAdded);
  }
  if (resolved.priceType === 'per_session') return Math.round(resolved.unitPrice);
  return null;
}

export function effectiveYenPerMin(resolved, minutes, kwhAdded) {
  if (!resolved || resolved.unitPrice == null) return null;
  if (resolved.priceType === 'per_min') return resolved.unitPrice;
  if (resolved.priceType === 'per_session' && minutes > 0) return resolved.unitPrice / minutes;
  if (resolved.priceType === 'per_kwh' && minutes > 0 && kwhAdded > 0) {
    return (resolved.unitPrice * kwhAdded) / minutes;
  }
  return null;
}

export function formatUnitPrice(resolved) {
  if (resolved?.priceType === 'free') return '無料';
  if (!resolved || resolved.unitPrice == null || resolved.priceType === 'unknown') return '不明';
  const n = Number.isInteger(resolved.unitPrice)
    ? String(resolved.unitPrice)
    : String(Math.round(resolved.unitPrice * 10) / 10);
  if (resolved.priceType === 'per_min') return `${n}円/分`;
  if (resolved.priceType === 'per_kwh') return `${n}円/kWh`;
  if (resolved.priceType === 'per_session') return `${n}円/回`;
  return '不明';
}

export function priceWarnings(resolved, minutes) {
  const warnings = [...(resolved?.warnings || [])];
  if (
    minutes > 30
    && resolved?.operatorClass === 'emp_operated'
    && resolved?.priceType === 'per_min'
  ) {
    warnings.push(`eMPのビジター利用は最大30分の場合があります。この充電は約${minutes}分の計画なので、1回では終わらない可能性があります。超えた分の料金は不明です。`);
  }
  if (resolved?.priceType === 'per_session' && resolved.unitPrice != null && minutes > 0) {
    const eff = Math.round(resolved.unitPrice / minutes);
    warnings.push(`1回定額のため、短い充電では割高です。予定${minutes}分だと実質約${eff}円/分です。`);
  }
  return warnings;
}

export function toAiShape(resolved) {
  if (!resolved || resolved.unitPrice == null || resolved.priceType === 'unknown') return null;
  return {
    priceKnown: true,
    priceType: resolved.priceType,
    unitPrice: resolved.unitPrice,
    sources: resolved.sources || [],
    priceNote: resolved.priceNote || '',
    hours: resolved.hours || '',
    hoursConflict: resolved.hoursConflict || '',
    checkedAt: resolved.checkedAt || null,
    operatorClass: resolved.operatorClass
  };
}
