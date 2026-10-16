import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

test('locales are valid, complete, and symmetric', async () => {
  const enRaw = await fs.readFile(path.join(root, 'public', 'locales', 'en.json'), 'utf8');
  const ptRaw = await fs.readFile(path.join(root, 'public', 'locales', 'pt-BR.json'), 'utf8');

  const en = JSON.parse(enRaw);
  const pt = JSON.parse(ptRaw);

  function getKeys(obj, prefix = '') {
    const keys = [];
    for (const [k, v] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        keys.push(...getKeys(v, fullKey));
      } else {
        keys.push(fullKey);
      }
    }
    return keys;
  }

  const enKeys = getKeys(en).sort();
  const ptKeys = getKeys(pt).sort();

  assert.deepEqual(ptKeys, enKeys, 'pt-BR keys must exactly match en keys');

  // Verify placeholders match
  for (const k of enKeys) {
    const getVal = (o, pathStr) => pathStr.split('.').reduce((acc, part) => acc?.[part], o);
    const enVal = getVal(en, k);
    const ptVal = getVal(pt, k);

    assert.equal(typeof enVal, 'string', `en key ${k} must be string`);
    assert.equal(typeof ptVal, 'string', `pt-BR key ${k} must be string`);
    assert.ok(enVal.length > 0, `en key ${k} must not be empty`);
    assert.ok(ptVal.length > 0, `pt-BR key ${k} must not be empty`);

    const enVars = [...enVal.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
    const ptVars = [...ptVal.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(ptVars, enVars, `Placeholders for key ${k} must match`);
  }
});

test('public/index.html includes language selector with English and pt-BR', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');

  assert.ok(html.includes('<select id="lang"'), 'Language selector must exist in index.html');
  assert.ok(html.includes('<option value="en">English</option>'), 'English option must exist');
  assert.ok(html.includes('<option value="pt-BR">Português (Brasil)</option>'), 'pt-BR option must exist');
});

test('all data-i18n attributes in public/index.html map to valid translation keys', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const en = JSON.parse(await fs.readFile(path.join(root, 'public', 'locales', 'en.json'), 'utf8'));

  const getVal = (o, pathStr) => pathStr.split('.').reduce((acc, part) => acc?.[part], o);

  const dataI18nMatches = [...html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(dataI18nMatches.length > 30, 'Should find many data-i18n attributes');

  for (const key of dataI18nMatches) {
    const val = getVal(en, key);
    assert.ok(val !== undefined, `data-i18n key "${key}" must exist in en.json`);
    assert.equal(typeof val, 'string', `data-i18n key "${key}" must be a string in en.json`);
  }
});

test('fallback logic returns English when key is missing in pt-BR', () => {
  const I18N = {
    en: { testKey: 'Hello world', nested: { val: 'Nested English' } },
    'pt-BR': { nested: {} }
  };
  let currentLang = 'pt-BR';

  function t(key, vars) {
    const lang = currentLang;
    let str = I18N[lang]?.[key] ?? I18N['en']?.[key];
    if (str == null) {
      const parts = key.split('.');
      let valLang = I18N[lang];
      let valEn = I18N['en'];
      for (const p of parts) {
        valLang = valLang?.[p];
        valEn = valEn?.[p];
      }
      str = valLang ?? valEn;
    }
    if (typeof str !== 'string') {
      if (str != null) return str;
      return key;
    }
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        str = str.replaceAll(`{${k}}`, v);
      }
    }
    return str;
  }

  assert.equal(t('testKey'), 'Hello world');
  assert.equal(t('nested.val'), 'Nested English');
  assert.equal(t('nonExistentKey'), 'nonExistentKey');
});

