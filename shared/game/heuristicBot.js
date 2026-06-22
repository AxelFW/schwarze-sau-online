import {
  VALS, QUEEN_SPADES, sameCard, cardKey, cardPts, getValidIdxs, suitIdx, sortHand,
} from './cards.js';

// Auto-quetsch for non-human seats. This mirrors the training-side heuristic:
// avoid isolated ♠Q danger, dangerous high hearts, keep low safety cards,
// prepare suits with A, and create cheap C/D voids when possible.
export const heuristicQuetschPick = (hand, gs = null, player = null) => {
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

  // Offensive/political ♠Q trap: when ♠Q is well protected by at least three
  // smaller spades and no ♠K/♠A are held, the bot may pass ♠Q left even though
  // it is not an emergency.  This is strongest when the left player is a
  // current target/leader, because the later H_Q1 pressure can attack them.
  const leftPlayerForQuetsch = Number.isInteger(player) ? (player + 1) % 4 : null;
  const leftRelationForQuetsch = gs && leftPlayerForQuetsch !== null
    ? playerRankRelation(gs, player, leftPlayerForQuetsch)
    : 'unknown';
  const politicalQueenTrap =
    hasQSpades &&
    highSpades.length === 0 &&
    lowSpadesBelowQueen.length >= 3;
  const politicalQueenTrapBase =
    leftRelationForQuetsch === 'target' ? 96 :
    leftRelationForQuetsch === 'nontarget' ? 62 :
    74;

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

  if(politicalQueenTrap && selected.length === 0) {
    good.push({
      card: QUEEN_SPADES,
      base: politicalQueenTrapBase,
      salt: 'political-long-spade-queen-trap',
    });
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
};

export const botQuetschPick = heuristicQuetschPick;
export const recommendHeuristicQuetschCards = (hand, gs = null, player = null) => {
  const cards = heuristicQuetschPick(hand, gs, player);
  const reason = cards.some(c => sameCard(c, QUEEN_SPADES))
    ? 'Easy Mode: Der Bot würde diese drei Karten quetschen. Er priorisiert gefährliche Strafkarten; mit langer Pik-Struktur kann ♠Q auch politisch nach links gegeben und später unter Druck gesetzt werden.'
    : 'Easy Mode: Der Bot würde diese drei Karten quetschen. Er priorisiert gefährliche Strafkarten, behält niedrige Schutzkarten und wirft ♣/♦-Asse nicht nur für einen Void weg.';
  return {
    cards,
    rule: 'quetsch_suggestion',
    reason,
    reasonByCard: Object.fromEntries(cards.map(c => [cardKey(c), reason])),
  };
};


// Local heuristic play agent.
// Ported from the updated Python `HeuristicOpponent` used in training. It keeps
// the same priority structure: void-dump, protected-♠Q high-heart dumping,
// heart/spade safety, dangerous-trick avoidance, late-game harvest, safe ace
// leads, quetsch/void awareness, and midgame small-card play.
const HIGH_WIN_LOWER_SHARE = 0.75;

// Late-game harvest mode: when remaining outside penalties are weak, prefer
// winning positive tricks instead of over-avoiding void-dump risk.
const HARVEST_MAX_SINGLE_OUTSIDE_PENALTY = 8;
const HARVEST_MAX_TOTAL_OUTSIDE_PENALTY_RATIO = 0.65;
const HARVEST_MIN_PROJECTED_NET = 1;

const randomFrom = cards => cards[Math.floor(Math.random() * cards.length)];
const smallestCards = cards => {
  const min = Math.min(...cards.map(c => c.v));
  return cards.filter(c => c.v === min);
};
const largestCards = cards => {
  const max = Math.max(...cards.map(c => c.v));
  return cards.filter(c => c.v === max);
};

const cardsOfSuit = s => VALS.map(v => ({s, v}));
const cardIn = (cards, target) => cards.some(c => sameCard(c, target));
const trickCards = gs => gs.trick.map(x => x.card);
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
  const seen = new Set(knownCardsFor(gs, player).map(cardKey));
  return cardsOfSuit(suit).filter(c => !seen.has(cardKey(c)));
};

const withInferredExhaustedSuitVoids = (gs, player) => {
  if(!gs?.hands?.[player]) return gs;

  const inferredVoids = Array.from({length: 4}, (_, i) => [
    ...(gs.knownVoids?.[i] ?? [false, false, false, false]),
  ]);
  let changed = false;

  for(const suit of ['C', 'D', 'H', 'S']) {
    if(unseenCardsOfSuit(gs, player, suit).length !== 0) continue;

    const si = suitIdx(suit);
    for(let off = 1; off <= 3; off++) {
      const p = (player + off) % 4;
      if(inferredVoids[p][si]) continue;
      inferredVoids[p][si] = true;
      changed = true;
    }
  }

  return changed ? {...gs, knownVoids: inferredVoids} : gs;
};

const currentWinningRank = gs => {
  if(!gs.leadSuit || !gs.trick.length) return null;
  const ranks = gs.trick.filter(x => x.card.s === gs.leadSuit).map(x => x.card.v);
  return ranks.length ? Math.max(...ranks) : null;
};

const trickNetValue = gs => 10 + gs.trick.reduce((sum, x) => sum + cardPts(x.card), 0);
const trickIsNetNegative = gs => trickNetValue(gs) < 0;
const beatsCurrentTrick = (card, gs) => {
  if(!gs.leadSuit || !gs.trick.length) return false;
  const rank = currentWinningRank(gs);
  return card.s === gs.leadSuit && rank !== null && card.v > rank;
};

const sortByNegativityDesc = cards => {
  const penalties = cards.filter(c => cardPts(c) < 0).sort((a,b) => cardPts(a) - cardPts(b));
  const neutral = cards.filter(c => cardPts(c) === 0);
  for(let i=neutral.length-1; i>0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [neutral[i], neutral[j]] = [neutral[j], neutral[i]];
  }
  return [...penalties, ...neutral];
};
const isHighNegativeForDump = c => sameCard(c, QUEEN_SPADES) || (c.s === 'H' && c.v >= 6);
const spadesLowerThanQueenInHand = (gs, player) =>
  gs.hands[player].filter(c => c.s === 'S' && c.v < 12).length;
const queenSpadesStillOutNotInHand = (gs, player) =>
  !cardIn(completedCards(gs), QUEEN_SPADES) &&
  !queenSpadesInTrick(gs) &&
  !queenSpadesInHand(gs, player);
const remainingPublicSuitCount = (gs, player, suit) =>
  unseenCardsOfSuit(gs, player, suit).length;

const numericScoreArray = value =>
  Array.isArray(value) && value.length >= 4 && value.slice(0,4).every(x => Number.isFinite(Number(x)))
    ? value.slice(0,4).map(Number)
    : null;

const scoreVectorFromPlayers = players => {
  if(!Array.isArray(players) || players.length < 4) return null;
  const keys = ['projectedScore', 'score', 'totalScore', 'points', 'total', 'cumScore'];
  for(const key of keys) {
    const scores = players.slice(0,4).map(p => Number(p?.[key]));
    if(scores.every(Number.isFinite)) return scores;
  }
  return null;
};

const publicScoreVector = gs => {
  // Prefer projected totals if the game state provides them. Otherwise use the
  // public total scoreboard and, if present, add the current round component.
  const totalKeys = [
    'projectedScores', 'projectedTotals', 'liveScores', 'currentScores',
    'totalScores', 'scores', 'scoreTotals', 'totals', 'scoreboard',
  ];
  let totals = null;
  for(const key of totalKeys) {
    totals = numericScoreArray(gs?.[key]);
    if(totals) break;
  }
  if(!totals) totals = scoreVectorFromPlayers(gs?.players);
  if(!totals) return null;

  const roundKeys = ['roundScores', 'roundScore', 'currentRoundScores', 'roundTotals'];
  let round = null;
  for(const key of roundKeys) {
    round = numericScoreArray(gs?.[key]);
    if(round) break;
  }
  return round ? totals.map((s, i) => s + round[i]) : totals;
};

const scoreHigherIsBetter = gs => gs?.scoreHigherIsBetter ?? gs?.higherScoreIsBetter ?? true;
const effectiveScores = gs => {
  const scores = publicScoreVector(gs);
  if(!scores) return null;
  return scoreHigherIsBetter(gs) ? scores : scores.map(x => -x);
};

const playerRankRelation = (gs, player, recipient) => {
  const scores = effectiveScores(gs);
  if(!scores || !Number.isInteger(recipient) || recipient < 0 || recipient >= scores.length) return 'unknown';

  const own = scores[player];
  const rec = scores[recipient];
  const best = Math.max(...scores);
  const ownIsTop = own === best;

  // Equal scores are treated as equal ranks.  The only exception is a co-leader
  // while we are also first: that player is an immediate title rival.
  if(rec === own) return ownIsTop && recipient !== player ? 'target' : 'peer';

  if(!ownIsTop) return rec > own ? 'target' : 'nontarget';

  // We are currently first.  Target all closest pursuers, including ties among
  // them, and treat lower players as non-targets.
  const below = scores.filter(score => score < own);
  if(!below.length) return 'peer';
  const closestPursuer = Math.max(...below);
  return rec === closestPursuer ? 'target' : 'nontarget';
};

