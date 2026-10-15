import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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
