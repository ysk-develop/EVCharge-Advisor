import assert from 'node:assert/strict';
import { isAllowedModel, modelCandidates, formatGeminiUserError } from './gemini-api.js';

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

console.log('model-filter tests ok');
