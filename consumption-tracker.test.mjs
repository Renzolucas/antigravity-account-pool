import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createConsumptionTracker } from './consumption-tracker.mjs';
import { extractUsageMetadata, estimatePromptTokens, estimateTokensFromText } from './quota-policy.mjs';

test('1. Uma requisição com poucos tokens', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-few-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    await tracker.load();

    tracker.recordRequest({
      requestId: 'req-few-1',
      accountId: 'acc-1',
      model: 'gemini-2.5-flash',
      promptTokens: 15,
      candidatesTokens: 6,
      isExact: true,
      statusCode: 200,
      durationMs: 150,
    });

    const cons = tracker.getAccountConsumption('acc-1');
    assert.equal(cons.requests, 1);
    assert.equal(cons.promptTokens, 15);
    assert.equal(cons.candidatesTokens, 6);
    assert.equal(cons.totalTokens, 21);
    assert.equal(cons.exactTokens, 21);
    assert.equal(cons.estimatedTokens, 0);
    assert.equal(cons.isAllExact, true);

    const totals = tracker.getTotals();
    assert.equal(totals.requests, 1);
    assert.equal(totals.promptTokens, 15);
    assert.equal(totals.candidatesTokens, 6);
    assert.equal(totals.totalTokens, 21);
    assert.equal(totals.lastRequest?.promptTokens, 15);
    assert.equal(totals.lastRequest?.candidatesTokens, 6);
    assert.equal(totals.lastRequest?.totalTokens, 21);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2. Uma requisição com contexto grande', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-large-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    await tracker.load();

    // Cenário real observado: prompt curto ('ola') com contexto acumulado/system instructions de 36.000 tokens
    tracker.recordRequest({
      requestId: 'req-large-ctx-1',
      accountId: 'acc-1',
      model: 'gemini-2.5-pro',
      promptTokens: 36000,
      candidatesTokens: 184,
      isExact: true,
      statusCode: 200,
      durationMs: 1100,
    });

    const cons = tracker.getAccountConsumption('acc-1');
    assert.equal(cons.requests, 1);
    assert.equal(cons.promptTokens, 36000, 'Contexto de entrada deve ser registrado separadamente');
    assert.equal(cons.candidatesTokens, 184, 'Resposta gerada deve ser registrada separadamente');
    assert.equal(cons.totalTokens, 36184);

    const totals = tracker.getTotals();
    assert.equal(totals.lastRequest?.promptTokens, 36000);
    assert.equal(totals.lastRequest?.candidatesTokens, 184);
    assert.equal(totals.lastRequest?.totalTokens, 36184);
    assert.equal(totals.lastRequest?.isExact, true);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('3. Vários chunks SSE com metadados de uso', () => {
  // Simula chunks sucessivos do fluxo SSE do Gemini onde usageMetadata é enviado/atualizado
  const chunk1 = 'event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"O"}]}}],"usageMetadata":{"promptTokenCount":36000,"candidatesTokenCount":5,"totalTokenCount":36005}}}\n\n';
  const chunk2 = 'event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"lá"}]}}],"usageMetadata":{"promptTokenCount":36000,"candidatesTokenCount":80,"totalTokenCount":36080}}}\n\n';
  const chunk3 = 'event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"! Como posso ajudar?"}]}}],"usageMetadata":{"promptTokenCount":36000,"candidatesTokenCount":184,"totalTokenCount":36184}}}\n\n';

  // Chunk a chunk (como ocorre no listener do servidor)
  let usageMeta = null;
  for (const chunk of [chunk1, chunk2, chunk3]) {
    const meta = extractUsageMetadata(chunk);
    if (meta) {
      usageMeta = meta;
    }
  }

  assert.ok(usageMeta);
  assert.equal(usageMeta.promptTokens, 36000);
  assert.equal(usageMeta.candidatesTokens, 184, 'Deve refletir a contagem final mais completa');
  assert.equal(usageMeta.totalTokens, 36184);

  // Também quando todos os chunks estão concatenados no mesmo buffer
  const combined = chunk1 + chunk2 + chunk3;
  const combinedMeta = extractUsageMetadata(combined);
  assert.equal(combinedMeta.candidatesTokens, 184, 'Deve extrair a última ocorrência quando múltiplos eventos estão no buffer');
});

test('4. Metadados de uso ausentes', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-missing-meta-'));
  try {
    const chunkWithoutUsage = 'event: message\ndata: {"response":{"candidates":[{"content":{"parts":[{"text":"Olá!"}]}}]}}\n\n';
    assert.equal(extractUsageMetadata(chunkWithoutUsage), null);

    // Fallback seguro via estimativa
    const body = Buffer.from(JSON.stringify({
      contents: [{ parts: [{ text: 'Mensagem de teste para o modelo' }] }]
    }));
    const estimatedPrompt = estimatePromptTokens(body);
    const estimatedOutput = estimateTokensFromText('Olá! Como posso ajudar?');

    assert.ok(estimatedPrompt > 0);
    assert.ok(estimatedOutput > 0);

    // Testar registro com fallback no tracker
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    tracker.recordRequest({
      requestId: 'req-estimated-1',
      accountId: 'acc-1',
      model: 'claude-3-7-sonnet',
      promptTokens: estimatedPrompt,
      candidatesTokens: estimatedOutput,
      isExact: false,
    });

    const cons = tracker.getAccountConsumption('acc-1');
    assert.equal(cons.isAllEstimated, true);
    assert.equal(cons.isAllExact, false);
    assert.equal(cons.exactTokens, 0);
    assert.equal(cons.estimatedTokens, estimatedPrompt + estimatedOutput);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('5. Respostas repetidas ou eventos duplicados', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-dup-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    await tracker.load();

    const requestPayload = {
      requestId: 'req-duplicate-uuid-1234',
      accountId: 'acc-1',
      model: 'gemini-2.5-pro',
      promptTokens: 1000,
      candidatesTokens: 200,
      isExact: true,
      statusCode: 200,
      durationMs: 400,
    };

    // Chamada inicial
    tracker.recordRequest(requestPayload);

    // Chamada duplicada com o mesmo requestId
    tracker.recordRequest(requestPayload);
    tracker.recordRequest(requestPayload);

    const cons = tracker.getAccountConsumption('acc-1');
    assert.equal(cons.requests, 1, 'Requisição duplicada deve ser contabilizada exatamente uma vez');
    assert.equal(cons.promptTokens, 1000);
    assert.equal(cons.candidatesTokens, 200);
    assert.equal(cons.totalTokens, 1200);

    const totals = tracker.getTotals();
    assert.equal(totals.requests, 1);
    assert.equal(totals.totalTokens, 1200);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('6. Múltiplas contas e troca automática', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-multi-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    await tracker.load();

    // Conta 1 processa requisição
    tracker.recordRequest({
      requestId: 'req-acc1',
      accountId: 'acc-1',
      model: 'gemini-2.5-pro',
      promptTokens: 500,
      candidatesTokens: 100,
      isExact: true,
    });

    // Troca de conta ocorre devido a cota baixa ou esgotamento
    tracker.recordSwitch({
      model: 'gemini-2.5-pro',
      fromAccountId: 'acc-1',
      toAccountId: 'acc-2',
      reason: 'quota_exhausted',
      message: 'Rate limit 429 encountered, rotated to acc-2',
    });

    // Conta 2 processa a próxima requisição
    tracker.recordRequest({
      requestId: 'req-acc2',
      accountId: 'acc-2',
      model: 'gemini-2.5-pro',
      promptTokens: 800,
      candidatesTokens: 150,
      isExact: true,
    });

    const c1 = tracker.getAccountConsumption('acc-1');
    const c2 = tracker.getAccountConsumption('acc-2');
    const totals = tracker.getTotals();

    assert.equal(c1.requests, 1);
    assert.equal(c1.totalTokens, 600);
    assert.equal(c2.requests, 1);
    assert.equal(c2.totalTokens, 950);

    assert.equal(totals.requests, 2);
    assert.equal(totals.totalTokens, 1550);
    assert.equal(totals.switchEvents.length, 1);
    assert.equal(totals.switchEvents[0].fromAccountId, 'acc-1');
    assert.equal(totals.switchEvents[0].toAccountId, 'acc-2');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('7. Separação entre última requisição e total acumulado', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-last-vs-total-'));
  try {
    const tracker = createConsumptionTracker({ dataDir: tmpDir });
    await tracker.load();

    // Requisição 1: pequena
    tracker.recordRequest({
      requestId: 'req-order-1',
      accountId: 'acc-1',
      model: 'gemini-2.5-flash',
      promptTokens: 100,
      candidatesTokens: 20,
      isExact: true,
    });

    // Requisição 2: contexto grande
    tracker.recordRequest({
      requestId: 'req-order-2',
      accountId: 'acc-1',
      model: 'gemini-2.5-pro',
      promptTokens: 36000,
      candidatesTokens: 184,
      isExact: true,
    });

    const totals = tracker.getTotals();
    assert.equal(totals.requests, 2, 'Total acumulado deve registrar 2 requisições');
    assert.equal(totals.totalTokens, 36304, 'Total acumulado deve ser a soma de todas as requisições (120 + 36184)');

    // Última requisição reflete SOMENTE a requisição 2
    assert.equal(totals.lastRequest?.id, 'req-order-2');
    assert.equal(totals.lastRequest?.model, 'gemini-2.5-pro');
    assert.equal(totals.lastRequest?.promptTokens, 36000);
    assert.equal(totals.lastRequest?.candidatesTokens, 184);
    assert.equal(totals.lastRequest?.totalTokens, 36184);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('8. Persistência do histórico após reiniciar o servidor', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-test-persist-'));
  try {
    const tracker1 = createConsumptionTracker({ dataDir: tmpDir, filename: 'consumption.json' });
    await tracker1.load();

    tracker1.recordRequest({
      requestId: 'req-persist-initial',
      accountId: 'acc-saved',
      model: 'gemini-2.5-pro',
      promptTokens: 2500,
      candidatesTokens: 500,
      isExact: true,
    });

    await tracker1.saveNow();

    // Simula reinicialização do servidor: nova instância carregando do disco
    const tracker2 = createConsumptionTracker({ dataDir: tmpDir, filename: 'consumption.json' });
    await tracker2.load();

    const reloadedCons = tracker2.getAccountConsumption('acc-saved');
    assert.equal(reloadedCons.requests, 1);
    assert.equal(reloadedCons.promptTokens, 2500);
    assert.equal(reloadedCons.candidatesTokens, 500);
    assert.equal(reloadedCons.totalTokens, 3000);

    const totals = tracker2.getTotals();
    assert.equal(totals.requests, 1);
    assert.equal(totals.totalTokens, 3000);
    assert.equal(totals.lastRequest?.id, 'req-persist-initial');

    // Tentar reenviar a requisição salva não deve duplicá-la
    tracker2.recordRequest({
      requestId: 'req-persist-initial',
      accountId: 'acc-saved',
      model: 'gemini-2.5-pro',
      promptTokens: 2500,
      candidatesTokens: 500,
      isExact: true,
    });

    assert.equal(tracker2.getAccountConsumption('acc-saved').requests, 1, 'Deduplicação deve persistir após reinicialização');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
