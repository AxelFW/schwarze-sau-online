#!/usr/bin/env node
/*
  Patch: richer strategic Quetsch policy for Wuzz / Schwarze Sau bots.

  Run from repo root:
    node patch-quetsch-policy-v1.cjs
    npm run build

  This replaces shared/game/heuristicBot.js::heuristicQuetschPick with a
  bucketed policy:
    - explicit ♠Q + ♠A/♠K emergency cluster
    - conditional high-heart passing
    - preservation of ♥2-♥5 and usually ♥6-♥7
    - side-suit A/K preservation with support-card passing
    - C/D medium-card filler with danger-biased short-suit preference
    - stable pseudo-random tie-breaking inside comparable buckets
*/

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = process.cwd();
const botPath = path.join(repoRoot, 'shared/game/heuristicBot.js');

function fail(message) {
  console.error('❌ ' + message);
  process.exit(1);
}

function ok(message) {
  console.log('✅ ' + message);
}

if (!fs.existsSync(botPath)) {
  fail('Could not find shared/game/heuristicBot.js. Run this patch from the repo root.');
}

const original = fs.readFileSync(botPath, 'utf8');
const startMarker = 'export const heuristicQuetschPick = hand =>';
const endMarker = 'export const botQuetschPick';
const start = original.indexOf(startMarker);
if (start < 0) fail('Could not find heuristicQuetschPick export.');
const end = original.indexOf(endMarker, start);
if (end < 0) fail('Could not find botQuetschPick marker after heuristicQuetschPick.');

