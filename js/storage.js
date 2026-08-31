/**
 * localStorage management - per device/browser
 */
const STORAGE_KEYS = {
  API_KEY: 'evca_apiKey',
  MODEL: 'evca_model',
  MODELS: 'evca_models',
  PRICE_MASTER: 'evca_priceMaster',
  SERVICE_ENABLED: 'evca_serviceEnabled'
};

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEYS.API_KEY) || '';
}

export function setApiKey(key) {
  if (key) {
    localStorage.setItem(STORAGE_KEYS.API_KEY, key);
  } else {
    localStorage.removeItem(STORAGE_KEYS.API_KEY);
  }
}

export function getModel() {
  return localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-2.0-flash';
}

export function setModel(model) {
  localStorage.setItem(STORAGE_KEYS.MODEL, model);
}

export function getModels() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.MODELS) || '[]');
  } catch {
    return [];
  }
}

export function setModels(models) {
  localStorage.setItem(STORAGE_KEYS.MODELS, JSON.stringify(models));
}

export function getPriceMaster() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.PRICE_MASTER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setPriceMaster(master) {
  localStorage.setItem(STORAGE_KEYS.PRICE_MASTER, JSON.stringify(master, null, 2));
}

export function getServiceEnabled() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.SERVICE_ENABLED) || '{}');
  } catch {
    return {};
  }
}

export function setServiceEnabled(map) {
  localStorage.setItem(STORAGE_KEYS.SERVICE_ENABLED, JSON.stringify(map));
}

export function setServiceEnabledFlag(serviceId, enabled) {
  const map = getServiceEnabled();
  map[serviceId] = enabled;
  setServiceEnabled(map);
}
