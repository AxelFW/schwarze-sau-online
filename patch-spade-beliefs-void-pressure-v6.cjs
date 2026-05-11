#!/usr/bin/env node
/*
  Patch: spade-belief risk multipliers + harmful-void / low-negative-pressure logic
  Target: current schwarze-sau-online repo after the V4 spade-follow / lead-order patch.

  Usage:
    node patch-spade-beliefs-void-pressure-v6.cjs .

  The script is intentionally idempotent-ish for the engine spadeBeliefs state:
  if that part is already present, it leaves it alone.  It then patches the
  current V4-shaped heuristicBot.js blocks.
*/
const fs = require('fs');
const path = require('path');

const rootArg = process.argv[2] || '.';
const root = path.resolve(rootArg);

const candidates = [
  root,
  path.join(root, 'shared/game/heuristicBot.js'),
];

const heuristicPath = fs.existsSync(root) && fs.statSync(root).isFile()
  ? root
  : path.join(root, 'shared/game/heuristicBot.js');
const enginePath = fs.existsSync(root) && fs.statSync(root).isFile()
  ? path.join(path.dirname(root), 'engine.js')
  : path.join(root, 'shared/game/engine.js');

function fail(msg) {
  console.error(`❌ Patch failed: ${msg}`);
  process.exit(1);
}

function backup(file, tag) {
  if (!fs.existsSync(file)) fail(`Missing file: ${file}`);
  const bak = `${file}.bak-${tag}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return bak;
}

function replaceExact(text, from, to, label) {
  if (!text.includes(from)) fail(`Could not find block: ${label}`);
  return text.replace(from, to);
}

function replaceRegex(text, regex, to, label) {
  if (!regex.test(text)) fail(`Could not find regex block: ${label}`);
  return text.replace(regex, to);
}

function patchEngine(engine) {
  // Latest uploaded repo already has this block because the previous failed V5
  // partially patched engine.js.  Keep it untouched when present.
  if (engine.includes('spadeBeliefs')) return engine;

  engine = replaceExact(
    engine,
    `    knownVoids: [0, 1, 2, 3].map(() => [false, false, false, false]), // C/D/H/S\n`,
    `    knownVoids: [0, 1, 2, 3].map(() => [false, false, false, false]), // C/D/H/S\n    spadeBeliefs: {\n      probableNoLowSpades: [false, false, false, false],\n      suspectedQueenHolder: [false, false, false, false],\n    },\n`,
    'engine dealRound spadeBeliefs'
  );

  engine = replaceExact(
    engine,
    `  const newKnownVoids = (prevGs.knownVoids ?? [0, 1, 2, 3].map(() => [false, false, false, false])).map(row => [...row]);\n\n  if (prevGs.leadSuit && card.s !== prevGs.leadSuit) {\n    newKnownVoids[player][suitIdx(prevGs.leadSuit)] = true;\n  }\n`,
    `  const newKnownVoids = (prevGs.knownVoids ?? [0, 1, 2, 3].map(() => [false, false, false, false])).map(row => [...row]);\n  const prevSpadeBeliefs = prevGs.spadeBeliefs ?? {};\n  const newSpadeBeliefs = {\n    probableNoLowSpades: [false, false, false, false].map((fallback, i) =>\n      Boolean(prevSpadeBeliefs.probableNoLowSpades?.[i] ?? fallback)\n    ),\n    suspectedQueenHolder: [false, false, false, false].map((fallback, i) =>\n      Boolean(prevSpadeBeliefs.suspectedQueenHolder?.[i] ?? fallback)\n    ),\n  };\n\n  if (prevGs.leadSuit && card.s !== prevGs.leadSuit) {\n    newKnownVoids[player][suitIdx(prevGs.leadSuit)] = true;\n  }\n\n  // Bot-belief support: infer spade-specific soft beliefs from public play.\n  // 1) If a player follows a spade trick with ♠Q before any ♠K/♠A is already\n  //    in that trick, they probably lacked harmless low spade shields.\n  if (prevGs.leadSuit === 'S' && prevGs.trick.length > 0 && card.s === 'S' && card.v === 12) {\n    const highSpadeAlreadyInTrick = prevGs.trick.some(x => x.card?.s === 'S' && (x.card.v === 13 || x.card.v === 14));\n    if (!highSpadeAlreadyInTrick) newSpadeBeliefs.probableNoLowSpades[player] = true;\n  }\n\n  // 2) If a player voluntarily uses ♠K/♠A before last position while ♠Q is\n  //    still live, treat that player as a likely ♠Q-holder.\n  const queenSpadesAlreadySeen = [...(prevGs.trickHistory ?? []), ...(prevGs.trick ?? []).map(x => x.card)]\n    .some(c => c?.s === 'S' && c?.v === 12);\n  if (newLeadSuit === 'S' && card.s === 'S' && (card.v === 13 || card.v === 14) && newTrick.length <= 3 && !queenSpadesAlreadySeen) {\n    newSpadeBeliefs.suspectedQueenHolder[player] = true;\n  }\n`,
    'engine applyCard spadeBeliefs inference'
  );

  engine = engine.replace(
    `      knownVoids: newKnownVoids,\n      currentPlayer: winner,`,
    `      knownVoids: newKnownVoids,\n      spadeBeliefs: newSpadeBeliefs,\n      currentPlayer: winner,`
  );
  engine = engine.replace(
    `    knownVoids: newKnownVoids,\n    currentPlayer: (player + 1) % 4,`,
    `    knownVoids: newKnownVoids,\n    spadeBeliefs: newSpadeBeliefs,\n    currentPlayer: (player + 1) % 4,`
  );

  return engine;
}

