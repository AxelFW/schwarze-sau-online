#!/usr/bin/env node
/*
  Fix Wuzz online bot delay being treated as 0ms.

  Root cause:
    scheduleAdvance(..., delayOverrideMs = null) did:
      const explicitDelay = Number(delayOverrideMs);
      if (Number.isFinite(explicitDelay)) use explicitDelay;
    In JavaScript, Number(null) === 0, so the default null override became an
    explicit 0ms delay. That made bot cards appear immediately even when
    BOT_DELAY_MS was set correctly.

  Run from repo root:
    node fix-bot-delay-null-override.cjs

  Then restart the server/dev process.
*/

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

const targets = [
  path.join(root, 'server', 'index.js'),
  // Also patch old local patch scripts if they are present, so re-running them
  // later does not reintroduce the same null -> 0ms bug.
  path.join(root, 'fix-current-player-bot-delay.cjs'),
  path.join(root, 'fix-visible-bot-delay.cjs'),
];

const oldBlock = `  const explicitDelay = Number(delayOverrideMs);
  const delay = Number.isFinite(explicitDelay)
    ? Math.max(0, explicitDelay)
    : (immediate ? 0 : normalDelay);`;

const newBlock = `  const hasDelayOverride = delayOverrideMs !== null && delayOverrideMs !== undefined && delayOverrideMs !== "";
  const explicitDelay = hasDelayOverride ? Number(delayOverrideMs) : NaN;
  const delay = Number.isFinite(explicitDelay)
    ? Math.max(0, explicitDelay)
    : (immediate ? 0 : normalDelay);`;

let changed = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(oldBlock)) {
    if (src.includes('const hasDelayOverride = delayOverrideMs !== null')) {
      console.log(`${path.relative(root, file)} already fixed.`);
    } else {
      console.log(`${path.relative(root, file)}: target block not found, skipped.`);
    }
    continue;
  }

  const backup = `${file}.bak-null-delay-${stamp}`;
  fs.copyFileSync(file, backup);
  fs.writeFileSync(file, src.replaceAll(oldBlock, newBlock));
  changed += 1;
  console.log(`Patched ${path.relative(root, file)} (backup: ${path.relative(root, backup)})`);
}

if (changed === 0) {
  console.log('No files changed. server/index.js may already be fixed or differs from the expected current build.');
} else {
  const serverIndex = path.join(root, 'server', 'index.js');
  if (fs.existsSync(serverIndex)) {
    try {
      execFileSync(process.execPath, ['--check', serverIndex], { stdio: 'inherit' });
      console.log('Syntax check passed: node --check server/index.js');
    } catch (err) {
      console.error('Syntax check failed. Restore the backup or inspect server/index.js.');
      process.exit(1);
    }
  }
  console.log('Restart npm run dev / the Render service after applying this patch.');
  console.log('For an obvious manual test, set BOT_DELAY_MS=1200 temporarily; bot cards should be about 1.2s apart.');
}
