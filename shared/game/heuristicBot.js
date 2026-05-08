import {
  VALS, QUEEN_SPADES, sameCard, cardKey, cardPts, getValidIdxs, suitIdx, sortHand,
} from './cards.js';

// Auto-quetsch for non-human seats. This mirrors the training-side heuristic:
// avoid isolated ♠Q danger, dangerous high hearts, keep low safety cards,
// prepare suits with A, and create cheap C/D voids when possible.
export const heuristicQuetschPick = hand => {
  const selected = [];
  const has = c => hand.some(x => sameCard(x,c));
  const cardsOfSuit = s => [...hand].filter(c=>c.s===s).sort((a,b)=>a.v-b.v);
  const protectedLow = c => ['H','D','C'].includes(c.s) && c.v>=2 && c.v<=4;
  const add = (c, allowProtected=false) => {
    if(selected.length>=3 || !has(c) || selected.some(x=>sameCard(x,c))) return;
    if(protectedLow(c) && !allowProtected) return;
    selected.push(c);
  };
  const addMany = (cards, allowProtected=false) => {
    for(const c of cards){ add(c, allowProtected); if(selected.length>=3) break; }
  };

  const spades = cardsOfSuit('S');
  if(has(QUEEN_SPADES)) {
    const otherSpades = spades.filter(c=>!sameCard(c, QUEEN_SPADES));
    if(otherSpades.length < 2) {
      add(QUEEN_SPADES);
      addMany(otherSpades.filter(c=>c.v===13||c.v===14).sort((a,b)=>b.v-a.v));
    }
  }

  const hearts = cardsOfSuit('H');
  const smallHearts = hearts.filter(c=>c.v<7);
  const highHearts = hearts.filter(c=>c.v>=11).sort((a,b)=>b.v-a.v);
  if(highHearts.length && smallHearts.length===0) addMany(highHearts);

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
    if(remaining.length && remaining.length <= 3-selected.length && !remaining.some(protectedLow)) {
      const avg = remaining.reduce((a,c)=>a+c.v,0)/remaining.length;
      voidOptions.push({n:remaining.length, avg, cards:remaining});
    }
  }
  voidOptions.sort((a,b)=>a.n-b.n || b.avg-a.avg);
  if(voidOptions.length) addMany(voidOptions[0].cards.sort((a,b)=>b.v-a.v));

  const fallbackScore = c => {
    if(sameCard(c, QUEEN_SPADES)) return 1000;
    if(c.s==='S' && (c.v===14||c.v===13)) return 800+c.v;
    if(c.s==='H' && c.v>=11) return 700+c.v;
    if(c.s==='H') return 300+c.v;
    if((c.s==='C'||c.s==='D') && c.v>=11) return 200+c.v;
    return c.v;
  };
  addMany([...hand].filter(c=>!selected.some(x=>sameCard(x,c)) && !protectedLow(c)).sort((a,b)=>fallbackScore(b)-fallbackScore(a)));
  addMany([...hand].filter(c=>!selected.some(x=>sameCard(x,c))).sort((a,b)=>{
    const pa = (a.s==='C'||a.s==='D') ? 0 : 1;
    const pb = (b.s==='C'||b.s==='D') ? 0 : 1;
    return pa-pb || b.v-a.v;
  }), true);
  return selected.slice(0,3);
};

export const botQuetschPick = heuristicQuetschPick;

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
const knownCardsFor = (gs, player) => [
  ...gs.hands[player],
  ...trickCards(gs),
  ...completedCards(gs),
];

