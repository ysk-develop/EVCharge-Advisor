import { setPriceMaster } from './storage.js';
import { getDefaultPriceMaster } from './price-master.js';

const UNIT_OPTIONS = [
  { value: 'JPY/min', label: '円/分' },
  { value: 'JPY/kWh', label: '円/kWh' }
];

const TYPE_OPTIONS = [
  { value: 'DC', label: '急速' },
  { value: 'AC', label: '普通' }
];

const LOCATION_OPTIONS = [
  { value: '', label: '指定なし' },
  { value: 'general', label: '一般道' },
  { value: 'highway', label: '高速道路' }
];

let currentMaster = null;
let onSaveCallback = null;

export function initPriceEditorUI(container, onSave) {
  onSaveCallback = onSave;
  container.innerHTML = `
    <div id="priceEditorList" class="price-editor-list"></div>
    <div class="btn-row">
      <button type="button" id="priceEditorSaveBtn" class="btn btn-primary">変更を保存</button>
      <button type="button" id="priceEditorResetBtn" class="btn btn-danger-outline">初期値に戻す</button>
    </div>
  `;
  container.querySelector('#priceEditorSaveBtn').addEventListener('click', handleSave);
  container.querySelector('#priceEditorResetBtn').addEventListener('click', handleReset);
}

export function renderPriceEditor(master) {
  currentMaster = JSON.parse(JSON.stringify(master));
  const list = document.getElementById('priceEditorList');
  if (!list) return;
  list.innerHTML = '';

  for (const service of currentMaster.services) {
    list.appendChild(createServiceEditor(service));
  }
}

function createServiceEditor(service) {
  const details = document.createElement('details');
  details.className = 'service-editor';

  const summary = document.createElement('summary');
  summary.className = 'service-editor-summary';
  const planCount = (service.plans || []).length;
  summary.innerHTML = `
    <span class="service-editor-name">${escapeHtml(service.name)}</span>
    <span class="service-editor-meta">${planCount}件の料金</span>
  `;
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'service-editor-body';

  body.innerHTML = `
    <div class="form-row">
      <label>月額基本料金（円）</label>
      <input type="number" data-field="monthlyFee" min="0" step="1" value="${service.monthlyFee ?? 0}">
    </div>
    <label class="checkbox-label">
      <input type="checkbox" data-field="visitorAvailable" ${service.visitorAvailable !== false ? 'checked' : ''}>
      ビジター利用可
    </label>
    <p class="hint">ビジター利用不可のサービスは料金比較に含まれません</p>
    <h4 class="plans-title">料金プラン</h4>
    <div class="plans-list" data-service-id="${service.id}"></div>
    <button type="button" class="btn btn-secondary btn-sm add-plan-btn" data-service-id="${service.id}">＋ プランを追加</button>
  `;

  const plansList = body.querySelector('.plans-list');
  for (let i = 0; i < (service.plans || []).length; i++) {
    plansList.appendChild(createPlanRow(service.id, service.plans[i], i));
  }

  body.querySelector('[data-field="monthlyFee"]').addEventListener('change', (e) => {
    service.monthlyFee = parseFloat(e.target.value) || 0;
  });

  body.querySelector('[data-field="visitorAvailable"]').addEventListener('change', (e) => {
    service.visitorAvailable = e.target.checked;
    service.requiresMembership = !e.target.checked;
  });

  body.querySelector('.add-plan-btn').addEventListener('click', () => {
    const newPlan = { type: 'DC', powerKw: null, price: 0, unit: 'JPY/min', note: '' };
    service.plans = service.plans || [];
    service.plans.push(newPlan);
    plansList.appendChild(createPlanRow(service.id, newPlan, service.plans.length - 1));
    updateSummary(details, service);
  });

  details.appendChild(body);
  return details;
}

