#!/usr/bin/env node
/* patch-lead-king-heart-risk-v2.cjs
 *
 * Corrects/extends v1 of the lead king + risky-heart patch:
 *   1) K♣/K♦ preservation only applies while the same-suit ace is still unplayed
 *      and not held by the bot. Once the ace has been played, the king may be led.
 *   2) The risky-heart escape handles low-heart exposure cases such as H3 + HA:
 *      if all non-heart alternatives are clearly bad void-dump traps, lead the
 *      preferred heart rather than keeping all bad alternatives in the pool.
 *
 * This script can be run after v1 or directly on the pre-v1 heuristicBot.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = process.cwd();
const heuristicPath = path.join(root, 'shared', 'game', 'heuristicBot.js');

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`Missing file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}

function write(file, text) {
  fs.writeFileSync(file, text, 'utf8');
}

function backup(file, backupRoot) {
  const rel = path.relative(root, file);
  const out = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(file, out);
}

function replaceOnce(text, search, replacement, label) {
  const idx = text.indexOf(search);
  if (idx < 0) return null;
  if (text.indexOf(search, idx + search.length) >= 0) fail(`Block is not unique: ${label}`);
  return text.slice(0, idx) + replacement + text.slice(idx + search.length);
}

function insertBeforeOnce(text, anchor, insertion, label) {
  const idx = text.indexOf(anchor);
  if (idx < 0) fail(`Could not find insertion anchor: ${label}`);
  if (text.indexOf(anchor, idx + anchor.length) >= 0) fail(`Insertion anchor is not unique: ${label}`);
  return text.slice(0, idx) + insertion + text.slice(idx);
}

let heuristic = read(heuristicPath);

if (heuristic.includes('aceAlreadyPlayedInSuit') && heuristic.includes('Alternativen wären klare Abwurf-Fallen')) {
  console.log('ℹ️ Lead king/heart-risk v2 patch already appears to be applied.');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(root, '.patch-backups', `lead-king-heart-risk-v2-${stamp}`);
backup(heuristicPath, backupRoot);

const correctedHelpers = `const allOpponentsKnownVoidInSuit = (gs, player, suit) =>
  [1, 2, 3].every(off => knownVoidInSuit(gs, (player + off) % 4, suit));

const aceAlreadyPlayedInSuit = (gs, suit) =>
  [...completedCards(gs), ...trickCards(gs)].some(c => c?.s === suit && c?.v === 14);

const clearlyBadLeadAlternative = (card, gs, player) => {
  if(!card || lowNegativePressureMode(gs) || harvestModeActive(gs, player)) return false;

  // Strongest case: everyone else is known void in this suit, so our lead is
  // effectively certain to keep the trick while opponents can dump remaining
  // penalty cards.  In that case, avoiding heart exposure at all costs can be
  // worse than leading a low heart that exposes a high heart still on hand.
  if(allOpponentsKnownVoidInSuit(gs, player, card.s) && projectedLeadNetFloor(card, gs, player) <= 0) {
    return true;
  }

  // General known-void / quetsch-suspicion risk: only classify it as clearly
  // bad when the pessimistic projected net is non-positive.
  return voidRiskyWinningLead(card, gs, player) && projectedLeadNetFloor(card, gs, player) <= 0;
};

const shouldKeepRiskyHeartsWhenAlternativesAreWorse = (riskyHearts, alternatives, gs, player) => {
  if(!riskyHearts?.length) return false;
  if(!alternatives?.length) return false;
  return alternatives.every(c => c.s !== 'H' && clearlyBadLeadAlternative(c, gs, player));
};

const protectMinorKingLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return cards;
  const hand = gs.hands[player] || [];
  const shouldProtectKing = card => {
    if(!(card.s === 'C' || card.s === 'D') || card.v !== 13) return false;
    const sameSuitHand = hand.filter(c => c.s === card.s);

    // The rule only applies while the ace is still live outside.  If we hold
    // the ace ourselves, or if it has already been played, the king is no
    // longer protected by avoiding the lead.
    if(sameSuitHand.some(c => c.v === 14)) return false;
    if(aceAlreadyPlayedInSuit(gs, card.s)) return false;

    return cards.some(c => c.s === card.s && c.v < 13);
  };
  const filtered = cards.filter(c => !shouldProtectKing(c));
  return filtered.length ? filtered : cards;
};

`;

const oldV1Helpers = `const allOpponentsKnownVoidInSuit = (gs, player, suit) =>
  [1, 2, 3].every(off => knownVoidInSuit(gs, (player + off) % 4, suit));

const clearlyBadLeadAlternative = (card, gs, player) => {
  if(!card || lowNegativePressureMode(gs) || harvestModeActive(gs, player)) return false;

  // Strongest case: everyone else is known void in this suit, so our lead is
  // effectively certain to keep the trick while opponents can dump remaining
  // penalty cards.  In that case, avoiding a high heart at all costs can be
  // worse than exposing the heart.
  if(allOpponentsKnownVoidInSuit(gs, player, card.s) && projectedLeadNetFloor(card, gs, player) <= 0) {
    return true;
  }

  // General known-void / quetsch-suspicion risk: only classify it as clearly
  // bad when the pessimistic projected net is non-positive.
  return voidRiskyWinningLead(card, gs, player) && projectedLeadNetFloor(card, gs, player) <= 0;
};

const shouldKeepRiskyHeartsWhenAlternativesAreWorse = (riskyHearts, alternatives, gs, player) => {
  if(!riskyHearts?.some(c => c.s === 'H' && c.v >= 8)) return false;
  if(!alternatives?.length) return false;
  return alternatives.every(c => c.s !== 'H' && clearlyBadLeadAlternative(c, gs, player));
};

const protectMinorKingLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return cards;
  const hand = gs.hands[player] || [];
  const shouldProtectKing = card => {
    if(!(card.s === 'C' || card.s === 'D') || card.v !== 13) return false;
    const sameSuitHand = hand.filter(c => c.s === card.s);
    if(sameSuitHand.some(c => c.v === 14)) return false;
    return cards.some(c => c.s === card.s && c.v < 13);
  };
  const filtered = cards.filter(c => !shouldProtectKing(c));
  return filtered.length ? filtered : cards;
};

`;

let replacedHelpers = replaceOnce(heuristic, oldV1Helpers, correctedHelpers, 'v1 lead helper block');
if (replacedHelpers !== null) {
  heuristic = replacedHelpers;
} else if (!heuristic.includes('protectMinorKingLeadCandidates')) {
  const helperAnchor = `const leastBadVoidRiskLeadCandidates = (cards, gs, player) => {\n`;
  heuristic = insertBeforeOnce(heuristic, helperAnchor, correctedHelpers, 'leastBadVoidRiskLeadCandidates helper anchor');
}

const v1HeartBlock = `      if(riskyHearts.length) {
        const filtered = candidates.filter(c => !riskyHearts.some(r => sameCard(r, c)));
        const keepRiskyHearts = shouldKeepRiskyHeartsWhenAlternativesAreWorse(riskyHearts, filtered, gs, player);
        if(filtered.length && !keepRiskyHearts) {
          candidates = filtered;
        } else if(!filtered.length && protectedSpadeFallback.length) {
          return finish(protectedSpadeFallback, 'risky_heart_lead');
        } else if(!filtered.length) {
          return finish(heartLeadPreferenceCandidates(hearts, gs, player), 'risky_heart_lead');
        }
      } else if(candidates.every(c => c.s === 'H')) {
`;

const originalHeartBlock = `      if(riskyHearts.length) {
        const filtered = candidates.filter(c => !riskyHearts.some(r => sameCard(r, c)));
        if(filtered.length) {
          candidates = filtered;
        } else if(protectedSpadeFallback.length) {
          return finish(protectedSpadeFallback, 'risky_heart_lead');
        } else {
          return finish(heartLeadPreferenceCandidates(hearts, gs, player), 'risky_heart_lead');
        }
      } else if(candidates.every(c => c.s === 'H')) {
`;

const correctedHeartBlock = `      if(riskyHearts.length) {
        const filtered = candidates.filter(c => !riskyHearts.some(r => sameCard(r, c)));
        const keepRiskyHearts = shouldKeepRiskyHeartsWhenAlternativesAreWorse(riskyHearts, filtered, gs, player);
        if(filtered.length && keepRiskyHearts) {
          return finish(
            heartLeadPreferenceCandidates(hearts, gs, player),
            'risky_heart_lead',
            '(Alternativen wären klare Abwurf-Fallen.)'
          );
        } else if(filtered.length) {
          candidates = filtered;
        } else if(protectedSpadeFallback.length) {
          return finish(protectedSpadeFallback, 'risky_heart_lead');
        } else {
          return finish(heartLeadPreferenceCandidates(hearts, gs, player), 'risky_heart_lead');
        }
      } else if(candidates.every(c => c.s === 'H')) {
`;

let replacedHeart = replaceOnce(heuristic, v1HeartBlock, correctedHeartBlock, 'v1 risky heart block');
if (replacedHeart !== null) {
  heuristic = replacedHeart;
} else {
  replacedHeart = replaceOnce(heuristic, originalHeartBlock, correctedHeartBlock, 'original risky heart block');
  if (replacedHeart === null && !heuristic.includes('Alternativen wären klare Abwurf-Fallen')) {
    fail('Could not find risky heart lead block to replace.');
  }
  if (replacedHeart !== null) heuristic = replacedHeart;
}

if (!heuristic.includes('candidates = protectMinorKingLeadCandidates(candidates, gs, player);')) {
  const kingAnchor = `    // H7: Prefer safe ♣A / ♦A openers after risk filters.  The serious-danger\n`;
  const kingInsertion = `    // H_K1: If we hold K♣/K♦ without the same-suit ace and also have a
    // smaller card of that suit, do not lead the king while the ace is still
    // live outside and a lower same-suit card can preserve it as a future
    // positive-trick winner.
    candidates = protectMinorKingLeadCandidates(candidates, gs, player);

`;
  heuristic = insertBeforeOnce(heuristic, kingAnchor, kingInsertion, 'H7 safe ace lead anchor');
}

write(heuristicPath, heuristic);

try {
  execFileSync(process.execPath, ['--check', heuristicPath], { stdio: 'pipe' });
} catch (err) {
  console.error(err.stdout?.toString() || '');
  console.error(err.stderr?.toString() || '');
  fail('node --check failed for shared/game/heuristicBot.js. Restore from backup: ' + path.relative(root, backupRoot));
}

console.log('✅ Applied lead king/heart-risk v2 patch.');
console.log('Backup written to ' + path.relative(root, backupRoot));
