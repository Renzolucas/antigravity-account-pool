import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quotaBuckets,
  quotaPools,
  quotaForModel,
  formatQuotaWindow,
  classifyQuotaError,
  extractUsageMetadata,
  estimateTokensFromText,
  estimatePromptTokens,
} from './quota-policy.mjs';
import { createConsumptionTracker } from './consumption-tracker.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('Google aicode-consumers quota payload with only 3p-weekly formats accurately', () => {
  // Real response returned by Google for consumer tier
  const googlePayload = {
    buckets: [
      {
        modelId: '3p-weekly',
        remainingFraction: 1.0,
        resetTime: '2026-10-26T17:07:08.572421Z',
      },
    ],
  };

  const pools = quotaPools(googlePayload);
  assert.equal(pools.other.weekly.remainingFraction, 1.0);
  assert.equal(pools.other.fiveHour, null);
  assert.equal(pools.gemini.weekly, null);
  assert.equal(pools.gemini.fiveHour, null);

  // Formatted windows for account
  const formattedOtherWeek = formatQuotaWindow(pools.other.weekly);
  assert.deepEqual(formattedOtherWeek, {
    percent: 100,
    resetTime: '2026-10-26T17:07:08.572421Z',
    status: 'confirmed',
  });

  const formattedOtherFive = formatQuotaWindow(pools.other.fiveHour);
  assert.deepEqual(formattedOtherFive, {
    percent: null,
    resetTime: null,
    status: 'not_provided',
  });

  const formattedGeminiFive = formatQuotaWindow(pools.gemini.fiveHour);
  assert.deepEqual(formattedGeminiFive, {
    percent: null,
    resetTime: null,
    status: 'not_provided',
  });
});

test('Rate limited account overrides quota window with blocked status and countdown', () => {
  const googlePayload = {
    buckets: [
      {
        modelId: '3p-weekly',
        remainingFraction: 1.0,
        resetTime: '2026-10-26T17:07:08.572421Z',
      },
    ],
  };
  const pools = quotaPools(googlePayload);

  const blockedUntil = Date.now() + 180_000;
  const blockedWindow = formatQuotaWindow(pools.other.weekly, blockedUntil);

  assert.equal(blockedWindow.status, 'blocked');
  assert.equal(blockedWindow.percent, 0);
  assert.equal(new Date(blockedWindow.resetTime).getTime(), blockedUntil);
});

test('Error classification identifies all Google API failure modes', () => {
  assert.equal(classifyQuotaError({ statusCode: 401 }), 'auth_expired');
  assert.equal(classifyQuotaError({ statusCode: 403 }), 'permission_denied');
  assert.equal(classifyQuotaError({ statusCode: 429 }), 'rate_limited');
  assert.equal(classifyQuotaError({ message: 'Google request timed out.' }), 'network_error');
  assert.equal(classifyQuotaError({ message: 'connect ECONNRESET 142.250.190.42:443' }), 'network_error');
  assert.equal(classifyQuotaError({ message: 'getaddrinfo ENOTFOUND daily-cloudcode-pa.sandbox.googleapis.com' }), 'network_error');
  assert.equal(classifyQuotaError({ statusCode: 502 }), 'api_error');
});

test('Streaming SSE token extraction vs heuristic estimation separation', () => {
  const officialChunk = `event: message\ndata: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello!"}]}}],"usageMetadata":{"promptTokenCount":350,"candidatesTokenCount":45,"totalTokenCount":395}}}\n\n`;

  const meta = extractUsageMetadata(officialChunk);
  assert.ok(meta);
  assert.equal(meta.promptTokens, 350);
  assert.equal(meta.candidatesTokens, 45);
  assert.equal(meta.totalTokens, 395);

  // Missing usage metadata fallback
  const fallbackReq = Buffer.from(JSON.stringify({
    contents: [{ parts: [{ text: 'Explain quantum computing in one short paragraph.' }] }]
  }));
  const estPrompt = estimatePromptTokens(fallbackReq);
  const estOutput = estimateTokensFromText('Quantum computing harnesses quantum mechanics.');

  assert.ok(estPrompt > 0);
  assert.ok(estOutput > 0);
});