function loadClientI18nContext(html) {
  const scriptMatch = html.match(/<script nonce="__AGY_POOL_KEY__">([\s\S]*?)const el =/);
  if (!scriptMatch) throw new Error('Could not find i18n script segment in public/index.html');

  const code = scriptMatch[1] + `
    globalThis.I18N = I18N;
    globalThis.t = t;
    globalThis.translateEvent = translateEvent;
    globalThis.translateEnrollment = translateEnrollment;
    globalThis.translateError = translateError;
    globalThis.applyLanguage = applyLanguage;
    globalThis.loadLanguage = loadLanguage;
    globalThis.LANGUAGES = LANGUAGES;
    globalThis.getLang = () => currentLang;
    globalThis.setLang = (l) => { currentLang = l; };
  `;

  const storage = new Map();
  const doc = {
    documentElement: { lang: 'en' },
    title: '',
    getElementById: () => ({ value: '' }),
    querySelectorAll: () => []
  };

  const context = {
    document: doc,
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k)
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    console: { warn: () => {}, log: () => {}, error: () => {} },
    setTimeout: () => {},
    clearTimeout: () => {},
    renderProjects: () => {},
    renderEvents: () => {},
    updateOfficeMotion: () => {},
    updateOfficeInspector: () => {},
    controls: () => {},
    storageUnavailable: () => {}
  };

  vm.createContext(context);
  vm.runInContext(code, context);
  return context;
}

test('inline I18N dictionary in public/index.html matches public/locales/*.json', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const en = JSON.parse(await fs.readFile(path.join(root, 'public', 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(await fs.readFile(path.join(root, 'public', 'locales', 'pt-BR.json'), 'utf8'));

  const ctx = loadClientI18nContext(html);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.I18N.en)), en, 'Inline I18N.en must match public/locales/en.json');
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.I18N['pt-BR'])), pt, 'Inline I18N["pt-BR"] must match public/locales/pt-BR.json');
});

test('translateEvent translates all 20 server event patterns to pt-BR and leaves en untouched', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const ctx = loadClientI18nContext(html);

  const testEvents = [
    {
      original: 'Saved the currently signed-in account in Windows Credential Manager.',
      pt: 'Conta atualmente conectada salva no Gerenciador de Credenciais do Windows.'
    },
    {
      original: 'Added user@example.com and restored the original CLI credential.',
      pt: 'Adicionado user@example.com e restaurada a credencial original do CLI.'
    },
    {
      original: 'Selected Account 1 for future requests.',
      pt: 'Selecionado Account 1 para futuras requisições.'
    },
    {
      original: 'Removed Account 2 from the account pool.',
      pt: 'Removido Account 2 do pool de contas.'
    },
    {
      original: 'Now routing gemini requests through Account 1.',
      pt: 'Roteando requisições de gemini agora através de Account 1.'
    },
    {
      original: 'Switched gemini before a request: selected account was at 5% (threshold 10%).',
      pt: 'Trocou gemini antes de uma requisição: a conta selecionada estava em 5% (limite 10%).'
    },
    {
      original: 'Account 1 reached its gemini quota; retrying with the next account.',
      pt: 'Account 1 atingiu sua cota de gemini; tentando com a próxima conta.'
    },
    {
      original: 'Account 1 reached its gemini quota; no other account is available.',
      pt: 'Account 1 atingiu sua cota de gemini; nenhuma outra conta disponível.'
    },
    {
      original: 'Refreshed access token for Account 1.',
      pt: 'Token de acesso renovado para Account 1.'
    },
    {
      original: 'Opened Antigravity CLI for my-proj (process 1234).',
      pt: 'Antigravity CLI aberto para my-proj (processo 1234).'
    },
    {
      original: 'Opened Antigravity CLI for a new account (process 5678).',
      pt: 'Antigravity CLI aberto para nova conta (processo 5678).'
    },
    {
      original: 'Account login timed out; original CLI credential restored.',
      pt: 'Tempo de login da conta esgotado; credencial original do CLI restaurada.'
    },
    {
      original: 'Account login canceled; original CLI credential restored.',
      pt: 'Login da conta cancelado; credencial original do CLI restaurada.'
    },
    {
      original: 'Low quota switch threshold set to 15%.',
      pt: 'Limite de troca por cota baixa definido para 15%.'
    },
    {
      original: 'Recovered the original Antigravity credential after an interrupted account login.',
      pt: 'Credencial original do Antigravity recuperada após login interrompido.'
    },
    {
      original: 'Stopped account enrollment; original credential restored.',
      pt: 'Cadastro de conta interrompido; credencial original restaurada.'
    },
    {
      original: 'The next gemini-2.5-pro request will receive a local quota error, then retry through another account.',
      pt: 'A próxima requisição gemini-2.5-pro receberá um erro local de cota e tentará outra conta.'
    },
    {
      original: 'The next gemini-2.5-pro request will test a low quota reading, then route through another account.',
      pt: 'A próxima requisição gemini-2.5-pro testará leitura de cota baixa e trocará de conta.'
    },
    {
      original: 'Automatic tool approvals enabled.',
      pt: 'Aprovações automáticas de ferramentas ativadas.'
    },
    {
      original: 'Automatic tool approvals disabled (safe mode).',
      pt: 'Aprovações manuais de ferramentas ativadas (modo seguro).'
    }
  ];

  assert.equal(testEvents.length, 20, 'Should test all 20 server event patterns');

  // When English
  ctx.setLang('en');
  for (const { original } of testEvents) {
    assert.equal(ctx.translateEvent(original), original, `English must leave "${original}" untouched`);
  }

  // When Brazilian Portuguese
  ctx.setLang('pt-BR');
  for (const { original, pt } of testEvents) {
    const translated = ctx.translateEvent(original);
    assert.equal(translated, pt, `pt-BR must translate "${original}"`);
    assert.notEqual(translated, original, `pt-BR translated string must differ from original`);
  }
});

