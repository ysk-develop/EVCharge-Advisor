import assert from 'node:assert/strict';
import {
  isAllowedModel,
  modelCandidates,
  formatGeminiUserError,
  parseGeminiHttpError,
  retryPlan,
  freeTierSearchModel,
  hasFreeTierGrounding,
  generateSearch
} from './gemini-api.js';

assert.equal(isAllowedModel('gemini-2.5-flash'), true);
assert.equal(isAllowedModel('gemini-2.0-flash'), true);
assert.equal(isAllowedModel('gemini-2.5-flash-lite'), true);
assert.equal(isAllowedModel('gemini-1.5-flash-8b'), true);
assert.equal(isAllowedModel('gemma-4-31b-it'), true);
assert.equal(isAllowedModel('gemma-4-26b-a4b-it'), true);

assert.equal(isAllowedModel('gemini-2.5-pro'), false);
assert.equal(isAllowedModel('gemini-2.5-flash-thinking'), false);
assert.equal(isAllowedModel('gemini-2.5-pro-preview'), false);
assert.equal(isAllowedModel('imagen-3.0-generate-002'), false);
assert.equal(isAllowedModel('gemma-3-27b-it'), false);
assert.equal(isAllowedModel(''), false);

const lite = modelCandidates('gemini-2.5-flash-lite');
assert.equal(lite[0], 'gemini-2.5-flash-lite');
assert.ok(lite.includes('gemini-2.5-flash'));
assert.ok(lite.every((id) => isAllowedModel(id)));

const blocked = modelCandidates('gemini-2.5-pro');
assert.ok(!blocked.includes('gemini-2.5-pro'));
assert.ok(blocked.includes('gemini-2.0-flash'));

const busy = formatGeminiUserError({ highDemand: true, code: 503, message: 'high demand' }, 'gemini-2.5-flash', '画像解析失敗');
assert.match(busy, /混雑/);
assert.match(busy, /レート制限の問題ではありません/);

const limited = formatGeminiUserError({ rateLimited: true, code: 429, message: 'quota' }, 'gemini-2.0-flash', '調査失敗');
assert.match(limited, /利用上限/);

assert.equal(isAllowedModel('gemini-flash-latest'), true);
assert.equal(isAllowedModel('gemini-3.8-flash'), true);
assert.equal(hasFreeTierGrounding('gemini-2.5-flash'), true);
assert.equal(hasFreeTierGrounding('gemini-2.5-flash-lite'), true);
assert.equal(hasFreeTierGrounding('gemini-flash-latest'), false);
assert.equal(hasFreeTierGrounding('gemini-3.8-flash'), false);
assert.equal(freeTierSearchModel('gemini-flash-latest'), 'gemini-2.5-flash');
assert.equal(freeTierSearchModel('gemini-3.8-flash'), 'gemini-2.5-flash');
assert.equal(freeTierSearchModel('gemini-3.5-flash-lite'), 'gemini-2.5-flash-lite');
assert.equal(freeTierSearchModel('gemma-4-31b-it'), 'gemini-2.5-flash');
assert.equal(freeTierSearchModel('gemini-2.5-flash'), 'gemini-2.5-flash');

function quotaBody({ metric, id, value, message, delay }) {
  const details = [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric: metric, quotaId: id, quotaValue: String(value) }]
    }
  ];
  if (delay) {
    details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
  }
  return JSON.stringify({
    error: {
      code: 429,
      message: message || 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
      status: 'RESOURCE_EXHAUSTED',
      details
    }
  });
}

const grounding = parseGeminiHttpError(429, quotaBody({
  metric: 'generativelanguage.googleapis.com/grounding_search_requests',
  id: 'GroundingSearchRequestsPerDay-FreeTier',
  value: 0
}), 'gemini-flash-latest');
assert.equal(grounding.quotaKind, 'grounding');
assert.equal(grounding.limitZero, true);
assert.equal(retryPlan(grounding).retry, false);
const groundingText = formatGeminiUserError(grounding, 'gemini-flash-latest', '料金調査失敗');
assert.match(groundingText, /Google検索グラウンディングの上限が 0/);
assert.match(groundingText, /You exceeded your current quota/);
assert.match(groundingText, /GroundingSearchRequestsPerDay-FreeTier/);
assert.match(groundingText, /上限: 0/);
assert.doesNotMatch(groundingText, /AIza/);