const unseenCardsOfSuit = (gs, player, suit) => {
  const seen = new Set(knownCardsFor(gs, player).map(cardKey));
  return cardsOfSuit(suit).filter(c => !seen.has(cardKey(c)));
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

const protectedQueenHighHeartDumpCandidates = (valid, gs, player) => {
  // Void-dump exception: when ♠Q is protected by at least three other spades,
  // exposed high hearts become more urgent than the queen.  If the hand has
  // ♥10–♥A but fewer than two small hearts (♥2–♥7), dump the highest high
  // heart before ♠Q.
  const hand = gs.hands[player];
  if(!cardIn(hand, QUEEN_SPADES)) return [];

  const otherSpades = hand.filter(c => c.s === 'S' && !sameCard(c, QUEEN_SPADES));
  if(otherSpades.length < 3) return [];

  const hearts = hand.filter(c => c.s === 'H');
  const highHearts = hearts.filter(c => c.v >= 10);
  const smallHearts = hearts.filter(c => c.v <= 7);
  if(!highHearts.length || smallHearts.length >= 2) return [];

  const dumpableHighHearts = valid.filter(c => c.s === 'H' && c.v >= 10);
  return dumpableHighHearts.length ? largestCards(dumpableHighHearts) : [];
};

const voidDump = (valid, gs, player) => {
  // 0. Protected-♠Q exception: if ♠Q is stable for now but high hearts are
  // insufficiently protected, dump ♥10–♥A before dumping ♠Q.
  const protectedQHeartDumps = protectedQueenHighHeartDumpCandidates(valid, gs, player);
  if(protectedQHeartDumps.length) return protectedQHeartDumps[0];

  // 1. Urgent penalties first: ♠Q and ♥6–♥A.
  const highNegatives = valid.filter(isHighNegativeForDump);
  if(highNegatives.length) return sortByNegativityDesc(highNegatives)[0];

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

const anyOpponentVoidIn = (gs, player, suit) => {
  const si = suitIdx(suit);
  return [1,2,3].some(off => gs.knownVoids?.[(player + off) % 4]?.[si]);
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

const voidRiskyWinningLead = (card, gs, player) =>
  suitVoidPenaltyRisk(gs, player, card.s) && highWinProbability(card, gs, player);

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

const cleanLateTrickWinners = (cards, gs) => {
  if(!gs.leadSuit || !gs.trick.length) return [];
  if(!(gs.trick.length === 2 || gs.trick.length === 3)) return [];
  if(trickIsNetNegative(gs)) return [];
  const winners = cards.filter(c => beatsCurrentTrick(c, gs));
  return winners.length ? largestCards(winners) : [];
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

  // Full cautious midgame is now only the general small/beatable preference.
  // Negative suit history is handled separately from trick 2 onward.
  const beatable = cards.filter(c => hasHigherUnplayedOutsideOwnHand(c, gs, player));
  if(beatable.length) cards = beatable;

  return smallestCards(cards);
};
export const chooseHeuristicCard = (gs, player) => {
  const hand = gs.hands[player];
  const valid = getValidIdxs(hand, gs.leadSuit).map(i => hand[i]);
  const isLeading = !gs.leadSuit || gs.trick.length === 0;

  // H1: Void dump — when unable to follow suit, dump worst penalty first.
  if(gs.leadSuit && !hand.some(c => c.s === gs.leadSuit)) {
    return voidDump(valid, gs, player);
  }

  // H2: Heart-follow-control.
  // Exception: in harvest mode, take a positive heart trick when the card is
  // likely to remain winning.
  if(!isLeading && gs.leadSuit === 'H') {
    const harvestFollow = harvestFollowWinners(valid, gs, player);
    if(harvestFollow.length) return randomFrom(harvestFollow);
    return heartFollowControl(valid, gs);
  }

  if(isLeading) {
    let candidates = [...valid];
    const protectedSpadeFallback = protectedNonQueenSpadeFallbackCandidates(valid, gs, player);

    // H0L: ♠Q cashout. This rare tactic has priority over every normal lead
    // heuristic: if all outside spades are ♠K/♠A, ♠Q is guaranteed to be beaten.
    const queenCashout = queenSpadeCashoutLeadCandidates(valid, gs, player);
    if(queenCashout.length) return queenCashout[0];

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
        if(nonQueenSpades.length) return randomFrom(nonQueenSpades);
        return candidates.find(c => sameCard(c, QUEEN_SPADES)) ?? valid[0];
      }
    } else {
      const noSpadeAboveQueen = candidates.filter(c => !(c.s === 'S' && c.v > 12));
      if(noSpadeAboveQueen.length) candidates = noSpadeAboveQueen;
    }

    // H_Q1: If we passed ♠Q left, allow safe LOW spades to pressure that seat.
    // The no-high-spade-lead rule still applies: never re-add ♠K/♠A here.
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

    // H_HARVEST: If late-game penalty risk is low, stop over-avoiding
    // voids and prefer high-probability winners of positive tricks.
    // This runs after ♠Q safety, so it cannot accidentally expose ♠Q.
    const harvestLeads = harvestWinningLeads(candidates, gs, player);
    if(harvestLeads.length) return randomFrom(harvestLeads);

    // H5: Avoid risky heart leads.  Risk now combines duck-under mass,
    // voluntary high-heart exposure, and burning the last low/mid protector
    // for ♥J–♥A.  If the heart filter empties all non-spade options, use a
    // protected low spade only when ♠Q still keeps a guard afterward.
    const hearts = candidates.filter(c => c.s === 'H');
    if(hearts.length) {
      const riskyHearts = hearts.filter(c => heartLeadRisk(c, gs, player));
      if(riskyHearts.length) {
        const filtered = candidates.filter(c => !riskyHearts.some(r => sameCard(r, c)));
        if(filtered.length) {
          candidates = filtered;
        } else if(protectedSpadeFallback.length) {
          return randomFrom(protectedSpadeFallback);
        } else {
          return randomFrom(heartLeadPreferenceCandidates(hearts, gs, player));
        }
      } else if(candidates.every(c => c.s === 'H')) {
        candidates = heartLeadPreferenceCandidates(hearts, gs, player);
      }
    }

    // H_V1: Known-void suits are only dangerous when the card is likely to
    // win. If every same-suit card outside is higher, the lead is a safe exit:
    // someone else must take the trick even if a void player dumps penalties.
    const riskyVoidLeads = candidates.filter(c => voidRiskyWinningLead(c, gs, player));
    if(riskyVoidLeads.length) {
      const safeFromVoid = candidates.filter(c => !riskyVoidLeads.some(r => sameCard(r, c)));
      if(safeFromVoid.length) {
        candidates = safeFromVoid;
      } else if(protectedSpadeFallback.length) {
        return randomFrom(protectedSpadeFallback);
      } else {
        candidates = leastBadVoidRiskLeadCandidates(candidates, gs, player);
      }
    }

    // H_NEGHIST: From trick 2 onward, avoid non-heart suits that have already
    // produced a negative trick, unless the candidate is a safe bleed/exit.
    // Hearts are deliberately excluded because heart tricks are usually
    // negative and are handled by H5.
    if(gs.tricksPlayed >= 1) {
      const filteredByHistory = negativeHistoryNonHeartLeadCandidates(candidates, gs, player);
      if(filteredByHistory.length) {
        candidates = filteredByHistory;
      } else if(protectedSpadeFallback.length) {
        return randomFrom(protectedSpadeFallback);
      }
    }

    // H6b: Under serious danger, prefer creating a short-suit void
    // before taking otherwise-safe ♣A/♦A openers.  This is a soft preference:
    // if it finds no option, keep the current safety-filtered candidates.
    const voidCreationLeads = voidCreationLeadCandidates(candidates, gs, player);
    if(voidCreationLeads.length) candidates = voidCreationLeads;

    // H7: Prefer safe ♣A / ♦A openers after risk filters and
    // the serious-danger void-creation preference.
    const safeAces = candidates.filter(c => (c.s === 'C' || c.s === 'D') && c.v === 14);
    if(safeAces.length) return randomFrom(safeAces);

    // H10 + H11: Midgame small-card, safe-suit preference.
    if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
      candidates = midgameLeadCandidates(candidates, gs, player);
    }

    return randomFrom(candidates);
  }

  // Following heuristics.
  let candidates = [...valid];
  const lateCleanWinners = cleanLateTrickWinners(candidates, gs);

  // H4: Spade-following intelligence.
  if(gs.leadSuit === 'S') {
    candidates = spadeFollowCandidates(candidates, gs, player);
  }

  // H8: Do not play King when Ace was led and smaller options exist.
  const first = gs.trick[0]?.card;
  if(first?.v === 14 && gs.leadSuit === first.s) {
    const nonKing = candidates.filter(c => !(c.s === first.s && c.v === 13));
    if(nonKing.length) candidates = nonKing;
  }

  // H_HARVEST: when remaining penalty risk is low, actively take
  // positive tricks with likely winners immediately.
  const harvestFollow = harvestFollowWinners(candidates, gs, player);
  if(harvestFollow.length) return randomFrom(harvestFollow);

  // H6 follow-side: avoid currently winning net-negative tricks.
  candidates = avoidRiskyFollowWinners(candidates, gs, player);

  // H10: Midgame — smallest valid card.
  if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
    candidates = smallestCards(candidates);
  }

  // H9: Clean late trick win as a late soft preference.
  if(lateCleanWinners.length) {
    const preferred = candidates.filter(c => lateCleanWinners.some(w => sameCard(w, c)));
    if(preferred.length) candidates = preferred;
  }

  return randomFrom(candidates);
};


