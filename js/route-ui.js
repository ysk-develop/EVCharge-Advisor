import { geocode } from './geo.js';
import {
  getApiKey, setApiKey, getModel, getPriceMaster, getVehicle, setVehicle,
  getUserPrices, setUserPrices, getResearchCache, setResearchCache
} from './storage.js';
import { getDefaultPriceMaster } from './price-master.js';
import {
  parseValhallaTrip,
  prepareRouteItem,
  assembleComparison,
  formatDuration,
  formatYen
} from './route-model.js';
import {
  resolveChargerPrice,
  formatUnitPrice,
  priceTypeLabel,
  effectiveYenPerMin,
  estimateSessionCost,
  sameCharger
} from './charger-price.js';
import {
  APP_OPTIONS,
  researchRoutes,
  researchNearby,
  buildDemoResearch
} from './route-research.js';

const VALHALLA = 'https://valhalla1.openstreetmap.de/route';

const DEFAULTS = {
  socPercent: 80,
  batteryKwh: 40,
  efficiencyKmPerKwh: 6.5,
  conservativeRangeKm: 220,
  maxDcKw: 50,
  connector: 'CHAdeMO',
  safetyMarginKm: 25,
  hasEtc: true,
  apps: ['emp', 'eneos', 'terra'],
  appsOther: '',
  origin: '',
  destination: ''
};

let session = null;
let nearbySession = null;

