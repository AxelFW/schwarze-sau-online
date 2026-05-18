#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const touched = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}
function write(rel, text) {
  const file = path.join(root, rel);
  const bak = `${file}.bak-political-spade-heart-${stamp}`;
  if(!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  fs.writeFileSync(file, text);
  touched.push(rel);
}
function replaceOnce(text, search, replacement, label) {
  if(!text.includes(search)) throw new Error(`Could not find block: ${label}`);
  return text.replace(search, replacement);
}
function replaceRegexOnce(text, regex, replacement, label) {
  if(!regex.test(text)) throw new Error(`Could not find regex block: ${label}`);
  return text.replace(regex, replacement);
}

// ── shared/game/heuristicBot.js ─────────────────────────────────────────────
let bot = read('shared/game/heuristicBot.js');

bot = replaceOnce(
  bot,
  'export const heuristicQuetschPick = hand => {',
  'export const heuristicQuetschPick = (hand, gs = null, player = null) => {',
  'quetsch signature with optional game state/player'
);

bot = replaceOnce(
  bot,
  `  const seriousDanger = toxicWuzzHighSpadeCluster || weakQSpades || noWuzzHighSpadeTrap || unprotectedHighHearts;\n`,
  `  const seriousDanger = toxicWuzzHighSpadeCluster || weakQSpades || noWuzzHighSpadeTrap || unprotectedHighHearts;\n\n  // Offensive/political ♠Q trap: when ♠Q is well protected by at least three\n  // smaller spades and no ♠K/♠A are held, the bot may pass ♠Q left even though\n  // it is not an emergency.  This is strongest when the left player is a\n  // current target/leader, because the later H_Q1 pressure can attack them.\n  const leftPlayerForQuetsch = Number.isInteger(player) ? (player + 1) % 4 : null;\n  const leftRelationForQuetsch = gs && leftPlayerForQuetsch !== null\n    ? playerRankRelation(gs, player, leftPlayerForQuetsch)\n    : 'unknown';\n  const politicalQueenTrap =\n    hasQSpades &&\n    highSpades.length === 0 &&\n    lowSpadesBelowQueen.length >= 3;\n  const politicalQueenTrapBase =\n    leftRelationForQuetsch === 'target' ? 96 :\n    leftRelationForQuetsch === 'nontarget' ? 62 :\n    74;\n`,
  'political quetsch trap variables'
);

bot = replaceOnce(
  bot,
  `  if(lightProtectedHighHearts) {\n    for(const c of highHearts) good.push({card: c, base: 78 + c.v / 10, salt: 'light-protected-high-hearts'});\n  }\n\n  const minorStructuralScore = card => {`,
  `  if(lightProtectedHighHearts) {\n    for(const c of highHearts) good.push({card: c, base: 78 + c.v / 10, salt: 'light-protected-high-hearts'});\n  }\n\n  if(politicalQueenTrap && selected.length === 0) {\n    good.push({\n      card: QUEEN_SPADES,\n      base: politicalQueenTrapBase,\n      salt: 'political-long-spade-queen-trap',\n    });\n  }\n\n  const minorStructuralScore = card => {`,
  'add political queen trap to good quetsch bucket'
);

bot = replaceOnce(
  bot,
  `export const recommendHeuristicQuetschCards = hand => {\n  const cards = heuristicQuetschPick(hand);\n  const reason = 'Easy Mode: Der Bot würde diese drei Karten quetschen. Er priorisiert gefährliche Strafkarten, behält niedrige Schutzkarten und wirft ♣/♦-Asse nicht nur für einen Void weg.';`,
  `export const recommendHeuristicQuetschCards = (hand, gs = null, player = null) => {\n  const cards = heuristicQuetschPick(hand, gs, player);\n  const reason = cards.some(c => sameCard(c, QUEEN_SPADES))\n    ? 'Easy Mode: Der Bot würde diese drei Karten quetschen. Er priorisiert gefährliche Strafkarten; mit langer Pik-Struktur kann ♠Q auch politisch nach links gegeben und später unter Druck gesetzt werden.'\n    : 'Easy Mode: Der Bot würde diese drei Karten quetschen. Er priorisiert gefährliche Strafkarten, behält niedrige Schutzkarten und wirft ♣/♦-Asse nicht nur für einen Void weg.';`,
  'quetsch recommendation signature/reason'
);

bot = replaceOnce(
  bot,
  `  const targetWeight = relation === 'target' ? 1.65 : 0.45;\n  const shapeWeight = relation === 'target' ? 0.35 : 1.45;`,
  `  const targetWeight = relation === 'target' ? 2.05 : 0.25;\n  const shapeWeight = relation === 'target' ? 0.20 : 1.65;`,
  'more severe target/nontarget strategic void dump weights'
);

bot = replaceOnce(
  bot,
  `      score -= 22;`,
  `      score -= 32;`,
  'stronger non-target poison discount'
);

bot = replaceOnce(
  bot,
  `const preserveLastLowSpadeShieldLead = (cards, gs, player) => {\n  // Lead-only candidate filter: if ♠Q is still outside and we hold ♠K/♠A, keep\n  // one low spade shield (<♠Q) when possible.  Do not make the bot unable to\n  // lead; if all candidates burn the shield, keep the original candidates.\n  if(!cards.length || !queenSpadesLiveOutside(gs, player)) return cards;\n\n  const hand = gs.hands[player] || [];\n  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));\n  if(!holdsHighSpade) return cards;\n\n  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);\n  if(lowSpadesInHand.length !== 1) return cards;\n\n  const shield = lowSpadesInHand[0];\n  const filtered = cards.filter(c => !sameCard(c, shield));\n  return filtered.length ? filtered : cards;\n};\n`,
  `const preserveLastLowSpadeShieldLead = (cards, gs, player) => {\n  // Lead-only candidate filter: if ♠Q is still outside and we hold ♠K/♠A, keep\n  // one low spade shield (<♠Q) when possible.  Do not make the bot unable to\n  // lead; if all candidates burn the shield, keep the original candidates.\n  if(!cards.length || !queenSpadesLiveOutside(gs, player)) return cards;\n\n  const hand = gs.hands[player] || [];\n  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));\n  if(!holdsHighSpade) return cards;\n\n  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);\n  if(lowSpadesInHand.length !== 1) return cards;\n\n  const shield = lowSpadesInHand[0];\n  const filtered = cards.filter(c => !sameCard(c, shield));\n  return filtered.length ? filtered : cards;\n};\n\nconst passedQueenPressureSpades = (valid, gs, player) => {\n  // If we know we passed ♠Q left, actively pressure that seat with the smallest\n  // safe low spade from early/midgame onward.  It becomes a little earlier when\n  // the left player is a target/current leader.  Do not burn the final low-spade\n  // shield while holding ♠K/♠A.\n  if(!queenSpadesPassedLeft(gs, player)) return [];\n\n  const leftPlayer = (player + 1) % 4;\n  const leftRelation = playerRankRelation(gs, player, leftPlayer);\n  const minTrick = leftRelation === 'target' ? 2 : 3;\n  if(gs.tricksPlayed < minTrick) return [];\n\n  const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);\n  if(!spadesInHand.length) return [];\n\n  const unseenSpades = unseenCardsOfSuit(gs, player, 'S');\n  const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));\n  if(!safeSpades.length) return [];\n\n  const hand = gs.hands[player] || [];\n  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);\n  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));\n  if(holdsHighSpade && lowSpadesInHand.length <= 1) return [];\n\n  return smallestCards(safeSpades);\n};\n`,
  'add aggressive passed-Q-left pressure helper'
);

bot = replaceOnce(
  bot,
  `const voidRiskyWinningLead = (card, gs, player) =>\n  (\n    !lowNegativePressureMode(gs) &&\n    suitVoidPenaltyRisk(gs, player, card.s) &&\n    highWinProbability(card, gs, player)\n  ) ||\n  quetschSuspiciousWinningLead(card, gs, player);\n`,
  `const voidRiskyWinningLead = (card, gs, player) =>\n  (\n    !lowNegativePressureMode(gs) &&\n    suitVoidPenaltyRisk(gs, player, card.s) &&\n    highWinProbability(card, gs, player)\n  ) ||\n  quetschSuspiciousWinningLead(card, gs, player);\n\nconst knownVoidDumpersInSuit = (gs, player, suit) => {\n  const si = suitIdx(suit);\n  return [1, 2, 3]\n    .map(off => (player + off) % 4)\n    .filter(p => gs.knownVoids?.[p]?.[si] && playerCanStillDumpNegative(gs, p));\n};\n\nconst targetAwareVoidLeadDecision = (cards, gs, player) => {\n  // If a target is known void in a candidate suit, reduce the appeal of that\n  // suit because the target can dump safely.  When a safe ♠/♥ pressure lead\n  // survived earlier filters, prefer it directly.\n  if(!cards.length || lowNegativePressureMode(gs)) return {cards, pressure: []};\n\n  const givesTargetFreeDump = card => knownVoidDumpersInSuit(gs, player, card.s)\n    .some(p => playerRankRelation(gs, player, p) === 'target');\n\n  const bad = cards.filter(givesTargetFreeDump);\n  if(!bad.length) return {cards, pressure: []};\n\n  const nonBad = cards.filter(c => !givesTargetFreeDump(c));\n  if(!nonBad.length) return {cards, pressure: []};\n\n  const pressure = nonBad.filter(c =>\n    (c.s === 'S' || c.s === 'H') &&\n    !voidRiskyWinningLead(c, gs, player)\n  );\n\n  return {\n    cards: pressure.length ? pressure : nonBad,\n    pressure,\n  };\n};\n`,
  'add target-aware void lead decision'
);

bot = replaceOnce(
  bot,
  `const harvestWinningLeads = (cards, gs, player) => {\n  if(!harvestModeActive(gs, player)) return [];\n\n  const positive = cards.filter(c =>\n    !sameCard(c, QUEEN_SPADES) &&\n    projectedLeadNetFloor(c, gs, player) >= HARVEST_MIN_PROJECTED_NET\n  );\n  if(!positive.length) return [];\n\n  // First preference: highest remaining card of a suit.\n  const highestRemaining = positive.filter(c => noHigherUnseenCard(c, gs, player));\n  if(highestRemaining.length) return largestCards(highestRemaining);\n\n  // Fallback: high-probability winners.\n  const likelyWinners = positive.filter(c => highWinProbability(c, gs, player));\n  return likelyWinners.length ? largestCards(likelyWinners) : [];\n};\n`,
  `const harvestWinningLeads = (cards, gs, player) => {\n  if(!harvestModeActive(gs, player)) return [];\n\n  const positive = cards.filter(c =>\n    !sameCard(c, QUEEN_SPADES) &&\n    projectedLeadNetFloor(c, gs, player) >= HARVEST_MIN_PROJECTED_NET\n  );\n  if(!positive.length) return [];\n\n  // First preference: highest remaining card of a suit.\n  const highestRemaining = positive.filter(c => noHigherUnseenCard(c, gs, player));\n  if(highestRemaining.length) return largestCards(highestRemaining);\n\n  // Fallback: high-probability winners.\n  const likelyWinners = positive.filter(c => highWinProbability(c, gs, player));\n  return likelyWinners.length ? largestCards(likelyWinners) : [];\n};\n\nconst smallestOutsideHeartRank = (gs, player) => {\n  const outside = unseenCardsOfSuit(gs, player, 'H');\n  return outside.length ? Math.min(...outside.map(c => c.v)) : null;\n};\n\nconst heartBleedLeadCandidates = (cards, gs, player) => {\n  // Anti-greed heart bleed: only in mid/late game when all outside hearts are\n  // at least ♥9, and only if a non-heart winning lead is tempting.  This keeps\n  // the bot from always leading tiny hearts while still avoiding automatic ace\n  // cash-ins when large hearts are waiting outside.\n  if(!cards.length) return [];\n  if(gs.tricksPlayed < 4) return [];\n  if(lowNegativePressureMode(gs)) return [];\n\n  const minOutsideHeart = smallestOutsideHeartRank(gs, player);\n  if(minOutsideHeart === null || minOutsideHeart < 9) return [];\n\n  const hearts = cards.filter(c => c.s === 'H');\n  if(!hearts.length) return [];\n\n  const temptingWinner = cards.some(c =>\n    c.s !== 'H' &&\n    !sameCard(c, QUEEN_SPADES) &&\n    projectedLeadNetFloor(c, gs, player) >= HARVEST_MIN_PROJECTED_NET &&\n    highWinProbability(c, gs, player)\n  );\n  if(!temptingWinner) return [];\n\n  const safeBleedHearts = hearts.filter(c =>\n    c.v < minOutsideHeart &&\n    c.v < 11 &&\n    hasHigherUnplayedOutsideOwnHand(c, gs, player) &&\n    !heartLeadExposureRisk(c, gs, player)\n  );\n\n  return safeBleedHearts.length ? smallestCards(safeBleedHearts) : [];\n};\n`,
  'add anti-greed heart bleed helper'
);

bot = replaceOnce(
  bot,
  `    case 'spade_safety_lead':\n      return 'Der Bot vermeidet gefährliche Pik-Anspiele und behält mit ♠K/♠A möglichst eine kleine Pik-Schutzkarte.' + suffix;\n    case 'harvest_lead':`,
  `    case 'spade_safety_lead':\n      return 'Der Bot vermeidet gefährliche Pik-Anspiele und behält mit ♠K/♠A möglichst eine kleine Pik-Schutzkarte.' + suffix;\n    case 'passed_queen_pressure_lead':\n      return 'Der Bot weiß, dass er ♠Q nach links gegeben hat, und setzt diesen Sitz mit einer kleinen Pik-Karte unter Druck.' + suffix;\n    case 'heart_bleed_lead':\n      return 'Der Bot spielt eine kleine Herz-Karte, weil draußen nur noch hohe Herzen liegen und ein sofortiger Gewinnzug sonst zu gierig wäre.' + suffix;\n    case 'target_void_pressure_lead':\n      return 'Der Bot meidet eine Farbe, in der ein Zielspieler sicher abwerfen könnte, und sucht stattdessen Druck über Pik oder Herz.' + suffix;\n    case 'harvest_lead':`,
  'new easy-mode reasons'
);

bot = replaceOnce(
  bot,
  `    // H_Q1: If we passed ♠Q left, allow safe LOW spades to pressure that seat.\n    // The no-high-spade-lead rule still applies: never re-add ♠K/♠A here.\n    if(queenSpadesPassedLeft(gs, player)) {\n      const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);\n      if(spadesInHand.length) {\n        const unseenSpades = unseenCardsOfSuit(gs, player, 'S');\n        const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));\n        if(safeSpades.length) {\n          const nonSpadeCandidates = candidates.filter(c => c.s !== 'S');\n          candidates = [\n            ...nonSpadeCandidates,\n            ...safeSpades.filter(c => !nonSpadeCandidates.some(x => sameCard(x, c))),\n          ];\n        }\n      }\n    }\n\n    // H_HARVEST: If late-game penalty risk is low, stop over-avoiding`,
  `    // H_Q1: If we passed ♠Q left, actively pressure that seat with safe LOW\n    // spades from early/midgame onward.  If the direct pressure trigger does\n    // not fire yet, still re-add safe low spades as allowed candidates.\n    const qPressureSpades = passedQueenPressureSpades(valid, gs, player);\n    if(qPressureSpades.length) {\n      return finish(qPressureSpades, 'passed_queen_pressure_lead');\n    }\n    if(queenSpadesPassedLeft(gs, player)) {\n      const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);\n      if(spadesInHand.length) {\n        const unseenSpades = unseenCardsOfSuit(gs, player, 'S');\n        const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));\n        if(safeSpades.length) {\n          const nonSpadeCandidates = candidates.filter(c => c.s !== 'S');\n          candidates = [\n            ...nonSpadeCandidates,\n            ...safeSpades.filter(c => !nonSpadeCandidates.some(x => sameCard(x, c))),\n          ];\n        }\n      }\n    }\n\n    // H_HBLEED: Before greedily harvesting positive winners, bleed the smallest\n    // safe held heart when every outside heart is at least ♥9.\n    const heartBleedLeads = heartBleedLeadCandidates(candidates, gs, player);\n    if(heartBleedLeads.length) return finish(heartBleedLeads, 'heart_bleed_lead');\n\n    // H_HARVEST: If late-game penalty risk is low, stop over-avoiding`,
  'replace H_Q1 and add heart bleed before harvest'
);

bot = replaceOnce(
  bot,
  `    // H_V1: Known-void suits are only dangerous when the card is likely to win.\n    const riskyVoidLeads = candidates.filter(c => voidRiskyWinningLead(c, gs, player));\n    if(riskyVoidLeads.length) {\n      const safeFromVoid = candidates.filter(c => !riskyVoidLeads.some(r => sameCard(r, c)));\n      if(safeFromVoid.length) {\n        candidates = safeFromVoid;\n      } else if(protectedSpadeFallback.length) {\n        return finish(protectedSpadeFallback, 'void_risk_lead');\n      } else {\n        candidates = leastBadVoidRiskLeadCandidates(candidates, gs, player);\n      }\n    }\n\n    // H_NEGHIST: From trick 2 onward, avoid non-heart suits that have already`,
  `    // H_V1: Known-void suits are only dangerous when the card is likely to win.\n    const riskyVoidLeads = candidates.filter(c => voidRiskyWinningLead(c, gs, player));\n    if(riskyVoidLeads.length) {\n      const safeFromVoid = candidates.filter(c => !riskyVoidLeads.some(r => sameCard(r, c)));\n      if(safeFromVoid.length) {\n        candidates = safeFromVoid;\n      } else if(protectedSpadeFallback.length) {\n        return finish(protectedSpadeFallback, 'void_risk_lead');\n      } else {\n        candidates = leastBadVoidRiskLeadCandidates(candidates, gs, player);\n      }\n    }\n\n    // H_TVOID: Score-aware void politics.  If a target is known void in a\n    // candidate suit, do not give them a safe dump when a sensible alternative\n    // exists; prefer surviving ♠/♥ pressure directly.\n    const targetVoidDecision = targetAwareVoidLeadDecision(candidates, gs, player);\n    if(targetVoidDecision.pressure.length) {\n      return finish(targetVoidDecision.pressure, 'target_void_pressure_lead');\n    }\n    candidates = targetVoidDecision.cards;\n\n    // H_NEGHIST: From trick 2 onward, avoid non-heart suits that have already`,
  'add target-aware void politics into lead ranking'
);

write('shared/game/heuristicBot.js', bot);

// ── shared/game/engine.js ───────────────────────────────────────────────────
let engine = read('shared/game/engine.js');
engine = replaceOnce(
  engine,
  `export const autoApplyAllQuetsch = (gs, pick = heuristicQuetschPick) => {\n  const selections = gs.hands.map(hand => pick(hand));\n  return applyQuetschSelections(gs, selections);\n};`,
  `export const autoApplyAllQuetsch = (gs, pick = heuristicQuetschPick) => {\n  const selections = gs.hands.map((hand, player) => pick(hand, gs, player));\n  return applyQuetschSelections(gs, selections);\n};`,
  'engine autoApplyAllQuetsch passes gs/player to pick'
);
write('shared/game/engine.js', engine);

// ── server/rooms.js ─────────────────────────────────────────────────────────
let rooms = read('server/rooms.js');
rooms = replaceOnce(
  rooms,
  `      game.quetschSelections[seat] = heuristicQuetschPick(game.gs.hands[seat]);`,
  `      game.quetschSelections[seat] = heuristicQuetschPick(game.gs.hands[seat], botDecisionGameState(room), seat);`,
  'server bot quetsch passes decision state/player'
);
rooms = replaceOnce(
  rooms,
  `    const rec = recommendHeuristicQuetschCards(hand);`,
  `    const rec = recommendHeuristicQuetschCards(hand, botDecisionGameState(room), seatIndex);`,
  'server easy-mode quetsch recommendation passes decision state/player'
);
write('server/rooms.js', rooms);

// ── src/App.jsx legacy/local bot quetsch helpers ─────────────────────────────
let app = read('src/App.jsx');
app = replaceOnce(
  app,
  `    const sels = g.hands.map(h => botQuetschPick(h));`,
  `    const sels = g.hands.map((h, i) => botQuetschPick(h, g, i));`,
  'local autoApplyAllQuetsch passes gs/player'
);
app = app.replace(/botQuetschPick\(gs\.hands\[i\]\)/g, 'botQuetschPick(gs.hands[i], gs, i)');
write('src/App.jsx', app);

console.log('✅ Political spade/heart bot patch applied.');
console.log('Updated files:');
for(const rel of touched) console.log(' - ' + rel);