const playersAfterCurrentInTrick = (gs, player) => {
  const remainingAfterBot = Math.max(0, 3 - gs.trick.length);
  return Array.from({length: remainingAfterBot}, (_, i) => (player + i + 1) % 4);
};

const certainTrickRecipient = (gs, player) => {
  if(!gs.leadSuit || !gs.trick.length) return null;

  const leadPlays = gs.trick.filter(x => x.card.s === gs.leadSuit);
  if(!leadPlays.length) return null;
  const winner = leadPlays.reduce((best, x) => x.card.v > best.card.v ? x : best, leadPlays[0]);
  const winningRank = winner.card.v;

  // If the bot is void, its dump cannot win the led suit trick.  The current
  // winner is certain when no future player can still beat the current rank.
  if(gs.trick.length === 3 || winningRank === 14) return winner.player;
  if(!unseenCardsOfSuit(gs, player, gs.leadSuit).some(c => c.v > winningRank)) return winner.player;

  const si = suitIdx(gs.leadSuit);
  const futurePlayers = playersAfterCurrentInTrick(gs, player);
  if(futurePlayers.length && futurePlayers.every(p => gs.knownVoids?.[p]?.[si])) return winner.player;

  return null;
};

const criticalVoidDumpCandidates = (valid, gs, player) => {
  const hand = gs.hands[player];
  const urgent = [];

  // ♠Q is urgent only when it has fewer than two other spade guards.
  const queen = valid.find(c => sameCard(c, QUEEN_SPADES));
  if(queen) {
    const otherSpades = hand.filter(c => c.s === 'S' && !sameCard(c, QUEEN_SPADES));
    if(otherSpades.length < 2) urgent.push(queen);
  }

  // ♥J–♥A are urgent only when the hand lacks two ♥2–♥9 protectors/exits.
  const heartProtection = hand.filter(c => c.s === 'H' && c.v >= 2 && c.v <= 9).length;
  if(heartProtection < 2) {
    urgent.push(...valid.filter(c => c.s === 'H' && c.v >= 11));
  }

  return sortByNegativityDesc(urgent);
};

const handSuitCountAfterDump = (gs, player, card) =>
  gs.hands[player].filter(c => c.s === card.s && !sameCard(c, card)).length;

const createsVoidAfterDump = (gs, player, card) => handSuitCountAfterDump(gs, player, card) === 0;
const shortensSuitValue = (gs, player, card) => {
  const after = handSuitCountAfterDump(gs, player, card);
  return Math.max(0, 4 - after);
};

const spadeExposurePenalty = (card, gs, player, relation) => {
  if(card.s !== 'S') return 0;
  const hand = gs.hands[player];
  const qInHand = queenSpadesInHand(gs, player);
  const target = relation === 'target';

  // Dumping ♠Q into a non-target trick wastes the poison and removes a guarded
  // card that could have hit a direct rival later.
  if(sameCard(card, QUEEN_SPADES)) return target ? 0 : 45;

  // If we hold ♠Q, non-queen spades are guards.  Do not spend them merely for
  // shape against a lower-ranked recipient.
  if(qInHand) {
    const guardsAfter = hand.filter(c => c.s === 'S' && !sameCard(c, QUEEN_SPADES) && !sameCard(c, card)).length;
    if(guardsAfter < 2) return target ? 10 : 45;
    return target ? 0 : 12;
  }

  // If ♠Q is still outside and we hold ♠K/♠A, low spades protect those high
  // spades from being trapped.  Avoid spending the last guards against a lower
  // player.  Dumping ♠K/♠A themselves is allowed as danger relief, but less
  // attractive when the recipient is not a target.
  if(queenSpadesStillOutNotInHand(gs, player)) {
    const highSpadesHeld = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));
    if(card.v < 12 && highSpadesHeld) {
      const lowGuardsAfter = hand.filter(c => c.s === 'S' && c.v < 12 && !sameCard(c, card)).length;
      if(lowGuardsAfter < 2) return target ? 8 : 38;
    }
    if(card.v === 13 || card.v === 14) return target ? 0 : 16;
  }

  return 0;
};

const strategicVoidDump = (valid, gs, player) => {
  const recipient = certainTrickRecipient(gs, player);
  if(recipient === null || recipient === player) return null;

  const relation = playerRankRelation(gs, player, recipient);
  if(relation === 'unknown' || relation === 'peer') return null;

  const keepWinnersMode = lateVoidDumpKeepWinnersMode(gs);
  const targetWeight = relation === 'target' ? 2.05 : 0.25;
  const shapeWeight = keepWinnersMode ? 0 : (relation === 'target' ? 0.20 : 1.65);

  const scored = valid.map(card => {
    const penalty = Math.max(0, -cardPts(card));
    const mediumMinor = (card.s === 'D' || card.s === 'C') && card.v >= 5 && card.v <= 11 ? 1 : 0;
    const voidValue = createsVoidAfterDump(gs, player, card) ? 18 : 0;
    const shortenValue = shortensSuitValue(gs, player, card) * 3;
    const minorShapeValue = mediumMinor ? 10 : 0;
    const exposure = spadeExposurePenalty(card, gs, player, relation);

    let score = 0;
    score += penalty * 10 * targetWeight;
    score += (voidValue + shortenValue + minorShapeValue) * shapeWeight;
    score -= exposure;
    score -= futureWinnerKeepPenalty(card, gs, player);

    // Against non-targets, keep truly poisonous cards for better targets unless
    // they also solve a major hand-shape problem.
    if(relation === 'nontarget' && (sameCard(card, QUEEN_SPADES) || (card.s === 'H' && card.v >= 11))) {
      score -= 22;
    }

    // Stable tie-breaks: prefer larger poison against targets, but safer medium
    // minors / shorter suits against non-targets.
    const tiePenalty = relation === 'target' ? penalty : -penalty;
    const tieRank = relation === 'target' ? card.v : -card.v;
    return {card, score, tiePenalty, tieRank};
  });

  scored.sort((a,b) =>
    b.score - a.score ||
    b.tiePenalty - a.tiePenalty ||
    b.tieRank - a.tieRank
  );
  return scored[0]?.card ?? null;
};

const unshieldedHighSpadeDumpCandidates = (valid, gs, player) => {
  if(!queenSpadesStillOutNotInHand(gs, player)) return [];
  if(spadesLowerThanQueenInHand(gs, player) !== 0) return [];
  return largestCards(valid.filter(c => c.s === 'S' && (c.v === 13 || c.v === 14)));
};

const voidDump = (valid, gs, player) => {
  // 1a. If ♠Q is live outside and ♠K/♠A have no low spade shield, those high
  // spades are immediate trap cards.  Dump them before ordinary heart poison.
  const unshieldedHighSpades = unshieldedHighSpadeDumpCandidates(valid, gs, player);
  if(unshieldedHighSpades.length) return unshieldedHighSpades[0];

  // 1b. True emergency dumps.  These override politics: escape ♠Q when it has
  // fewer than two spade guards, and escape ♥J–♥A when there are fewer than two
  // ♥2–♥9 protectors.
  const emergencyDumps = criticalVoidDumpCandidates(valid, gs, player);
  if(emergencyDumps.length) return emergencyDumps[0];

  // 1c. Strategic recipient-aware dumping.  Only active when the current trick
  // recipient is certain and public scores are available in gs.
  const strategicDump = strategicVoidDump(valid, gs, player);
  if(strategicDump) return strategicDump;

  // 1d. Ordinary high-negative fallback for uncertain recipients / missing
  // scores: use the previous safety-first dump order.
  const highNegatives = valid.filter(isHighNegativeForDump);
  if(highNegatives.length) return sortByNegativityDesc(highNegatives)[0];

  // 1e. Once the important penalty danger is gone, stop chasing void shape and
  // keep future winners in hand when a weaker dump is available.
  if(lateVoidDumpKeepWinnersMode(gs)) {
    const smallHearts = valid.filter(c => c.s === 'H' && c.v <= 5);
    if(smallHearts.length) return largestCards(smallHearts)[0];

    const nonPenalty = valid.filter(c => cardPts(c) === 0);
    if(nonPenalty.length) return leastFutureWinnerValueCards(nonPenalty, gs, player)[0];
  }

  // 2. If ♠Q is still out and we are poorly protected in spades, shed ♠A/♠K.
  if(queenSpadesStillOutNotInHand(gs, player) && spadesLowerThanQueenInHand(gs, player) < 2) {
    const highSpades = valid.filter(c => c.s === 'S' && (c.v === 13 || c.v === 14));
    if(highSpades.length) return largestCards(highSpades)[0];
  }

  // 3. Shed mid-level ♦/♣ cards, preferring the shorter remaining suit.
  const midMinor = valid.filter(c => (c.s === 'D' || c.s === 'C') && c.v >= 5 && c.v <= 11);
  if(midMinor.length) {
    const minRemaining = Math.min(...midMinor.map(c => remainingPublicSuitCount(gs, player, c.s)));
    const shortestSuitCards = midMinor.filter(c => remainingPublicSuitCount(gs, player, c.s) === minRemaining);
    return largestCards(shortestSuitCards)[0];
  }

  // 4. Only then dump small hearts.
  const smallHearts = valid.filter(c => c.s === 'H' && c.v <= 5);
  if(smallHearts.length) return largestCards(smallHearts)[0];

  // 5. Thereafter dump spades below ♠Q.
  const lowSpades = valid.filter(c => c.s === 'S' && c.v < 12);
  if(lowSpades.length) return largestCards(lowSpades)[0];

  // 6. Final fallback: old negativity order / shuffled neutral tie-breaks.
  return sortByNegativityDesc(valid)[0];
};

