import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedModel, quotaForModel, quotaGroup, quotaPools, quotaResetMs, chooseAccountForModel, isAuxiliaryModel, orderAccountsForGroup, extractUsageMetadata, estimateTokensFromText, estimatePromptTokens, formatQuotaWindow, classifyQuotaError } from './quota-policy.mjs';

const quotas = {
  buckets: [
    { id: 'gemini-5h', remainingFraction: 0.72 },
    { id: 'gemini-weekly', remainingFraction: 0.04 },
    { id: '3p-5h', remainingFraction: 0.61 },
    { id: '3p-weekly', remainingFraction: 0.44 },
  ],
};

test('uses the lower five-hour or weekly bucket for the requested model family', () => {
  assert.equal(quotaForModel(quotas, 'gemini-3.8-flash-high').remainingFraction, 0.04);
  assert.equal(quotaForModel(quotas, 'claude-sonnet-4-6-thinking').remainingFraction, 0.44);
  assert.equal(quotaForModel(quotas, 'gpt-oss-120b').remainingFraction, 0.44);
  assert.equal(quotaGroup('models/Gemini-3.8-Flash'), 'gemini');
  assert.equal(quotaGroup('Claude-Sonnet'), '3p');
});

test('accepts status-line shaped buckets and does not guess an unknown quota', () => {
  const statusLine = { quota: { 'gemini-5h': { remaining_fraction: 0.25 },
    'gemini-weekly': { remaining_fraction: 0.8 } } };
  assert.equal(quotaForModel(statusLine, 'gemini-3.1-pro').remainingFraction, 0.25);
  assert.equal(quotaForModel(statusLine, 'claude-sonnet'), null);
});

test('supplies both visual quota windows for each model pool', () => {
  const pools = quotaPools(quotas);
  assert.equal(pools.gemini.fiveHour.remainingFraction, 0.72);
  assert.equal(pools.gemini.weekly.remainingFraction, 0.04);
  assert.equal(pools.other.fiveHour.remainingFraction, 0.61);
  assert.equal(pools.other.weekly.remainingFraction, 0.44);
});

test('switches Gemini when its quota is low while keeping Claude on the same account', async () => {
  const accounts = [{ id: 'one' }, { id: 'two' }];
  const byAccount = { one: quotas, two: { buckets: [
    { id: 'gemini-5h', remainingFraction: 0.81 },
    { id: 'gemini-weekly', remainingFraction: 0.64 },
    { id: '3p-5h', remainingFraction: 0.02 },
    { id: '3p-weekly', remainingFraction: 0.03 },
  ] } };
  const readQuota = account => byAccount[account.id];
  assert.equal((await chooseAccountForModel(accounts, 'gemini-3.8-flash', 10, readQuota)).account.id, 'two');
  assert.equal((await chooseAccountForModel(accounts, 'claude-sonnet', 10, readQuota)).account.id, 'one');
});

test('unknown active quota keeps its account; synthetic low quota selects another', async () => {
  const accounts = [{ id: 'one' }, { id: 'two' }];
  assert.equal((await chooseAccountForModel(accounts, 'gemini-3.8-flash', 10, () => null)).account.id, 'one');
  assert.equal((await chooseAccountForModel(accounts, 'gemini-3.8-flash', 10, () => null, true)).account.id, 'two');
});

test('a Gemini helper switch does not change the Claude account preference', () => {
  const accounts = [{ id: 'one' }, { id: 'two' }];
  const byGroup = { gemini: 'two' };
  assert.equal(isAuxiliaryModel('gemini-3.5-flash-lite'), true);
  assert.equal(isAuxiliaryModel('claude-opus-4-6-thinking'), false);
  assert.equal(orderAccountsForGroup(accounts, 'one', byGroup, 'gemini')[0].id, 'two');
  assert.equal(orderAccountsForGroup(accounts, 'one', byGroup, '3p')[0].id, 'one');
});

test('reads model from generation request and parses weekly reset delays', () => {
  assert.equal(requestedModel('/v1internal:streamGenerateContent?alt=sse', Buffer.from('{"model":"models/Gemini-3.8-Flash"}')), 'gemini-3.8-flash');
  assert.equal(requestedModel('/v1internal:loadCodeAssist', Buffer.from('{"model":"gemini-3.8-flash"}')), null);
  assert.equal(quotaResetMs('Individual quota reached. Resets in 1w2d3h4m5s.'),
    ((7 + 2) * 24 * 3600 + 3 * 3600 + 4 * 60 + 5) * 1000);
});

test('extractUsageMetadata parses prompt and candidate token counts from chunks', () => {
  const sseChunk = 'data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "Hello"}]}}],"usageMetadata": {"promptTokenCount": 42,"candidatesTokenCount": 18,"totalTokenCount": 60}}}';
  const meta = extractUsageMetadata(sseChunk);
  assert.deepEqual(meta, { promptTokens: 42, candidatesTokens: 18, totalTokens: 60 });
  assert.equal(extractUsageMetadata('data: {"response": {}}'), null);
});

test('estimateTokensFromText and estimatePromptTokens provide fallback token metrics', () => {
  assert.equal(estimateTokensFromText('Hello world!'), 3);
  assert.equal(estimateTokensFromText(''), 0);

  const req = Buffer.from(JSON.stringify({
    contents: [
      { parts: [{ text: '12345678' }] }
    ]
  }));
  assert.equal(estimatePromptTokens(req), 2);
  assert.equal(estimatePromptTokens(Buffer.from('{}')), 0);
});

test('formatQuotaWindow differentiates confirmed, not_provided, and blocked states', () => {
  const confirmed = formatQuotaWindow({ remainingFraction: 0.85, resetTime: '2026-10-26T00:00:00Z' });
  assert.deepEqual(confirmed, { percent: 85, resetTime: '2026-10-26T00:00:00Z', status: 'confirmed' });

  const notProvided = formatQuotaWindow(null);
  assert.deepEqual(notProvided, { percent: null, resetTime: null, status: 'not_provided' });

  const future = Date.now() + 60000;
  const blocked = formatQuotaWindow({ remainingFraction: 1.0 }, future);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.percent, 0);
});

test('classifyQuotaError correctly categorizes HTTP codes and network failures', () => {
  assert.equal(classifyQuotaError({ statusCode: 401 }), 'auth_expired');
  assert.equal(classifyQuotaError({ statusCode: 403 }), 'permission_denied');
  assert.equal(classifyQuotaError({ statusCode: 429 }), 'rate_limited');
  assert.equal(classifyQuotaError({ message: 'Google request timed out.' }), 'network_error');
  assert.equal(classifyQuotaError({ message: 'connect ETIMEDOUT 142.250.190.42:443' }), 'network_error');
  assert.equal(classifyQuotaError({ statusCode: 500 }), 'api_error');
});