test('Consumption tracker maintains isolated account usage and switch history', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-full-test-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir, filename: 'test-cons.json' });
    await tracker.load();

    // Account 1: exact usage
    tracker.recordRequest({
      accountId: 'acc-1',
      model: 'gemini-2.5-pro',
      promptTokens: 500,
      candidatesTokens: 100,
      isExact: true,
      statusCode: 200,
      durationMs: 400,
    });

    // Account 2: estimated usage
    tracker.recordRequest({
      accountId: 'acc-2',
      model: 'claude-3-7-sonnet',
      promptTokens: 250,
      candidatesTokens: 50,
      isExact: false,
      statusCode: 200,
      durationMs: 700,
    });

    // Switch event
    tracker.recordSwitch({
      model: 'gemini-2.5-pro',
      fromAccountId: 'acc-1',
      toAccountId: 'acc-2',
      reason: 'quota_exhausted',
      message: 'Individual quota reached. Resets in 5m',
    });

    const a1 = tracker.getAccountConsumption('acc-1');
    const a2 = tracker.getAccountConsumption('acc-2');
    const totals = tracker.getTotals();

    assert.equal(a1.requests, 1);
    assert.equal(a1.exactTokens, 600);
    assert.equal(a1.estimatedTokens, 0);
    assert.equal(a1.isAllExact, true);

    assert.equal(a2.requests, 1);
    assert.equal(a2.exactTokens, 0);
    assert.equal(a2.estimatedTokens, 300);
    assert.equal(a2.isAllEstimated, true);

    assert.equal(totals.requests, 2);
    assert.equal(totals.exactTokens, 600);
    assert.equal(totals.estimatedTokens, 300);
    assert.equal(totals.totalTokens, 900);
    assert.equal(totals.switchEvents.length, 1);
    assert.equal(totals.switchEvents[0].fromAccountId, 'acc-1');
    assert.equal(totals.switchEvents[0].toAccountId, 'acc-2');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Quota cache isolation and deduplication logic', async () => {
  const quotaCache = new Map();
  const quotaChecks = new Map();
  let fetchCountA = 0;
  let fetchCountB = 0;

  async function mockFetch(account) {
    if (account.id === 'acc-A') {
      fetchCountA++;
      await new Promise(r => setTimeout(r, 20));
      return { buckets: [{ modelId: '3p-weekly', remainingFraction: 0.85 }] };
    }
    if (account.id === 'acc-B') {
      fetchCountB++;
      await new Promise(r => setTimeout(r, 20));
      const err = new Error('HTTP 401');
      err.statusCode = 401;
      throw err;
    }
    return null;
  }

  async function checkedQuotaMock(account, force = false) {
    const cached = quotaCache.get(account.id);
    const age = cached ? Date.now() - cached.checkedAt : Infinity;
    if (!force && cached && age < (cached.error ? 60_000 : 5_000)) return cached.payload;
    if (quotaChecks.has(account.id)) return quotaChecks.get(account.id);

    const task = (async () => {
      try {
        const payload = await mockFetch(account);
        quotaCache.set(account.id, { payload, checkedAt: Date.now(), error: null });
        return payload;
      } catch (error) {
        const errInfo = {
          code: error.statusCode || 0,
          type: classifyQuotaError(error),
          message: error.message,
          checkedAt: Date.now(),
        };
        quotaCache.set(account.id, { payload: null, checkedAt: Date.now(), error: errInfo });
        return null;
      }
    })();

    quotaChecks.set(account.id, task);
    try {
      return await task;
    } finally {
      quotaChecks.delete(account.id);
    }
  }

  // Simultaneous calls for acc-A should deduplicate into 1 fetch
  const [resA1, resA2, resA3] = await Promise.all([
    checkedQuotaMock({ id: 'acc-A' }),
    checkedQuotaMock({ id: 'acc-A' }),
    checkedQuotaMock({ id: 'acc-A' }),
  ]);

  assert.equal(fetchCountA, 1, 'Concurrent calls to acc-A must be deduplicated into a single network call');
  assert.equal(resA1.buckets[0].remainingFraction, 0.85);
  assert.equal(resA2.buckets[0].remainingFraction, 0.85);
  assert.equal(resA3.buckets[0].remainingFraction, 0.85);

  // acc-B fails with 401, must not affect acc-A
  const resB = await checkedQuotaMock({ id: 'acc-B' });
  assert.equal(resB, null);
  assert.equal(fetchCountB, 1);

  // Check cache isolation
  const cachedA = quotaCache.get('acc-A');
  const cachedB = quotaCache.get('acc-B');

  assert.ok(cachedA.payload);
  assert.equal(cachedA.error, null);
  assert.equal(cachedB.payload, null);
  assert.ok(cachedB.error);
  assert.equal(cachedB.error.type, 'auth_expired');
  assert.equal(cachedB.error.code, 401);
});