const queenSpadesPlayed = gs => cardIn(completedCards(gs), QUEEN_SPADES);
const queenSpadesInHand = (gs, player) => cardIn(gs.hands[player], QUEEN_SPADES);
const queenSpadesInTrick = gs => gs.trick.some(x => sameCard(x.card, QUEEN_SPADES));
const queenSpadesPassedLeft = (gs, player) => {
  const passed = gs.quetschPassedLeft?.[player] ?? [];
  const inPlay = new Set([...completedCards(gs), ...trickCards(gs)].map(cardKey));
  return passed.some(c => sameCard(c, QUEEN_SPADES) && !inPlay.has(cardKey(c)));
};
const handSuitCount = (gs, player, suit) => gs.hands[player].filter(c => c.s === suit).length;

const heartDangerOnHand = (gs, player) => {
  const hearts = gs.hands[player].filter(c => c.s === 'H');
  const highHearts = hearts.filter(c => c.v >= 11);
  const mediumHearts = hearts.filter(c => c.v >= 6 && c.v <= 10);
  const smallHearts = hearts.filter(c => c.v < 6);
  return highHearts.length > 0 || (mediumHearts.length >= 2 && smallHearts.length === 0);
};

const seriousDangerOnHand = (gs, player) =>
  queenSpadesInHand(gs, player) || heartDangerOnHand(gs, player);

const voidCreationLeadCandidates = (cards, gs, player) => {
  // Low-priority leading preference under serious danger.  It only sees cards
  // that survived the earlier safety filters, then tries to create a short-suit
  // void for future dumps.  It is a preference, not a hard filter: callers only
  // apply it when this function returns a non-empty option set.
  if(!cards.length || !seriousDangerOnHand(gs, player)) return [];

  let eligible = cards;
  if(heartDangerOnHand(gs, player)) {
    const nonHearts = eligible.filter(c => c.s !== 'H');
    if(nonHearts.length) eligible = nonHearts;
  }

  if(!eligible.length) return [];

  const minCount = Math.min(...eligible.map(c => handSuitCount(gs, player, c.s)));
  const shortestSuitCards = eligible.filter(c => handSuitCount(gs, player, c.s) === minCount);
  return smallestCards(shortestSuitCards);
};

const queenSpadesLiveOutside = (gs, player) =>
  !queenSpadesInHand(gs, player) && !queenSpadesPlayed(gs) && !queenSpadesInTrick(gs);

const preserveLastLowSpadeShieldLead = (cards, gs, player) => {
  // Lead-only candidate filter: if ♠Q is still outside and we hold ♠K/♠A, keep
  // one low spade shield (<♠Q) when possible.  Do not make the bot unable to
  // lead; if all candidates burn the shield, keep the original candidates.
  // Exception: do not preserve the shield at the cost of an immediate certain
  // dump disaster, such as a dead ♣/♦ winner into known-void opponents.
  if(!cards.length || !queenSpadesLiveOutside(gs, player)) return cards;

  const hand = gs.hands[player] || [];
  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));
  if(!holdsHighSpade) return cards;

  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);
  if(lowSpadesInHand.length !== 1) return cards;

  const shield = lowSpadesInHand[0];
  const filtered = cards.filter(c => !sameCard(c, shield));
  if(!filtered.length) return cards;

  // If every alternative left after removing the shield is already classified
  // as an immediate bad lead, keep the shield available.  Later H_V1 / normal
  // lead logic can then prefer the low spade over walking into the dump.
  const onlyImmediateBadAlternatives = filtered.every(c =>
    c.s !== 'S' && clearlyBadLeadAlternative(c, gs, player)
  );
  if(onlyImmediateBadAlternatives) return cards;

  return filtered;
};

const passedQueenPressureSpades = (valid, gs, player) => {
  // If we know we passed ♠Q left, actively pressure that seat with the smallest
  // safe low spade from early/midgame onward.  It becomes a little earlier when
  // the left player is a target/current leader.  Do not burn the final low-spade
  // shield while holding ♠K/♠A.
  if(!queenSpadesPassedLeft(gs, player)) return [];

  const leftPlayer = (player + 1) % 4;
  const leftRelation = playerRankRelation(gs, player, leftPlayer);
  const minTrick = leftRelation === 'target' ? 2 : 3;
  if(gs.tricksPlayed < minTrick) return [];

  const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);
  if(!spadesInHand.length) return [];

  const unseenSpades = unseenCardsOfSuit(gs, player, 'S');
  const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));
  if(!safeSpades.length) return [];

  const hand = gs.hands[player] || [];
  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);
  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));
  if(holdsHighSpade && lowSpadesInHand.length <= 1) return [];

  return smallestCards(safeSpades);
};

const leftAlreadyPlayedThisTrick = (gs, player) => gs.trick.some(x => x.player === ((player + 1) % 4));

const remainingPenaltiesOutside = (gs, player) => {
  const known = new Set(knownCardsFor(gs, player).map(cardKey));
  const penalties = cardsOfSuit('H').filter(c => !known.has(cardKey(c)));
  if(!known.has(cardKey(QUEEN_SPADES))) penalties.push(QUEEN_SPADES);
  return penalties;
};

const penaltiesStillOut = (gs, player) => remainingPenaltiesOutside(gs, player).length > 0;

const remainingPenaltyCost = cards =>
  -cards.reduce((sum, c) => sum + Math.min(0, cardPts(c)), 0);

const allPenaltyCards = () => [QUEEN_SPADES, ...cardsOfSuit('H')];

const unresolvedNegativePressure = gs => {
  // Negative pressure means all penalty cards not yet locked away in completed
  // tricks.  This includes the current trick and every hand, including our own.
  const completed = completedCards(gs);
  return remainingPenaltyCost(allPenaltyCards().filter(c => !cardIn(completed, c)));
};

const lowNegativePressureMode = gs => unresolvedNegativePressure(gs) <= 10;

const knownVoidInSuit = (gs, player, suit) =>
  Boolean(gs.knownVoids?.[player]?.[suitIdx(suit)]);

const playerCanStillDumpNegative = (gs, player) => {
  // In low-pressure mode, void fear is deliberately switched off.
  if(lowNegativePressureMode(gs)) return false;

  const unavailable = new Set([...completedCards(gs), ...trickCards(gs)].map(cardKey));
  const heartsStillAvailable = cardsOfSuit('H').some(c => !unavailable.has(cardKey(c)));
  const canDumpHearts = heartsStillAvailable && !knownVoidInSuit(gs, player, 'H');

  const queenStillAvailable =
    !queenSpadesPlayed(gs) &&
    !queenSpadesInTrick(gs) &&
    !knownVoidInSuit(gs, player, 'S');

  return canDumpHearts || queenStillAvailable;
};

const anyOpponentVoidIn = (gs, player, suit) => {
  if(lowNegativePressureMode(gs)) return false;
  const si = suitIdx(suit);
  return [1,2,3].some(off => {
    const p = (player + off) % 4;
    return gs.knownVoids?.[p]?.[si] && playerCanStillDumpNegative(gs, p);
  });
};

const worstVoidDumpCost = (gs, player, suit) => {
  if(!anyOpponentVoidIn(gs, player, suit)) return 0;
  const penalties = remainingPenaltiesOutside(gs, player);
  return penalties.length ? Math.max(...penalties.map(c => remainingPenaltyCost([c]))) : 0;
};

const suitVoidPenaltyRisk = (gs, player, suit) => {
  // Value-aware void risk: late in the round, a known void is only scary if
  // the worst plausible dump can make an otherwise neutral trick non-positive.
  const worstDump = worstVoidDumpCost(gs, player, suit);
  if(worstDump <= 0) return false;
  return 10 - worstDump < HARVEST_MIN_PROJECTED_NET;
};

const harvestModeActive = (gs, player) => {
  if(lowNegativePressureMode(gs)) return true;
  const penalties = remainingPenaltiesOutside(gs, player);
  if(!penalties.length) return true;
  if(penalties.some(c => sameCard(c, QUEEN_SPADES))) return false;

  const worstSingle = Math.max(...penalties.map(c => remainingPenaltyCost([c])));
  if(worstSingle > HARVEST_MAX_SINGLE_OUTSIDE_PENALTY) return false;

  const remainingTricks = Math.max(1, 13 - gs.tricksPlayed);
  const remainingBonus = 10 * remainingTricks;
  const totalCost = remainingPenaltyCost(penalties);
  return totalCost <= HARVEST_MAX_TOTAL_OUTSIDE_PENALTY_RATIO * remainingBonus;
};