function patchHeuristic(src) {
  if (!src.includes('const lowNegativePressureMode = gs =>')) {
    src = replaceExact(
      src,
      `const remainingPenaltyCost = cards =>\n  -cards.reduce((sum, c) => sum + Math.min(0, cardPts(c)), 0);\n\n`,
      `const remainingPenaltyCost = cards =>\n  -cards.reduce((sum, c) => sum + Math.min(0, cardPts(c)), 0);\n\nconst allPenaltyCards = () => [QUEEN_SPADES, ...cardsOfSuit('H')];\n\nconst unresolvedNegativePressure = gs => {\n  // Negative pressure means all penalty cards not yet locked away in completed\n  // tricks.  This includes the current trick and every hand, including our own.\n  const completed = completedCards(gs);\n  return remainingPenaltyCost(allPenaltyCards().filter(c => !cardIn(completed, c)));\n};\n\nconst lowNegativePressureMode = gs => unresolvedNegativePressure(gs) <= 10;\n\nconst knownVoidInSuit = (gs, player, suit) =>\n  Boolean(gs.knownVoids?.[player]?.[suitIdx(suit)]);\n\nconst playerCanStillDumpNegative = (gs, player) => {\n  // In low-pressure mode, void fear is deliberately switched off.\n  if(lowNegativePressureMode(gs)) return false;\n\n  const unavailable = new Set([...completedCards(gs), ...trickCards(gs)].map(cardKey));\n  const heartsStillAvailable = cardsOfSuit('H').some(c => !unavailable.has(cardKey(c)));\n  const canDumpHearts = heartsStillAvailable && !knownVoidInSuit(gs, player, 'H');\n\n  const queenStillAvailable =\n    !queenSpadesPlayed(gs) &&\n    !queenSpadesInTrick(gs) &&\n    !knownVoidInSuit(gs, player, 'S');\n\n  return canDumpHearts || queenStillAvailable;\n};\n\n`,
      'low negative pressure helper insertion'
    );
  }

  if (!src.includes('return gs.knownVoids?.[p]?.[si] && playerCanStillDumpNegative(gs, p);')) {
    src = replaceRegex(
      src,
      /const anyOpponentVoidIn = \(gs, player, suit\) => \{\n\s*const si = suitIdx\(suit\);\n\s*return \[1,2,3\]\.some\(off => gs\.knownVoids\?\.\[\(player \+ off\) % 4\]\?\.\[si\]\);\n\};/,
      `const anyOpponentVoidIn = (gs, player, suit) => {\n  if(lowNegativePressureMode(gs)) return false;\n  const si = suitIdx(suit);\n  return [1,2,3].some(off => {\n    const p = (player + off) % 4;\n    return gs.knownVoids?.[p]?.[si] && playerCanStillDumpNegative(gs, p);\n  });\n};`,
      'harmful known-void opponent check'
    );
  }

  if (!src.includes('const harvestModeActive = (gs, player) => {\n  if(lowNegativePressureMode(gs)) return true;')) {
    src = replaceExact(
      src,
      `const harvestModeActive = (gs, player) => {\n  const penalties = remainingPenaltiesOutside(gs, player);\n`,
      `const harvestModeActive = (gs, player) => {\n  if(lowNegativePressureMode(gs)) return true;\n  const penalties = remainingPenaltiesOutside(gs, player);\n`,
      'harvest low-negative-pressure activation'
    );
  }

  if (!src.includes('const voidRiskyWinningLead = (card, gs, player) =>\n  !lowNegativePressureMode(gs)')) {
    src = src.replace(
      `const voidRiskyWinningLead = (card, gs, player) =>\n  suitVoidPenaltyRisk(gs, player, card.s) && highWinProbability(card, gs, player);`,
      `const voidRiskyWinningLead = (card, gs, player) =>\n  !lowNegativePressureMode(gs) &&\n  suitVoidPenaltyRisk(gs, player, card.s) &&\n  highWinProbability(card, gs, player);`
    );
  }

  if (!src.includes('if(!lowNegativePressureMode(gs) && seriousDangerOnHand(gs, player) && beatable.length) {')) {
    src = src.replace(
      `if(seriousDangerOnHand(gs, player) && beatable.length) {`,
      `if(!lowNegativePressureMode(gs) && seriousDangerOnHand(gs, player) && beatable.length) {`
    );
  }

  if (!src.includes('A known void is only bad if that player can still dump negative cards.')) {
    src = replaceExact(
      src,
      `const followSuitNonVoidProbability = (gs, player, targetPlayer, suit) => {\n  if(!suit || !Number.isInteger(targetPlayer)) return 0;\n\n  const si = suitIdx(suit);\n  if(gs.knownVoids?.[targetPlayer]?.[si]) return 0;\n\n  const unseenSuitCount = unseenCardsOfSuit(gs, player, suit).length;\n`,
      `const followSuitNonVoidProbability = (gs, player, targetPlayer, suit) => {\n  if(!suit || !Number.isInteger(targetPlayer)) return 0;\n  if(lowNegativePressureMode(gs)) return 1;\n\n  const si = suitIdx(suit);\n  if(gs.knownVoids?.[targetPlayer]?.[si]) {\n    // A known void is only bad if that player can still dump negative cards.\n    return playerCanStillDumpNegative(gs, targetPlayer) ? 0 : 1;\n  }\n\n  const unseenSuitCount = unseenCardsOfSuit(gs, player, suit).length;\n`,
      'follow probability harmful-known-void handling'
    );
  }

  if (!src.includes('const applyOvertakeRiskMultiplier =')) {
    src = replaceExact(
      src,
      `  const pVoid = comb(unknownTotal - unseenSuitCount, targetHandSize) / denom;\n  return clamp01(1 - pVoid);\n};\n\nconst positiveFollowWinners = (cards, gs, player) => {\n`,
      `  const pVoid = comb(unknownTotal - unseenSuitCount, targetHandSize) / denom;\n  return clamp01(1 - pVoid);\n};\n\nconst applyOvertakeRiskMultiplier = (pTake, gs, player, laterPlayers) => {\n  // Soft spade beliefs affect voluntary 2nd/3rd-position overtakes only.\n  // They never block legal play, forced wins, or 4th-position positive takes.\n  if(lowNegativePressureMode(gs)) return clamp01(pTake);\n\n  const beliefs = gs.spadeBeliefs ?? {};\n  const probableNoLowSpades = beliefs.probableNoLowSpades ?? [];\n  const suspectedQueenHolder = beliefs.suspectedQueenHolder ?? [];\n\n  let p = pTake;\n\n  if(gs.leadSuit === 'S' && !queenSpadesPlayed(gs)) {\n    for(const lp of laterPlayers) {\n      if(probableNoLowSpades[lp]) p *= 0.3;\n    }\n  }\n\n  if((gs.leadSuit === 'C' || gs.leadSuit === 'D') && !queenSpadesPlayed(gs) && !queenSpadesInTrick(gs) && !queenSpadesInHand(gs, player)) {\n    for(const lp of laterPlayers) {\n      if(suspectedQueenHolder[lp]) p *= 0.3;\n    }\n  }\n\n  return clamp01(p);\n};\n\nconst positiveFollowWinners = (cards, gs, player) => {\n`,
      'spade-belief overtake multiplier helper insertion'
    );
  }

  if (!src.includes('const baseTake = followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);')) {
    src = replaceExact(
      src,
      `      const fourthPlayer = (player + 1) % 4;\n      const pTake = followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);\n      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Chance, dass der nächste Spieler bedienen kann).';\n`,
      `      const fourthPlayer = (player + 1) % 4;\n      const baseTake = followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);\n      const pTake = applyOvertakeRiskMultiplier(baseTake, gs, player, [fourthPlayer]);\n      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Risiko-abgewogene Übernahmechance).';\n`,
      'third-position risk-adjusted overtake probability'
    );
  }

  if (!src.includes('const baseTake =\n        followSuitNonVoidProbability(gs, player, thirdPlayer, gs.leadSuit) *')) {
    src = replaceExact(
      src,
      `      const thirdPlayer = (player + 1) % 4;\n      const fourthPlayer = (player + 2) % 4;\n      const pTake =\n        followSuitNonVoidProbability(gs, player, thirdPlayer, gs.leadSuit) *\n        followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);\n      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Chance, dass beide späteren Spieler bedienen können).';\n`,
      `      const thirdPlayer = (player + 1) % 4;\n      const fourthPlayer = (player + 2) % 4;\n      const baseTake =\n        followSuitNonVoidProbability(gs, player, thirdPlayer, gs.leadSuit) *\n        followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);\n      const pTake = applyOvertakeRiskMultiplier(baseTake, gs, player, [thirdPlayer, fourthPlayer]);\n      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Risiko-abgewogene Übernahmechance).';\n`,
      'second-position risk-adjusted overtake probability'
    );
  }

  // Refresh easy-mode explanations, but do not fail if user has customized them.
  src = src.replace(
    `return 'Der Bot sieht nur noch wenig Strafkarten-Risiko und versucht einen positiven Stich zu gewinnen.' + suffix;`,
    `return 'Der Bot sieht nur noch wenig ungelösten Strafkarten-Druck und versucht nun aktiver positive Stiche zu gewinnen.' + suffix;`
  );
  src = src.replace(
    `return 'Der Bot meidet eine Farbe, in der ein Mitspieler vermutlich abwerfen kann, falls die Karte den Stich gewinnt.' + suffix;`,
    `return 'Der Bot meidet eine Farbe nur dann wegen Abwurfgefahr, wenn der void Spieler noch wirklich negative Karten abwerfen kann.' + suffix;`
  );
  src = src.replace(
    `return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich; bei Pik bleibt die ♠Q-Sicherheit berücksichtigt.' + suffix;`,
    `return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich; bei Pik und vermuteten ♠Q-Gefahren wird die Übernahmechance angepasst.' + suffix;`
  );
  src = src.replace(
    `return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler noch übernehmen oder abwerfen könnten.' + suffix;`,
    `return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler nach Risikoabschätzung noch übernehmen oder gefährlich abwerfen könnten.' + suffix;`
  );
  src = src.replace(
    `return 'Im Mittelspiel bevorzugt der Bot zuerst noch übernehmbare Karten; unter Gefahr nimmt er danach eher eine kurze Farbe.' + suffix;`,
    `return 'Im Mittelspiel bevorzugt der Bot erst übernehmbare Karten; nur bei echter Strafkarten-Gefahr zählt danach die kurze Farbe.' + suffix;`
  );

  return src;
}

