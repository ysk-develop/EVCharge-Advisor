/**
 * Price comparison engine - deterministic, no AI
 */

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[\s　・/／\-_]/g, '')
    .replace(/zesp2/g, 'zesp')
    .replace(/zesp3/g, 'zesp');
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
  if (location) {
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

  const perMin = matched.filter((p) => p.unit === 'JPY/min');
  const perKwh = matched.filter((p) => p.unit === 'JPY/kWh');

  const bestMin = perMin.sort((a, b) => a.price - b.price)[0] || null;
  const bestKwh = perKwh.sort((a, b) => a.price - b.price)[0] || null;

  return { perMin: bestMin, perKwh: bestKwh };
}

function formatPrice(plan) {
  if (!plan) return null;
  if (plan.unit === 'JPY/min') return `${plan.price}円/分`;
  if (plan.unit === 'JPY/kWh') return `${plan.price}円/kWh`;
  return `${plan.price}`;
}

function effectiveKwhCost(perMinPrice, chargingKw) {
  if (!perMinPrice || !chargingKw || chargingKw <= 0) return null;
  return (perMinPrice / chargingKw) * 60;
}

/**
 * @param {object} analysis - { connector, power_kw, location, services[] }
 * @param {object} priceMaster
 * @param {object} serviceEnabled - { serviceId: boolean }
 * @param {object} options - { chargingKw, estimatedKwh }
 */
export function comparePrices(analysis, priceMaster, serviceEnabled, options = {}) {
  const powerKw = analysis.power_kw ?? analysis.powerKw ?? null;
  const location = analysis.location || null;
  const detected = analysis.services || [];

  const results = [];
  const unmatched = [];

  for (const detectedName of detected) {
    let found = false;
    for (const service of priceMaster.services) {
      if (!matchService(detectedName, service)) continue;
      found = true;

      const enabled = serviceEnabled[service.id] !== false;
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
        monthlyFee: service.monthlyFee ?? 0,
        perMin: plans?.perMin || null,
        perKwh: plans?.perKwh || null,
        perMinFormatted: formatPrice(plans?.perMin),
        perKwhFormatted: formatPrice(plans?.perKwh),
        note: plans?.perMin?.note || plans?.perKwh?.note || ''
      };

      if (options.chargingKw && entry.perMin) {
        entry.effectiveKwhCost = effectiveKwhCost(entry.perMin.price, options.chargingKw);
        entry.effectiveKwhFormatted = entry.effectiveKwhCost
          ? `約${Math.round(entry.effectiveKwhCost)}円/kWh相当（${options.chargingKw}kW時）`
          : null;
      }

      results.push(entry);
      break;
    }
    if (!found) unmatched.push(detectedName);
  }

  const active = results.filter((r) => r.enabled && !r.skipped);

  const minRanked = active
    .filter((r) => r.perMin)
    .sort((a, b) => a.perMin.price - b.perMin.price);

  const kwhRanked = active
    .filter((r) => r.perKwh)
    .sort((a, b) => a.perKwh.price - b.perKwh.price);

  let recommendation = null;
  if (options.chargingKw && minRanked.length > 0 && kwhRanked.length > 0) {
    const bestMin = minRanked[0];
    const bestKwh = kwhRanked[0];
    const minEffective = effectiveKwhCost(bestMin.perMin.price, options.chargingKw);
    if (minEffective != null && bestKwh.perKwh.price < minEffective) {
      recommendation = {
        type: 'kwh',
        service: bestKwh,
        reason: `充電速度${options.chargingKw}kWではkWh課金の方が有利（${Math.round(bestKwh.perKwh.price)}円/kWh vs 約${Math.round(minEffective)}円/kWh相当）`
      };
    } else if (minRanked.length > 0) {
      recommendation = {
        type: 'min',
        service: bestMin,
        reason: `時間課金が有利（${bestMin.perMinFormatted}）`
      };
    }
  }

  return {
    results,
    unmatched,
    minRanked,
    kwhRanked,
    recommendation,
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

  if (comparison.recommendation) {
    const rec = comparison.recommendation;
    const svc = rec.service;
    html += `<div class="recommendation">
      <h3>💡 ZE1向け推奨</h3>
      <p><strong>${svc.serviceName}</strong></p>
      <p>${rec.type === 'kwh' ? svc.perKwhFormatted : svc.perMinFormatted}</p>
      <p class="hint">${rec.reason}</p>
    </div>`;
  }

  if (comparison.minRanked.length > 0) {
    html += '<h3 class="rank-title">時間課金（円/分）安い順</h3><ol class="rank-list">';
    comparison.minRanked.forEach((r, i) => {
      const medal = medals[i] || `${i + 1}.`;
      html += `<li>
        <span class="medal">${medal}</span>
        <strong>${r.serviceName}</strong>
        <span class="price">${r.perMinFormatted}</span>
        ${r.effectiveKwhFormatted ? `<span class="sub">${r.effectiveKwhFormatted}</span>` : ''}
        ${r.note ? `<span class="sub">${r.note}</span>` : ''}
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
        <strong>${r.serviceName}</strong>
        <span class="price">${r.perKwhFormatted}</span>
        ${r.note ? `<span class="sub">${r.note}</span>` : ''}
      </li>`;
    });
    html += '</ol>';
  }

  const skipped = comparison.results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    html += '<h3 class="rank-title">除外されたサービス</h3><ul class="skipped-list">';
    skipped.forEach((r) => {
      html += `<li>${r.serviceName}（${r.reason}）</li>`;
    });
    html += '</ul>';
  }

  if (comparison.unmatched.length > 0) {
    html += '<h3 class="rank-title">未登録のサービス</h3><ul class="skipped-list">';
    comparison.unmatched.forEach((name) => {
      html += `<li>${name}</li>`;
    });
    html += '</ul>';
  }

  if (comparison.minRanked.length === 0 && comparison.kwhRanked.length === 0) {
    html += '<p class="hint">有効なサービスが見つかりませんでした。設定で利用サービスを確認してください。</p>';
  }

  return html;
}