test('translateError maps all server.mjs error strings to localized pt-BR text', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const ctx = loadClientI18nContext(html);

  const errors = [
    'Wait for the current account removal to finish.',
    'An account login is already in progress.',
    'Wait for the previous CLI launch to finish loading.',
    'Finish or cancel the current account login first.',
    'Keep at least one account in the pool.',
    'Unknown account.',
    'Enter a label of 1 to 80 characters.',
    'Project path must be a directory.',
    'Add a second account first.',
    'Send a prompt first so the selected model is known.',
    'Set a quota threshold above 0% first.',
    'Enter a whole percentage from 0 to 100.',
    'Enter a whole percentage between 0 and 100.',
    'Enabled must be a boolean.',
    'Could not reconnect to the pool.',
    'Reload the dashboard to reconnect.'
  ];

  ctx.setLang('en');
  for (const err of errors) {
    assert.equal(ctx.translateError(err), err, `English must preserve error: ${err}`);
  }

  ctx.setLang('pt-BR');
  for (const err of errors) {
    const translated = ctx.translateError(err);
    assert.ok(translated && typeof translated === 'string', `Translated error must be string: ${err}`);
    assert.notEqual(translated, err, `pt-BR must translate error: ${err}`);
    assert.ok(!translated.includes('errors.'), `Translation must resolve key, got: ${translated}`);
  }
});

test('translateEnrollment correctly localizes CLI enrollment messages', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const ctx = loadClientI18nContext(html);

  const promptMsg = 'Sign in in the new Antigravity CLI window.';
  const existsMsg = 'That Google account is already in the pool. Sign into a different account.';

  ctx.setLang('en');
  assert.equal(ctx.translateEnrollment(promptMsg), promptMsg);
  assert.equal(ctx.translateEnrollment(existsMsg), existsMsg);

  ctx.setLang('pt-BR');
  assert.equal(ctx.translateEnrollment(promptMsg), 'Faça login na nova janela do Antigravity CLI.');
  assert.equal(ctx.translateEnrollment(existsMsg), 'Essa conta Google já está no pool. Faça login com uma conta diferente.');
});