const projectedLeadNetFloor = (card, gs, player) =>
  10 + cardPts(card) - worstVoidDumpCost(gs, player, card.s);

const highUnplayedCount = (gs, player, suit) => {
  const known = new Set(knownCardsFor(gs, player).map(cardKey));
  return [10,11,12,13,14].filter(v => !known.has(cardKey({s:suit, v}))).length;
};

const heartPenaltyMass = c => Math.max(0, -cardPts(c));

const lowerHeartPenaltyMassOutside = (card, gs, player) =>
  unseenCardsOfSuit(gs, player, 'H')
    .filter(c => c.v < card.v)
    .reduce((sum, c) => sum + heartPenaltyMass(c), 0);

const heartLeadExposureRisk = (card, gs, player) => {
  const heartsAfter = gs.hands[player].filter(c => c.s === 'H' && !sameCard(c, card));
  const highHeartsAfter = heartsAfter.filter(c => c.v >= 11);
  if(!highHeartsAfter.length) return false;

  // A low/mid heart protects ♥J–♥A because it can be spent before the bot is
  // forced to overtake later heart leads.  Burning the last such protector
  // while the suit is still live is dangerous even if this lead is currently
  // overtaken.
  const remainingProtection = heartsAfter.filter(c => c.v < 11);
  if(remainingProtection.length) return false;
  if(card.v >= 11) return false;

  return unseenCardsOfSuit(gs, player, 'H').length > 2;
};

const heartLeadRisk = (card, gs, player) => {
  if(card.s !== 'H') return false;

  // 1. Duck-under danger: enough lower penalty hearts remain outside that
  // opponents can cheaply stay below this lead.
  if(lowerHeartPenaltyMassOutside(card, gs, player) > 5) return true;

  // 2. High-heart danger: do not voluntarily lead ♥10–♥A while holding a
  // smaller heart escape and hearts are still live outside.
  const handHearts = gs.hands[player].filter(c => c.s === 'H');
  const minHeartInHand = handHearts.length ? Math.min(...handHearts.map(c => c.v)) : null;
  const outsideHearts = unseenCardsOfSuit(gs, player, 'H');
  if(card.v > 9 && minHeartInHand !== null && card.v !== minHeartInHand && outsideHearts.length) return true;

  // 3. Exposure danger: a seemingly safe low/mid heart can be bad when it is
  // the last protector for ♥J–♥A and several outside hearts can still force
  // future heart rounds.
  return heartLeadExposureRisk(card, gs, player);
};

const heartLeadPreferenceCandidates = (hearts, gs, player) => {
  if(!hearts.length) return [];
  const outsideHearts = unseenCardsOfSuit(gs, player, 'H');

  // If any candidate has lower hearts outside, minimize duck-under exposure by
  // leading the lowest heart available.
  if(hearts.some(c => outsideHearts.some(o => o.v < c.v))) {
    return smallestCards(hearts);
  }

  // Otherwise, if a higher outside heart can still overtake us, bleed the
  // highest heart that remains below an outside card.
  const beatableHearts = hearts.filter(c => outsideHearts.some(o => o.v > c.v));
  if(beatableHearts.length) return largestCards(beatableHearts);

  // No higher outside heart remains: if forced to lead hearts, keep the damage
  // as small as possible.
  return smallestCards(hearts);
};

const queenSpadeCashoutLeadCandidates = (valid, gs, player) => {
  // Highest-priority leading tactic: if we hold ♠Q and every remaining
  // outside spade is ♠K and/or ♠A, leading ♠Q cannot win.  An opponent with
  // the remaining high spade must beat it, so ♠Q is transferred immediately.
  if(!queenSpadesInHand(gs, player)) return [];
  const queen = valid.find(c => sameCard(c, QUEEN_SPADES));
  if(!queen) return [];

  const outsideSpades = unseenCardsOfSuit(gs, player, 'S');
  if(!outsideSpades.length) return [];
  return outsideSpades.every(c => c.v === 13 || c.v === 14) ? [queen] : [];
};

const nonQueenSpadeLeadCandidates = valid => {
  const nonQueenSpades = valid.filter(c => c.s === 'S' && !sameCard(c, QUEEN_SPADES));
  return nonQueenSpades.length ? smallestCards(nonQueenSpades) : [];
};

const protectedNonQueenSpadeFallbackCandidates = (valid, gs, player) => {
  // Holding ♠Q makes spade leads expensive, not impossible.  A fallback spade
  // is allowed only when leading it still leaves a non-queen spade guard with
  // ♠Q afterward.  Prefer non-Q spades below the queen; do not use ♠K/♠A as a
  // normal escape hatch.
  if(!queenSpadesInHand(gs, player)) return [];
  const otherSpadesInHand = gs.hands[player].filter(c => c.s === 'S' && !sameCard(c, QUEEN_SPADES));
  if(otherSpadesInHand.length < 2) return [];

  const lowNonQueenSpades = valid.filter(c => c.s === 'S' && c.v < 12);
  return lowNonQueenSpades.length ? smallestCards(lowNonQueenSpades) : [];
};

const highestLosingCards = (cards, gs) => {
  const rank = currentWinningRank(gs);
  if(rank === null) return [];
  const losing = cards.filter(c => c.v < rank);
  return losing.length ? largestCards(losing) : [];
};

const noHigherUnseenCard = (card, gs, player) =>
  !unseenCardsOfSuit(gs, player, card.s).some(c => c.v > card.v);

const highWinProbability = (card, gs, player) => {
  if(gs.leadSuit && gs.trick.length) {
    const rank = currentWinningRank(gs);
    if(card.s === gs.leadSuit && rank !== null && card.v < rank) return false;
    if(card.s !== gs.leadSuit) return false;
  }

  const unseen = unseenCardsOfSuit(gs, player, card.s);
  if(!unseen.length) return true;
  const lower = unseen.filter(c => c.v < card.v).length;
  const higher = unseen.filter(c => c.v > card.v).length;
  return higher === 0 || lower / unseen.length >= HIGH_WIN_LOWER_SHARE;
};

const unseenRankCounts = (card, gs, player) => {
  const unseen = unseenCardsOfSuit(gs, player, card.s);
  return {
    higher: unseen.filter(c => c.v > card.v).length,
    lower: unseen.filter(c => c.v < card.v).length,
  };
};

const highHeartDangerGone = gs => {
  const completed = completedCards(gs);
  return [11, 12, 13, 14].every(v => cardIn(completed, {s: 'H', v}));
};

const lateVoidDumpKeepWinnersMode = gs =>
  queenSpadesPlayed(gs) && highHeartDangerGone(gs);

const futureWinnerKeepPenalty = (card, gs, player) => {
  if(!lateVoidDumpKeepWinnersMode(gs)) return 0;
  if(cardPts(card) < 0) return 0;

  const {higher, lower} = unseenRankCounts(card, gs, player);
  const total = higher + lower;
  if(higher === 0) return 48;
  if(!total) return 48;

  const lowerShare = lower / total;
  if(lowerShare < 0.5) return 0;

  return Math.round(
    8 +
    lowerShare * 28 +
    Math.max(0, card.v - 10) * 2 -
    higher * 4
  );
};

const leastFutureWinnerValueCards = (cards, gs, player) => {
  if(!cards.length) return [];
  const scored = cards.map(card => ({
    card,
    keepPenalty: futureWinnerKeepPenalty(card, gs, player),
    rank: card.v,
  }));
  scored.sort((a,b) =>
    a.keepPenalty - b.keepPenalty ||
    a.rank - b.rank
  );
  const best = scored[0];
  return scored
    .filter(x => x.keepPenalty === best.keepPenalty && x.rank === best.rank)
    .map(x => x.card);
};

const quetschReceivedFromRightFor = (gs, player) => gs.quetschReceivedFromRight?.[player] ?? [];
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

const knownVoidDumpersInSuit = (gs, player, suit) => {
  const si = suitIdx(suit);
  return [1, 2, 3]
    .map(off => (player + off) % 4)
    .filter(p => gs.knownVoids?.[p]?.[si] && playerCanStillDumpNegative(gs, p));
};

const targetAwareVoidLeadDecision = (cards, gs, player) => {
  // If a target is known void in a candidate suit, reduce the appeal of that
  // suit because the target can dump safely.  When a safe ♠/♥ pressure lead
  // survived earlier filters, prefer it directly.
  if(!cards.length || lowNegativePressureMode(gs)) return {cards, pressure: []};

  const givesTargetFreeDump = card => knownVoidDumpersInSuit(gs, player, card.s)
    .some(p => playerRankRelation(gs, player, p) === 'target');

  const bad = cards.filter(givesTargetFreeDump);
  if(!bad.length) return {cards, pressure: []};

  const nonBad = cards.filter(c => !givesTargetFreeDump(c));
  if(!nonBad.length) return {cards, pressure: []};

  const pressure = nonBad.filter(c =>
    (c.s === 'S' || c.s === 'H') &&
    !voidRiskyWinningLead(c, gs, player)
  );

  return {
    cards: pressure.length ? pressure : nonBad,
    pressure,
  };
};