function $(id) {
  return document.getElementById(id);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    return null;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function priceContext() {
  const master = getPriceMaster() || getDefaultPriceMaster();
  return {
    userPrices: getUserPrices(),
    researchCache: getResearchCache(),
    priceMaster: master
  };
}

function num(id) {
  return Number($(id).value);
}

function readDraft() {
  const apps = [...document.querySelectorAll('#routeApps input:checked')].map((el) => el.value);
  return {
    origin: $('routeOrigin').value.trim(),
    destination: $('routeDest').value.trim(),
    socPercent: num('routeSoc'),
    batteryKwh: num('routeBattery'),
    efficiencyKmPerKwh: num('routeEfficiency'),
    conservativeRangeKm: num('routeRange'),
    maxDcKw: num('routeMaxKw'),
    connector: $('routeConnector').value,
    safetyMarginKm: num('routeMargin'),
    hasEtc: $('routeEtc').checked,
    apps,
    appsOther: $('routeAppsOther').value.trim()
  };
}

function vehicleFrom(draft) {
  return {
    socPercent: draft.socPercent,
    batteryKwh: draft.batteryKwh,
    efficiencyKmPerKwh: draft.efficiencyKmPerKwh,
    conservativeRangeKm: draft.conservativeRangeKm,
    maxDcKw: draft.maxDcKw,
    connector: draft.connector,
    safetyMarginKm: draft.safetyMarginKm,
    hasEtc: draft.hasEtc,
    apps: draft.apps,
    appsOther: draft.appsOther
  };
}

function appsLabel(draft) {
  const names = APP_OPTIONS.filter((a) => draft.apps.includes(a.id)).map((a) => a.label);
  if (draft.appsOther) names.push(draft.appsOther);
  return names.join('、');
}

function validate(draft, { needTrip }) {
  const v = vehicleFrom(draft);
  if (!(v.socPercent > 0 && v.socPercent <= 100)) return '出発時の充電量は1〜100%です';
  if (!(v.batteryKwh > 0)) return '電池容量を入力してください';
  if (!(v.efficiencyKmPerKwh > 0)) return '電費を入力してください';
  if (!(v.conservativeRangeKm > 0)) return '保守的な満充電航続を入力してください';
  if (!(v.maxDcKw > 0)) return '最大受入kWを入力してください';
  if (!(v.safetyMarginKm >= 0)) return '残す距離を入力してください';
  if (needTrip) {
    if (!draft.origin || !draft.destination) return '出発地と目的地を入力してください';
    if (draft.origin === draft.destination) return '出発地と目的地が同じです';
    if (!$('routeDepart').value) return '出発日時を入力してください';
  }
  return '';
}

function renderAppToggles(selected) {
  const box = $('routeApps');
  box.innerHTML = '';
  for (const app of APP_OPTIONS) {
    const label = document.createElement('label');
    label.className = 'toggle-item';
    const checked = selected.includes(app.id);
    label.innerHTML = `<input type="checkbox" value="${app.id}" ${checked ? 'checked' : ''}><span>${escapeHtml(app.label)}</span>`;
    box.appendChild(label);
  }
}

function fillForm(saved) {
  const v = { ...DEFAULTS, ...(saved || {}) };
  $('routeOrigin').value = v.origin || '';
  $('routeDest').value = v.destination || '';
  $('routeSoc').value = v.socPercent;
  $('routeBattery').value = v.batteryKwh;
  $('routeEfficiency').value = v.efficiencyKmPerKwh;
  $('routeRange').value = v.conservativeRangeKm;
  $('routeMaxKw').value = v.maxDcKw;
  $('routeConnector').value = v.connector || 'CHAdeMO';
  $('routeMargin').value = v.safetyMarginKm ?? 25;
  $('routeEtc').checked = v.hasEtc !== false;
  $('routeAppsOther').value = v.appsOther || '';
  renderAppToggles(Array.isArray(v.apps) ? v.apps : DEFAULTS.apps);
  if (!$('routeDepart').value) {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    $('routeDepart').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  }
}

function persistDraft() {
  const draft = readDraft();
  setVehicle({ ...vehicleFrom(draft), origin: draft.origin, destination: draft.destination });
}

function currentApi() {
  const typed = ($('apiKeyInput')?.value || '').trim();
  const apiKey = typed || getApiKey();
  const modelId = $('modelSelect')?.value || getModel();
  if ($('saveApiKey')?.checked && typed) setApiKey(typed);
  return { apiKey, modelId };
}

function setRouteError(msg) {
  const el = $('routeError');
  if (!msg) {
    hide(el);
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  show(el);
}

function setNearbyError(msg) {
  const el = $('nearbyError');
  if (!msg) {
    hide(el);
    el.textContent = '';
    return;
  }
  el.textContent = msg;
  show(el);
}

async function fetchValhalla(origin, dest, options, alternates) {
  const body = {
    locations: [
      { lat: origin.lat, lon: origin.lon },
      { lat: dest.lat, lon: dest.lon }
    ],
    costing: 'auto',
    costing_options: { auto: options },
    units: 'kilometers',
    language: 'ja-JP',
    elevation_interval: 1000
  };
  if (alternates) body.alternates = alternates;
  const res = await fetch(VALHALLA, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text.slice(0, 160) || `ルート計算に失敗 (${res.status})`);
  }
  return res.json();
}

function collectTrips(data, requestKey) {
  const trips = [];
  if (data.trip) trips.push(data.trip);
  for (const alt of data.alternates || []) {
    if (alt.trip) trips.push(alt.trip);
  }
  return trips.map((trip, index) => parseValhallaTrip(trip, {
    key: index === 0 ? requestKey : `${requestKey}-alt-${index}`,
    requestKey
  }));
}

async function fetchRoutePool(origin, dest, onStatus) {
  const jobs = [
    { requestKey: 'fast', alternates: 2, options: { use_highways: 1, use_tolls: 1 } },
    { requestKey: 'local', alternates: 0, options: { use_highways: 0, use_tolls: 0, use_ferry: 0.1 } },
    { requestKey: 'mixed', alternates: 1, options: { use_highways: 0.45, use_tolls: 0.3 } }
  ];
  const settled = await Promise.allSettled(jobs.map((job) => fetchValhalla(origin, dest, job.options, job.alternates)));
  const routes = [];
  const problems = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      routes.push(...collectTrips(result.value, jobs[i].requestKey));
    } else {
      problems.push(result.reason?.message || '失敗');
    }
  });
  if (!routes.length) {
    throw new Error(`ルートを計算できませんでした。${problems[0] || ''}`);
  }
  if (problems.length) onStatus(`一部のルートは計算できませんでした（${problems.length}件）。取れたルートで比較します。`);
  return routes;
}

async function fillMissingPoints(chargers, onStatus) {
  let looked = 0;
  for (const charger of chargers) {
    if (charger.lat != null || looked >= 5) continue;
    const query = charger.address || charger.name;
    if (!query) continue;
    looked += 1;
    onStatus(`充電器の位置を確認しています（${charger.name}）`);
    if (looked > 1) await sleep(1100);
    try {
      const hit = await geocode(query);
      charger.lat = hit.lat;
      charger.lon = hit.lon;
    } catch {
      // 座標が無いまま候補一覧に残す
    }
  }
}

