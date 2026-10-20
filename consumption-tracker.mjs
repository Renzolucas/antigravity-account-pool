import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createConsumptionTracker(options = {}) {
  const dataDir = options.dataDir || process.cwd();
  const filePath = path.join(dataDir, options.filename || 'consumption.json');

  let state = {
    version: 2,
    accounts: {},
    switchEvents: [],
    lastRequest: null,
    processedRequestIds: [],
  };

  let seenRequestIds = new Set();
  let saveQueue = Promise.resolve();
  let saveTimer = null;

  async function load() {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.version = parsed.version || 2;
        state.accounts = parsed.accounts || {};
        state.switchEvents = Array.isArray(parsed.switchEvents) ? parsed.switchEvents : [];
        state.lastRequest = parsed.lastRequest || null;
        state.processedRequestIds = Array.isArray(parsed.processedRequestIds) ? parsed.processedRequestIds : [];
        seenRequestIds = new Set(state.processedRequestIds);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`Failed to load consumption data: ${err.message}\n`);
      }
    }
  }

  function queueSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow().catch(err => {
        process.stderr.write(`Failed to save consumption data: ${err.message}\n`);
      });
    }, 1000);
  }

  async function saveNow() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const out = JSON.stringify(state, null, 2);
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const tempPath = `${filePath}.tmp`;
      await fs.writeFile(tempPath, out, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tempPath, filePath);
    });
    return saveQueue;
  }

  function ensureAccount(accountId) {
    if (!state.accounts[accountId]) {
      state.accounts[accountId] = {
        requests: 0,
        tokens: {
          promptExact: 0,
          candidatesExact: 0,
          promptEstimated: 0,
          candidatesEstimated: 0,
        },
        models: {},
        recentRequests: [],
      };
    }
    return state.accounts[accountId];
  }

  function recordRequest({
    requestId,
    accountId,
    model,
    promptTokens = 0,
    candidatesTokens = 0,
    isExact = false,
    statusCode = 200,
    durationMs = 0
  }) {
    if (!accountId) return;
    const reqId = requestId || randomUUID();

    // Deduplication: ignore duplicate request IDs
    if (seenRequestIds.has(reqId)) {
      return;
    }
    seenRequestIds.add(reqId);
    state.processedRequestIds.push(reqId);
    if (state.processedRequestIds.length > 1000) {
      const removed = state.processedRequestIds.shift();
      seenRequestIds.delete(removed);
    }

    const acc = ensureAccount(accountId);
    const pTokens = Math.max(0, Math.round(Number(promptTokens) || 0));
    const cTokens = Math.max(0, Math.round(Number(candidatesTokens) || 0));
    const now = new Date().toISOString();

    acc.requests += 1;
    if (isExact) {
      acc.tokens.promptExact += pTokens;
      acc.tokens.candidatesExact += cTokens;
    } else {
      acc.tokens.promptEstimated += pTokens;
      acc.tokens.candidatesEstimated += cTokens;
    }

    if (model) {
      if (!acc.models[model]) {
        acc.models[model] = { requests: 0, exactTokens: 0, estimatedTokens: 0 };
      }
      acc.models[model].requests += 1;
      if (isExact) {
        acc.models[model].exactTokens += (pTokens + cTokens);
      } else {
        acc.models[model].estimatedTokens += (pTokens + cTokens);
      }
    }

    const reqRecord = {
      id: reqId,
      at: now,
      accountId,
      model: model || 'unknown',
      promptTokens: pTokens,
      candidatesTokens: cTokens,
      totalTokens: pTokens + cTokens,
      isExact: !!isExact,
      statusCode: Number(statusCode) || 200,
      durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    };

    state.lastRequest = reqRecord;

    acc.recentRequests.unshift(reqRecord);
    if (acc.recentRequests.length > 100) {
      acc.recentRequests = acc.recentRequests.slice(0, 100);
    }

    queueSave();
  }

  function recordSwitch({ model, fromAccountId, toAccountId, reason, message }) {
    const event = {
      at: new Date().toISOString(),
      model: model || null,
      fromAccountId: fromAccountId || null,
      toAccountId: toAccountId || null,
      reason: reason || 'switch',
      message: message || '',
    };
    state.switchEvents.unshift(event);
    if (state.switchEvents.length > 40) {
      state.switchEvents = state.switchEvents.slice(0, 40);
    }
    queueSave();
  }

  function getAccountConsumption(accountId) {
    const acc = state.accounts[accountId];
    if (!acc) {
      return {
        requests: 0,
        promptTokens: 0,
        candidatesTokens: 0,
        totalTokens: 0,
        exactTokens: 0,
        estimatedTokens: 0,
        promptExact: 0,
        candidatesExact: 0,
        promptEstimated: 0,
        candidatesEstimated: 0,
        isAllExact: false,
        isPartiallyEstimated: false,
        isAllEstimated: false,
        lastRequest: null,
        lastHour: { requests: 0, promptTokens: 0, candidatesTokens: 0, tokens: 0 },
        today: { requests: 0, promptTokens: 0, candidatesTokens: 0, tokens: 0 },
        allTime: { requests: 0, promptTokens: 0, candidatesTokens: 0, tokens: 0 },
        models: {},
        recentRequests: [],
      };
    }

    const promptTokens = acc.tokens.promptExact + acc.tokens.promptEstimated;
    const candidatesTokens = acc.tokens.candidatesExact + acc.tokens.candidatesEstimated;
    const exactTokens = acc.tokens.promptExact + acc.tokens.candidatesExact;
    const estimatedTokens = acc.tokens.promptEstimated + acc.tokens.candidatesEstimated;
    const totalTokens = promptTokens + candidatesTokens;

    const now = Date.now();
    const oneHourAgo = now - 3600_000;
    const startOfToday = new Date().setHours(0, 0, 0, 0);

    let lastHourRequests = 0;
    let lastHourPrompt = 0;
    let lastHourCandidates = 0;

    let todayRequests = 0;
    let todayPrompt = 0;
    let todayCandidates = 0;

    for (const req of acc.recentRequests) {
      const t = Date.parse(req.at);
      if (t >= oneHourAgo) {
        lastHourRequests += 1;
        lastHourPrompt += (req.promptTokens || 0);
        lastHourCandidates += (req.candidatesTokens || 0);
      }
      if (t >= startOfToday) {
        todayRequests += 1;
        todayPrompt += (req.promptTokens || 0);
        todayCandidates += (req.candidatesTokens || 0);
      }
    }

    return {
      requests: acc.requests,
      promptTokens,
      candidatesTokens,
      totalTokens,
      exactTokens,
      estimatedTokens,
      promptExact: acc.tokens.promptExact,
      candidatesExact: acc.tokens.candidatesExact,
      promptEstimated: acc.tokens.promptEstimated,
      candidatesEstimated: acc.tokens.candidatesEstimated,
      isAllExact: estimatedTokens === 0 && exactTokens > 0,
      isPartiallyEstimated: estimatedTokens > 0 && exactTokens > 0,
      isAllEstimated: exactTokens === 0 && estimatedTokens > 0,
      lastRequest: acc.recentRequests[0] || null,
      lastHour: {
        requests: lastHourRequests,
        promptTokens: lastHourPrompt,
        candidatesTokens: lastHourCandidates,
        tokens: lastHourPrompt + lastHourCandidates,
      },
      today: {
        requests: todayRequests,
        promptTokens: todayPrompt,
        candidatesTokens: todayCandidates,
        tokens: todayPrompt + todayCandidates,
      },
      allTime: {
        requests: acc.requests,
        promptTokens,
        candidatesTokens,
        tokens: totalTokens,
      },
      models: acc.models,
      recentRequests: acc.recentRequests.slice(0, 10),
    };
  }

  function getTotals() {
    let requests = 0;
    let exactTokens = 0;
    let estimatedTokens = 0;
    let promptTokens = 0;
    let candidatesTokens = 0;

    let lastHourRequests = 0;
    let lastHourPrompt = 0;
    let lastHourCandidates = 0;

    let todayRequests = 0;
    let todayPrompt = 0;
    let todayCandidates = 0;

    for (const accountId of Object.keys(state.accounts)) {
      const accCons = getAccountConsumption(accountId);
      requests += accCons.requests;
      exactTokens += accCons.exactTokens;
      estimatedTokens += accCons.estimatedTokens;
      promptTokens += accCons.promptTokens;
      candidatesTokens += accCons.candidatesTokens;

      lastHourRequests += accCons.lastHour.requests;
      lastHourPrompt += accCons.lastHour.promptTokens;
      lastHourCandidates += accCons.lastHour.candidatesTokens;

      todayRequests += accCons.today.requests;
      todayPrompt += accCons.today.promptTokens;
      todayCandidates += accCons.today.candidatesTokens;
    }

    return {
      requests,
      promptTokens,
      candidatesTokens,
      exactTokens,
      estimatedTokens,
      totalTokens: exactTokens + estimatedTokens,
      lastRequest: state.lastRequest || null,
      lastHour: {
        requests: lastHourRequests,
        promptTokens: lastHourPrompt,
        candidatesTokens: lastHourCandidates,
        tokens: lastHourPrompt + lastHourCandidates,
      },
      today: {
        requests: todayRequests,
        promptTokens: todayPrompt,
        candidatesTokens: todayCandidates,
        tokens: todayPrompt + todayCandidates,
      },
      allTime: {
        requests,
        promptTokens,
        candidatesTokens,
        tokens: exactTokens + estimatedTokens,
      },
      lastHourRequests,
      lastHourTokens: lastHourPrompt + lastHourCandidates,
      todayRequests,
      todayTokens: todayPrompt + todayCandidates,
      switchEvents: state.switchEvents.slice(0, 15),
    };
  }

  function deleteAccount(accountId) {
    if (state.accounts[accountId]) {
      delete state.accounts[accountId];
      queueSave();
    }
  }

  return {
    load,
    saveNow,
    recordRequest,
    recordSwitch,
    getAccountConsumption,
    getTotals,
    deleteAccount,
    getState: () => state,
  };
}
