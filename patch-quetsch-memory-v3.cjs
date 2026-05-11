#!/usr/bin/env node
/* patch-quetsch-memory-v3.cjs
 *
 * Applies the Wuzz/Schwarze-Sau quetsch-memory improvements discussed:
 *   1) preserve safe side-suit aces (A♣ / A♦) during bot quetsch unless emergency;
 *   2) remember own passed cards as known cards in the left player's hand;
 *   3) store received-from-right quetsch cards in gs;
 *   4) permanently treat receiving 3 C/D cards from right as strong lead-warning;
 *      receiving 2 C/D cards is a soft tie-break against likely winners.
 *
 * Run from repo root:
 *   node patch-quetsch-memory-v3.cjs
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const root = process.cwd();
const files = {
  heuristic: path.join(root, 'shared/game/heuristicBot.js'),
  engine: path.join(root, 'shared/game/engine.js'),
};

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`Missing file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content);
}

function makeBackup(file, backupRoot) {
  const rel = path.relative(root, file);
  const dest = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
}

function replaceOnce(src, needle, replacement, label) {
  if (!src.includes(needle)) fail(`Could not find block: ${label}`);
  return src.replace(needle, replacement);
}

function replaceBetween(src, startNeedle, endNeedle, replacement, label) {
  const start = src.indexOf(startNeedle);
  if (start < 0) fail(`Could not find start block: ${label}`);
  const end = src.indexOf(endNeedle, start);
  if (end < 0) fail(`Could not find end block: ${label}`);
  return src.slice(0, start) + replacement + src.slice(end);
}

function checkSyntax(file) {
  try {
    childProcess.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const out = String(err.stdout || '') + String(err.stderr || '');
    fail(`Syntax check failed for ${path.relative(root, file)}:\n${out}`);
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(root, '.patch-backups', `quetsch-memory-v3-${stamp}`);

let heuristic = read(files.heuristic);
let engine = read(files.engine);

if (heuristic.includes('quetschReceivedCountBySuit') || engine.includes('quetschReceivedFromRight: toAdd.map')) {
  fail('This patch appears to have been applied already. Aborting to avoid duplicate helpers.');
}

makeBackup(files.heuristic, backupRoot);
makeBackup(files.engine, backupRoot);

const newQuetschPick = `export const heuristicQuetschPick = hand => {
  const selected = [];
  const has = c => hand.some(x => sameCard(x,c));
  const cardsOfSuit = s => [...hand].filter(c=>c.s===s).sort((a,b)=>a.v-b.v);
  const protectedLow = c => ['H','D','C'].includes(c.s) && c.v>=2 && c.v<=4;
  const sideSuitAce = c => (c.s==='C' || c.s==='D') && c.v===14;

  const spades = cardsOfSuit('S');
  const otherSpades = spades.filter(c=>!sameCard(c, QUEEN_SPADES));
  const spadeEmergency = has(QUEEN_SPADES) && otherSpades.length < 2;
  const highSpadeEmergency = !has(QUEEN_SPADES) &&
    spades.some(c=>c.v===13 || c.v===14) &&
    spades.filter(c=>c.v<12).length < 2;

  const hearts = cardsOfSuit('H');
  const smallHearts = hearts.filter(c=>c.v<7);
  const highHearts = hearts.filter(c=>c.v>=11).sort((a,b)=>b.v-a.v);
  const heartEmergency = highHearts.length > 0 && smallHearts.length===0;

  // Side-suit aces are usually safe-trick assets.  Only emergency structures
  // are allowed to spend A♣/A♦ freely during quetsch.
  const emergencyMode = spadeEmergency || highSpadeEmergency || heartEmergency;

  const add = (c, allowProtected=false, allowSideAce=false) => {
    if(selected.length>=3 || !has(c) || selected.some(x=>sameCard(x,c))) return;
    if(protectedLow(c) && !allowProtected) return;
    if(sideSuitAce(c) && !allowSideAce && !emergencyMode) return;
    selected.push(c);
  };
  const addMany = (cards, allowProtected=false, allowSideAce=false) => {
    for(const c of cards){ add(c, allowProtected, allowSideAce); if(selected.length>=3) break; }
  };

  if(spadeEmergency) {
    add(QUEEN_SPADES);
    addMany(otherSpades.filter(c=>c.v===13||c.v===14).sort((a,b)=>b.v-a.v));
  }

  if(heartEmergency) addMany(highHearts);

  for(const s of ['C','D']) {
    if(selected.length>=3) break;
    if(!has({s,v:14})) continue;
    const same = cardsOfSuit(s).filter(c=>c.v!==14 && !selected.some(x=>sameCard(x,c)));
    const groups = [
      same.filter(c=>c.v>=7&&c.v<=10).sort((a,b)=>a.v-b.v),
      same.filter(c=>c.v>=5&&c.v<=6).sort((a,b)=>a.v-b.v),
      same.filter(c=>c.v>=11&&c.v<=13).sort((a,b)=>b.v-a.v),
    ];
    for(const g of groups) { if(g.length) { add(g[0]); break; } }
  }

  const voidOptions = [];
  for(const s of ['C','D']) {
    const remaining = cardsOfSuit(s).filter(c=>!selected.some(x=>sameCard(x,c)));

    // Do not create a cheap C/D void by passing away A♣/A♦ in normal hands.
    // The ace is a control card; keep it unless the hand is in emergency mode.
    if(!emergencyMode && remaining.some(sideSuitAce)) continue;

    if(remaining.length && remaining.length <= 3-selected.length && !remaining.some(protectedLow)) {
      const avg = remaining.reduce((a,c)=>a+c.v,0)/remaining.length;
      voidOptions.push({n:remaining.length, avg, cards:remaining});
    }
  }
  voidOptions.sort((a,b)=>a.n-b.n || b.avg-a.avg);
  if(voidOptions.length) addMany(voidOptions[0].cards.sort((a,b)=>b.v-a.v), false, emergencyMode);

  const fallbackScore = c => {
    if(sameCard(c, QUEEN_SPADES)) return 1000;
    if(c.s==='S' && (c.v===14||c.v===13)) return 800+c.v;
    if(c.s==='H' && c.v>=11) return 700+c.v;
    if(c.s==='H') return 300+c.v;
    if((c.s==='C'||c.s==='D') && c.v>=11) return 200+c.v;
    return c.v;
  };

  const remainingByFallback = () =>
    [...hand].filter(c=>!selected.some(x=>sameCard(x,c))).sort((a,b)=>fallbackScore(b)-fallbackScore(a));

  // Normal fallback still preserves low safety cards and side-suit aces.
  addMany(remainingByFallback().filter(c=>!protectedLow(c)));

  // If needed, spend protected lows before spending a preserved side-suit ace.
  addMany(remainingByFallback(), true);

  // Absolute last resort: always return exactly three legal cards.
  addMany(remainingByFallback(), true, true);

  return selected.slice(0,3);
};

`;

heuristic = replaceBetween(
  heuristic,
  'export const heuristicQuetschPick = hand => {',
  'export const botQuetschPick = heuristicQuetschPick;',
  newQuetschPick,
  'heuristicQuetschPick function'
);

const knownCardsOld = `const trickCards = gs => gs.trick.map(x => x.card);
const completedCards = gs => gs.trickHistory ?? [];
const knownCardsFor = (gs, player) => [
  ...gs.hands[player],
  ...trickCards(gs),
  ...completedCards(gs),
];

const unseenCardsOfSuit = (gs, player, suit) => {
`;
const knownCardsNew = `const trickCards = gs => gs.trick.map(x => x.card);
const completedCards = gs => gs.trickHistory ?? [];
const livePlayedOrCurrentCardKeys = gs => new Set([...trickCards(gs), ...completedCards(gs)].map(cardKey));
const liveKnownPassedLeft = (gs, player) => {
  const used = livePlayedOrCurrentCardKeys(gs);
  return (gs.quetschPassedLeft?.[player] ?? []).filter(c => !used.has(cardKey(c)));
};
const knownCardsFor = (gs, player) => [
  ...gs.hands[player],
  ...trickCards(gs),
  ...completedCards(gs),
];

const unseenCardsOfSuit = (gs, player, suit) => {
`;
heuristic = replaceOnce(heuristic, knownCardsOld, knownCardsNew, 'knownCardsFor quetsch memory');

const voidRiskOld = `const voidRiskyWinningLead = (card, gs, player) =>
  !lowNegativePressureMode(gs) &&
  suitVoidPenaltyRisk(gs, player, card.s) &&
  highWinProbability(card, gs, player);

`;
const voidRiskNew = `const quetschReceivedFromRightFor = (gs, player) => gs.quetschReceivedFromRight?.[player] ?? [];
const quetschReceivedCountBySuit = (gs, player, suit) =>
  quetschReceivedFromRightFor(gs, player).filter(c => c.s === suit).length;
const sideSuit = suit => suit === 'C' || suit === 'D';

const quetschDangerRelevant = (gs, player) =>
  !lowNegativePressureMode(gs) && !harvestModeActive(gs, player);

const quetschSuspiciousWinningLead = (card, gs, player) =>
  sideSuit(card.s) &&
  quetschReceivedCountBySuit(gs, player, card.s) >= 3 &&
  quetschDangerRelevant(gs, player) &&
  highWinProbability(card, gs, player);

const quetschSoftSuspiciousWinningLead = (card, gs, player) =>
  sideSuit(card.s) &&
  quetschReceivedCountBySuit(gs, player, card.s) === 2 &&
  quetschDangerRelevant(gs, player) &&
  highWinProbability(card, gs, player);

const preferNonQuetschSoftWinningLeads = (cards, gs, player) => {
  if(!cards.length) return cards;
  const softRisk = cards.filter(c => quetschSoftSuspiciousWinningLead(c, gs, player));
  if(!softRisk.length || softRisk.length === cards.length) return cards;
  return cards.filter(c => !softRisk.some(r => sameCard(r, c)));
};

const voidRiskyWinningLead = (card, gs, player) =>
  (
    !lowNegativePressureMode(gs) &&
    suitVoidPenaltyRisk(gs, player, card.s) &&
    highWinProbability(card, gs, player)
  ) ||
  quetschSuspiciousWinningLead(card, gs, player);

`;
heuristic = replaceOnce(heuristic, voidRiskOld, voidRiskNew, 'voidRiskyWinningLead with quetsch suspicion');

const followProbOld = `  const unseenSuitCount = unseenCardsOfSuit(gs, player, suit).length;
  if(unseenSuitCount <= 0) return 0;
`;
const followProbNew = `  // Own quetsch pass memory: cards passed left are known to remain in the
  // left player's hand until played, so left is not void in that suit.
  const leftPlayer = (player + 1) % 4;
  if(targetPlayer === leftPlayer && liveKnownPassedLeft(gs, player).some(c => c.s === suit)) return 1;

  const unseenSuitCount = unseenCardsOfSuit(gs, player, suit).length;
  if(unseenSuitCount <= 0) return 0;
`;
heuristic = replaceOnce(heuristic, followProbOld, followProbNew, 'followSuitNonVoidProbability known-left insertion');

heuristic = replaceOnce(
  heuristic,
  `    case 'void_risk_lead':
      return 'Der Bot meidet eine Farbe nur dann wegen Abwurfgefahr, wenn der void Spieler noch wirklich negative Karten abwerfen kann.' + suffix;
`,
  `    case 'void_risk_lead':
      return 'Der Bot meidet eine Farbe wegen echter Abwurfgefahr oder wegen eines starken Quetsch-Hinweises aus den erhaltenen Karten.' + suffix;
`,
  'void risk suggestion reason'
);

heuristic = replaceOnce(
  heuristic,
  `    const safeAces = candidates.filter(c => (c.s === 'C' || c.s === 'D') && c.v === 14);
    if(safeAces.length) return finish(safeAces, 'safe_ace_lead');

`,
  `    const safeAces = candidates.filter(c => (c.s === 'C' || c.s === 'D') && c.v === 14);
    if(safeAces.length) return finish(preferNonQuetschSoftWinningLeads(safeAces, gs, player), 'safe_ace_lead');

`,
  'safe ace soft quetsch tie-break'
);

heuristic = replaceOnce(
  heuristic,
  `    if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
      candidates = midgameLeadCandidates(candidates, gs, player);
      return finish(candidates, 'midgame_lead');
    }

    return finish(candidates, 'normal_lead');
`,
  `    if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
      candidates = midgameLeadCandidates(candidates, gs, player);
      return finish(preferNonQuetschSoftWinningLeads(candidates, gs, player), 'midgame_lead');
    }

    return finish(preferNonQuetschSoftWinningLeads(candidates, gs, player), 'normal_lead');
`,
  'midgame/normal soft quetsch tie-break'
);

engine = replaceOnce(
  engine,
  `    quetschPassedLeft: [[], [], [], []],
    knownVoids: [0, 1, 2, 3].map(() => [false, false, false, false]), // C/D/H/S
`,
  `    quetschPassedLeft: [[], [], [], []],
    quetschReceivedFromRight: [[], [], [], []],
    knownVoids: [0, 1, 2, 3].map(() => [false, false, false, false]), // C/D/H/S
`,
  'dealRound quetschReceivedFromRight init'
);

engine = replaceOnce(
  engine,
  `    quetschSelections: [[], [], [], []],
    quetschPassedLeft: selections.map(sel => [...sel]),
  };
};
`,
  `    quetschSelections: [[], [], [], []],
    quetschPassedLeft: selections.map(sel => [...sel]),
    quetschReceivedFromRight: toAdd.map(sel => [...sel]),
  };
};
`,
  'applyQuetschSelections quetschReceivedFromRight storage'
);

write(files.heuristic, heuristic);
write(files.engine, engine);

checkSyntax(files.heuristic);
checkSyntax(files.engine);

console.log('✅ Applied quetsch memory v3 patch.');
console.log(`   Backups written to ${path.relative(root, backupRoot)}`);
console.log('   Changed: shared/game/heuristicBot.js');
console.log('   Changed: shared/game/engine.js');
console.log('Next: npm run build');