const replacement = String.raw`export const heuristicQuetschPick = hand => {
  const selected = [];
  const has = c => hand.some(x => sameCard(x, c));
  const selectedHas = c => selected.some(x => sameCard(x, c));
  const cardsOfSuitLocal = s => [...hand].filter(c => c.s === s).sort((a,b) => a.v - b.v);
  const handSignature = [...hand].map(cardKey).sort().join('|');

  // Stable pseudo-randomness: unclear equal-priority choices vary across hands,
  // but Easy-Mode quetsch suggestions do not flicker while the same hand is shown.
  const tieNoise = (card, salt = '') => {
    const str = handSignature + '|' + salt + '|' + cardKey(card);
    let h = 2166136261;
    for(let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  };

  const add = c => {
    if(selected.length >= 3 || !c || !has(c) || selectedHas(c)) return false;
    selected.push(c);
    return true;
  };
  const remainingCandidates = cards => (cards || [])
    .filter(c => c && has(c) && !selectedHas(c));
  const addRanked = (cards, salt, scoreFn = c => c.v, limit = 3) => {
    const ranked = remainingCandidates(cards)
      .map(card => ({card, score: scoreFn(card), noise: tieNoise(card, salt)}))
      .sort((a,b) => b.score - a.score || a.noise - b.noise);
    for(const x of ranked) {
      if(selected.length >= Math.min(3, limit)) break;
      add(x.card);
    }
  };
  const addUntilFull = (cards, salt, scoreFn = c => c.v) => {
    const ranked = remainingCandidates(cards)
      .map(card => ({card, score: scoreFn(card), noise: tieNoise(card, salt)}))
      .sort((a,b) => b.score - a.score || a.noise - b.noise);
    for(const x of ranked) {
      if(selected.length >= 3) break;
      add(x.card);
    }
  };

  const spades = cardsOfSuitLocal('S');
  const hearts = cardsOfSuitLocal('H');
  const hasQSpades = has(QUEEN_SPADES);
  const highSpades = spades.filter(c => c.v === 13 || c.v === 14).sort((a,b) => b.v - a.v);
  const lowSpadesBelowQueen = spades.filter(c => c.v < 12);
  const otherSpades = spades.filter(c => !sameCard(c, QUEEN_SPADES));

  const lowHearts = hearts.filter(c => c.v >= 2 && c.v <= 5);
  const softLowHearts = hearts.filter(c => c.v >= 6 && c.v <= 7);
  const mediumHearts = hearts.filter(c => c.v >= 8 && c.v <= 10);
  const highHearts = hearts.filter(c => c.v >= 11).sort((a,b) => b.v - a.v);
  const heartLowMediumCover = lowHearts.length + softLowHearts.length + mediumHearts.length;
  const heartEarlyCover = lowHearts.length + softLowHearts.length;

  const minorCards = ['C','D'].flatMap(s => cardsOfSuitLocal(s));
  const minorSuitCount = s => cardsOfSuitLocal(s).length;
  const minorSmallCount = s => cardsOfSuitLocal(s).filter(c => c.v <= 6).length;
  const minorHasAce = s => cardsOfSuitLocal(s).some(c => c.v === 14);
  const minorHasKing = s => cardsOfSuitLocal(s).some(c => c.v === 13);
  const lowestSmallMinor = s => cardsOfSuitLocal(s).filter(c => c.v <= 6).sort((a,b) => a.v - b.v)[0] ?? null;

  // A usable exit is approximated as an already blank suit or a short C/D suit
  // that can plausibly be blanked without giving away an ace.  This is only a
  // threshold signal for ♠Q handling, not a command to force a void.
  const hasExit = ['C','D','H'].some(s => cardsOfSuitLocal(s).length === 0) ||
    ['C','D'].some(s => {
      const suitCards = cardsOfSuitLocal(s);
      return suitCards.length > 0 && suitCards.length <= 3 && !suitCards.some(c => c.v === 14);
    });

  const toxicWuzzHighSpadeCluster =
    hasQSpades && highSpades.length > 0 && spades.length < 4;
  const weakQSpades =
    hasQSpades && !toxicWuzzHighSpadeCluster && otherSpades.length < (hasExit ? 2 : 3);
  const noWuzzHighSpadeTrap =
    !hasQSpades && highSpades.length > 0 && lowSpadesBelowQueen.length < 2;
  const unprotectedHighHearts =
    highHearts.length > 0 && (heartEarlyCover === 0 || (highHearts.length >= 2 && heartLowMediumCover <= 1));
  const lightProtectedHighHearts =
    highHearts.length > 0 && !unprotectedHighHearts && heartLowMediumCover <= 2;

  const seriousDanger = toxicWuzzHighSpadeCluster || weakQSpades || noWuzzHighSpadeTrap || unprotectedHighHearts;

  // 1. Emergency bucket.
  // ♠Q with ♠A/♠K and fewer than four total spades is especially toxic: pass
  // ♠Q and every held ♠A/♠K before considering normal shape rules.
  if(toxicWuzzHighSpadeCluster) {
    add(QUEEN_SPADES);
    addRanked(highSpades, 'toxic-wuzz-high-spades', c => c.v);
  } else if(weakQSpades) {
    add(QUEEN_SPADES);
  }

  // No ♠Q: with fewer than two low spades below the queen, ♠A/♠K are trap
  // cards and should be passed with high emergency priority.
  if(noWuzzHighSpadeTrap) {
    addRanked(highSpades, 'no-wuzz-high-spade-trap', c => c.v);
  }

  // High hearts are emergency only when unprotected.  With enough lower hearts,
  // they are not automatically junk.
  if(unprotectedHighHearts) {
    addRanked(highHearts, 'unprotected-high-hearts', c => c.v);
  }

  if(selected.length >= 3) return selected.slice(0,3);

  // 2. Good Quetsch bucket: conditional high hearts, surplus high spade, and
  // C/D structure cards.  C/D suit choice is danger-aware: under real danger,
  // prefer cards from the shorter minor suit as a path toward future dumps.
  const good = [];

  // If the hand has two small spades and both ♠K/♠A without ♠Q, pass ♠A as a
  // controlled de-risking move while keeping the rest of the spade structure.
  if(!hasQSpades && lowSpadesBelowQueen.length >= 2 &&
     highSpades.some(c => c.v === 14) && highSpades.some(c => c.v === 13) &&
     spades.length === 4) {
    good.push({card: highSpades.find(c => c.v === 14), base: 95, salt: 'two-low-two-high-spades'});
  }

  if(lightProtectedHighHearts) {
    for(const c of highHearts) good.push({card: c, base: 78 + c.v / 10, salt: 'light-protected-high-hearts'});
  }

  const minorStructuralScore = card => {
    if(card.s !== 'C' && card.s !== 'D') return -999;
    const s = card.s;
    const suitCards = cardsOfSuitLocal(s);
    const count = suitCards.length;
    const smallCount = minorSmallCount(s);
    const hasA = minorHasAce(s);
    const hasK = minorHasKing(s);
    const supportSmall = lowestSmallMinor(s);

    // A♣/A♦ are preserved unless we are forced very late by fallback.
    if(card.v === 14) return -500;

    // K♣/K♦ are usually control cards.  When we have the king without the ace,
    // prefer passing surplus smaller/middle cards while keeping K + one small.
    if(card.v === 13 && hasK && !hasA) return supportSmall ? -220 : -80;

    let score = 0;
    if(card.v >= 7 && card.v <= 12) score += 64;
    else if(card.v >= 5 && card.v <= 6) score += 28;
    else score += 8;

    // With A♣/A♦, pass support cards rather than the ace where possible.
    if(hasA) score += 26;

    // With K♣/K♦ and no ace, keep the king and one small support card if
    // possible; pass the surplus cards.  This gives at least one such card a
    // real chance to enter the good bucket.
    if(hasK && !hasA) {
      if(supportSmall && sameCard(card, supportSmall)) score -= 45;
      else score += 30;
    }

    // Medium chains like 6-9: when passing from the chain, prefer the higher
    // end and preserve lower exits.
    const hasLowerNeighbor = suitCards.some(c => c.v === card.v - 1);
    const hasHigherNeighbor = suitCards.some(c => c.v === card.v + 1);
    if(hasLowerNeighbor || hasHigherNeighbor) score += Math.max(0, card.v - 5) * 1.5;

    // Prefer suits with fewer low cards; they have weaker safety structure.
    score += Math.max(0, 3 - smallCount) * 5;

    // Under danger, use C/D candidate choice as a void/exit decider.
    if(seriousDanger) score += Math.max(0, 5 - count) * 9;

    // Mild high-card pressure inside the same bucket.
    score += card.v / 10;
    return score;
  };

  for(const c of minorCards) {
    const score = minorStructuralScore(c);
    if(score >= 58) good.push({card: c, base: score, salt: 'minor-good-structure'});
  }

  addUntilFull(good.map(x => x.card), 'good-quetsch-bucket', c => {
    const entry = good.find(x => sameCard(x.card, c));
    return entry ? entry.base : 0;
  });

  if(selected.length >= 3) return selected.slice(0,3);

  // 3. Filler bucket.  Medium C/D are normal filler; ♥8-♥10 are okay only
  // when no ♥2-♥5 are present; ♥6-♥7 are last-resort filler, not priority.
  const filler = [];
  for(const c of minorCards) {
    const score = minorStructuralScore(c);
    if(score > -100) filler.push({card: c, base: score, salt: 'minor-filler'});
  }

  if(lowHearts.length === 0) {
    for(const c of mediumHearts) filler.push({card: c, base: 42 + c.v / 10, salt: 'medium-hearts-no-low-hearts'});
  }
  for(const c of softLowHearts) filler.push({card: c, base: 12 + c.v / 10, salt: 'soft-low-heart-last-resort'});

  // Well-protected high hearts are not preferred, but they can fill if the
  // alternatives are worse than touching low hearts or C/D aces/kings.
  if(!unprotectedHighHearts && !lightProtectedHighHearts) {
    for(const c of highHearts) filler.push({card: c, base: 18 + c.v / 10, salt: 'well-protected-high-heart-filler'});
  }

  addUntilFull(filler.map(x => x.card), 'filler-quetsch-bucket', c => {
    const entry = filler.find(x => sameCard(x.card, c));
    return entry ? entry.base : 0;
  });

  if(selected.length >= 3) return selected.slice(0,3);

  // 4. Forced fallback / avoid bucket.  This is only reached for awkward hands.
  // It still tries to avoid ♥2-♥5, C/D aces, protected C/D kings, and needed
  // spade guards as long as anything more disposable exists.
  const fallbackScore = c => {
    if(selectedHas(c)) return -9999;
    if(sameCard(c, QUEEN_SPADES)) return 900;
    if(c.s === 'S' && (c.v === 14 || c.v === 13)) return 650 + c.v;
    if(c.s === 'S' && hasQSpades && c.v < 12) return -120 + c.v;
    if(c.s === 'H' && c.v >= 11) return 360 + c.v;
    if(c.s === 'H' && c.v >= 8 && c.v <= 10) return lowHearts.length === 0 ? 210 + c.v : 70 + c.v;
    if(c.s === 'H' && c.v >= 6 && c.v <= 7) return 20 + c.v;
    if(c.s === 'H' && c.v <= 5) return -260 + c.v;
    if((c.s === 'C' || c.s === 'D') && c.v === 14) return seriousDanger ? -40 : -420;
    if((c.s === 'C' || c.s === 'D') && c.v === 13 && minorHasKing(c.s) && !minorHasAce(c.s) && lowestSmallMinor(c.s)) return -180;
    if(c.s === 'C' || c.s === 'D') return minorStructuralScore(c);
    return c.v;
  };

  addUntilFull([...hand], 'forced-avoid-fallback', fallbackScore);
  return selected.slice(0,3);
};`;

const updated = original.slice(0, start) + replacement + '\n\n' + original.slice(end);

if (updated === original) fail('Patch produced no changes.');

const backupDir = path.join(repoRoot, '.patch-backups', 'quetsch-policy-v1-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backupDir, { recursive: true });
fs.writeFileSync(path.join(backupDir, 'heuristicBot.js'), original);
fs.writeFileSync(botPath, updated);

const check = spawnSync(process.execPath, ['--check', botPath], { encoding: 'utf8' });
if (check.status !== 0) {
  fs.writeFileSync(botPath, original);
  console.error(check.stdout || '');
  console.error(check.stderr || '');
  fail('Syntax check failed. Restored original heuristicBot.js.');
}

ok('Updated heuristicQuetschPick in shared/game/heuristicBot.js');
ok('Backup written to ' + path.relative(repoRoot, backupDir));
ok('Syntax check passed');
