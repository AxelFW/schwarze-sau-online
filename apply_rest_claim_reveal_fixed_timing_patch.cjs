#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const roomsPath = path.join(root, 'server', 'rooms.js');
const envExamplePath = path.join(root, '.env.example');

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}
function write(file, text) { fs.writeFileSync(file, text); }
function backup(file, suffix) { fs.copyFileSync(file, file + suffix); }
function replaceRegex(text, regex, replacement, label) {
  if (!regex.test(text)) throw new Error(`Could not find block: ${label}`);
  return text.replace(regex, replacement);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suffix = `.bak-rest-claim-reveal-fixed-timing-${stamp}`;

// ---------------------------------------------------------------------------
// server/rooms.js
// ---------------------------------------------------------------------------
let rooms = read(roomsPath);
backup(roomsPath, suffix);

const desiredFunction = `function restClaimRevealDelayMs(_room) {\n  const base = Number(REST_CLAIM_REVEAL_MS);\n  return Number.isFinite(base) ? Math.max(0, base) : 1250;\n}`;

if (rooms.includes(desiredFunction)) {
  console.log('ℹ️ server/rooms.js already keeps Rest-zu-mir reveal timing independent from quick-game factor.');
} else {
  rooms = replaceRegex(
    rooms,
    /function\s+restClaimRevealDelayMs\s*\([^)]*\)\s*\{\s*return\s+quickGameDelayMs\s*\(\s*[^,]+\s*,\s*REST_CLAIM_REVEAL_MS\s*\)\s*;\s*\}/,
    desiredFunction,
    'restClaimRevealDelayMs using quickGameDelayMs'
  );
  write(roomsPath, rooms);
  console.log('✅ Updated server/rooms.js: Rest-zu-mir reveal timing now ignores QUICK_GAME_DELAY_FACTOR.');
}

// ---------------------------------------------------------------------------
// .env.example
// ---------------------------------------------------------------------------
if (fs.existsSync(envExamplePath)) {
  let envExample = read(envExamplePath);
  backup(envExamplePath, suffix);

  if (envExample.includes('Does not affect REST_CLAIM_REVEAL_MS')) {
    console.log('ℹ️ .env.example already documents that quick-game does not affect Rest-zu-mir timing.');
  } else if (envExample.includes('QUICK_GAME_DELAY_FACTOR=')) {
    envExample = envExample.replace(
      /# Multiplies display delays when "Schnelles Spiel" is enabled in the lobby\.\r?\n# 0\.62 means quick-game delays are 62% of the normal duration\.\r?\nQUICK_GAME_DELAY_FACTOR=0\.62/,
      `# Multiplies normal completed-trick display delays when "Schnelles Spiel" is enabled in the lobby.\n# Does not affect REST_CLAIM_REVEAL_MS / Rest-zu-mir reveal timing.\n# 0.62 means quick-game trick delays are 62% of the normal duration.\nQUICK_GAME_DELAY_FACTOR=0.62`
    );
    write(envExamplePath, envExample);
    console.log('✅ Updated .env.example documentation for QUICK_GAME_DELAY_FACTOR.');
  } else {
    console.log('ℹ️ .env.example does not mention QUICK_GAME_DELAY_FACTOR; skipped docs update.');
  }
} else {
  console.log('ℹ️ No .env.example found; skipped example env update.');
}

console.log('🎉 Rest-claim reveal fixed-timing patch applied.');
