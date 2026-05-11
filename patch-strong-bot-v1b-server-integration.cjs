#!/usr/bin/env node
/*
  Repair patch for patch-strong-bot-v1.cjs server integration.

  Use after v1 failed with:
    Error: Could not find heuristicBot import in server/rooms.js

  It patches server/rooms.js more tolerantly, supporting imports like:
    import { heuristicQuetschPick, chooseHeuristicCard, recommendHeuristicCards } from "../shared/game/heuristicBot.js";
*/
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const roomsRel = 'server/rooms.js';
const roomsAbs = path.join(ROOT, roomsRel);
const strongRel = 'shared/game/strongBot.js';
const strongAbs = path.join(ROOT, strongRel);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const fail = msg => {
  console.error(`❌ ${msg}`);
  process.exit(1);
};
const backupFile = abs => {
  const backup = `${abs}.bak-strong-bot-server-fix-${stamp()}`;
  fs.copyFileSync(abs, backup);
  return backup;
};

if (!fs.existsSync(roomsAbs)) fail(`${roomsRel} not found. Run this from the repo root.`);
if (!fs.existsSync(strongAbs)) {
  console.warn(`⚠ ${strongRel} not found. The first part of patch-strong-bot-v1.cjs should have created it.`);
  console.warn('  This repair patch will still patch server/rooms.js, but BOT_ENGINE=strong needs strongBot.js to exist.');
}

let rooms = fs.readFileSync(roomsAbs, 'utf8');
const before = rooms;

// 1) Add strongBot import if missing.
if (!rooms.includes('../shared/game/strongBot.js') && !rooms.includes("../shared/game/strongBot.js")) {
  const heuristicImportRe = /import\s*\{\s*[^}]*\bheuristicQuetschPick\b[^}]*\bchooseHeuristicCard\b[^}]*\}\s*from\s*(["'])\.\.\/shared\/game\/heuristicBot\.js\1\s*;?/m;
  if (!heuristicImportRe.test(rooms)) {
    fail('Could not find a heuristicBot import containing heuristicQuetschPick and chooseHeuristicCard in server/rooms.js. Please paste the first ~20 lines of server/rooms.js.');
  }
  rooms = rooms.replace(
    heuristicImportRe,
    match => `${match} import { strongBotQuetschPick, chooseStrongCard } from "../shared/game/strongBot.js";`
  );
  console.log('✓ added strongBot import to server/rooms.js');
} else {
  console.log('• strongBot import already present; skipped import insertion');
}

// 2) Add helper selectors after imports / before rooms map.
if (!rooms.includes('const BOT_ENGINE = String(process.env.BOT_ENGINE || "heuristic").toLowerCase();')) {
  const helpers = [
    'const BOT_ENGINE = String(process.env.BOT_ENGINE || "heuristic").toLowerCase();',
    'const chooseBotCardForSeat = (gs, seat) => BOT_ENGINE === "strong" ? chooseStrongCard(gs, seat) : chooseHeuristicCard(gs, seat);',
    'const chooseBotQuetschForSeat = hand => BOT_ENGINE === "strong" ? strongBotQuetschPick(hand) : heuristicQuetschPick(hand);',
    ''
  ].join('\n');

  const roomsDeclRe = /const\s+rooms\s*=\s*new\s+Map\s*\(\s*\)\s*;?/m;
  if (!roomsDeclRe.test(rooms)) {
    fail('Could not find `const rooms = new Map();` insertion point in server/rooms.js.');
  }
  rooms = rooms.replace(roomsDeclRe, match => `${helpers}${match}`);
  console.log('✓ added BOT_ENGINE helper selectors');
} else {
  console.log('• BOT_ENGINE helper selectors already present; skipped helper insertion');
}

// 3) Replace bot quetsch selection calls. Current repo shape uses game.gs.hands[seat], but be tolerant.
let replacements = 0;
rooms = rooms.replace(/heuristicQuetschPick\s*\(\s*game\.gs\.hands\s*\[\s*seat\s*\]\s*\)/g, () => {
  replacements += 1;
  return 'chooseBotQuetschForSeat(game.gs.hands[seat])';
});
rooms = rooms.replace(/heuristicQuetschPick\s*\(\s*hand\s*\)/g, () => {
  // Do not replace export aliases or arbitrary local uses; this pattern is intentionally conservative.
  return 'heuristicQuetschPick(hand)';
});
if (replacements > 0) console.log(`✓ rewired ${replacements} bot quetsch call(s)`);
else console.log('• no direct server bot quetsch calls needed rewiring or they were already rewired');

// 4) Replace server bot card selection calls, without touching easy-mode recommendations.
let cardReplacements = 0;
const cardPatterns = [
  /chooseHeuristicCard\s*\(\s*botDecisionGameState\s*\(\s*room\s*\)\s*,\s*player\s*\)/g,
  /chooseHeuristicCard\s*\(\s*game\.gs\s*,\s*player\s*\)/g,
  /chooseHeuristicCard\s*\(\s*room\.game\.gs\s*,\s*player\s*\)/g,
];
for (const re of cardPatterns) {
  rooms = rooms.replace(re, match => {
    cardReplacements += 1;
    if (match.includes('botDecisionGameState')) return 'chooseBotCardForSeat(botDecisionGameState(room), player)';
    if (match.includes('room.game.gs')) return 'chooseBotCardForSeat(room.game.gs, player)';
    return 'chooseBotCardForSeat(game.gs, player)';
  });
}
if (cardReplacements > 0) console.log(`✓ rewired ${cardReplacements} bot card call(s)`);
else console.log('• no direct server bot card calls needed rewiring or they were already rewired');

if (rooms === before) {
  console.log('• No changes written; server/rooms.js already appears patched.');
  process.exit(0);
}

const backup = backupFile(roomsAbs);
fs.writeFileSync(roomsAbs, rooms, 'utf8');
console.log(`↩ backed up ${roomsRel} -> ${path.basename(backup)}`);
console.log(`✓ patched ${roomsRel}`);
console.log('\nNext commands:');
console.log('  node scripts/simulate-strong-vs-heuristic.mjs --deals-per-seat=100 --particles=0');
console.log('  BOT_ENGINE=strong npm run dev');
