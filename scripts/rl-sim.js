import {
  applyCard,
  applyQuetschSelections,
  clearFinishedTrick,
  dealRound,
  getValidCards,
} from '../shared/game/engine.js';
import { heuristicQuetschPick } from '../shared/game/heuristicBot.js';
import { chooseSeededHeuristicCard, chooseRlCardFromModel } from '../shared/game/rlBot.js';
import { makeSeededRng, sameCard } from '../shared/game/cards.js';

export const parseArgs = argv => {
  const args = new Map();
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    args.set(key, !next || next.startsWith('--') ? true : argv[++i]);
  }
  return args;
};

export const gameStateForDecision = (gs, scores) => ({
  ...gs,
  scores: [...scores],
  roundScores: [...(gs.roundPts ?? [0, 0, 0, 0])],
  projectedScores: scores.map((score, i) => score + (gs.roundPts?.[i] || 0)),
  scoreHigherIsBetter: true,
  botTargetingProfiles: ['normal', 'normal', 'normal', 'normal'],
});

export const makeHeuristicPolicy = () => ({
  name: 'heuristic',
  chooseCard: (gs, player, rng) => chooseSeededHeuristicCard(gs, player, rng),
  chooseQuetsch: (hand, gs, player) => heuristicQuetschPick(hand, gs, player),
});

export const makeRlPolicy = (model, {
  exploration = 0,
  name = 'rl',
} = {}) => ({
  name,
  chooseCard: (gs, player, rng) => chooseRlCardFromModel(gs, player, { model, rng, exploration }),
  chooseQuetsch: (hand, gs, player) => heuristicQuetschPick(hand, gs, player),
});

const assertLegalCard = (gs, player, card, policyName) => {
  const legal = getValidCards(gs, player);
  if (!card || !legal.some(c => sameCard(c, card))) {
    throw new Error(`${policyName} selected illegal card for player ${player}: ${JSON.stringify(card)}; legal=${JSON.stringify(legal)}`);
  }
};

export const runSimulatedMatch = ({
  rounds = 8,
  seed = 12345,
  policies,
  firstDealer = null,
} = {}) => {
  const rng = typeof seed === 'function' ? seed : makeSeededRng(seed);
  const scores = [0, 0, 0, 0];
  const roundSummaries = [];
  let dealer = Number.isInteger(firstDealer) ? firstDealer : Math.floor(rng() * 4);

  for (let round = 1; round <= rounds; round++) {
    let gs = dealRound(dealer, rng);
    const quetschGs = gameStateForDecision(gs, scores);
    const selections = gs.hands.map((hand, player) =>
      policies[player].chooseQuetsch(hand, quetschGs, player, rng)
    );
    gs = applyQuetschSelections(gs, selections);

    let safety = 0;
    while (gs.tricksPlayed < 13) {
      const player = gs.currentPlayer;
      const decisionGs = gameStateForDecision(gs, scores);
      const card = policies[player].chooseCard(decisionGs, player, rng);
      assertLegalCard(gs, player, card, policies[player].name);
      gs = applyCard(gs, player, card);
      if (!gs) throw new Error(`Could not apply card for player ${player}: ${JSON.stringify(card)}`);
      if (gs._trickJustFinished && gs.tricksPlayed < 13) gs = clearFinishedTrick(gs);
      safety += 1;
      if (safety > 60) throw new Error('Round simulation exceeded safety limit.');
    }

    for (let i = 0; i < 4; i++) scores[i] += gs.roundPts[i];
    roundSummaries.push({
      round,
      dealer,
      roundPts: [...gs.roundPts],
      totalScores: [...scores],
      tricksWon: [...gs.tricksWon],
    });
    dealer = (dealer + 1) % 4;
  }

  return { rounds, scores, roundSummaries };
};

export const relativeSeatMargin = (scores, seat) => {
  const own = scores[seat] || 0;
  const others = scores.filter((_, i) => i !== seat);
  const avgOther = others.reduce((sum, score) => sum + score, 0) / Math.max(1, others.length);
  return own - avgOther;
};

export const isSeatWinner = (scores, seat) => {
  const best = Math.max(...scores);
  return scores[seat] === best;
};

export const buildOneRlVsHeuristicPolicies = (model, rlSeat, options = {}) =>
  [0, 1, 2, 3].map(seat => seat === rlSeat ? makeRlPolicy(model, options) : makeHeuristicPolicy());