try {
  if (!fs.existsSync(heuristicPath)) fail(`Could not find heuristicBot.js at ${heuristicPath}`);
  if (!fs.existsSync(enginePath)) fail(`Could not find engine.js at ${enginePath}`);

  const tag = 'spade-beliefs-void-pressure-v6';
  const heuristicBak = backup(heuristicPath, tag);
  const engineBak = backup(enginePath, tag);

  const engineBefore = fs.readFileSync(enginePath, 'utf8');
  const heuristicBefore = fs.readFileSync(heuristicPath, 'utf8');

  const engineAfter = patchEngine(engineBefore);
  const heuristicAfter = patchHeuristic(heuristicBefore);

  fs.writeFileSync(enginePath, engineAfter);
  fs.writeFileSync(heuristicPath, heuristicAfter);

  console.log('✅ Patch applied: spade beliefs, harmful voids, low negative pressure.');
  console.log(`   Patched: ${path.relative(process.cwd(), enginePath)}`);
  console.log(`   Patched: ${path.relative(process.cwd(), heuristicPath)}`);
  console.log(`   Backups: ${path.relative(process.cwd(), engineBak)}`);
  console.log(`            ${path.relative(process.cwd(), heuristicBak)}`);
  console.log('   Run: node --check shared/game/engine.js && node --check shared/game/heuristicBot.js');
} catch (err) {
  fail(err.message || String(err));
}
