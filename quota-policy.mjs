export function canonicalModel(value) {
  if (typeof value !== 'string') return null;
  const model = value.trim().replace(/^models\//i, '').toLowerCase();
  return model || null;
}

export function quotaGroup(modelId) {
  const model = canonicalModel(modelId);
  if (model?.startsWith('gemini')) return 'gemini';
  if (model?.startsWith('claude') || model?.startsWith('gpt')) return '3p';
  return model;
}

export function isAuxiliaryModel(modelId) {
  return /(?:^|[-_])lite(?:$|[-_])/.test(canonicalModel(modelId) || '');
}

export function orderAccountsForGroup(accounts, defaultId, activeByGroup, group) {
  const preferredId = (group && activeByGroup[group]) || defaultId;
  const preferred = accounts.find(account => account.id === preferredId);
  return preferred ? [preferred, ...accounts.filter(account => account.id !== preferredId)] : accounts;
}

export function requestedModel(url, body) {
  if (!/:(?:streamGenerateContent|generateContent)(?:\?|$)/.test(url)) return null;
  try {
    const request = JSON.parse(body.toString('utf8'));
    return canonicalModel(request.model || request.request?.model);
  } catch { return null; }
}

export function quotaBuckets(payload) {
  const buckets = [];
  const bucketId = value => typeof value === 'string' && /^(?:gemini|3p)-(?:5h|weekly)$/i.test(value);
  function visit(value, inheritedModel, depth) {
    if (!value || depth > 8) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedModel, depth + 1);
    } else if (typeof value === 'object') {
      const identity = [value.id, value.bucketId, value.quotaBucketId].find(bucketId);
      const model = canonicalModel(value.modelId || value.modelName || value.model || identity) || inheritedModel;
      const rawFraction = value.remainingFraction ?? value.remaining_fraction ??
        value.remaining?.remainingFraction ??
        (value.remaining?.case === 'remainingFraction' ? value.remaining.value : null);
      const fraction = Number(rawFraction);
      if (rawFraction != null && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 && model) {
        buckets.push({ modelId: model, remainingFraction: fraction,
          resetTime: typeof (value.resetTime || value.reset_time) === 'string' ?
            (value.resetTime || value.reset_time) : null });
      }
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === 'object') {
          const keyedModel = /^(?:models\/)?(?:gemini|claude|gpt|3p)[\w.\-]+$/i.test(key) ? canonicalModel(key) : model;
          visit(item, keyedModel, depth + 1);
        }
      }
    }
  }
  visit(payload, null, 0);
  return buckets;
}

export function quotaWindowsForModel(payload, modelId) {
  const model = canonicalModel(modelId);
  if (!model) return [];
  const group = quotaGroup(model);
  const allowed = new Set([model]);
  if (group === 'gemini' || group === '3p') {
    allowed.add(`${group}-5h`);
    allowed.add(`${group}-weekly`);
  }
  return quotaBuckets(payload).filter(bucket => allowed.has(bucket.modelId));
}

export function quotaPools(payload) {
  const buckets = quotaBuckets(payload);
  function windowFor(id) {
    const matches = buckets.filter(bucket => bucket.modelId === id);
    if (!matches.length) return null;
    const lowest = matches.reduce((left, right) =>
      right.remainingFraction < left.remainingFraction ? right : left);
    return { remainingFraction: lowest.remainingFraction, resetTime: lowest.resetTime };
  }
  return {
    gemini: { fiveHour: windowFor('gemini-5h'), weekly: windowFor('gemini-weekly') },
    other: { fiveHour: windowFor('3p-5h'), weekly: windowFor('3p-weekly') },
  };
}

export function quotaForModel(payload, modelId) {
  const matches = quotaWindowsForModel(payload, modelId);
  if (!matches.length) return null;
  return matches.reduce((lowest, bucket) =>
    bucket.remainingFraction < lowest.remainingFraction ? bucket : lowest);
}

export async function chooseAccountForModel(candidates, model, thresholdPercent, readQuota, simulateLow = false) {
  if (!model || thresholdPercent <= 0 || candidates.length < 2) return { account: candidates[0] };
  let unknown = null;
  let bestLow = null;
  let firstLow = null;
  const threshold = thresholdPercent / 100;
  for (const [index, account] of candidates.entries()) {
    const quota = simulateLow && index === 0
      ? { remainingFraction: 0 }
      : quotaForModel(await readQuota(account), model);
    if (!quota) {
      if (index === 0) return { account };
      unknown ||= account;
      continue;
    }
    if (quota.remainingFraction > threshold) return { account, firstLow, preferredId: candidates[0].id };
    if (index === 0) firstLow = quota.remainingFraction;
    if (!bestLow || quota.remainingFraction > bestLow.quota.remainingFraction) bestLow = { account, quota };
  }
  return { account: unknown || bestLow?.account || candidates[0], firstLow, preferredId: candidates[0].id };
}

