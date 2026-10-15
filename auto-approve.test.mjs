import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const pwsh = process.env.AGY_POOL_PWSH || 'pwsh.exe';

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(pwsh, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

test('Launch-Agy.ps1 correctly omits or includes --dangerously-skip-permissions', async () => {
  // Test by simulating the parameter evaluation logic of Launch-Agy.ps1
  const scriptPath = path.join(root, 'Launch-Agy.ps1');
  const content = await fs.readFile(scriptPath, 'utf8');

  // Verify parameter definition
  assert.match(content, /\[switch\]\$SkipPermissions/, 'Launch-Agy.ps1 must declare [switch]$SkipPermissions');
  assert.match(content, /\[switch\]\$ContinueConversation/, 'Launch-Agy.ps1 must declare [switch]$ContinueConversation');

  // Verify the argument array construction
  assert.match(content, /if\s*\(\$ContinueConversation\)\s*\{\s*\$agyArgs\s*\+=\s*'-c'\s*\}/);
  assert.match(content, /if\s*\(\$SkipPermissions\)\s*\{\s*\$agyArgs\s*\+=\s*'--dangerously-skip-permissions'\s*\}/);
  assert.match(content, /&\s*\$agyPath\s+@agyArgs/);

  // Test pwsh invocation of the argument building logic
  const checkCmd = `
    function Get-TestArgs([switch]$ContinueConversation, [switch]$SkipPermissions) {
      $agyArgs = @()
      if ($ContinueConversation) { $agyArgs += '-c' }
      if ($SkipPermissions) { $agyArgs += '--dangerously-skip-permissions' }
      return ($agyArgs -join ' ')
    }
    $off = Get-TestArgs
    $on = Get-TestArgs -SkipPermissions
    $continueOff = Get-TestArgs -ContinueConversation
    $continueOn = Get-TestArgs -ContinueConversation -SkipPermissions
    "$off|$on|$continueOff|$continueOn"
  `;
  const result = await runPowershell(checkCmd);
  assert.equal(result.code, 0);
  const [off, on, continueOff, continueOn] = result.stdout.split('|');
  assert.equal(off, '', 'OFF must produce empty arguments');
  assert.equal(on, '--dangerously-skip-permissions', 'ON must include --dangerously-skip-permissions');
  assert.equal(continueOff, '-c', 'Continue OFF must include only -c');
  assert.equal(continueOn, '-c --dangerously-skip-permissions', 'Continue ON must include both -c and --dangerously-skip-permissions');
});

test('Open-AgyWindow.ps1 propagates -SkipPermissions argument', async () => {
  const scriptPath = path.join(root, 'Open-AgyWindow.ps1');
  const content = await fs.readFile(scriptPath, 'utf8');

  assert.match(content, /\[switch\]\$SkipPermissions/, 'Open-AgyWindow.ps1 must declare [switch]$SkipPermissions');
  assert.match(content, /if\s*\(\$SkipPermissions\)\s*\{\s*\$argsForWindow\s*\+=\s*'-SkipPermissions'\s*\}/,
    'Open-AgyWindow.ps1 must append -SkipPermissions when switch is active');
});

test('server.mjs defaults autoApproveTools to false (safe default) and persists changes', async () => {
  const serverPath = path.join(root, 'server.mjs');
  const content = await fs.readFile(serverPath, 'utf8');

  // Verify safe default in bootstrap
  assert.match(content, /meta\.autoApproveTools\s*=\s*meta\.autoApproveTools\s*===\s*true;/,
    'server.mjs bootstrap must safely default autoApproveTools to false unless strictly true');

  // Verify status() exposes autoApproveTools
  assert.match(content, /autoApproveTools:\s*!!meta\.autoApproveTools/,
    'status() must expose autoApproveTools boolean');

  // Verify launch() accepts skipPermissions
  assert.match(content, /function\s+launch\(mode,\s*projectPath,\s*resume\s*=\s*false,\s*skipPermissions\s*=\s*false\)/,
    'launch() must accept skipPermissions parameter defaulting to false');

  // Verify launch() pushes -SkipPermissions to openWindow
  assert.match(content, /if\s*\(skipPermissions\)\s*args\.push\('-SkipPermissions'\);/,
    'launch() must pass -SkipPermissions to Open-AgyWindow.ps1');

  // Verify endpoint /api/settings/auto-approve exists and validates boolean
  assert.match(content, /req\.url\s*===\s*'\/api\/settings\/auto-approve'/,
    '/api/settings/auto-approve endpoint must be handled');
  assert.match(content, /typeof\s+body\.enabled\s*!==\s*'boolean'/,
    '/api/settings/auto-approve must reject non-boolean enabled');

  // Verify launch endpoint passes meta.autoApproveTools
  assert.match(content, /await\s+launch\('Project',\s*projectPath,\s*!!body\.resume,\s*!!meta\.autoApproveTools\)/,
    '/api/projects/launch must pass !!meta.autoApproveTools');
});

test('public/index.html includes auto-approval toggle button, badge, and description', async () => {
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');

  assert.ok(html.includes('id="toggleAutoApprove"'), 'Toggle button must exist in index.html');
  assert.ok(html.includes('id="autoApproveBadge"'), 'Badge element must exist in index.html');
  assert.ok(html.includes('id="autoApproveDesc"'), 'Description element must exist in index.html');
  assert.ok(html.includes('data-i18n="autoApproveTitle"'), 'Title must be localized');

  // Check event handlers and controls
  assert.ok(html.includes("$('toggleAutoApprove').disabled=locked||accountBusy"),
    'toggleAutoApprove must be controlled by connection and account lock state');
  assert.ok(html.includes('/api/settings/auto-approve'),
    'Clicking toggle button must call /api/settings/auto-approve');
});

test('autoApproveTools persistence logic and boolean safety', () => {
  // Test 1: Empty / undefined defaults to false
  let meta = {};
  meta.autoApproveTools = meta.autoApproveTools === true;
  assert.equal(meta.autoApproveTools, false, 'undefined must normalize to false');

  // Test 2: Truthy non-boolean values must normalize to false
  meta = { autoApproveTools: 'true' };
  meta.autoApproveTools = meta.autoApproveTools === true;
  assert.equal(meta.autoApproveTools, false, 'string "true" must normalize to false');

  meta = { autoApproveTools: 1 };
  meta.autoApproveTools = meta.autoApproveTools === true;
  assert.equal(meta.autoApproveTools, false, 'number 1 must normalize to false');

  // Test 3: Explicit boolean true is preserved
  meta = { autoApproveTools: true };
  meta.autoApproveTools = meta.autoApproveTools === true;
  assert.equal(meta.autoApproveTools, true, 'boolean true must be preserved');

  // Test 4: Explicit boolean false is preserved
  meta = { autoApproveTools: false };
  meta.autoApproveTools = meta.autoApproveTools === true;
  assert.equal(meta.autoApproveTools, false, 'boolean false must be preserved');

  // Test 5: JSON round-trip
  const serializedTrue = JSON.stringify({ autoApproveTools: true });
  const parsedTrue = JSON.parse(serializedTrue);
  parsedTrue.autoApproveTools = parsedTrue.autoApproveTools === true;
  assert.equal(parsedTrue.autoApproveTools, true, 'JSON round-trip with true must work');

  const serializedFalse = JSON.stringify({ autoApproveTools: false });
  const parsedFalse = JSON.parse(serializedFalse);
  parsedFalse.autoApproveTools = parsedFalse.autoApproveTools === true;
  assert.equal(parsedFalse.autoApproveTools, false, 'JSON round-trip with false must work');
});

test('Open-AgyWindow.ps1 argument list construction in PowerShell', async () => {
  const checkCmd = `
    function Build-Args([string]$Mode, [string]$ProjectPath, [int]$Port, [switch]$ContinueConversation, [switch]$SkipPermissions) {
      $launchScript = 'Launch-Agy.ps1'
      $argsForWindow = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit',
        '-File', ('"' + $launchScript + '"'), '-Mode', $Mode
      )
      if ($Mode -eq 'Project') {
        $argsForWindow += @('-ProjectPath', ('"' + $ProjectPath + '"'), '-Port', [string]$Port)
        if ($ContinueConversation) { $argsForWindow += '-ContinueConversation' }
        if ($SkipPermissions) { $argsForWindow += '-SkipPermissions' }
      }
      return ($argsForWindow -join ' ')
    }

    $safeArgs = Build-Args -Mode 'Project' -ProjectPath 'C:\\My Projects\\Test [1]' -Port 18454
    $autoArgs = Build-Args -Mode 'Project' -ProjectPath 'C:\\My Projects\\Test [1]' -Port 18454 -SkipPermissions
    $continueSafe = Build-Args -Mode 'Project' -ProjectPath 'C:\\My Projects\\Test [1]' -Port 18454 -ContinueConversation
    $continueAuto = Build-Args -Mode 'Project' -ProjectPath 'C:\\My Projects\\Test [1]' -Port 18454 -ContinueConversation -SkipPermissions

    "$safeArgs###$autoArgs###$continueSafe###$continueAuto"
  `;
  const result = await runPowershell(checkCmd);
  assert.equal(result.code, 0);
  const [safe, auto, contSafe, contAuto] = result.stdout.split('###');

  assert.ok(!safe.includes('-SkipPermissions'), 'Safe mode must not include -SkipPermissions');
  assert.ok(!safe.includes('-ContinueConversation'), 'Safe mode without resume must not include -ContinueConversation');

  assert.ok(auto.includes('-SkipPermissions'), 'Auto mode must include -SkipPermissions');
  assert.ok(!auto.includes('-ContinueConversation'), 'Auto mode without resume must not include -ContinueConversation');

  assert.ok(contSafe.includes('-ContinueConversation'), 'Continue safe must include -ContinueConversation');
  assert.ok(!contSafe.includes('-SkipPermissions'), 'Continue safe must not include -SkipPermissions');

  assert.ok(contAuto.includes('-ContinueConversation'), 'Continue auto must include -ContinueConversation');
  assert.ok(contAuto.includes('-SkipPermissions'), 'Continue auto must include -SkipPermissions');
});