test('dynamic office and connection translations cover online, offline, aria, and agent label patterns', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const ctx = loadClientI18nContext(html);

  ctx.setLang('en');
  assert.equal(ctx.t('docTitle'), 'Antigravity Account Pool');
  assert.equal(ctx.t('officeCountOnline', { working: 2, total: 3 }), '2 working · 3 here');
  assert.equal(ctx.t('officeCountOffline', { total: 3 }), '3 accounts · disconnected');
  assert.equal(ctx.t('officeCountEmpty'), 'No accounts yet');
  assert.equal(ctx.t('officeAgentLabel', { index: 1, label: 'Work', state: 'Working' }), 'Agent 1, Work, Working');
  assert.equal(ctx.t('agentPrefix'), 'Agent ');
  assert.equal(ctx.t('officeTypingBusy'), 'Busy typing!');
  assert.equal(ctx.t('connectionState.running'), 'Connected');

  ctx.setLang('pt-BR');
  assert.equal(ctx.t('docTitle'), 'Pool de Contas Antigravity');
  assert.equal(ctx.t('officeCountOnline', { working: 2, total: 3 }), '2 trabalhando · 3 aqui');
  assert.equal(ctx.t('officeCountOffline', { total: 3 }), '3 contas · desconectado');
  assert.equal(ctx.t('officeCountEmpty'), 'Nenhuma conta ainda');
  assert.equal(ctx.t('officeAgentLabel', { index: 1, label: 'Trabalho', state: 'Trabalhando' }), 'Agente 1, Trabalho, Trabalhando');
  assert.equal(ctx.t('agentPrefix'), 'Agente ');
  assert.equal(ctx.t('officeTypingBusy'), 'Digitando a todo vapor!');
  assert.equal(ctx.t('connectionState.running'), 'Conectado');
});

test('auto-approval translation keys and event strings are complete in both locales', async () => {
  const en = JSON.parse(await fs.readFile(path.join(root, 'public', 'locales', 'en.json'), 'utf8'));
  const pt = JSON.parse(await fs.readFile(path.join(root, 'public', 'locales', 'pt-BR.json'), 'utf8'));

  const autoKeys = [
    'autoApproveTitle',
    'autoApproveSafeBadge',
    'autoApproveActiveBadge',
    'autoApproveEnableBtn',
    'autoApproveDisableBtn',
    'autoApproveSafeDesc',
    'autoApproveActiveDesc',
    'msgAutoApproveEnabled',
    'msgAutoApproveDisabled',
    'msgProjectOpeningSafe',
    'msgProjectOpeningAuto'
  ];

  for (const key of autoKeys) {
    assert.ok(en[key], `en.json must contain ${key}`);
    assert.ok(pt[key], `pt-BR.json must contain ${key}`);
    assert.notEqual(en[key], pt[key], `pt-BR should differ from en for ${key}`);
  }
});

test('language selection persistence and fallback logic', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const ctx = loadClientI18nContext(html);

  // Default initial language
  assert.equal(ctx.getLang(), 'en');
  assert.equal(ctx.document.documentElement.lang, 'en');

  // Change to pt-BR with persistence
  ctx.applyLanguage('pt-BR', true);
  assert.equal(ctx.getLang(), 'pt-BR');
  assert.equal(ctx.document.documentElement.lang, 'pt-BR');
  assert.equal(ctx.document.title, 'Pool de Contas Antigravity');
  assert.equal(ctx.localStorage.getItem('agy-pool.lang.v1'), 'pt-BR');

  // Change to English with persistence
  ctx.applyLanguage('en', true);
  assert.equal(ctx.getLang(), 'en');
  assert.equal(ctx.document.documentElement.lang, 'en');
  assert.equal(ctx.document.title, 'Antigravity Account Pool');
  assert.equal(ctx.localStorage.getItem('agy-pool.lang.v1'), 'en');

  // Fallback on invalid language code
  ctx.applyLanguage('invalid-lang', false);
  assert.equal(ctx.getLang(), 'en', 'Invalid language code must fallback to en');

  // Test loadLanguage from storage
  ctx.localStorage.setItem('agy-pool.lang.v1', 'pt-BR');
  ctx.loadLanguage();
  assert.equal(ctx.getLang(), 'pt-BR', 'loadLanguage should restore pt-BR from localStorage');

  // Test loadLanguage with corrupt / unsupported storage value
  ctx.localStorage.setItem('agy-pool.lang.v1', 'fr-FR');
  ctx.loadLanguage();
  assert.equal(ctx.getLang(), 'en', 'loadLanguage with unsupported locale should fallback to en');
});
