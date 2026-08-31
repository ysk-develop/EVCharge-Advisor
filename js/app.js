import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getPriceMaster, setPriceMaster,
  getServiceEnabled, setServiceEnabled, setServiceEnabledFlag
} from './storage.js';
import { getDefaultPriceMaster, getDefaultServiceEnabled } from './price-master.js';
import { comparePrices, renderComparisonHtml } from './price-engine.js';
import { fetchModels, analyzeImage, researchPrices } from './gemini-api.js';

let imageData = null;
let imageMime = 'image/jpeg';

function $(id) {
  return document.getElementById(id);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(msg) {
  const el = $('errorArea');
  el.textContent = msg;
  show(el);
}

function clearError() {
  hide($('errorArea'));
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function loadPriceMaster() {
  let master = getPriceMaster();
  if (!master) {
    master = getDefaultPriceMaster();
    setPriceMaster(master);
  }
  return master;
}

function loadServiceEnabled(master) {
  let enabled = getServiceEnabled();
  if (Object.keys(enabled).length === 0) {
    enabled = getDefaultServiceEnabled();
    setServiceEnabled(enabled);
  }
  for (const svc of master.services) {
    if (enabled[svc.id] === undefined) {
      enabled[svc.id] = svc.enabled;
    }
  }
  return enabled;
}

function renderServiceToggles(master, enabled) {
  const container = $('serviceToggles');
  container.innerHTML = '';
  for (const svc of master.services) {
    const label = document.createElement('label');
    label.className = 'toggle-item';
    const checked = enabled[svc.id] !== false;
    label.innerHTML = `
      <input type="checkbox" data-service-id="${svc.id}" ${checked ? 'checked' : ''}>
      <span>${svc.name}</span>
    `;
    label.querySelector('input').addEventListener('change', (e) => {
      setServiceEnabledFlag(svc.id, e.target.checked);
    });
    container.appendChild(label);
  }
}

function populateModelSelect() {
  const select = $('modelSelect');
  const models = getModels();
  const current = getModel();
  select.innerHTML = '';

  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current;
    select.appendChild(opt);
    return;
  }

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  }
  select.value = current;
}

function initSettings() {
  const apiKey = getApiKey();
  if (apiKey) $('apiKeyInput').value = apiKey;

  populateModelSelect();
  $('modelSelect').addEventListener('change', (e) => setModel(e.target.value));

  const master = loadPriceMaster();
  const enabled = loadServiceEnabled(master);
  renderServiceToggles(master, enabled);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function initImageInput() {
  const input = $('imageInput');
  input.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearError();
    imageMime = file.type || 'image/jpeg';

    try {
      imageData = await readFileAsBase64(file);
      const preview = $('previewImg');
      preview.src = URL.createObjectURL(file);
      show($('imagePreview'));
      $('imageStatus').textContent = `画像を読み込みました（${file.name}）`;
    } catch (err) {
      showError(`画像の読み込みに失敗: ${err.message}`);
      imageData = null;
    }
  });
}

async function handleAnalyze() {
  clearError();
  hide($('resultArea'));

  if (!imageData) {
    showError('先にスクリーンショットを選択してください');
    return;
  }

  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showError('設定タブでGemini APIキーを入力してください');
    return;
  }

  if ($('saveApiKey').checked) {
    setApiKey(apiKey);
  }

  const model = $('modelSelect').value || getModel();
  if (!model) {
    showError('モデルを選択してください（設定タブでモデル一覧を取得）');
    return;
  }

  show($('loadingArea'));
  $('analyzeBtn').disabled = true;

  try {
    const analysis = await analyzeImage(apiKey, model, imageData, imageMime);
    const master = loadPriceMaster();
    const enabled = loadServiceEnabled(master);

    const chargingKw = parseFloat($('chargingKwInput').value) || null;

    const comparison = comparePrices(analysis, master, enabled, { chargingKw });
    displayResults(analysis, comparison);
    show($('resultArea'));
  } catch (err) {
    showError(err.message);
  } finally {
    hide($('loadingArea'));
    $('analyzeBtn').disabled = false;
  }
}

