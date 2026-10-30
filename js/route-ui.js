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
  formatYen,
  buildEnergyProfile,
  googleDirectionsUrl,
  appleDirectionsUrl,
  distanceLabels
} from './route-model.js';
import { usableBatteryKwh } from './energy.js';
import { estimateAmbientC } from './climate.js';
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
  researchTollsAndStopPrices,
  buildDemoResearch,
  matchToll
} from './route-research.js';
import { renderNotice } from './notice.js';
import { describeNetError, mergeChargerPrices } from './charger-lookup.js';
import { areasForRoutes } from './charge-areas.js';
import { researchAreas } from './area-search.js';
import { loadChargerCatalog } from './charger-catalog.js';
import { loadTollTable, tollsForRoutes } from './toll-calc.js';
import { loadSpotCatalog, boundsOfRoutes } from './spot-catalog.js';

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
  const draft = readDraft();
  return {
    userPrices: getUserPrices(),
    researchCache: getResearchCache(),
    priceMaster: master,
    selectedApps: draft.apps,
    memberApps: draft.memberApps
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
    memberApps: [...document.querySelectorAll('#routeApps input[data-member]:checked')].map((el) => el.value),
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

function renderAppToggles(selected, members) {
  const box = $('routeApps');
  box.innerHTML = '';
  for (const app of APP_OPTIONS) {
    const label = document.createElement('label');
    label.className = 'toggle-item';
    const checked = selected.includes(app.id);
    const member = (members || []).includes(app.id);
    label.innerHTML = `<input type="checkbox" value="${app.id}" ${checked ? 'checked' : ''}><span>${escapeHtml(app.label)}</span><input type="checkbox" data-member value="${app.id}" ${member ? 'checked' : ''}><span>会員</span>`;
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
  renderAppToggles(Array.isArray(v.apps) ? v.apps : DEFAULTS.apps, v.memberApps || []);
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
  setVehicle({
    ...vehicleFrom(draft),
    origin: draft.origin,
    destination: draft.destination,
    apps: draft.apps,
    memberApps: draft.memberApps,
    appsOther: draft.appsOther
  });
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
  renderNotice(el, msg);
  show(el);
}

function setNearbyError(msg) {
  const el = $('nearbyError');
  if (!msg) {
    hide(el);
    el.textContent = '';
    return;
  }
  renderNotice(el, msg);
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
  return urls.map((url) => `<a class="src-ico" href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="出典">出典</a>`).join('');
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

function powerLabel(charger) {
  if (charger.powerKw != null) return `${escapeHtml(charger.powerKw)} kW`;
  if (charger.powerAssumed || charger.timeKw) return `${escapeHtml(charger.timeKw || 50)} kW（想定）`;
  return '不明';
}

function priceLine(stop) {
  const app = stop.chosenApp;
  const resolved = stop.resolved || {};
  const unit = formatUnitPrice(app ? { priceType: app.priceType, unitPrice: app.unitPrice } : resolved);
  const name = app?.label && app.label !== '保存' ? `${escapeHtml(app.label)} ` : '';
  const assumed = app?.assumed || resolved.assumed ? '（想定）' : '';
  const flat = (app?.priceType || resolved.priceType) === 'per_session' && unit !== '不明' ? ' <span class="unknown-tag">定額</span>' : '';
  const sources = sourceLinks(app?.sources || resolved.sources);
  const runner = stop.runnerUp
    ? `<br><span class="hint">次点 ${escapeHtml(stop.runnerUp.label)} ${escapeHtml(formatUnitPrice(stop.runnerUp))}${stop.runnerUp.assumed ? '（想定）' : ''}</span>`
    : '';
  return `${name}${escapeHtml(unit)}${assumed}${flat} ${sources}${runner}`;
}

function chargerBlock(charger, { minutes = null } = {}) {
  const map = mapLink(charger);
  const mins = minutes ?? charger.minutes;
  return `<article class="charger-block">
    <h3>${escapeHtml(charger.name || '名称不明')}${charger.fallback ? ' <span class="unknown-tag">地図</span>' : ''}</h3>
    <p class="hint">${escapeHtml(charger.address || '')}${map ? ` <a class="src-ico" href="${map}" target="_blank" rel="noopener" aria-label="地図">地図</a>` : ''}</p>
    <p>${powerLabel(charger)} · ${escapeHtml(charger.connector || 'コネクタ不明')} · ${priceLine(charger)}</p>
    <dl class="info-dl">
      <dt>充電時間</dt><dd>${mins == null ? '不明' : `約${mins}分`}</dd>
      ${charger.arrivalRangeKm != null ? `<dt>到着残</dt><dd>${Math.round(charger.arrivalRangeKm)} km（${Math.round(charger.arrivalSoc)}%）</dd>` : ''}
      <dt>営業時間</dt><dd>${hoursHtml(charger.hours, '')}</dd>
    </dl>
  </article>`;
}

function backupLine(b) {
  const resolved = b.resolved || resolveChargerPrice(b, priceContext());
  return `<p class="backup-item"><strong>${escapeHtml(b.name)}</strong> ${escapeHtml(b.address || '')}<br>
    ${escapeHtml(resolved.operatorLabel)} / ${escapeHtml(formatUnitPrice(resolved))} / ${b.powerKw != null ? `${escapeHtml(b.powerKw)} kW` : '出力不明'}
    ${resolved.caution ? `<br><span class="caution-inline">${escapeHtml(resolved.caution)}</span>` : ''}
  </p>`;
}

function patternCard(pattern, index, endpoints) {
  const toll = pattern.toll.tollYen == null
    ? '<span class="unknown-tag">不明</span>'
    : `${formatYen(pattern.toll.tollYen)}${pattern.toll.provisional ? '（想定）' : ''} ${sourceLinks(pattern.toll.sources)}`;
  const google = googleDirectionsUrl({
    origin: endpoints?.origin,
    destination: endpoints?.destination,
    stops: pattern.stops,
    avoidTolls: pattern.id === 'local'
  });
  const apple = appleDirectionsUrl({
    origin: endpoints?.origin,
    destination: endpoints?.destination,
    stops: pattern.stops
  });
  return `<details class="pattern-card" ${index === 0 ? 'open' : ''}>
    <summary>
      <span class="pattern-summary-row"><span>${escapeHtml(pattern.title)}${pattern.hot ? ' <span class="unknown-tag">高温注意</span>' : ''}</span><span class="pattern-metrics">${escapeHtml(pattern.distanceText || `${pattern.distanceKm.toFixed(0)} km`)} · 合計 ${pattern.totalYen == null ? '不明' : formatYen(pattern.totalYen)}</span></span>
      ${pattern.viaLine ? `<span class="pattern-via">${escapeHtml(pattern.viaLine)}</span>` : ''}
    </summary>
    <div class="pattern-body">
      <p class="map-links"><a class="btn btn-secondary btn-sm" href="${escapeHtml(google)}" target="_blank" rel="noopener">Googleマップ</a> <a class="btn btn-secondary btn-sm" href="${escapeHtml(apple)}" target="_blank" rel="noopener">Appleマップ</a></p>
      <dl class="info-dl">
        <dt>距離</dt><dd>${escapeHtml(pattern.distanceText || `${pattern.distanceKm.toFixed(0)} km`)}</dd>
        <dt>運転</dt><dd>${formatDuration(pattern.driveSec)}</dd>
        <dt>通行料金</dt><dd>${toll}</dd>
        <dt>充電料金</dt><dd>${pattern.chargeYen == null ? '不明' : formatYen(pattern.chargeYen)}</dd>
        <dt>充電時間</dt><dd>${pattern.chargeMinutes == null ? '不明' : formatDuration(pattern.chargeMinutes * 60)}</dd>
        ${(pattern.restMinutes || 0) > 0 ? `<dt>休憩</dt><dd>${formatDuration(pattern.restMinutes * 60)}</dd>` : ''}
        <dt>総時間</dt><dd>${pattern.totalTimeSec == null ? '不明' : formatDuration(pattern.totalTimeSec)}</dd>
        <dt>到着残</dt><dd>${pattern.arrivalKm == null ? '不足' : `${Math.round(pattern.arrivalKm)} km（${Math.round(pattern.arrivalSoc)}%）`}</dd>
        <dt>総費用</dt><dd>${pattern.totalYen == null ? '不明' : formatYen(pattern.totalYen)}</dd>
      </dl>
      ${pattern.stops.length ? pattern.stops.map((s) => chargerBlock(s, { minutes: s.minutes })).join('') : ''}
      ${pattern.unreachable ? '<p class="hint">不足</p>' : ''}
      ${otherCandidates(pattern)}
    </div>
  </details>`;
}

function otherCandidates(pattern) {
  const used = new Set(pattern.stops.map((s) => s.name));
  const pool = (pattern.candidates || []).filter((c) => !used.has(c.name));
  const alternates = pool.filter((c) => c.alternate);
  const extra = (alternates.length ? alternates : pool).slice(0, 2);
  const unplaced = extra.length >= 2 ? [] : (pattern.unplaced || []).slice(0, 2 - extra.length);
  if (!extra.length && !unplaced.length) return '';
  const count = extra.length + unplaced.length;
  return `<details class="nested-details">
    <summary>ほかの候補（${count}件）</summary>
    <div class="nested-details-body">
      ${extra.map((c) => chargerBlock(c)).join('')}
      ${unplaced.map((c) => chargerBlock({ ...c, address: `${c.address || ''}（${c.reason || 'ルートに重ねられず'}）` })).join('')}
    </div>
  </details>`;
}

function comparisonTable(patterns) {
  const costs = patterns.map((p) => p.totalYen).filter((n) => n != null);
  const times = patterns.map((p) => p.totalTimeSec).filter((n) => n != null);
  const minCost = costs.length ? Math.min(...costs) : null;
  const minTime = times.length ? Math.min(...times) : null;
  const labels = distanceLabels(patterns);
  patterns.forEach((pattern, index) => { pattern.distanceText = labels[index]; });
  const head = patterns.map((p) => `<th>${escapeHtml(p.title)}</th>`).join('');
  const row = (label, fn) => `<tr><th>${label}</th>${patterns.map((p) => `<td>${fn(p)}</td>`).join('')}</tr>`;
  return `<div class="table-scroll"><table class="compare-table">
    <thead><tr><th></th>${head}</tr></thead>
    <tbody>
      ${row('距離', (p) => escapeHtml(p.distanceText))}
      ${row('運転', (p) => formatDuration(p.driveSec))}
      ${row('充電時間', (p) => (p.chargeMinutes == null ? '不明' : formatDuration(p.chargeMinutes * 60)))}
      ${patterns.some((p) => (p.restMinutes || 0) > 0) ? row('休憩', (p) => ((p.restMinutes || 0) > 0 ? formatDuration(p.restMinutes * 60) : '—')) : ''}
      ${row('総時間', (p) => {
        const text = p.totalTimeSec == null ? '不明' : formatDuration(p.totalTimeSec);
        const mark = p.totalTimeSec != null && p.totalTimeSec === minTime ? ' class="best-cell"' : '';
        return `<span${mark}>${text}</span>`;
      })}
      ${row('通行料金', (p) => (p.toll.tollYen == null ? '不明' : `${formatYen(p.toll.tollYen)}${p.toll.provisional ? '（想定）' : ''}`))}
      ${row('充電料金', (p) => (p.chargeYen == null ? '不明' : formatYen(p.chargeYen)))}
      ${row('総費用', (p) => {
        const text = p.totalYen == null ? '不明' : formatYen(p.totalYen);
        const mark = p.totalYen != null && p.totalYen === minCost ? ' class="best-cell"' : '';
        return `<span${mark}>${text}</span>`;
      })}
      ${row('到着残', (p) => (p.arrivalKm == null ? '不足' : `${Math.round(p.arrivalKm)} km（${Math.round(p.arrivalSoc)}%）`))}
      ${row('充電回数', (p) => (p.unreachable ? '不足' : String(p.stops.length)))}
    </tbody>
  </table></div>`;
}

function researchExtras(bundle) {
  const { grounding, notes, researchText, debug } = bundle;
  const hasGrounding = grounding?.length > 0;
  const hasNotes = Boolean(notes);
  const hasDebug = Boolean(debug);
  const hasExtraText = Boolean(researchText && researchText !== debug?.rawText);
  if (!hasGrounding && !hasNotes && !hasDebug && !hasExtraText) return '';

  return `<details class="settings-section research-extras">
    <summary>調査の詳細</summary>
    <div class="settings-section-body">
      ${hasNotes ? `<p class="hint">${escapeHtml(notes)}</p>` : ''}
      ${hasGrounding ? `<p class="hint">参照ページ</p>${sourceLinks(grounding)}` : ''}
      ${hasDebug ? `
        <p class="hint">地図 ${debug.osmCount ?? 0} / 参照 ${debug.groundingCount ?? 0} / 読取 ${debug.parsedCount ?? 0} / 料金付 ${debug.pricedCount ?? 0} / 候補 ${debug.chargerCount ?? 0}</p>
        ${(debug.steps || []).length ? `<ul class="hint">${debug.steps.map((step) => `<li>${escapeHtml(step.name)}: ${step.ok ? '成功' : '失敗'} ${escapeHtml(step.detail || '')}</li>`).join('')}</ul>` : ''}
        <pre class="research-text">${escapeHtml(debug.rawText || '（モデルの本文なし）')}</pre>
      ` : ''}
      ${hasExtraText ? `<pre class="research-text">${escapeHtml(researchText)}</pre>` : ''}
    </div>
  </details>`;
}

function attributionBlock(attribution) {
  if (!attribution?.length) return '';
  const lines = attribution.map((item) => {
    const state = item.included ? '使用' : '未使用';
    return `<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.name)}</a>（${escapeHtml(item.license)}、${state}）${item.note ? ` ${escapeHtml(item.note)}` : ''}</li>`;
  }).join('');
  return `<div class="card"><h2>データの出典</h2><ul class="hint">${lines}</ul></div>`;
}

function renderComparison(bundle) {
  const { comparison, origin, destination, warning, vehicle, climate } = bundle;
  const usable = usableBatteryKwh(vehicle || {});
  const temp = climate?.c == null ? '' : ` · ${climate.c}°C`;
  const hot = (climate?.hot || climate?.extreme || comparison.patterns.some((p) => p.hot))
    ? ' <span class="unknown-tag">高温注意</span>'
    : '';
  $('routeResults').innerHTML = `
    ${warning ? '<div id="routeWarning" class="caution-box"></div>' : ''}
    <div class="card">
      <h2>${escapeHtml(origin.label)} → ${escapeHtml(destination.label)}</h2>
      <p class="hint">使える電池 ${escapeHtml(String(usable.usableKwh))} kWh${temp}${hot}</p>
      ${comparisonTable(comparison.patterns)}
    </div>
    ${comparison.patterns.map((pattern, index) => patternCard(pattern, index, { origin, destination })).join('')}
    ${researchExtras(bundle)}
  `;
  if (warning) renderNotice($('routeWarning'), warning);
}

function renderNearby(list, meta) {
  $('nearbyResults').innerHTML = `
    ${meta.modelNotice ? `<p class="hint">${escapeHtml(meta.modelNotice)}</p>` : ''}
    ${meta.warning ? '<div id="nearbyWarning" class="caution-box"></div>' : ''}
    ${meta.checkedAt ? `<p class="hint">調査日 ${escapeHtml(meta.checkedAt)}</p>` : ''}
    ${list.length ? list.map((c) => chargerBlock(c)).join('') : '<p class="hint">充電器を特定できませんでした。</p>'}
    ${meta.notes || meta.grounding?.length ? `<details class="settings-section research-extras">
      <summary>調査ログ（通常は不要）</summary>
      <div class="settings-section-body">
        ${meta.notes ? `<p class="hint">${escapeHtml(meta.notes)}</p>` : ''}
        ${meta.grounding?.length ? sourceLinks(meta.grounding) : ''}
      </div>
    </details>` : ''}
  `;
  if (meta.warning) renderNotice($('nearbyWarning'), meta.warning);
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
    const toll = matchToll(session.research.tolls || [], route);
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
    const depart = $('routeDepart').value;
    status('通行料金を料金表から計算しています');
    const tollTable = await loadTollTable();
    const tolls = tollsForRoutes(routes, tollTable, { departIso: depart, hasEtc: draft.hasEtc });
    if (mock) {
      status('サンプルの充電器を置いています');
      research = buildDemoResearch(routes, vehicle);
      research.tolls = tolls;
    } else {
      status('電池が少なくなる地点を見ています');
      const profiles = routes.map((route) => buildEnergyProfile(route, vehicle));
      const areas = areasForRoutes(routes, profiles, vehicle, depart);
      const spots = await loadSpotCatalog(boundsOfRoutes(routes));
      const covered = areas.filter((area) => spots.covers(area.lat, area.lon));
      const uncovered = areas.filter((area) => !spots.covers(area.lat, area.lon));
      const bundled = spots.spots;
      let live = { chargers: [], groundedCalls: 0, cachedAreas: 0, notes: '', researchText: '', modelNotice: '', grounding: [] };
      if (uncovered.length) {
        if (!apiKey || !modelId) {
          live.notes = '同梱データに無い地点は検索していません。';
        } else {
          live = await researchAreas({
            apiKey,
            model: modelId,
            areas: uncovered,
            vehicle,
            onStatus: status
          });
        }
      }
      const chargers = [...bundled, ...(live.chargers || [])];
      const steps = [
        {
          name: '充電が必要な地点',
          ok: true,
          detail: areas.length ? `${areas.length}か所（パターン間で近い地点は1回にまとめています）` : '途中充電は不要そうです'
        },
        {
          name: '同梱の充電スポット',
          ok: bundled.length > 0 || covered.length === 0,
          detail: `ルート沿い ${bundled.length}件 / 充電が必要な地点の近く ${covered.length}地点`
        },
        {
          name: '地点ごとの検索',
          ok: uncovered.length === 0 || (live.chargers || []).length > 0 || !apiKey,
          detail: uncovered.length ? `検索 ${live.groundedCalls || 0}回 / 対象外 ${uncovered.length}地点` : '同梱の範囲内のため検索していません'
        },
        {
          name: '通行料金',
          ok: true,
          detail: '同梱の料金表で計算しました'
        }
      ];
      research = {
        tolls,
        chargers,
        grounding: live.grounding || [],
        notes: live.notes || '',
        researchText: live.researchText || '',
        checkedAt: spots.updated || new Date().toISOString().slice(0, 10),
        modelNotice: live.modelNotice || '',
        emptyMessage: '',
        priceMessage: live.notes || '',
        tollMessage: '',
        attribution: [{
          name: 'EVsmart',
          license: 'スポットページ',
          url: 'https://www.evsmart.net/',
          included: bundled.length > 0,
          note: `事前取得 ${spots.count}件（${spots.updated}）`
        }],
        debug: {
          rawText: live.researchText || '',
          groundingCount: 0,
          osmCount: chargers.filter((charger) => charger.fallback).length,
          parsedCount: chargers.filter((charger) => charger.preferred).length,
          pricedCount: chargers.filter((charger) => (charger.appPrices || []).length).length,
          chargerCount: chargers.length,
          groundedCalls: live.groundedCalls || 0,
          parseNote: steps.map((step) => `${step.name}: ${step.ok ? '成功' : '失敗'} ${step.detail}`).join('\n'),
          steps
        }
      };
      const failed = chargers.length === 0 && areas.length > 0;
      warning = failed ? '充電器を特定できませんでした。' : '';
    }
    status('比較をまとめています');
    let sessionClimate = null;
    if (!mock) {
      const shape = routes[0]?.shape || [];
      const along = [0.25, 0.5, 0.75]
        .map((t) => shape[Math.min(shape.length - 1, Math.floor((shape.length - 1) * t))])
        .filter(Boolean);
      const climate = await estimateAmbientC([
        { lat: origin.lat, lon: origin.lon },
        ...along.map((p) => ({ lat: p[0], lon: p[1] })),
        { lat: destination.lat, lon: destination.lon }
      ], depart);
      vehicle.ambientC = climate.c;
      vehicle.highwayHeatC = climate.highwayC;
      sessionClimate = climate;
    }
    const items = routes.map((route) => {
      const chargers = (research.chargers || []).filter((c) => !c.routeId || c.routeId === route.key);
      const toll = matchToll(research.tolls || [], route);
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
      modelNotice: research.modelNotice || '',
      demo: Boolean(research.demo),
      grounding: research.grounding || [],
      notes: research.notes || '',
      researchText: research.researchText || '',
      debug: research.debug || null,
      attribution: research.attribution || null,
      climate: sessionClimate
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
  const btn = $('nearbyBtn');
  btn.disabled = true;
  show($('nearbyLoading'));
    $('nearbyStatus').textContent = '同梱データから近くの充電器を探しています';
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
    const spots = await loadSpotCatalog(point
      ? { south: point.lat, north: point.lat, west: point.lon, east: point.lon }
      : null);
    const catalog = await loadChargerCatalog();
    const q = query.toLowerCase();
    const fromSpots = point
      ? spots.near(point.lat, point.lon, 15).slice(0, 12)
      : spots.spots.filter((row) => `${row.name} ${row.address}`.toLowerCase().includes(q)).slice(0, 12);
    const fromOsm = point ? catalog.near(point.lat, point.lon, 15).slice(0, 12) : catalog.search(query);
    const nearbyFound = fromSpots.length ? fromSpots : fromOsm;
    let research = {
      chargers: nearbyFound,
      emptyMessage: nearbyFound.length ? '' : '同梱データに、この場所の充電器がありませんでした。',
      priceMessage: '',
      modelNotice: '',
      checkedAt: fromSpots.length ? spots.updated : catalog.updated,
      notes: '',
      grounding: []
    };
    const needsLive = !fromSpots.length && nearbyFound.length > 0 && apiKey && modelId;
    if (needsLive) {
      try {
        const priced = await researchTollsAndStopPrices(
          apiKey,
          modelId,
          [],
          nearbyFound.slice(0, 6),
          vehicleFrom(draft),
          appsLabel(draft),
          '',
          (text) => { $('nearbyStatus').textContent = text; }
        );
        research.chargers = mergeChargerPrices(nearbyFound, priced.priced).slice(0, nearbyFound.length);
        research.priceMessage = priced.priceMessage || '';
        research.modelNotice = priced.modelNotice || '';
        research.grounding = priced.grounding || [];
      } catch (err) {
        research.priceMessage = describeNetError(err, '料金検索');
      }
    }
    rememberResearch(research.chargers);
    const chargers = research.chargers.map((c) => ({
      ...c,
      resolved: resolveChargerPrice(c, priceContext())
    }));
    nearbySession = {
      raw: research.chargers,
      chargers,
      warning: research.emptyMessage || research.priceMessage || '',
      modelNotice: research.modelNotice || '',
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
      $('routeTripCard').classList.toggle('hidden', nearby);
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