const allOpponentsKnownVoidInSuit = (gs, player, suit) =>
  [1, 2, 3].every(off => knownVoidInSuit(gs, (player + off) % 4, suit));

const aceAlreadyPlayedInSuit = (gs, suit) =>
  [...completedCards(gs), ...trickCards(gs)].some(c => c?.s === suit && c?.v === 14);

const certainBadMinorWinnerLead = (card, gs, player) => {
  if(!card || !sideSuit(card.s)) return false;
  if(lowNegativePressureMode(gs) || harvestModeActive(gs, player)) return false;
  if(!anyOpponentVoidIn(gs, player, card.s) && !allOpponentsKnownVoidInSuit(gs, player, card.s)) return false;

  // The failure mode we want to catch is not merely "a minor-suit card"; it is
  // a card that is very likely to keep the lead, e.g. last/highest remaining
  // ♣/♦, while opponents have a live dump.
  const likelyKeepsTrick = noHigherUnseenCard(card, gs, player) || highWinProbability(card, gs, player);
  if(!likelyKeepsTrick) return false;

  return projectedLeadNetFloor(card, gs, player) <= 0;
};

const clearlyBadLeadAlternative = (card, gs, player) => {
  if(!card || lowNegativePressureMode(gs) || harvestModeActive(gs, player)) return false;
  if(certainBadMinorWinnerLead(card, gs, player)) return true;

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

const leastBadVoidRiskLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return [];
  const scored = cards.map(c => {
    const {higher, lower} = unseenRankCounts(c, gs, player);
    return {card: c, higher, lower, rank: c.v};
  });
  scored.sort((a,b) =>
    b.higher - a.higher ||   // more possible overtakers
    a.lower - b.lower ||     // fewer duck-under cards
    a.rank - b.rank          // lower card if still tied
  );
  const best = scored[0];
  return scored
    .filter(x => x.higher === best.higher && x.lower === best.lower && x.rank === best.rank)
    .map(x => x.card);
};

const canStillBeOvertaken = (card, gs, player) => {
  if(gs.trick.length >= 3) return false;
  return unseenCardsOfSuit(gs, player, card.s).some(c => c.v > card.v);
};

const avoidRiskyFollowWinners = (cards, gs, player) => {
  if(!gs.leadSuit || !gs.trick.length) return cards;

  const risky = c => {
    if(!beatsCurrentTrick(c, gs)) return false;
    if(trickNetValue(gs) + cardPts(c) >= 0) return false;
    if(canStillBeOvertaken(c, gs, player)) return false;
    return true;
  };

  const safe = cards.filter(c => !risky(c));
  if(safe.length) return safe;

  // Forced into winning a bad trick: minimize control / penalty exposure.
  return smallestCards(cards);
};

const harvestWinningLeads = (cards, gs, player) => {
  if(!harvestModeActive(gs, player)) return [];

  const positive = cards.filter(c =>
    !sameCard(c, QUEEN_SPADES) &&
    projectedLeadNetFloor(c, gs, player) >= HARVEST_MIN_PROJECTED_NET
  );
  if(!positive.length) return [];

  // First preference: highest remaining card of a suit.
  const highestRemaining = positive.filter(c => noHigherUnseenCard(c, gs, player));
  if(highestRemaining.length) return largestCards(highestRemaining);

  // Fallback: high-probability winners.
  const likelyWinners = positive.filter(c => highWinProbability(c, gs, player));
  return likelyWinners.length ? largestCards(likelyWinners) : [];
};

const smallestOutsideHeartRank = (gs, player) => {
  const outside = unseenCardsOfSuit(gs, player, 'H');
  return outside.length ? Math.min(...outside.map(c => c.v)) : null;
};

const heartBleedLeadCandidates = (cards, gs, player) => {
  // Anti-greed heart bleed: only in mid/late game when all outside hearts are
  // at least ♥9, and only if a non-heart winning lead is tempting.  This keeps
  // the bot from always leading tiny hearts while still avoiding automatic ace
  // cash-ins when large hearts are waiting outside.
  if(!cards.length) return [];
  if(gs.tricksPlayed < 4) return [];
  if(lowNegativePressureMode(gs)) return [];

  const minOutsideHeart = smallestOutsideHeartRank(gs, player);
  if(minOutsideHeart === null || minOutsideHeart < 9) return [];

  const hearts = cards.filter(c => c.s === 'H');
  if(!hearts.length) return [];

  const temptingWinner = cards.some(c =>
    c.s !== 'H' &&
    !sameCard(c, QUEEN_SPADES) &&
    projectedLeadNetFloor(c, gs, player) >= HARVEST_MIN_PROJECTED_NET &&
    highWinProbability(c, gs, player)
  );
  if(!temptingWinner) return [];

  const safeBleedHearts = hearts.filter(c =>
    c.v < minOutsideHeart &&
    c.v < 11 &&
    hasHigherUnplayedOutsideOwnHand(c, gs, player) &&
    !heartLeadExposureRisk(c, gs, player)
  );

  return safeBleedHearts.length ? smallestCards(safeBleedHearts) : [];
};

const harvestFollowWinners = (cards, gs, player) => {
  if(!harvestModeActive(gs, player)) return [];
  if(!gs.leadSuit || !gs.trick.length) return [];

  const positiveWinners = cards.filter(c =>
    beatsCurrentTrick(c, gs) &&
    trickNetValue(gs) + cardPts(c) >= HARVEST_MIN_PROJECTED_NET
  );
  if(!positiveWinners.length) return [];

  // Last to act: no one can still dump into the trick. Earlier seats require
  // a sure or high-probability winner.
  if(gs.trick.length === 3) return largestCards(positiveWinners);

  const sureOrLikely = positiveWinners.filter(c =>
    noHigherUnseenCard(c, gs, player) || highWinProbability(c, gs, player)
  );
  return sureOrLikely.length ? largestCards(sureOrLikely) : [];
};

const clamp01 = x => Math.max(0, Math.min(1, x));

