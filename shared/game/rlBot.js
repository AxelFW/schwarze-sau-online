import {
  NEGATIVE_CARDS,
  PY_SUITS,
  QUEEN_SPADES,
  VALS,
  cardKey,
  cardPts,
  cardToIdx,
  getValidIdxs,
  sameCard,
} from './cards.js';
import {
  chooseHeuristicCard,
  heuristicQuetschPick,
  recommendHeuristicCards,
} from './heuristicBot.js';
import { RL_POLICY } from './rlPolicyData.js';

export const RL_RULES = Object.freeze([
  'void_dump',
  'heart_follow_control',
  'spade_cashout',
  'spade_safety_lead',
  'passed_queen_pressure_lead',
  'heart_bleed_lead',
  'target_void_pressure_lead',
  'harvest_lead',
  'risky_heart_lead',
  'void_risk_lead',
  'negative_history_lead',
  'void_creation_lead',
  'safe_ace_lead',
  'midgame_lead',
  'positive_follow_take',
  'positive_follow_duck',
  'spade_control_unblock',
  'avoid_bad_follow_win',
  'midgame_follow',
  'normal_follow',
  'normal_lead',
]);

export const RL_FEATURE_NAMES = Object.freeze([
  'bias',
  'heuristic_candidate',
  'heuristic_singleton',
  'heuristic_candidate_count',
  'rank_high',
  'rank_low',
  'penalty_abs',
  'point_value',
  'is_heart',
  'is_spade',
  'is_club',
  'is_diamond',
  'is_minor',
  'is_queen_spades',
  'is_high_heart',
  'is_small_heart',
  'is_low_spade',
  'is_high_spade',
  'is_ace',
  'is_king',
  'is_queen',
  'is_jack',
  'is_leading',
  'follow_pos_2',
  'follow_pos_3',
  'follow_pos_4',
  'last_to_act',
  'trick_net_before',
  'current_trick_negative',
  'beats_current_trick',
  'loses_current_trick',
  'creates_void',
  'suit_count_before',
  'suit_count_after',
  'lower_own_same_suit',
  'higher_own_same_suit',
  'known_void_opponents_suit',
  'future_known_voids_suit',
  'queen_spades_in_hand',
  'queen_spades_played',
  'queen_spades_in_trick',
  'queen_spades_live_outside',
  'low_spade_guards_after',
  'high_spades_held',
  'remaining_penalty_count',
  'remaining_penalty_abs',
  'tricks_played',
  'round_score_self',
  'score_margin_best',
  'score_margin_avg',
  ...RL_RULES.map(rule => `rule:${rule}`),
]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const bool = value => (value ? 1 : 0);
const norm = (value, scale) => clamp(Number(value || 0) / scale, -1, 1);

const trickCards = gs => (gs?.trick ?? []).map(x => x.card).filter(Boolean);
const completedCards = gs => gs?.trickHistory ?? [];
const knownCardsFor = (gs, player) => [
  ...(gs?.hands?.[player] ?? []),
  ...trickCards(gs),
  ...completedCards(gs),
];

const cardIn = (cards, target) => cards.some(c => sameCard(c, target));
const liveCardKeys = gs => new Set([...trickCards(gs), ...completedCards(gs)].map(cardKey));
const queenSpadesInHand = (gs, player) => cardIn(gs?.hands?.[player] ?? [], QUEEN_SPADES);
const queenSpadesPlayed = gs => cardIn(completedCards(gs), QUEEN_SPADES);
const queenSpadesInTrick = gs => cardIn(trickCards(gs), QUEEN_SPADES);
const queenSpadesLiveOutside = (gs, player) =>
  !queenSpadesInHand(gs, player) && !queenSpadesPlayed(gs) && !queenSpadesInTrick(gs);

const unseenPenaltyCards = gs => {
  const seen = liveCardKeys(gs);
  return NEGATIVE_CARDS.filter(c => !seen.has(cardKey(c)));
};

const currentWinningRank = gs => {
  if (!gs?.leadSuit || !gs?.trick?.length) return null;
  const ranks = gs.trick.filter(x => x.card?.s === gs.leadSuit).map(x => x.card.v);
  return ranks.length ? Math.max(...ranks) : null;
};

const currentTrickNet = gs =>
  10 + (gs?.trick ?? []).reduce((sum, x) => sum + cardPts(x.card), 0);

const beatsCurrentTrick = (card, gs) => {
  const rank = currentWinningRank(gs);
  return Boolean(gs?.leadSuit && rank !== null && card.s === gs.leadSuit && card.v > rank);
};

const losesCurrentTrick = (card, gs) => {
  const rank = currentWinningRank(gs);
  return Boolean(gs?.leadSuit && rank !== null && card.s === gs.leadSuit && card.v < rank);
};

const suitCount = (hand, suit) => hand.filter(c => c.s === suit).length;

const publicScores = gs => {
  if (Array.isArray(gs?.projectedScores) && gs.projectedScores.length >= 4) {
    return gs.projectedScores.slice(0, 4).map(Number);
  }
  if (Array.isArray(gs?.scores) && gs.scores.length >= 4) {
    const round = Array.isArray(gs?.roundScores)
      ? gs.roundScores
      : Array.isArray(gs?.roundPts)
        ? gs.roundPts
        : [0, 0, 0, 0];
    return gs.scores.slice(0, 4).map((score, i) => Number(score || 0) + Number(round[i] || 0));
  }
  return [0, 0, 0, 0];
};

const stableCardTie = card => {
  const idx = cardToIdx(card);
  return Number.isInteger(idx) ? -idx / 1000 : 0;
};

const dot = (a, b) => {
  let out = 0;
  for (let i = 0; i < a.length && i < b.length; i++) out += a[i] * b[i];
  return out;
};

const validCardsFor = (gs, player) => {
  const hand = gs?.hands?.[player] ?? [];
  return getValidIdxs(hand, gs?.leadSuit ?? null).map(i => hand[i]);
};

export const makeInitialRlModel = ({
  candidateMode = 'legal',
  heuristicCandidateWeight = 2.0,
} = {}) => {
  const weights = RL_FEATURE_NAMES.map(name => {
    if (name === 'heuristic_candidate') return heuristicCandidateWeight;
    if (name === 'penalty_abs') return -0.05;
    if (name === 'creates_void') return 0.03;
    return 0;
  });
  return {
    kind: 'residual-linear-card-policy',
    version: 1,
    trained: true,
    candidateMode,
    featureNames: [...RL_FEATURE_NAMES],
    weights,
    metadata: {
      source: 'initial-residual-prior',
    },
  };
};

export const normalizeRlModel = (model = RL_POLICY) => {
  if (!model || model.kind !== 'residual-linear-card-policy') return null;
  if (!Array.isArray(model.weights)) return null;

  const byName = new Map();
  if (Array.isArray(model.featureNames) && model.featureNames.length === model.weights.length) {
    for (let i = 0; i < model.featureNames.length; i++) {
      byName.set(model.featureNames[i], Number(model.weights[i]) || 0);
    }
    return {
      ...model,
      candidateMode: model.candidateMode === 'legal' ? 'legal' : 'heuristic',
      weights: RL_FEATURE_NAMES.map(name => byName.get(name) ?? 0),
      featureNames: [...RL_FEATURE_NAMES],
    };
  }

  if (model.weights.length === RL_FEATURE_NAMES.length) {
    return {
      ...model,
      candidateMode: model.candidateMode === 'legal' ? 'legal' : 'heuristic',
      weights: model.weights.map(x => Number(x) || 0),
      featureNames: [...RL_FEATURE_NAMES],
    };
  }

  return null;
};

export const encodeRlCardFeatures = (gs, player, card, decision = null) => {
  const hand = gs?.hands?.[player] ?? [];
  const recommendation = decision ?? recommendHeuristicCards(gs, player);
  const heuristicCards = recommendation?.cards ?? [];
  const heuristicCandidate = heuristicCards.some(c => sameCard(c, card));
  const rule = recommendation?.rule ?? 'normal_follow';
  const ruleSet = new Set(RL_RULES.map(r => `rule:${r}`));
  const featureByName = new Map();

  const leadSuit = gs?.leadSuit ?? null;
  const trickLength = gs?.trick?.length ?? 0;
  const isLeading = !leadSuit || trickLength === 0;
  const countBefore = suitCount(hand, card.s);
  const countAfter = hand.filter(c => c.s === card.s && !sameCard(c, card)).length;
  const lowerSameSuit = hand.filter(c => c.s === card.s && c.v < card.v).length;
  const higherSameSuit = hand.filter(c => c.s === card.s && c.v > card.v).length;
  const knownVoids = gs?.knownVoids ?? [];
  const suitIndex = PY_SUITS.indexOf(card.s);
  const opponents = [1, 2, 3].map(offset => (player + offset) % 4);
  const futurePlayers = Array.from({ length: Math.max(0, 3 - trickLength) }, (_, i) => (player + i + 1) % 4);
  const knownVoidOpponents = opponents.filter(p => knownVoids[p]?.[suitIndex]).length;
  const futureKnownVoids = futurePlayers.filter(p => knownVoids[p]?.[suitIndex]).length;
  const unseenPenalty = unseenPenaltyCards(gs);
  const scores = publicScores(gs);
  const ownScore = Number(scores[player] || 0);
  const otherScores = scores.filter((_, i) => i !== player).map(Number);
  const bestOther = otherScores.length ? Math.max(...otherScores) : ownScore;
  const avgOther = otherScores.length
    ? otherScores.reduce((sum, score) => sum + score, 0) / otherScores.length
    : ownScore;
  const lowSpadeGuardsAfter = hand.filter(c =>
    c.s === 'S' && c.v < 12 && !sameCard(c, card)
  ).length;
  const highSpadesHeld = hand.filter(c => c.s === 'S' && c.v > 12).length;
  const currentNet = currentTrickNet(gs);

  featureByName.set('bias', 1);
  featureByName.set('heuristic_candidate', bool(heuristicCandidate));
  featureByName.set('heuristic_singleton', bool(heuristicCards.length === 1 && heuristicCandidate));
  featureByName.set('heuristic_candidate_count', norm(heuristicCards.length, 13));
  featureByName.set('rank_high', norm(card.v - 2, 12));
  featureByName.set('rank_low', norm(14 - card.v, 12));
  featureByName.set('penalty_abs', norm(Math.max(0, -cardPts(card)), 35));
  featureByName.set('point_value', norm(cardPts(card), 35));
  featureByName.set('is_heart', bool(card.s === 'H'));
  featureByName.set('is_spade', bool(card.s === 'S'));
  featureByName.set('is_club', bool(card.s === 'C'));
  featureByName.set('is_diamond', bool(card.s === 'D'));
  featureByName.set('is_minor', bool(card.s === 'C' || card.s === 'D'));
  featureByName.set('is_queen_spades', bool(sameCard(card, QUEEN_SPADES)));
  featureByName.set('is_high_heart', bool(card.s === 'H' && card.v >= 11));
  featureByName.set('is_small_heart', bool(card.s === 'H' && card.v <= 5));
  featureByName.set('is_low_spade', bool(card.s === 'S' && card.v < 12));
  featureByName.set('is_high_spade', bool(card.s === 'S' && card.v > 12));
  featureByName.set('is_ace', bool(card.v === 14));
  featureByName.set('is_king', bool(card.v === 13));
  featureByName.set('is_queen', bool(card.v === 12));
  featureByName.set('is_jack', bool(card.v === 11));
  featureByName.set('is_leading', bool(isLeading));
  featureByName.set('follow_pos_2', bool(!isLeading && trickLength === 1));
  featureByName.set('follow_pos_3', bool(!isLeading && trickLength === 2));
  featureByName.set('follow_pos_4', bool(!isLeading && trickLength === 3));
  featureByName.set('last_to_act', bool(trickLength === 3));
  featureByName.set('trick_net_before', norm(currentNet, 60));
  featureByName.set('current_trick_negative', bool(currentNet < 0));
  featureByName.set('beats_current_trick', bool(beatsCurrentTrick(card, gs)));
  featureByName.set('loses_current_trick', bool(losesCurrentTrick(card, gs)));
  featureByName.set('creates_void', bool(countAfter === 0));
  featureByName.set('suit_count_before', norm(countBefore, 13));
  featureByName.set('suit_count_after', norm(countAfter, 12));
  featureByName.set('lower_own_same_suit', norm(lowerSameSuit, 12));
  featureByName.set('higher_own_same_suit', norm(higherSameSuit, 12));
  featureByName.set('known_void_opponents_suit', norm(knownVoidOpponents, 3));
  featureByName.set('future_known_voids_suit', norm(futureKnownVoids, 3));
  featureByName.set('queen_spades_in_hand', bool(queenSpadesInHand(gs, player)));
  featureByName.set('queen_spades_played', bool(queenSpadesPlayed(gs)));
  featureByName.set('queen_spades_in_trick', bool(queenSpadesInTrick(gs)));
  featureByName.set('queen_spades_live_outside', bool(queenSpadesLiveOutside(gs, player)));
  featureByName.set('low_spade_guards_after', norm(lowSpadeGuardsAfter, 12));
  featureByName.set('high_spades_held', norm(highSpadesHeld, 2));
  featureByName.set('remaining_penalty_count', norm(unseenPenalty.length, NEGATIVE_CARDS.length));
  featureByName.set('remaining_penalty_abs', norm(
    unseenPenalty.reduce((sum, c) => sum + Math.max(0, -cardPts(c)), 0),
    139
  ));
  featureByName.set('tricks_played', norm(gs?.tricksPlayed ?? 0, 13));
  featureByName.set('round_score_self', norm(gs?.roundPts?.[player] ?? 0, 100));
  featureByName.set('score_margin_best', norm(ownScore - bestOther, 160));
  featureByName.set('score_margin_avg', norm(ownScore - avgOther, 160));

  for (const name of ruleSet) featureByName.set(name, name === `rule:${rule}` ? 1 : 0);

  return RL_FEATURE_NAMES.map(name => featureByName.get(name) ?? 0);
};

export const scoreRlCard = (gs, player, card, {
  model = RL_POLICY,
  decision = null,
} = {}) => {
  const normalized = normalizeRlModel(model);
  if (!normalized) return 0;
  const features = encodeRlCardFeatures(gs, player, card, decision);
  return dot(normalized.weights, features);
};

export const chooseRlCardFromModel = (gs, player, {
  model = RL_POLICY,
  rng = Math.random,
  exploration = 0,
} = {}) => {
  const normalized = normalizeRlModel(model);
  if (!normalized || normalized.trained === false) return chooseHeuristicCard(gs, player);

  const legal = validCardsFor(gs, player);
  if (!legal.length) return null;
  if (exploration > 0 && rng() < exploration) {
    return legal[Math.floor(rng() * legal.length)] ?? legal[0];
  }

  const decision = recommendHeuristicCards(gs, player);
  const heuristicCards = decision?.cards ?? [];
  const pool = normalized.candidateMode === 'legal'
    ? legal
    : heuristicCards.filter(c => legal.some(x => sameCard(x, c)));
  const candidates = pool.length ? pool : legal;

  let best = null;
  for (const card of candidates) {
    const score = scoreRlCard(gs, player, card, { model: normalized, decision }) + stableCardTie(card);
    if (!best || score > best.score) best = { card, score };
  }

  return best?.card ?? candidates[0] ?? null;
};

export const chooseRlCard = (gs, player) => chooseRlCardFromModel(gs, player, { model: RL_POLICY });
export const rlQuetschPick = heuristicQuetschPick;

export const chooseSeededHeuristicCard = (gs, player, rng = Math.random) => {
  const decision = recommendHeuristicCards(gs, player);
  const cards = decision?.cards ?? [];
  if (!cards.length) return chooseHeuristicCard(gs, player);
  return cards[Math.floor(rng() * cards.length)] ?? cards[0];
};

export const allCards = () => PY_SUITS.flatMap(s => VALS.map(v => ({ s, v })));