export function quotaResetMs(message) {
  const match = String(message).match(/Resets? in\s+(?:(\d+)w)?\s*(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (!match || !/\d/.test(match[0])) return 5 * 60_000;
  const seconds = Number(match[1] || 0) * 604800 + Number(match[2] || 0) * 86400 +
    Number(match[3] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[5] || 0);
  return Math.max(60_000, seconds * 1000);
}

export function extractUsageMetadata(text) {
  if (typeof text !== 'string') return null;
  const marker = '"usageMetadata"';
  let lastMeta = null;
  let idx = text.indexOf(marker);

  while (idx !== -1) {
    const braceStart = text.indexOf('{', idx + marker.length);
    if (braceStart === -1) break;

    let depth = 1;
    let endIdx = -1;
    let inString = false;
    let escape = false;

    for (let i = braceStart + 1; i < text.length; i++) {
      const char = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            endIdx = i;
            break;
          }
        }
      }
    }

    const jsonStr = endIdx !== -1 ? text.slice(braceStart, endIdx + 1) : text.slice(braceStart);
    try {
      const parsed = JSON.parse(jsonStr);
      const promptTokens = Number(parsed.promptTokenCount) || 0;
      const candidatesTokens = Number(parsed.candidatesTokenCount) || 0;
      const totalTokens = Number(parsed.totalTokenCount) || (promptTokens + candidatesTokens);
      if (parsed.promptTokenCount != null || parsed.candidatesTokenCount != null || parsed.totalTokenCount != null) {
        lastMeta = { promptTokens, candidatesTokens, totalTokens };
      }
    } catch {
      const pMatch = jsonStr.match(/"promptTokenCount"\s*:\s*(\d+)/);
      const cMatch = jsonStr.match(/"candidatesTokenCount"\s*:\s*(\d+)/);
      const tMatch = jsonStr.match(/"totalTokenCount"\s*:\s*(\d+)/);
      if (pMatch || cMatch || tMatch) {
        const promptTokens = pMatch ? Number(pMatch[1]) : 0;
        const candidatesTokens = cMatch ? Number(cMatch[1]) : 0;
        const totalTokens = tMatch ? Number(tMatch[1]) : (promptTokens + candidatesTokens);
        lastMeta = { promptTokens, candidatesTokens, totalTokens };
      }
    }

    if (endIdx === -1) break;
    idx = text.indexOf(marker, endIdx + 1);
  }

  return lastMeta;
}

export function estimateTokensFromText(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimatePromptTokens(requestBody) {
  try {
    const parsed = typeof requestBody === 'string' ? JSON.parse(requestBody) : JSON.parse(requestBody.toString('utf8'));
    const contents = parsed.contents || parsed.request?.contents || [];
    let chars = 0;
    if (Array.isArray(contents)) {
      for (const item of contents) {
        if (Array.isArray(item.parts)) {
          for (const p of item.parts) {
            if (typeof p.text === 'string') chars += p.text.length;
          }
        }
      }
    }
    if (chars === 0) return 0;
    return Math.max(1, Math.ceil(chars / 4));
  } catch {
    return 0;
  }
}

export function formatQuotaWindow(window, blockedUntilMs = 0) {
  const now = Date.now();
  if (blockedUntilMs && Number(blockedUntilMs) > now) {
    return {
      percent: 0,
      resetTime: new Date(Number(blockedUntilMs)).toISOString(),
      status: 'blocked'
    };
  }
  if (!window || window.remainingFraction == null) {
    return {
      percent: null,
      resetTime: null,
      status: 'not_provided'
    };
  }
  return {
    percent: Math.max(0, Math.min(100, Math.round(window.remainingFraction * 100))),
    resetTime: window.resetTime || null,
    status: 'confirmed'
  };
}

export function classifyQuotaError(error) {
  const code = error?.statusCode || error?.status || 0;
  if (code === 401) return 'auth_expired';
  if (code === 403) return 'permission_denied';
  if (code === 429) return 'rate_limited';
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|timed out/i.test(error?.message || '')) return 'network_error';
  return 'api_error';
}