const comb = (n, k) => {
  if(k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let out = 1;
  for(let i = 1; i <= k; i++) {
    out *= (n - k + i) / i;
  }
  return out;
};

const followSuitNonVoidProbability = (gs, player, targetPlayer, suit) => {
  if(!suit || !Number.isInteger(targetPlayer)) return 0;
  if(lowNegativePressureMode(gs)) return 1;

  const si = suitIdx(suit);
  if(gs.knownVoids?.[targetPlayer]?.[si]) {
    // A known void is only bad if that player can still dump negative cards.
    return playerCanStillDumpNegative(gs, targetPlayer) ? 0 : 1;
  }

  // Own quetsch pass memory: cards passed left are known to remain in the
  // left player's hand until played, so left is not void in that suit.
  const leftPlayer = (player + 1) % 4;
  if(targetPlayer === leftPlayer && liveKnownPassedLeft(gs, player).some(c => c.s === suit)) return 1;

  const unseenSuitCount = unseenCardsOfSuit(gs, player, suit).length;
  if(unseenSuitCount <= 0) return 0;

  // Public-information approximation: distribute all unknown cards uniformly.
  // The target player has not yet acted in this trick, so their current hand
  // size is well approximated by the acting bot's current hand size.
  const known = new Set(knownCardsFor(gs, player).map(cardKey));
  const unknownTotal = 52 - known.size;
  const targetHandSize = gs.hands[player]?.length ?? 0;

  if(unknownTotal <= 0 || targetHandSize <= 0) return 0;
  if(unseenSuitCount >= unknownTotal) return 1;

  const denom = comb(unknownTotal, targetHandSize);
  if(!denom) return 0;

  const pVoid = comb(unknownTotal - unseenSuitCount, targetHandSize) / denom;
  return clamp01(1 - pVoid);
};

const applyOvertakeRiskMultiplier = (pTake, gs, player, laterPlayers) => {
  // Soft spade beliefs affect voluntary 2nd/3rd-position overtakes only.
  // They never block legal play, forced wins, or 4th-position positive takes.
  if(lowNegativePressureMode(gs)) return clamp01(pTake);

  const beliefs = gs.spadeBeliefs ?? {};
  const probableNoLowSpades = beliefs.probableNoLowSpades ?? [];
  const suspectedQueenHolder = beliefs.suspectedQueenHolder ?? [];

  let p = pTake;

  if(gs.leadSuit === 'S' && !queenSpadesPlayed(gs)) {
    for(const lp of laterPlayers) {
      if(probableNoLowSpades[lp]) p *= 0.3;
    }
  }

  if((gs.leadSuit === 'C' || gs.leadSuit === 'D') && !queenSpadesPlayed(gs) && !queenSpadesInTrick(gs) && !queenSpadesInHand(gs, player)) {
    for(const lp of laterPlayers) {
      if(suspectedQueenHolder[lp]) p *= 0.3;
    }
  }

  return clamp01(p);
};

const positiveFollowWinners = (cards, gs, player) => {
  let winners = cards.filter(c =>
    beatsCurrentTrick(c, gs) &&
    trickNetValue(gs) + cardPts(c) > 0
  );

  if(gs.leadSuit !== 'S') return winners;

  // If ♠Q is already in the current trick, do not apply normal positive-take
  // logic; the dedicated spade-follow safety should decide instead.
  if(queenSpadesInTrick(gs)) return [];

  // Once ♠Q is completed/out, spades are a normal suit again.
  if(queenSpadesPlayed(gs)) return winners;

  // Last to act: nobody can still dump ♠Q on our ♠K/♠A, so taking a positive
  // spade trick is a safe way to spend high spades.
  if(gs.trick.length === 3) return winners;

  // Earlier positions while ♠Q is live: if we hold ♠Q, nobody else can dump it
  // on us, so high spades may be used.  Otherwise, voluntary overtake cards are
  // capped at ♠J to avoid inviting ♠Q onto ♠K/♠A.
  if(queenSpadesInHand(gs, player)) return winners;
  return winners.filter(c => c.s !== 'S' || c.v <= 11);
};

const exposedHighSpadeControlFollowCandidates = (cards, gs, player) => {
  if(gs.leadSuit !== 'S' || !gs.trick.length) return [];
  if(queenSpadesPlayed(gs) || queenSpadesInTrick(gs) || queenSpadesInHand(gs, player)) return [];
  if(gs.trick.length >= 3) return [];

  const laterPlayers = playersAfterCurrentInTrick(gs, player);
  if(!laterPlayers.length || !laterPlayers.every(p => knownVoidInSuit(gs, p, 'S'))) return [];

  const rank = currentWinningRank(gs);
  if(rank === null) return [];

  const highWinners = cards.filter(c => c.s === 'S' && (c.v === 13 || c.v === 14) && c.v > rank);
  if(!highWinners.length) return [];

  const spadesInHand = gs.hands[player].filter(c => c.s === 'S');
  const losingGuards = cards.filter(c => c.s === 'S' && c.v < 12 && c.v < rank);
  const lowDuckExposesControl = losingGuards.some(guard => {
    const remainingSpades = spadesInHand.filter(c => !sameCard(c, guard));
    return remainingSpades.some(c => c.v === 13 || c.v === 14) &&
      !remainingSpades.some(c => c.v < 12);
  });

  return lowDuckExposesControl ? smallestCards(highWinners) : [];
};

const avoidKingUnderAcePressure = (cards, gs, player) => {
  if(!gs.leadSuit || !gs.trick.length) return cards;

  const isKingOfLeadSuit = c => c.s === gs.leadSuit && c.v === 13;
  if(!cards.some(isKingOfLeadSuit)) return cards;

  const aceAlreadyInTrick = gs.trick.some(x =>
    x.card?.s === gs.leadSuit && x.card?.v === 14
  );

  const known = new Set(knownCardsFor(gs, player).map(cardKey));
  const aceStillOut = !known.has(cardKey({s: gs.leadSuit, v: 14}));
  const someoneCanStillPlayAfterBot = gs.trick.length < 3;

  const kingUnderAcePressure =
    aceAlreadyInTrick ||
    (someoneCanStillPlayAfterBot && aceStillOut);

  if(!kingUnderAcePressure) return cards;

  const nonKing = cards.filter(c => !isKingOfLeadSuit(c));
  return nonKing.length ? nonKing : cards;
};

const heartFollowControl = (cards, gs) => {
  const losing = highestLosingCards(cards, gs);
  return losing.length ? randomFrom(losing) : randomFrom(smallestCards(cards));
};

const spadeFollowCandidates = (cards, gs, player) => {
  const isHighSpade = c => c.s === 'S' && (c.v === 13 || c.v === 14);
  const highInTrick = gs.trick.some(x => isHighSpade(x.card));
  const queenInTrick = queenSpadesInTrick(gs);
  const isLast = gs.trick.length === 3;

  // Case A: Dump ♠Q on an existing ♠K/♠A winner.
  if(highInTrick && cardIn(cards, QUEEN_SPADES) && queenSpadesInHand(gs, player)) {
    return [cards.find(c => sameCard(c, QUEEN_SPADES))];
  }

  // Case E / H0: Do not self-win with ♠Q when no K/A is already in the trick.
  if(queenSpadesInHand(gs, player) && cardIn(cards, QUEEN_SPADES) && !highInTrick && !queenInTrick) {
    const safe = cards.filter(c => !sameCard(c, QUEEN_SPADES));
    if(safe.length) return safe;
  }

  // Case B: ♠Q is in the trick. Avoid taking it; prefer highest losing spade.
  if(queenInTrick) {
    const safe = cards.filter(c => !isHighSpade(c));
    if(safe.length) {
      const rank = currentWinningRank(gs);
      const losing = rank === null ? [] : safe.filter(c => c.v < rank);
      return losing.length ? losing : safe;
    }
    return smallestCards(cards);
  }

  // Case C: Last to act and no ♠Q in trick: high spades are allowed.
  if(isLast) return cards;

  // Case D: ♠Q is still floating, or certainly with the left neighbor.
  if(queenSpadesPassedLeft(gs, player)) {
    if(!leftAlreadyPlayedThisTrick(gs, player)) {
      const safe = cards.filter(c => !isHighSpade(c));
      if(safe.length) return safe;
    }
    return cards;
  }

  const queenFloatingUnknown = !queenSpadesInHand(gs, player) && !queenSpadesPlayed(gs);
  if(queenFloatingUnknown) {
    const safe = cards.filter(c => !isHighSpade(c));
    if(safe.length) return safe;
  }

  return cards;
};

const stillUnplayedCardsOfSuit = (gs, suit) => {
  const played = new Set([...completedCards(gs), ...trickCards(gs)].map(cardKey));
  return cardsOfSuit(suit).filter(c => !played.has(cardKey(c)));
};
const isLowestStillUnplayedInSuit = (card, gs) => !stillUnplayedCardsOfSuit(gs, card.s).some(c => c.v < card.v);
const hasHigherUnplayedOutsideOwnHand = (card, gs, player) => unseenCardsOfSuit(gs, player, card.s).some(c => c.v > card.v);
const allOutsideSameSuitCardsAreHigher = (card, gs, player) => {
  const outside = unseenCardsOfSuit(gs, player, card.s);
  return outside.length > 0 && outside.every(c => c.v > card.v);
};
const negativeTrickSuitSet = gs => new Set(gs.negativeTrickSuits ?? []);

const isSafeBleedLead = (card, gs, player) =>
  (isLowestStillUnplayedInSuit(card, gs) && hasHigherUnplayedOutsideOwnHand(card, gs, player)) ||
  allOutsideSameSuitCardsAreHigher(card, gs, player);

const negativeHistoryNonHeartLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return [];
  const badSuits = negativeTrickSuitSet(gs);
  if(!badSuits.size) return cards;

  // Hearts almost always make tricks negative, so heart history is not
  // informative.  Heart danger is handled by the dedicated risky-heart logic.
  return cards.filter(c => c.s === 'H' || !badSuits.has(c.s) || isSafeBleedLead(c, gs, player));
};

const midgameLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return [];

  // First keep only leads that can still be overtaken from outside.  This
  // prevents the short-suit idea from selecting a dead suit that nobody else
  // can take, which can load the bot with dumped penalty cards.
  const beatable = cards.filter(c => hasHigherUnplayedOutsideOwnHand(c, gs, player));
  const pool = beatable.length ? beatable : cards;

  // Under serious danger, void creation is now only a midgame tie-breaker after
  // the beatable filter and after safe ♣/♦ ace openers.  Prefer the suit closest
  // to emptying, but do not use this preference if nothing is beatable.
  if(!lowNegativePressureMode(gs) && seriousDangerOnHand(gs, player) && beatable.length) {
    let eligible = pool;
    if(heartDangerOnHand(gs, player)) {
      const nonHearts = eligible.filter(c => c.s !== 'H');
      if(nonHearts.length) eligible = nonHearts;
    }

    if(eligible.length) {
      const minCount = Math.min(...eligible.map(c => handSuitCount(gs, player, c.s)));
      const shortestSuitCards = eligible.filter(c => handSuitCount(gs, player, c.s) === minCount);
      return smallestCards(shortestSuitCards);
    }
  }

  return smallestCards(pool);
};
const uniqueCardsByKey = cards => {
  const seen = new Set();
  const out = [];
  for(const c of cards || []) {
    if(!c) continue;
    const key = cardKey(c);
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
};

const botSuggestionReason = (rule, detail = '') => {
  const suffix = detail ? ' ' + detail : '';
  switch(rule) {
    case 'void_dump':
      return 'Du kannst die angespielte Farbe nicht bedienen; der Bot nutzt das zum Abwerfen einer gefährlichen oder strategisch passenden Karte.' + suffix;
    case 'heart_follow_control':
      return 'Bei Herz versucht der Bot möglichst unter dem aktuellen Stich zu bleiben; falls das nicht geht, hält er den Schaden klein.' + suffix;
    case 'spade_cashout':
      return 'Die ♠Q ist hier ein Cashout: außen sind nur noch hohe Pik, daher muss jemand sie übernehmen.' + suffix;
    case 'spade_safety_lead':
      return 'Der Bot vermeidet gefährliche Pik-Anspiele und behält mit ♠K/♠A möglichst eine kleine Pik-Schutzkarte.' + suffix;
    case 'passed_queen_pressure_lead':
      return 'Der Bot weiß, dass er ♠Q nach links gegeben hat, und setzt diesen Sitz mit einer kleinen Pik-Karte unter Druck.' + suffix;
    case 'heart_bleed_lead':
      return 'Der Bot spielt eine kleine Herz-Karte, weil draußen nur noch hohe Herzen liegen und ein sofortiger Gewinnzug sonst zu gierig wäre.' + suffix;
    case 'target_void_pressure_lead':
      return 'Der Bot meidet eine Farbe, in der ein Zielspieler sicher abwerfen könnte, und sucht stattdessen Druck über Pik oder Herz.' + suffix;
    case 'harvest_lead':
      return 'Der Bot sieht nur noch wenig ungelösten Strafkarten-Druck und versucht nun aktiver positive Stiche zu gewinnen.' + suffix;
    case 'risky_heart_lead':
      return 'Der Bot meidet riskante Herz-Anspiele und nimmt die sicherere verbliebene Alternative.' + suffix;
    case 'void_risk_lead':
      return 'Der Bot meidet eine Farbe wegen echter Abwurfgefahr oder wegen eines starken Quetsch-Hinweises aus den erhaltenen Karten.' + suffix;
    case 'negative_history_lead':
      return 'Der Bot meidet Farben, die schon negative Stiche erzeugt haben, außer die Karte ist ein sicherer Ausstieg.' + suffix;
    case 'void_creation_lead':
      return 'Unter Gefahr bevorzugt der Bot im Mittelspiel eine kurze, noch übernehmbare Farbe, um später besser abwerfen zu können.' + suffix;
    case 'safe_ace_lead':
      return 'Der Bot spielt ein sicheres ♣/♦-Ass, weil es meist einen positiven Stich einsammelt.' + suffix;
    case 'midgame_lead':
      return 'Im Mittelspiel bevorzugt der Bot erst übernehmbare Karten; nur bei echter Strafkarten-Gefahr zählt danach die kurze Farbe.' + suffix;
    case 'positive_follow_take':
      return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich; bei Pik und vermuteten ♠Q-Gefahren wird die Übernahmechance angepasst.' + suffix;
    case 'positive_follow_duck':
      return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler nach Risikoabschätzung noch übernehmen oder gefährlich abwerfen könnten.' + suffix;
    case 'spade_control_unblock':
      return 'Der Bot übernimmt mit ♠K/♠A, weil alle späteren Spieler in Pik void sind und ein kleiner Pik die hohe Pik-Kontrolle für ♠Q festsetzen würde.' + suffix;
    case 'avoid_bad_follow_win':
      return 'Der Bot vermeidet es, einen aktuell negativen Stich selbst zu gewinnen.' + suffix;
    case 'midgame_follow':
      return 'Im Mittelspiel wirft der Bot die höchste Karte ab, die den Stich nicht gewinnt.' + suffix;
    case 'normal_follow':
      return 'Der Bot wählt unter den sicheren gültigen Karten nach seiner normalen Stichlogik.' + suffix;
    case 'normal_lead':
    default:
      return 'Der Bot empfiehlt diese Karte nach seiner normalen Sicherheits- und Stichlogik.' + suffix;
  }
};

const suggestionDecision = (cards, rule, detail = '') => {
  const cleanCards = uniqueCardsByKey(cards);
  const reason = botSuggestionReason(rule, detail);
  return {
    cards: cleanCards,
    rule,
    reason,
    reasonByCard: Object.fromEntries(cleanCards.map(c => [cardKey(c), reason])),
  };
};

const voidDumpRecommendationCandidates = (valid, gs, player) => {
  const unshieldedHighSpades = unshieldedHighSpadeDumpCandidates(valid, gs, player);
  if(unshieldedHighSpades.length) return unshieldedHighSpades;

  const emergencyDumps = criticalVoidDumpCandidates(valid, gs, player);
  if(emergencyDumps.length) return [emergencyDumps[0]];

  const strategicDump = strategicVoidDump(valid, gs, player);
  if(strategicDump) return [strategicDump];

  const highNegatives = valid.filter(isHighNegativeForDump);
  if(highNegatives.length) return [sortByNegativityDesc(highNegatives)[0]];

  if(lateVoidDumpKeepWinnersMode(gs)) {
    const smallHearts = valid.filter(c => c.s === 'H' && c.v <= 5);
    if(smallHearts.length) return largestCards(smallHearts);

    const nonPenalty = valid.filter(c => cardPts(c) === 0);
    if(nonPenalty.length) return leastFutureWinnerValueCards(nonPenalty, gs, player);
  }

  if(queenSpadesStillOutNotInHand(gs, player) && spadesLowerThanQueenInHand(gs, player) < 2) {
    const highSpades = valid.filter(c => c.s === 'S' && (c.v === 13 || c.v === 14));
    if(highSpades.length) return largestCards(highSpades);
  }

  const midMinor = valid.filter(c => (c.s === 'D' || c.s === 'C') && c.v >= 5 && c.v <= 11);
  if(midMinor.length) {
    const minRemaining = Math.min(...midMinor.map(c => remainingPublicSuitCount(gs, player, c.s)));
    const shortestSuitCards = midMinor.filter(c => remainingPublicSuitCount(gs, player, c.s) === minRemaining);
    return largestCards(shortestSuitCards);
  }

  const smallHearts = valid.filter(c => c.s === 'H' && c.v <= 5);
  if(smallHearts.length) return largestCards(smallHearts);

  const lowSpades = valid.filter(c => c.s === 'S' && c.v < 12);
  if(lowSpades.length) return largestCards(lowSpades);

  return [sortByNegativityDesc(valid)[0]];
};

const heartFollowControlCandidates = (cards, gs) => {
  const losing = highestLosingCards(cards, gs);
  return losing.length ? losing : smallestCards(cards);
};

const heuristicDecision = (gs, player, { stochastic = true } = {}) => {
  gs = withInferredExhaustedSuitVoids(gs, player);
  const hand = gs.hands[player];
  const valid = getValidIdxs(hand, gs.leadSuit).map(i => hand[i]);
  const isLeading = !gs.leadSuit || gs.trick.length === 0;
  const finish = (cards, rule, detail = '') => {
    const clean = uniqueCardsByKey(cards);
    if(stochastic) return suggestionDecision([randomFrom(clean)], rule, detail);
    return suggestionDecision(clean, rule, detail);
  };

  if(!valid.length) return suggestionDecision([], 'normal_follow');

  // H1: Void dump — when unable to follow suit, dump worst penalty first.
  if(gs.leadSuit && !hand.some(c => c.s === gs.leadSuit)) {
    const cards = stochastic ? [voidDump(valid, gs, player)] : voidDumpRecommendationCandidates(valid, gs, player);
    return finish(cards, 'void_dump');
  }

  // H2: Heart-follow-control.
  // Exception: in harvest mode, take a positive heart trick when the card is
  // likely to remain winning.
  if(!isLeading && gs.leadSuit === 'H') {
    const harvestFollow = harvestFollowWinners(valid, gs, player);
    if(harvestFollow.length) return finish(harvestFollow, 'positive_follow_take');
    return finish(heartFollowControlCandidates(valid, gs), 'heart_follow_control');
  }

  if(isLeading) {
    let candidates = [...valid];
    const protectedSpadeFallback = protectedNonQueenSpadeFallbackCandidates(valid, gs, player);

    // H0L: ♠Q cashout. This rare tactic has priority over every normal lead
    // heuristic: if all outside spades are ♠K/♠A, ♠Q is guaranteed to be beaten.
    const queenCashout = queenSpadeCashoutLeadCandidates(valid, gs, player);
    if(queenCashout.length) return finish(queenCashout, 'spade_cashout');

    // H3: Spade-lead safety.
    // - If we hold ♠Q, do not lead any spade while an alternative exists.
    // - If ♠Q is not in our hand, do not lead ♠K/♠A while an alternative exists.
    //   These high spades are exactly the cards that can later be trapped by ♠Q.
    if(queenSpadesInHand(gs, player)) {
      const noSpade = candidates.filter(c => c.s !== 'S');
      if(noSpade.length) {
        candidates = noSpade;
      } else {
        // H0L did not fire, so leading ♠Q is unsafe. If the hand is all
        // spades, lead the lowest non-queen spade and only play ♠Q if forced.
        const nonQueenSpades = nonQueenSpadeLeadCandidates(candidates);
        if(nonQueenSpades.length) return finish(nonQueenSpades, 'spade_safety_lead');
        return finish([candidates.find(c => sameCard(c, QUEEN_SPADES)) ?? valid[0]], 'spade_safety_lead');
      }
    } else {
      const noSpadeAboveQueen = candidates.filter(c => !(c.s === 'S' && c.v > 12));
      if(noSpadeAboveQueen.length) candidates = noSpadeAboveQueen;
    }

    // H3b: If ♠Q is still outside and we hold ♠K/♠A, avoid spending the last
    // low spade shield on lead when another candidate exists.
    candidates = preserveLastLowSpadeShieldLead(candidates, gs, player);

    // H_Q1: If we passed ♠Q left, actively pressure that seat with safe LOW
    // spades from early/midgame onward.  If the direct pressure trigger does
    // not fire yet, still re-add safe low spades as allowed candidates.
    const qPressureSpades = passedQueenPressureSpades(valid, gs, player);
    if(qPressureSpades.length) {
      return finish(qPressureSpades, 'passed_queen_pressure_lead');
    }
    if(queenSpadesPassedLeft(gs, player)) {
      const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);
      if(spadesInHand.length) {
        const unseenSpades = unseenCardsOfSuit(gs, player, 'S');
        const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));
        if(safeSpades.length) {
          const nonSpadeCandidates = candidates.filter(c => c.s !== 'S');
          candidates = [
            ...nonSpadeCandidates,
            ...safeSpades.filter(c => !nonSpadeCandidates.some(x => sameCard(x, c))),
          ];
        }
      }
    }

    // H_HBLEED: Before greedily harvesting positive winners, bleed the smallest
    // safe held heart when every outside heart is at least ♥9.
    const heartBleedLeads = heartBleedLeadCandidates(candidates, gs, player);
    if(heartBleedLeads.length) return finish(heartBleedLeads, 'heart_bleed_lead');

    // H_HARVEST: If late-game penalty risk is low, stop over-avoiding
    // voids and prefer high-probability winners of positive tricks.
    // This runs after ♠Q safety, so it cannot accidentally expose ♠Q.
    const harvestLeads = harvestWinningLeads(candidates, gs, player);
    if(harvestLeads.length) return finish(harvestLeads, 'harvest_lead');

    // H5: Avoid risky heart leads.
    const hearts = candidates.filter(c => c.s === 'H');
    if(hearts.length) {
      const riskyHearts = hearts.filter(c => heartLeadRisk(c, gs, player));
      if(riskyHearts.length) {
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
        candidates = heartLeadPreferenceCandidates(hearts, gs, player);
      }
    }

    // H_V1: Known-void suits are only dangerous when the card is likely to win.
    const riskyVoidLeads = candidates.filter(c => voidRiskyWinningLead(c, gs, player));
    if(riskyVoidLeads.length) {
      const safeFromVoid = candidates.filter(c => !riskyVoidLeads.some(r => sameCard(r, c)));
      if(safeFromVoid.length) {
        candidates = safeFromVoid;
      } else if(protectedSpadeFallback.length) {
        return finish(protectedSpadeFallback, 'void_risk_lead');
      } else {
        candidates = leastBadVoidRiskLeadCandidates(candidates, gs, player);
      }
    }

    // H_TVOID: Score-aware void politics.  If a target is known void in a
    // candidate suit, do not give them a safe dump when a sensible alternative
    // exists; prefer surviving ♠/♥ pressure directly.
    const targetVoidDecision = targetAwareVoidLeadDecision(candidates, gs, player);
    if(targetVoidDecision.pressure.length) {
      return finish(targetVoidDecision.pressure, 'target_void_pressure_lead');
    }
    candidates = targetVoidDecision.cards;

    // H_NEGHIST: From trick 2 onward, avoid non-heart suits that have already
    // produced a negative trick, unless the candidate is a safe bleed/exit.
    if(gs.tricksPlayed >= 1) {
      const filteredByHistory = negativeHistoryNonHeartLeadCandidates(candidates, gs, player);
      if(filteredByHistory.length) {
        candidates = filteredByHistory;
      } else if(protectedSpadeFallback.length) {
        return finish(protectedSpadeFallback, 'negative_history_lead');
      }
    }

    // H_K1: If we hold K♣/K♦ without the same-suit ace and also have a
    // smaller card of that suit, do not lead the king while the ace is still
    // live outside and a lower same-suit card can preserve it as a future
    // positive-trick winner.
    candidates = protectMinorKingLeadCandidates(candidates, gs, player);

    // H7: Prefer safe ♣A / ♦A openers after risk filters.  The serious-danger
    // short-suit idea is now handled inside midgameLeadCandidates, after this
    // safe-ace opener and only among beatable leads.
    const safeAces = candidates.filter(c => (c.s === 'C' || c.s === 'D') && c.v === 14);
    if(safeAces.length) return finish(preferNonQuetschSoftWinningLeads(safeAces, gs, player), 'safe_ace_lead');

    // H10 + H11: Midgame small-card, safe-suit preference.
    if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
      candidates = midgameLeadCandidates(candidates, gs, player);
      return finish(preferNonQuetschSoftWinningLeads(candidates, gs, player), 'midgame_lead');
    }

    return finish(preferNonQuetschSoftWinningLeads(candidates, gs, player), 'normal_lead');
  }

  // Following heuristics.
  let candidates = [...valid];

  // Hearts deliberately keep the old dedicated heart-follow branch above.
  // Spades use dedicated safety while ♠Q is live, but the positive-follow rules
  // below are still allowed in an adjusted form: 4th position may spend ♠K/♠A,
  // while 2nd/3rd are capped at ♠J unless the bot holds ♠Q.
  const spadesAreCompleted = gs.leadSuit === 'S' && queenSpadesPlayed(gs);

  // H4: Spade-following intelligence while ♠Q is still live/current.
  if(gs.leadSuit === 'S' && !spadesAreCompleted) {
    const unblockHighSpade = exposedHighSpadeControlFollowCandidates(candidates, gs, player);
    if(unblockHighSpade.length) return finish(unblockHighSpade, 'spade_control_unblock');
    candidates = spadeFollowCandidates(candidates, gs, player);
  }

  // New H9a: fourth position — always take truly positive tricks.  For spades,
  // this also allows safe ♠K/♠A wins while ♠Q is still live, because nobody can
  // play after the bot.
  if(gs.trick.length === 3) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);
    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // H8 revised: avoid wasting King under Ace pressure.
  candidates = avoidKingUnderAcePressure(candidates, gs, player);

  // H6 follow-side: avoid currently winning net-negative tricks.
  const beforeRiskAvoidance = candidates;
  candidates = avoidRiskyFollowWinners(candidates, gs, player);
  const avoidedRiskyWin = beforeRiskAvoidance.length !== candidates.length || (
    beforeRiskAvoidance.length === candidates.length &&
    beforeRiskAvoidance.some((c, i) => !sameCard(c, candidates[i]))
  );

  // New H9b: third position — probabilistically overtake positive tricks.
  if(gs.trick.length === 2) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);
    const losing = highestLosingCards(candidates, gs);

    if(positiveWinners.length && losing.length) {
      const fourthPlayer = (player + 1) % 4;
      const baseTake = followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);
      const pTake = applyOvertakeRiskMultiplier(baseTake, gs, player, [fourthPlayer]);
      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Risiko-abgewogene Übernahmechance).';
      if(stochastic) {
        return Math.random() < pTake
          ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
          : finish(losing, 'positive_follow_duck', detail);
      }
      return pTake >= 0.5
        ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
        : finish(losing, 'positive_follow_duck', detail);
    }

    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // New H9c: second position — probabilistically overtake positive tricks,
  // but only as often as both later players are plausibly non-void.
  if(gs.trick.length === 1) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);
    const losing = highestLosingCards(candidates, gs);

    if(positiveWinners.length && losing.length) {
      const thirdPlayer = (player + 1) % 4;
      const fourthPlayer = (player + 2) % 4;
      const baseTake =
        followSuitNonVoidProbability(gs, player, thirdPlayer, gs.leadSuit) *
        followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);
      const pTake = applyOvertakeRiskMultiplier(baseTake, gs, player, [thirdPlayer, fourthPlayer]);
      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Risiko-abgewogene Übernahmechance).';
      if(stochastic) {
        return Math.random() < pTake
          ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
          : finish(losing, 'positive_follow_duck', detail);
      }
      return pTake >= 0.5
        ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
        : finish(losing, 'positive_follow_duck', detail);
    }

    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // H10 revised: Midgame follow — shed the largest non-winning card.
  if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
    const losing = highestLosingCards(candidates, gs);
    candidates = losing.length ? losing : smallestCards(candidates);
    return finish(candidates, 'midgame_follow');
  }

  return finish(candidates, avoidedRiskyWin ? 'avoid_bad_follow_win' : 'normal_follow');
};

export const recommendHeuristicCards = (gs, player) => heuristicDecision(gs, player, { stochastic: false });

export const chooseHeuristicCard = (gs, player) => {
  const decision = heuristicDecision(gs, player, { stochastic: true });
  return decision.cards[0];
};
