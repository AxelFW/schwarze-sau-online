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

function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) throw new Error(`Could not find block: ${label}`);
  return text.replace(needle, replacement);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suffix = `.bak-quick-game-delay-factor-env-${stamp}`;

// ---------------------------------------------------------------------------
// server/rooms.js
// ---------------------------------------------------------------------------
let rooms = read(roomsPath);
backup(roomsPath, suffix);

if (rooms.includes('process.env.QUICK_GAME_DELAY_FACTOR')) {
  console.log('ℹ️ server/rooms.js already uses QUICK_GAME_DELAY_FACTOR; leaving it unchanged.');
} else {
  rooms = replaceOnce(
    rooms,
    `const QUICK_GAME_DELAY_FACTOR = 0.62;`,
    `const QUICK_GAME_DELAY_FACTOR = (() => {\n  const value = Number(process.env.QUICK_GAME_DELAY_FACTOR ?? 0.62);\n  return Number.isFinite(value) && value > 0 ? value : 0.62;\n})();`,
    'quick game delay factor constant'
  );
  write(roomsPath, rooms);
  console.log('✅ Updated server/rooms.js to read QUICK_GAME_DELAY_FACTOR from the environment.');
}

// ---------------------------------------------------------------------------
// .env.example
// ---------------------------------------------------------------------------
if (fs.existsSync(envExamplePath)) {
  let envExample = read(envExamplePath);
  backup(envExamplePath, suffix);

  if (envExample.includes('QUICK_GAME_DELAY_FACTOR=')) {
    console.log('ℹ️ .env.example already mentions QUICK_GAME_DELAY_FACTOR; leaving it unchanged.');
  } else {
    const addition = `\n# Multiplies display delays when \"Schnelles Spiel\" is enabled in the lobby.\n# 0.62 means quick-game delays are 62% of the normal duration.\nQUICK_GAME_DELAY_FACTOR=0.62\n`;

    if (envExample.includes('REST_CLAIM_REVEAL_MS=')) {
      envExample = envExample.replace(/(REST_CLAIM_REVEAL_MS=.*(?:\r?\n)?)/, `$1${addition}`);
    } else {
      envExample = envExample.trimEnd() + addition;
    }
    write(envExamplePath, envExample);
    console.log('✅ Added QUICK_GAME_DELAY_FACTOR to .env.example.');
  }
} else {
  console.log('ℹ️ No .env.example found; skipped example env update.');
}

console.log('🎉 Quick-game delay factor env patch applied.');