function rememberResearch(chargers) {
  const cache = getResearchCache();
  let next = cache.slice();
  for (const charger of chargers) {
    if (charger.demo || !charger.ai?.priceKnown) continue;
    next = next.filter((row) => !sameCharger(row, charger));
    next.unshift({
      name: charger.name,
      address: charger.address,
      operatorClass: charger.operatorClass,
      operatorName: charger.operatorName,
      ...charger.ai
    });
  }
  setResearchCache(next);
}

function sourceLinks(sources) {
  const urls = (sources || []).map(safeUrl).filter(Boolean);
  if (!urls.length) return '';
  return `<ul class="source-list">${urls.map((u) => `<li><a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></li>`).join('')}</ul>`;
}

function hoursHtml(hours, conflict) {
  if (!hours && !conflict) return '<span class="unknown-tag">不明</span>';
  let html = escapeHtml(hours || '不明');
  if (conflict) html += `<br><span class="hours-conflict">別の情報: ${escapeHtml(conflict)}</span>`;
  return html;
}

function mapLink(charger) {
  if (charger.lat != null && charger.lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${charger.lat},${charger.lon}`;
  }
  const q = `${charger.name || ''} ${charger.address || ''}`.trim();
  if (!q) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

function priceBits(resolved, minutes, kwhAdded) {
  const unit = formatUnitPrice(resolved);
  const session = estimateSessionCost(resolved, minutes, kwhAdded);
  const effective = effectiveYenPerMin(resolved, minutes, kwhAdded);
  const effectiveText = effective == null
    ? ''
    : `実質約${Math.round(effective)}円/分${resolved.priceType === 'per_min' ? '' : '（予定時間で換算）'}`;
  return { unit, session, effectiveText };
}

function savePriceForm(name, address) {
  return `<details class="user-price-form">
    <summary>アプリで見た料金を保存</summary>
    <div class="plan-row-grid">
      <select data-field="type">
        <option value="per_min">円/分</option>
        <option value="per_kwh">円/kWh</option>
        <option value="per_session">円/回</option>
      </select>
      <input data-field="amount" inputmode="decimal" placeholder="金額">
    </div>
    <button type="button" class="btn btn-secondary btn-sm" data-action="save-price" data-name="${escapeHtml(name)}" data-address="${escapeHtml(address || '')}">この端末に保存</button>
  </details>`;
}

function chargerBlock(charger, { minutes = null, kwhAdded = null, heading = '' } = {}) {
  const resolved = charger.resolved || resolveChargerPrice(charger, priceContext());
  const bits = priceBits(resolved, minutes, kwhAdded);
  const warnings = [...(charger.warnings || resolved.warnings || [])];
  const plannedMin = minutes ?? charger.minutes;
  if (resolved.priceType === 'per_session' && resolved.unitPrice != null && !(plannedMin > 0)) {
    warnings.push('1回定額です。短い充電でもこの金額になります。');
  }
  const map = mapLink(charger);
  const checked = resolved.checkedAt ? `確認日 ${escapeHtml(resolved.checkedAt)}` : '';
  return `<article class="charger-block">
    ${heading ? `<p class="charger-kicker">${heading}</p>` : ''}
    <h3>${escapeHtml(charger.name || '名称不明')}</h3>
    <p class="hint">${escapeHtml(charger.address || '住所不明')}${map ? ` · <a href="${map}" target="_blank" rel="noopener">地図</a>` : ''}</p>
    <p><span class="op-badge op-${escapeHtml(resolved.operatorClass)}">${escapeHtml(resolved.operatorLabel)}</span>
      <span class="op-badge">${escapeHtml(priceTypeLabel(resolved.priceType))}</span></p>
    ${resolved.caution ? `<p class="caution-box">${escapeHtml(resolved.caution)}</p>` : ''}
    <dl class="info-dl">
      <dt>単価</dt><dd>${escapeHtml(bits.unit)}${resolved.provisional ? ' <span class="unknown-tag">（試算・参考）</span>' : ''}</dd>
      <dt>料金の出どころ</dt><dd>${escapeHtml(resolved.label)}${checked ? `<br>${checked}` : ''}</dd>
      ${charger.km != null ? `<dt>累計距離</dt><dd>${charger.km.toFixed(1)} km${charger.offKm != null ? `（ルートから約${charger.offKm.toFixed(1)} km）` : ''}</dd>` : ''}
      ${charger.arrivalRangeKm != null ? `<dt>到着時の推定残航続</dt><dd>約${Math.round(charger.arrivalRangeKm)} km（SOC ${charger.arrivalSoc != null ? Math.round(charger.arrivalSoc) : '—'}%）</dd>` : ''}
      <dt>出力</dt><dd>${charger.powerKw != null ? `${escapeHtml(charger.powerKw)} kW` : '<span class="unknown-tag">不明</span>'}</dd>
      <dt>アプリ・支払い</dt><dd>${escapeHtml(charger.apps || resolved.operatorName || '不明')}</dd>
      <dt>営業時間</dt><dd>${hoursHtml(charger.hours || resolved.hours, charger.hoursConflict || resolved.hoursConflict)}</dd>
      ${minutes != null || charger.minutes != null ? `<dt>充電時間の目安</dt><dd>${(minutes ?? charger.minutes) == null ? '<span class="unknown-tag">不明</span>' : `約${minutes ?? charger.minutes}分`}</dd>` : ''}
      ${kwhAdded != null || charger.kwhAdded != null ? `<dt>充電量の目安</dt><dd>${((kwhAdded ?? charger.kwhAdded) == null) ? '不明' : `約${(kwhAdded ?? charger.kwhAdded).toFixed(1)} kWh`}</dd>` : ''}
      <dt>この充電の費用</dt><dd>${bits.session == null ? '<span class="unknown-tag">不明</span>' : `約${bits.session.toLocaleString('ja-JP')}円`}${bits.effectiveText ? `<br><span class="sub">${escapeHtml(bits.effectiveText)}</span>` : ''}</dd>
    </dl>
    ${resolved.priceNote ? `<p class="hint">${escapeHtml(resolved.priceNote)}</p>` : ''}
    ${warnings.map((w) => `<p class="warning-text">${escapeHtml(w)}</p>`).join('')}
    ${sourceLinks(resolved.sources)}
    ${savePriceForm(charger.name, charger.address)}
    ${charger.backups?.length ? `<div class="backup-list"><p class="hint">代わりに寄れる候補</p>${charger.backups.map((b) => backupLine(b)).join('')}</div>` : ''}
  </article>`;
}

function backupLine(b) {
  const resolved = b.resolved || resolveChargerPrice(b, priceContext());
  return `<p class="backup-item"><strong>${escapeHtml(b.name)}</strong> ${escapeHtml(b.address || '')}<br>
    ${escapeHtml(resolved.operatorLabel)} / ${escapeHtml(formatUnitPrice(resolved))} / ${b.powerKw != null ? `${escapeHtml(b.powerKw)} kW` : '出力不明'}
    ${resolved.caution ? `<br><span class="caution-inline">${escapeHtml(resolved.caution)}</span>` : ''}
  </p>`;
}

function patternCard(pattern, index) {
  const toll = pattern.toll.tollYen == null ? '<span class="unknown-tag">不明</span>' : `${formatYen(pattern.toll.tollYen)}${pattern.toll.note ? `<br><span class="hint">${escapeHtml(pattern.toll.note)}</span>` : ''}`;
  const ferry = pattern.hasFerry ? '<p class="warning-text">フェリーを含む可能性があります。乗船中の充電は見ていません。</p>' : '';
  const stuck = pattern.unreachable ? `<p class="caution-box">${escapeHtml(pattern.unreachable.message)} 到達できそうなのは出発から約${pattern.unreachable.km.toFixed(0)} kmまでです。</p>` : '';
  const scaleNote = pattern.scale > 1.05
    ? '入力した電費より保守航続の方が厳しいため、消費を保守航続に合わせて引き上げています。'
    : '';
  return `<details class="pattern-card" ${index === 0 ? 'open' : ''}>
    <summary>
      <span>${escapeHtml(pattern.title)}</span>
      <span class="pattern-metrics">${pattern.distanceKm.toFixed(0)} km · 合計 ${pattern.totalYen == null ? '不明' : formatYen(pattern.totalYen)}</span>
    </summary>
    <div class="pattern-body">
      <p>${escapeHtml(pattern.blurb)}</p>
      <p class="road-summary">${escapeHtml(pattern.roadSummary)}</p>
      ${ferry}
      <dl class="info-dl">
        <dt>距離</dt><dd>${pattern.distanceKm.toFixed(1)} km（高速区間の目安 ${Math.round(pattern.highwayRatio * 100)}%）</dd>
        <dt>運転時間</dt><dd>${formatDuration(pattern.driveSec)}</dd>
        <dt>通行料金</dt><dd>${toll}</dd>
        <dt>充電料金</dt><dd>${pattern.chargeYen == null ? '<span class="unknown-tag">不明</span>' : formatYen(pattern.chargeYen)}${pattern.provisional ? ' <span class="unknown-tag">試算・参考を含む</span>' : ''}</dd>
        <dt>充電時間</dt><dd>${pattern.chargeMinutes == null ? '<span class="unknown-tag">不明</span>' : formatDuration(pattern.chargeMinutes * 60)}</dd>
        <dt>総所要時間</dt><dd>${pattern.totalTimeSec == null ? '<span class="unknown-tag">不明</span>' : formatDuration(pattern.totalTimeSec)}</dd>
        <dt>総費用</dt><dd>${pattern.totalYen == null ? '<span class="unknown-tag">不明</span>' : formatYen(pattern.totalYen)}</dd>
      </dl>
      <p class="hint">標高は推定です。上り合計 ${Math.round(pattern.gainM)} m、下り ${Math.round(pattern.lossM)} m。推定消費 ${pattern.totalKwh.toFixed(1)} kWh（平均 ${pattern.avgKmPerKwh.toFixed(1)} km/kWh）。高速は速度が高い分だけ消費を増やし、下りは位置エネルギーの一部だけを回生で戻しています。${escapeHtml(scaleNote)}</p>
      ${stuck}
      ${pattern.toll.sources?.length ? `<p class="hint">通行料金の出典</p>${sourceLinks(pattern.toll.sources)}` : ''}
      <h3 class="rank-title">充電ストップ</h3>
      ${pattern.stops.length ? pattern.stops.map((s) => chargerBlock(s, { minutes: s.minutes, kwhAdded: s.kwhAdded })).join('') : '<p class="hint">途中充電なし、または充電器を特定できませんでした。</p>'}
      ${otherCandidates(pattern)}
    </div>
  </details>`;
}

function otherCandidates(pattern) {
  const used = new Set(pattern.stops.map((s) => s.name));
  const extra = (pattern.candidates || []).filter((c) => !used.has(c.name)).slice(0, 3);
  const unplaced = (pattern.unplaced || []).slice(0, 3);
  if (!extra.length && !unplaced.length) return '';
  return `<h3 class="rank-title">ほかの候補</h3>
    ${extra.map((c) => chargerBlock(c)).join('')}
    ${unplaced.map((c) => chargerBlock({ ...c, address: `${c.address || ''}（${c.reason || 'ルートに重ねられず'}）` })).join('')}`;
}

function comparisonTable(patterns) {
  const costs = patterns.map((p) => p.totalYen).filter((n) => n != null);
  const times = patterns.map((p) => p.totalTimeSec).filter((n) => n != null);
  const minCost = costs.length ? Math.min(...costs) : null;
  const minTime = times.length ? Math.min(...times) : null;
  const head = patterns.map((p) => `<th>${escapeHtml(p.title)}</th>`).join('');
  const row = (label, fn) => `<tr><th>${label}</th>${patterns.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`;
  return `<div class="table-scroll"><table class="compare-table">
    <thead><tr><th></th>${head}</tr></thead>
    <tbody>
      ${row('距離', (p) => `${p.distanceKm.toFixed(0)} km`)}
      ${row('運転', (p) => formatDuration(p.driveSec))}
      ${row('充電時間', (p) => (p.chargeMinutes == null ? '不明' : formatDuration(p.chargeMinutes * 60)))}
      ${row('総時間', (p) => {
        const text = p.totalTimeSec == null ? '不明' : formatDuration(p.totalTimeSec);
        const mark = p.totalTimeSec != null && p.totalTimeSec === minTime ? ' class="best-cell"' : '';
        return `<span${mark}>${text}</span>`;
      })}
      ${row('通行料金', (p) => (p.toll.tollYen == null ? '不明' : formatYen(p.toll.tollYen)))}
      ${row('充電料金', (p) => (p.chargeYen == null ? '不明' : formatYen(p.chargeYen)))}
      ${row('総費用', (p) => {
        const text = p.totalYen == null ? '不明' : formatYen(p.totalYen);
        const mark = p.totalYen != null && p.totalYen === minCost ? ' class="best-cell"' : '';
        return `<span${mark}>${text}</span>`;
      })}
      ${row('充電回数', (p) => (p.unreachable ? '不足' : String(p.stops.length)))}
    </tbody>
  </table></div>`;
}

function renderComparison(bundle) {
  const { comparison, origin, destination, warning, demo, grounding, notes, researchText } = bundle;
  const banner = demo
    ? '<p class="caution-box">サンプル表示です。ルートと標高は実データ、充電器と料金は実在の調査ではありません。URLに mock=1 が付いているときだけこうなります。</p>'
    : '<p class="warning-text">距離・時間・標高はValhalla（OpenStreetMap）の推定です。充電器料金と通行料金はAIのWeb調査による参考値で、出典のない数値は出していません。必ず公式と現地のアプリで確認してください。</p>';
  $('routeResults').innerHTML = `
    ${banner}
    ${warning ? `<p class="caution-box">${escapeHtml(warning)}</p>` : ''}
    <div class="card">
      <h2>${escapeHtml(origin.label)} → ${escapeHtml(destination.label)}</h2>
      <p class="hint">意図と違う場所なら、市区町村まで入れてもう一度比較してください。</p>
      <div class="recommendation"><h3>まとめ</h3><p>${escapeHtml(comparison.recommendation)}</p></div>
      ${comparisonTable(comparison.patterns)}
    </div>
    ${comparison.patterns.map(patternCard).join('')}
    ${notes ? `<div class="card"><h2>調査メモの補足</h2><p>${escapeHtml(notes)}</p></div>` : ''}
    ${grounding?.length ? `<div class="card"><h2>検索で参照したページ</h2>${sourceLinks(grounding)}</div>` : ''}
    ${researchText ? `<details class="settings-section"><summary>調査メモ原文</summary><div class="settings-section-body"><pre class="research-text">${escapeHtml(researchText)}</pre></div></details>` : ''}
  `;
}

function renderNearby(list, meta) {
  const banner = '<p class="warning-text">AIのWeb調査による参考値です。出典のない単価は不明にしています。eMP提携（ディーラー等）に標準の円/分は当てはめていません。アプリのQRで確認してください。</p>';
  $('nearbyResults').innerHTML = `
    ${banner}
    ${meta.warning ? `<p class="caution-box">${escapeHtml(meta.warning)}</p>` : ''}
    ${meta.checkedAt ? `<p class="hint">調査日 ${escapeHtml(meta.checkedAt)}</p>` : ''}
    ${list.length ? list.map((c) => chargerBlock(c)).join('') : '<p class="hint">充電器を特定できませんでした。</p>'}
    ${meta.notes ? `<div class="card"><h2>補足</h2><p>${escapeHtml(meta.notes)}</p></div>` : ''}
    ${meta.grounding?.length ? `<div class="card"><h2>検索で参照したページ</h2>${sourceLinks(meta.grounding)}</div>` : ''}
  `;
}

function renderUserPriceList() {
  const host = $('userPriceList');
  if (!host) return;
  const rows = getUserPrices();
  if (!rows.length) {
    host.innerHTML = '<p class="hint">まだありません。</p>';
    return;
  }
  host.innerHTML = rows.map((row) => `<div class="backup-item">
    <strong>${escapeHtml(row.name)}</strong>
    <span class="hint">${escapeHtml(formatUnitPrice(row))} · ${escapeHtml((row.savedAt || '').slice(0, 10))}</span>
    <button type="button" class="btn btn-danger-outline btn-sm" data-action="delete-price" data-id="${escapeHtml(row.id)}">削除</button>
  </div>`).join('');
}

function saveUserPrice(name, address, priceType, unitPrice) {
  const amount = Number(unitPrice);
  if (!name || !priceType || !(amount > 0)) {
    throw new Error('料金の種類と、0より大きい金額を入力してください');
  }
  const entry = {
    id: `up_${Date.now().toString(36)}`,
    name,
    address,
    priceType,
    unitPrice: amount,
    savedAt: new Date().toISOString()
  };
  const next = getUserPrices().filter((row) => !sameCharger(row, entry));
  next.unshift(entry);
  setUserPrices(next);
  renderUserPriceList();
}

function repriceSession() {
  if (!session) return;
  const items = session.routes.map((route) => {
    const chargers = (session.research.chargers || []).filter((c) => !c.routeId || c.routeId === route.key);
    const toll = (session.research.tolls || []).find((t) => t.routeId === route.key) || null;
    return prepareRouteItem(route, session.vehicle, chargers, toll, priceContext());
  });
  session.comparison = assembleComparison(items);
  renderComparison(session);
  if (nearbySession) {
    nearbySession.chargers = nearbySession.raw.map((c) => ({
      ...c,
      resolved: resolveChargerPrice(c, priceContext())
    }));
    renderNearby(nearbySession.chargers, nearbySession);
  }
}

async function runCompare() {
  setRouteError('');
  const draft = readDraft();
  const problem = validate(draft, { needTrip: true });
  if (problem) {
    setRouteError(problem);
    return;
  }
  persistDraft();
  const vehicle = vehicleFrom(draft);
  const mock = new URLSearchParams(location.search).has('mock');
  const { apiKey, modelId } = currentApi();
  if (!mock && !apiKey) {
    setRouteError('設定タブでGemini APIキーを入力してください');
    return;
  }
  if (!mock && !modelId) {
    setRouteError('設定タブでモデルを選んでください');
    return;
  }

  const btn = $('routeCompareBtn');
  btn.disabled = true;
  show($('routeLoading'));
  const status = (text) => { $('routeStatus').textContent = text; };
  try {
    status('住所を検索しています');
    const [origin, destination] = await Promise.all([geocode(draft.origin), geocode(draft.destination)]);
    status('ルートと標高を計算しています');
    const routes = await fetchRoutePool(origin, destination, status);
    let research;
    let warning = '';
    if (mock) {
      status('サンプルの充電器を置いています');
      research = buildDemoResearch(routes, vehicle);
    } else {
      status('充電器と通行料金を調査しています（数十秒かかることがあります）');
      try {
        research = await researchRoutes(apiKey, modelId, routes, vehicle, appsLabel(draft), $('routeDepart').value);
        await fillMissingPoints(research.chargers, status);
        rememberResearch(research.chargers);
      } catch (err) {
        warning = `料金のWeb調査に失敗しました。ルートは表示しますが、単価は保存済み・料金マスター・不明です。${err.message}`;
        research = { tolls: [], chargers: [], grounding: [], notes: '', researchText: '', checkedAt: '' };
      }
    }
    status('比較をまとめています');
    const items = routes.map((route) => {
      const chargers = (research.chargers || []).filter((c) => !c.routeId || c.routeId === route.key);
      const toll = (research.tolls || []).find((t) => t.routeId === route.key) || null;
      return prepareRouteItem(route, vehicle, chargers, toll, priceContext());
    });
    const comparison = assembleComparison(items);
    session = {
      routes,
      research,
      vehicle,
      comparison,
      origin,
      destination,
      warning,
      demo: Boolean(research.demo),
      grounding: research.grounding || [],
      notes: research.notes || '',
      researchText: research.researchText || ''
    };
    renderComparison(session);
  } catch (err) {
    setRouteError(err.message || String(err));
  } finally {
    hide($('routeLoading'));
    btn.disabled = false;
  }
}

async function runNearby() {
  setNearbyError('');
  const draft = readDraft();
  const problem = validate(draft, { needTrip: false });
  if (problem) {
    setNearbyError(problem);
    return;
  }
  const query = $('nearbyQuery').value.trim();
  if (!query) {
    setNearbyError('充電器名か場所を入力してください');
    return;
  }
  persistDraft();
  const mock = new URLSearchParams(location.search).has('mock');
  const { apiKey, modelId } = currentApi();
  if (!mock && !apiKey) {
    setNearbyError('設定タブでGemini APIキーを入力してください');
    return;
  }
  const btn = $('nearbyBtn');
  btn.disabled = true;
  show($('nearbyLoading'));
  $('nearbyStatus').textContent = '調査しています（数十秒かかることがあります）';
  try {
    if (mock) {
      const sample = {
        name: query,
        address: 'サンプル',
        operatorClass: /販売|店|ディーラー/.test(query) ? 'emp_partner' : 'unknown',
        operatorName: query,
        powerKw: 90,
        locationType: 'general',
        hours: '要確認（サンプル）',
        hoursConflict: '',
        apps: 'e-Mobility Power',
        demo: true,
        ai: /販売|店|ディーラー/.test(query)
          ? {
            priceKnown: true,
            priceType: 'per_session',
            unitPrice: 2970,
            sources: ['https://example.com/demo-not-a-real-price'],
            priceNote: 'サンプル。1回定額の例',
            checkedAt: new Date().toISOString().slice(0, 10)
          }
          : { priceKnown: false, priceType: 'unknown', unitPrice: null, sources: [], checkedAt: new Date().toISOString().slice(0, 10) }
      };
      const resolved = resolveChargerPrice(sample, priceContext());
      nearbySession = {
        raw: [sample],
        chargers: [{ ...sample, resolved }],
        warning: 'サンプル表示です。Geminiは呼んでいません。',
        checkedAt: resolved.checkedAt,
        notes: '',
        grounding: []
      };
      renderNearby(nearbySession.chargers, nearbySession);
      return;
    }
    let point = null;
    try {
      point = await geocode(query);
    } catch {
      point = null;
    }
    const research = await researchNearby(apiKey, modelId, query, vehicleFrom(draft), appsLabel(draft), point);
    rememberResearch(research.chargers);
    const chargers = research.chargers.map((c) => ({
      ...c,
      resolved: resolveChargerPrice(c, priceContext())
    }));
    nearbySession = {
      raw: research.chargers,
      chargers,
      warning: '',
      checkedAt: research.checkedAt,
      notes: research.notes,
      grounding: research.grounding
    };
    renderNearby(chargers, nearbySession);
  } catch (err) {
    setNearbyError(err.message || String(err));
  } finally {
    hide($('nearbyLoading'));
    btn.disabled = false;
  }
}

function onResultsClick(event) {
  const save = event.target.closest('[data-action="save-price"]');
  if (save) {
    const box = save.closest('.user-price-form');
    const priceType = box.querySelector('[data-field="type"]').value;
    const amount = box.querySelector('[data-field="amount"]').value;
    try {
      saveUserPrice(save.dataset.name, save.dataset.address, priceType, amount);
      repriceSession();
      setRouteError('');
    } catch (err) {
      showActiveError(err.message);
    }
    return;
  }
  const del = event.target.closest('[data-action="delete-price"]');
  if (del) {
    setUserPrices(getUserPrices().filter((row) => row.id !== del.dataset.id));
    renderUserPriceList();
    repriceSession();
  }
}

function showActiveError(msg) {
  const nearby = !$('routeNearbyPane').classList.contains('hidden');
  if (nearby) setNearbyError(msg);
  else setRouteError(msg);
}

function initSubtabs() {
  document.querySelectorAll('.subtab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.subtab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      const nearby = tab.dataset.sub === 'nearby';
      $('routeComparePane').classList.toggle('hidden', nearby);
      $('routeNearbyPane').classList.toggle('hidden', !nearby);
    });
  });
}

export function initRouteUI() {
  fillForm(getVehicle());
  renderUserPriceList();
  initSubtabs();
  $('routeCompareBtn').addEventListener('click', () => { runCompare(); });
  $('nearbyBtn').addEventListener('click', () => { runNearby(); });
  $('routeResults').addEventListener('click', onResultsClick);
  $('nearbyResults').addEventListener('click', onResultsClick);
  $('userPriceList').addEventListener('click', onResultsClick);
  const persist = () => persistDraft();
  ['routeOrigin', 'routeDest', 'routeSoc', 'routeBattery', 'routeEfficiency', 'routeRange', 'routeMaxKw', 'routeMargin', 'routeAppsOther'].forEach((id) => {
    $(id).addEventListener('change', persist);
  });
  $('routeConnector').addEventListener('change', persist);
  $('routeEtc').addEventListener('change', persist);
  $('routeApps').addEventListener('change', persist);
}