const daily = parseGeminiHttpError(429, quotaBody({
  metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  id: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
  value: 1500
}));
assert.equal(daily.quotaKind, 'rpd');
assert.equal(daily.limitZero, false);
assert.equal(retryPlan(daily).retry, false);
assert.match(formatGeminiUserError(daily, 'gemini-2.5-flash', '調査失敗'), /1日あたり/);

const minute = parseGeminiHttpError(429, quotaBody({
  metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  id: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
  value: 15,
  delay: '8s'
}));
assert.equal(minute.quotaKind, 'rpm');
assert.equal(retryPlan(minute).retry, true);
assert.equal(retryPlan(minute).delayMs, 8000);
assert.match(formatGeminiUserError(minute, 'gemini-2.5-flash', '調査失敗'), /1分あたり/);

const longWait = parseGeminiHttpError(429, quotaBody({
  metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  id: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
  value: 15,
  delay: '45s'
}));
assert.equal(retryPlan(longWait).retry, false);

const leaked = formatGeminiUserError({
  rateLimited: true,
  code: 429,
  message: 'key=AIzaSyDUMMYKEY1234567890abcd quota',
  violations: []
}, 'gemini-2.5-flash', '調査失敗');
assert.doesNotMatch(leaked, /AIzaSyDUMMYKEY/);

const gemma500 = parseGeminiHttpError(500, JSON.stringify({
  error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' }
}), 'gemma-4-31b-it');
assert.equal(gemma500.unsupportedSearch, true);
assert.match(formatGeminiUserError(gemma500, 'gemma-4-31b-it', '調査失敗'), /Google 検索に対応していません/);

const calls = [];
globalThis.fetch = async (url, init) => {
  const model = String(url).match(/models\/([^:]+):/)[1];
  calls.push({ model, body: JSON.parse(init.body) });
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: '調べました' }] } }] }),
    text: async () => ''
  };
};
const pinned = await generateSearch('test-key', 'gemini-flash-latest', {
  contents: [{ parts: [{ text: '料金' }] }],
  systemInstruction: { parts: [{ text: 'no' }] },
  generationConfig: { responseSchema: { type: 'object' }, temperature: 0.2 }
});
assert.equal(calls.length, 1);
assert.equal(calls[0].model, 'gemini-2.5-flash');
assert.deepEqual(calls[0].body.tools, [{ google_search: {} }]);
assert.equal(calls[0].body.systemInstruction, undefined);
assert.equal(calls[0].body.generationConfig.responseSchema, undefined);
assert.equal(calls[0].body.generationConfig.temperature, 0.2);
assert.equal(pinned.modelUsed, 'gemini-2.5-flash');
assert.match(pinned.notice, /無料枠/);
assert.doesNotMatch(pinned.notice, /test-key/);

calls.length = 0;
globalThis.fetch = async (url) => {
  const model = String(url).match(/models\/([^:]+):/)[1];
  calls.push(model);
  return {
    ok: false,
    status: 429,
    text: async () => quotaBody({
      metric: 'generativelanguage.googleapis.com/grounding_search_requests',
      id: 'GroundingSearchRequestsPerDay-FreeTier',
      value: 0
    })
  };
};
await assert.rejects(() => generateSearch('test-key', 'gemini-flash-latest', { contents: [] }));
assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);

calls.length = 0;
globalThis.fetch = async (url) => {
  calls.push(String(url).match(/models\/([^:]+):/)[1]);
  return {
    ok: false,
    status: 404,
    text: async () => JSON.stringify({
      error: { code: 404, message: 'models/gemini-2.5-flash is not found', status: 'NOT_FOUND' }
    })
  };
};
await assert.rejects(
  () => generateSearch('test-key', 'gemini-flash-latest', { contents: [] }),
  (err) => {
    assert.match(err.message, /2\.5 Flash と 2\.5 Flash-Lite/);
    assert.match(err.message, /上限 0/);
    assert.match(err.message, /is not found/);
    return true;
  }
);
assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash-lite']);

calls.length = 0;
globalThis.fetch = async (url) => {
  calls.push(String(url).match(/models\/([^:]+):/)[1]);
  return {
    ok: false,
    status: 429,
    text: async () => quotaBody({
      metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
      id: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
      value: 10,
      delay: '0.01s'
    })
  };
};
await assert.rejects(() => generateSearch('test-key', 'gemini-2.5-flash', { contents: [] }));
assert.deepEqual(calls, ['gemini-2.5-flash', 'gemini-2.5-flash']);

console.log('model-filter tests ok');