function displayResults(analysis, comparison) {
  const info = comparison.charger;
  $('chargerInfo').innerHTML = `
    <dl class="info-dl">
      <dt>コネクタ</dt><dd>${info.connector}</dd>
      <dt>出力</dt><dd>${info.powerKw != null ? `${info.powerKw} kW` : '不明'}</dd>
      <dt>場所</dt><dd>${info.location === 'highway' ? '高速道路' : info.location === 'general' ? '一般道' : '不明'}</dd>
    </dl>
  `;

  const svcList = $('detectedServices');
  svcList.innerHTML = '';
  (analysis.services || []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s;
    svcList.appendChild(li);
  });

  $('priceComparison').innerHTML = renderComparisonHtml(comparison);
}

async function handleFetchModels() {
  clearError();
  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showError('APIキーを入力してください');
    return;
  }

  if ($('saveApiKey').checked) setApiKey(apiKey);

  $('fetchModelsBtn').disabled = true;
  $('fetchModelsBtn').textContent = '取得中...';

  try {
    const models = await fetchModels(apiKey);
    setModels(models);
    populateModelSelect();
    if (models.length > 0 && !getModel()) {
      const flash = models.find((m) => /flash/i.test(m.id)) || models[0];
      setModel(flash.id);
      $('modelSelect').value = flash.id;
    }
    showError(`モデル ${models.length} 件を取得しました`);
    $('errorArea').classList.remove('error-box');
    $('errorArea').classList.add('success-box');
  } catch (err) {
    $('errorArea').classList.remove('success-box');
    $('errorArea').classList.add('error-box');
    showError(err.message);
  } finally {
    $('fetchModelsBtn').disabled = false;
    $('fetchModelsBtn').textContent = 'モデル一覧を取得';
  }
}

async function handleResearchPrices() {
  clearError();
  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showError('APIキーを入力してください');
    return;
  }

  const model = $('modelSelect').value || getModel();

  $('researchPricesBtn').disabled = true;
  $('researchPricesBtn').textContent = '調査中...（数十秒かかります）';

  try {
    const result = await researchPrices(apiKey, model);
    const area = $('researchResult');
    let html = `<pre class="research-text">${escapeHtml(result.text)}</pre>`;
    if (result.sources.length > 0) {
      html += '<h4>参照ソース</h4><ul class="source-list">';
      result.sources.forEach((s) => {
        html += `<li><a href="${s.uri}" target="_blank" rel="noopener">${escapeHtml(s.title || s.uri)}</a></li>`;
      });
      html += '</ul>';
    }
    area.innerHTML = html;
    show(area);
  } catch (err) {
    showError(err.message);
  } finally {
    $('researchPricesBtn').disabled = false;
    $('researchPricesBtn').textContent = '最新料金を調査';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function initPriceEditor() {
  $('editPricesBtn').addEventListener('click', () => {
    const master = loadPriceMaster();
    $('priceMasterJson').value = JSON.stringify(master, null, 2);
    show($('priceEditor'));
  });

  $('savePricesBtn').addEventListener('click', () => {
    try {
      const parsed = JSON.parse($('priceMasterJson').value);
      setPriceMaster(parsed);
      hide($('priceEditor'));
      const enabled = loadServiceEnabled(parsed);
      renderServiceToggles(parsed, enabled);
      showError('料金マスターを保存しました');
      $('errorArea').classList.remove('error-box');
      $('errorArea').classList.add('success-box');
    } catch (err) {
      showError(`JSON形式エラー: ${err.message}`);
    }
  });

  $('resetPricesBtn').addEventListener('click', () => {
    if (!confirm('料金マスターを初期値に戻しますか？')) return;
    const master = getDefaultPriceMaster();
    setPriceMaster(master);
    $('priceMasterJson').value = JSON.stringify(master, null, 2);
    renderServiceToggles(master, getDefaultServiceEnabled());
  });

  $('cancelPricesBtn').addEventListener('click', () => hide($('priceEditor')));
}

function initApiKeyActions() {
  $('deleteApiKeyBtn').addEventListener('click', () => {
    if (!confirm('APIキーをこの端末から削除しますか？')) return;
    setApiKey('');
    $('apiKeyInput').value = '';
    showError('APIキーを削除しました');
    $('errorArea').classList.remove('error-box');
    $('errorArea').classList.add('success-box');
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

function init() {
  initTabs();
  initSettings();
  initImageInput();
  initPriceEditor();
  initApiKeyActions();
  registerServiceWorker();

  $('analyzeBtn').addEventListener('click', handleAnalyze);
  $('fetchModelsBtn').addEventListener('click', handleFetchModels);
  $('researchPricesBtn').addEventListener('click', handleResearchPrices);
}

document.addEventListener('DOMContentLoaded', init);
