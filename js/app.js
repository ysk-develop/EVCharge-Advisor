import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getPriceMaster, setPriceMaster,
  getServiceEnabled, setServiceEnabled, setServiceEnabledFlag
} from './storage.js';
import { getDefaultPriceMaster, getDefaultServiceEnabled } from './price-master.js';
import { comparePrices, renderComparisonHtml } from './price-engine.js';
import { fetchModels, analyzeImage, researchPrices, isAllowedModel } from './gemini-api.js';
import { initPriceEditorUI, renderPriceEditor } from './price-editor-ui.js';
import { initRouteUI } from './route-ui.js';
import { APP_VERSION } from './version.js';
import { renderNotice } from './notice.js';

let imageData = null;
let imageMime = 'image/jpeg';

function $(id) {
  return document.getElementById(id);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showMessage(msg, type = 'error') {
  const el = $('errorArea');
  el.classList.remove('error-box', 'success-box');
  el.classList.add(type === 'success' ? 'success-box' : 'error-box');
  if (type === 'success') el.textContent = msg;
  else renderNotice(el, msg);
  show(el);
}

function clearMessage() {
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

function preferredModel(models, current) {
  if (current && isAllowedModel(current) && models.some((m) => m.id === current)) return current;
  const flash = models.find((m) => /flash/i.test(m.id) && !/lite/i.test(m.id));
  const freeSearch = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  const grounded = freeSearch.map((id) => models.find((m) => m.id === id)).find(Boolean);
  return grounded?.id || flash?.id || models[0]?.id || 'gemini-2.5-flash';
}

function populateModelSelect() {
  const select = $('modelSelect');
  const models = getModels().filter((m) => isAllowedModel(m.id));
  let current = getModel();
  if (!isAllowedModel(current)) current = preferredModel(models, '');
  select.innerHTML = '';

  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current;
    select.appendChild(opt);
    if (current !== getModel()) setModel(current);
    return;
  }

  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  }
  const picked = preferredModel(models, current);
  select.value = picked;
  if (picked !== getModel()) setModel(picked);
}

function initSettings() {
  const apiKey = getApiKey();
  if (apiKey) $('apiKeyInput').value = apiKey;
  else $('apiSettings').open = true;

  populateModelSelect();
  $('modelSelect').addEventListener('change', (e) => setModel(e.target.value));

  const master = loadPriceMaster();
  const enabled = loadServiceEnabled(master);
  renderServiceToggles(master, enabled);

  initPriceEditorUI($('priceEditorContainer'), (savedMaster) => {
    renderServiceToggles(savedMaster, loadServiceEnabled(savedMaster));
    showMessage('料金マスターを保存しました', 'success');
  });
  renderPriceEditor(master);
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

    clearMessage();
    imageMime = file.type || 'image/jpeg';

    try {
      imageData = await readFileAsBase64(file);
      const preview = $('previewImg');
      preview.src = URL.createObjectURL(file);
      show($('imagePreview'));
      $('imageStatus').textContent = `画像を読み込みました（${file.name}）`;
    } catch (err) {
      showMessage(`画像の読み込みに失敗: ${err.message}`);
      imageData = null;
    }
  });
}

async function handleAnalyze() {
  clearMessage();
  hide($('resultArea'));

  if (!imageData) {
    showMessage('先にスクリーンショットを選択してください');
    return;
  }

  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showMessage('設定タブでGemini APIキーを入力してください');
    return;
  }

  if ($('saveApiKey').checked) {
    setApiKey(apiKey);
  }

  const model = $('modelSelect').value || getModel();
  if (!model) {
    showMessage('モデルを選択してください（設定タブでモデル一覧を取得）');
    return;
  }

  show($('loadingArea'));
  $('analyzeBtn').disabled = true;

  try {
    const analysis = await analyzeImage(apiKey, model, imageData, imageMime);
    const master = loadPriceMaster();
    const enabled = loadServiceEnabled(master);

    const comparison = comparePrices(analysis, master, enabled);
    displayResults(analysis, comparison);
    show($('resultArea'));
    if (analysis.model_fallback && analysis.model_used) {
      showMessage(`混雑のため ${analysis.model_used} で解析しました`, 'success');
    }
  } catch (err) {
    showMessage(err.message);
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
  clearMessage();
  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showMessage('APIキーを入力してください');
    return;
  }

  if ($('saveApiKey').checked) setApiKey(apiKey);

  $('fetchModelsBtn').disabled = true;
  $('fetchModelsBtn').textContent = '取得中...';

  try {
    const models = await fetchModels(apiKey);
    setModels(models);
    populateModelSelect();
    showMessage(`モデル ${models.length} 件を取得しました`, 'success');
  } catch (err) {
    showMessage(err.message);
  } finally {
    $('fetchModelsBtn').disabled = false;
    $('fetchModelsBtn').textContent = 'モデル一覧を取得';
  }
}

async function handleResearchPrices() {
  clearMessage();
  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showMessage('APIキーを入力してください');
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
    if (result.notice) showMessage(result.notice, 'success');
  } catch (err) {
    showMessage(err.message);
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

function initApiKeyActions() {
  $('deleteApiKeyBtn').addEventListener('click', () => {
    if (!confirm('APIキーをこの端末から削除しますか？')) return;
    setApiKey('');
    $('apiKeyInput').value = '';
    showMessage('APIキーを削除しました', 'success');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js')
    .then((reg) => {
      const check = () => reg.update().catch(() => {});
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch(() => {});
}

/** Clear SW caches and hard-reload so the PWA picks up the latest GitHub Pages deploy. */
async function forceAppUpdate() {
  const status = $('forceUpdateStatus');
  const btn = $('forceUpdateBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  if (status) status.textContent = 'キャッシュと Service Worker をクリアしています…';

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (status) status.textContent = '最新版を読み込みます…';
    const url = new URL(location.href);
    url.searchParams.set('_reload', String(Date.now()));
    location.replace(url.toString());
  } catch (err) {
    if (status) status.textContent = `更新に失敗しました: ${err.message || err}`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '最新版を読み込み';
    }
    showMessage(`更新エラー: ${err.message || err}`);
  }
}

function cleanReloadQueryParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('_reload')) return;
    url.searchParams.delete('_reload');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

function applyAppVersion() {
  const label = `v${APP_VERSION}`;
  const header = $('appVersion');
  if (header) header.textContent = label;
  const about = $('aboutVersion');
  if (about) about.textContent = label;
}

function init() {
  cleanReloadQueryParam();
  applyAppVersion();
  initTabs();
  initSettings();
  initImageInput();
  initApiKeyActions();
  registerServiceWorker();

  $('analyzeBtn').addEventListener('click', handleAnalyze);
  $('fetchModelsBtn').addEventListener('click', handleFetchModels);
  $('researchPricesBtn').addEventListener('click', handleResearchPrices);
  $('forceUpdateBtn')?.addEventListener('click', forceAppUpdate);
  initRouteUI();
}

document.addEventListener('DOMContentLoaded', init);