function createPlanRow(serviceId, plan, index) {
  const row = document.createElement('div');
  row.className = 'plan-row';
  row.dataset.serviceId = serviceId;
  row.dataset.planIndex = index;

  row.innerHTML = `
    <div class="plan-row-grid">
      <div class="form-row">
        <label>種別</label>
        <select data-plan-field="type">${optionsHtml(TYPE_OPTIONS, plan.type || 'DC')}</select>
      </div>
      <div class="form-row">
        <label>出力（kW）</label>
        <input type="number" data-plan-field="powerKw" min="0" step="1" placeholder="任意" value="${plan.powerKw ?? ''}">
      </div>
      <div class="form-row">
        <label>料金</label>
        <input type="number" data-plan-field="price" min="0" step="0.1" value="${plan.price ?? 0}">
      </div>
      <div class="form-row">
        <label>単位</label>
        <select data-plan-field="unit">${optionsHtml(UNIT_OPTIONS, plan.unit || 'JPY/min')}</select>
      </div>
      <div class="form-row">
        <label>場所</label>
        <select data-plan-field="location">${optionsHtml(LOCATION_OPTIONS, plan.location || '')}</select>
      </div>
      <div class="form-row plan-note">
        <label>メモ</label>
        <input type="text" data-plan-field="note" placeholder="例: 50kW急速" value="${escapeAttr(plan.note || '')}">
      </div>
    </div>
    <button type="button" class="btn-icon delete-plan-btn" title="削除">✕</button>
  `;

  row.querySelectorAll('[data-plan-field]').forEach((el) => {
    el.addEventListener('change', () => syncPlanFromRow(serviceId, index, row));
    el.addEventListener('input', () => syncPlanFromRow(serviceId, index, row));
  });

  row.querySelector('.delete-plan-btn').addEventListener('click', () => {
    const svc = currentMaster.services.find((s) => s.id === serviceId);
    if (svc && svc.plans) {
      svc.plans.splice(index, 1);
      rerenderPlans(serviceId);
      const details = row.closest('.service-editor');
      if (details) updateSummary(details, svc);
    }
  });

  return row;
}

function syncPlanFromRow(serviceId, index, row) {
  const svc = currentMaster.services.find((s) => s.id === serviceId);
  if (!svc || !svc.plans[index]) return;

  const plan = svc.plans[index];
  plan.type = row.querySelector('[data-plan-field="type"]').value;
  const powerVal = row.querySelector('[data-plan-field="powerKw"]').value;
  plan.powerKw = powerVal === '' ? null : parseFloat(powerVal);
  plan.price = parseFloat(row.querySelector('[data-plan-field="price"]').value) || 0;
  plan.unit = row.querySelector('[data-plan-field="unit"]').value;
  const loc = row.querySelector('[data-plan-field="location"]').value;
  plan.location = loc || undefined;
  plan.note = row.querySelector('[data-plan-field="note"]').value;
}

function rerenderPlans(serviceId) {
  const svc = currentMaster.services.find((s) => s.id === serviceId);
  const list = document.querySelector(`.plans-list[data-service-id="${serviceId}"]`);
  if (!svc || !list) return;
  list.innerHTML = '';
  (svc.plans || []).forEach((plan, i) => {
    list.appendChild(createPlanRow(serviceId, plan, i));
  });
}

function updateSummary(details, service) {
  const meta = details.querySelector('.service-editor-meta');
  if (meta) meta.textContent = `${(service.plans || []).length}件の料金`;
}

function handleSave() {
  if (!currentMaster) return;
  currentMaster.updatedAt = new Date().toISOString().slice(0, 10);
  setPriceMaster(currentMaster);
  if (onSaveCallback) onSaveCallback(currentMaster);
}

function handleReset() {
  if (!confirm('料金マスターを初期値に戻しますか？')) return;
  currentMaster = getDefaultPriceMaster();
  renderPriceEditor(currentMaster);
  setPriceMaster(currentMaster);
  if (onSaveCallback) onSaveCallback(currentMaster);
}

function optionsHtml(options, selected) {
  return options.map((o) =>
    `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`
  ).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}
