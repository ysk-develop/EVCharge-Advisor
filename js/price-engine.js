/**
 * Price comparison engine - deterministic, no AI
 */

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\s　・/／\-_]/g, '');
}

function matchService(detectedName, service) {
  const norm = normalizeText(detectedName);
  if (normalizeText(service.name) === norm) return true;
  return service.aliases.some((alias) => {
    const a = normalizeText(alias);
    return norm.includes(a) || a.includes(norm);
  });
}

function findBestPlan(service, powerKw, location) {
  const plans = service.plans || [];
  if (plans.length === 0) return null;

  const dcPlans = plans.filter((p) => p.type === 'DC' || !p.type);
  const candidates = dcPlans.length > 0 ? dcPlans : plans;

  let matched = candidates;
  if (location && location !== 'unknown') {
    const locMatched = candidates.filter((p) => !p.location || p.location === location);
    if (locMatched.length > 0) matched = locMatched;
  }

  if (powerKw != null) {
    const withPower = matched.filter((p) => p.powerKw != null);
    if (withPower.length > 0) {
      matched = withPower.sort((a, b) => {
        const diffA = Math.abs(a.powerKw - powerKw);
        const diffB = Math.abs(b.powerKw - powerKw);
        return diffA - diffB;
      });
    }
  }

  const validPrice = (p) => p.price != null && p.price > 0;
  const perMin = matched.filter((p) => p.unit === 'JPY/min' && validPrice(p));
  const perKwh = matched.filter((p) => p.unit === 'JPY/kWh' && validPrice(p));

  const bestMin = perMin.sort((a, b) => a.price - b.price)[0] || null;
  const bestKwh = perKwh.sort((a, b) => a.price - b.price)[0] || null;

  return { perMin: bestMin, perKwh: bestKwh };
}

function formatPrice(plan) {
  if (!plan || plan.price == null || plan.price <= 0) return null;
  if (plan.unit === 'JPY/min') return `${plan.price}円/分`;
  if (plan.unit === 'JPY/kWh') return `${plan.price}円/kWh`;
  return `${plan.price}`;
}

function isMembershipRequired(service) {
  return service.requiresMembership === true || service.visitorAvailable === false;
}

/**
 * @param {object} analysis - { connector, power_kw, location, services[] }
 * @param {object} priceMaster
 * @param {object} serviceEnabled - { serviceId: boolean }
 */
export function comparePrices(analysis, priceMaster, serviceEnabled) {
  const powerKw = analysis.power_kw ?? analysis.powerKw ?? null;
  const location = analysis.location || null;
  const detected = analysis.services || [];

  const results = [];
  const unmatched = [];
  const seenServiceIds = new Set();

  for (const detectedName of detected) {
    let found = false;
    for (const service of priceMaster.services) {
      if (!matchService(detectedName, service)) continue;
      found = true;

      if (seenServiceIds.has(service.id)) break;
      seenServiceIds.add(service.id);

      const enabled = serviceEnabled[service.id] !== false;
      const membershipRequired = isMembershipRequired(service);

      if (!enabled) {
        results.push({
          detectedName,
          serviceId: service.id,
          serviceName: service.name,
          enabled: false,
          skipped: true,
          reason: '利用サービスから除外'
        });
        break;
      }

      const plans = findBestPlan(service, powerKw, location);
      const entry = {
        detectedName,
        serviceId: service.id,
        serviceName: service.name,
        enabled: true,
        membershipRequired,
        monthlyFee: service.monthlyFee ?? 0,
        perMin: plans?.perMin || null,
        perKwh: plans?.perKwh || null,
        perMinFormatted: formatPrice(plans?.perMin),
        perKwhFormatted: formatPrice(plans?.perKwh),
        note: plans?.perMin?.note || plans?.perKwh?.note || ''
      };

      results.push(entry);
      break;
    }
    if (!found) unmatched.push(detectedName);
  }

  const isRankable = (r) =>
    r.enabled &&
    !r.skipped &&
    !r.membershipRequired &&
    ((r.perMin && r.perMin.price > 0) || (r.perKwh && r.perKwh.price > 0));

  const active = results.filter(isRankable);

  const minRanked = active
    .filter((r) => r.perMin && r.perMin.price > 0)
    .sort((a, b) => a.perMin.price - b.perMin.price);

  const kwhRanked = active
    .filter((r) => r.perKwh && r.perKwh.price > 0)
    .sort((a, b) => a.perKwh.price - b.perKwh.price);

  const membershipOnly = results.filter(
    (r) => r.enabled && !r.skipped && r.membershipRequired
  );

  return {
    results,
    unmatched,
    minRanked,
    kwhRanked,
    membershipOnly,
    charger: {
      connector: analysis.connector || '不明',
      powerKw,
      location: location || '不明'
    }
  };
}

export function renderComparisonHtml(comparison) {
  const medals = ['🥇', '🥈', '🥉'];
  let html = '';

  if (comparison.minRanked.length > 0) {
    html += '<h3 class="rank-title">時間課金（円/分）安い順</h3><ol class="rank-list">';
    comparison.minRanked.forEach((r, i) => {
      const medal = medals[i] || `${i + 1}.`;
      html += `<li>
        <span class="medal">${medal}</span>
        <strong>${escapeHtml(r.serviceName)}</strong>
        <span class="price">${escapeHtml(r.perMinFormatted)}</span>
        ${r.note ? `<span class="sub">${escapeHtml(r.note)}</span>` : ''}
      </li>`;
    });
    html += '</ol>';
  }

  if (comparison.kwhRanked.length > 0) {
    html += '<h3 class="rank-title">kWh課金 安い順</h3><ol class="rank-list">';
    comparison.kwhRanked.forEach((r, i) => {
      const medal = medals[i] || `${i + 1}.`;
      html += `<li>
        <span class="medal">${medal}</span>
        <strong>${escapeHtml(r.serviceName)}</strong>
        <span class="price">${escapeHtml(r.perKwhFormatted)}</span>
        ${r.note ? `<span class="sub">${escapeHtml(r.note)}</span>` : ''}
      </li>`;
    });
    html += '</ol>';
  }

  const skipped = comparison.results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    html += '<h3 class="rank-title">除外されたサービス</h3><ul class="skipped-list">';
    skipped.forEach((r) => {
      html += `<li>${escapeHtml(r.serviceName)}（${escapeHtml(r.reason)}）</li>`;
    });
    html += '</ul>';
  }

  if (comparison.membershipOnly.length > 0) {
    html += '<h3 class="rank-title">会員契約が必要</h3><ul class="skipped-list">';
    comparison.membershipOnly.forEach((r) => {
      html += `<li>${escapeHtml(r.serviceName)}（ビジター利用不可）</li>`;
    });
    html += '</ul>';
  }

  if (comparison.unmatched.length > 0) {
    html += '<h3 class="rank-title">未登録のサービス</h3><ul class="skipped-list">';
    comparison.unmatched.forEach((name) => {
      html += `<li>${escapeHtml(name)}</li>`;
    });
    html += '</ul>';
  }

  if (comparison.minRanked.length === 0 && comparison.kwhRanked.length === 0) {
    html += '<p class="hint">比較可能なサービスが見つかりませんでした。設定で利用サービスを確認してください。</p>';
  }

  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
