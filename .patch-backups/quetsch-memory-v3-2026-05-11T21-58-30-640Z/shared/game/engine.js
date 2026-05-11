import {
  createDeck, shuffle, sortHand, suitIdx, cardKey, cardPts, isPenalty,
  trickWinner, getValidIdxs,
} from './cards.js';
import { heuristicQuetschPick, chooseHeuristicCard } from './heuristicBot.js';

export const dealRound = (dealer, rng = Math.random) => {
  const deck = shuffle(createDeck(), rng);
  return {
    dealer,
    hands: [0, 1, 2, 3].map(i => sortHand(deck.slice(i * 13, (i + 1) * 13))),
    quetschSelections: [[], [], [], []],
    currentPlayer: (dealer + 1) % 4,
    trick: [],
    leadSuit: null,
    tricksPlayed: 0,
    roundPts: [0, 0, 0, 0],
    tricksWon: [0, 0, 0, 0],
    penaltyPlayed: [],
    negativeTrickSuits: [],
    trickHistory: [],
    quetschPassedLeft: [[], [], [], []],
    knownVoids: [0, 1, 2, 3].map(() => [false, false, false, false]), // C/D/H/S
    spadeBeliefs: {
      probableNoLowSpades: [false, false, false, false],
      suspectedQueenHolder: [false, false, false, false],
    },
  };
};

export const applyCard = (prevGs, player, card) => {
  const hand = prevGs.hands[player];
  const cardIdx = hand.findIndex(c => c.s === card.s && c.v === card.v);
  if (cardIdx === -1) return null;

  const newHands = prevGs.hands.map((h, i) => i === player ? h.filter((_, ci) => ci !== cardIdx) : h);
  const newTrick = [...prevGs.trick, { player, card }];
  const newLeadSuit = prevGs.trick.length === 0 ? card.s : prevGs.leadSuit;
  const newKnownVoids = (prevGs.knownVoids ?? [0, 1, 2, 3].map(() => [false, false, false, false])).map(row => [...row]);
  const prevSpadeBeliefs = prevGs.spadeBeliefs ?? {};
  const newSpadeBeliefs = {
    probableNoLowSpades: [false, false, false, false].map((fallback, i) =>
      Boolean(prevSpadeBeliefs.probableNoLowSpades?.[i] ?? fallback)
    ),
    suspectedQueenHolder: [false, false, false, false].map((fallback, i) =>
      Boolean(prevSpadeBeliefs.suspectedQueenHolder?.[i] ?? fallback)
    ),
  };

  if (prevGs.leadSuit && card.s !== prevGs.leadSuit) {
    newKnownVoids[player][suitIdx(prevGs.leadSuit)] = true;
  }

  // Bot-belief support: infer spade-specific soft beliefs from public play.
  // 1) If a player follows a spade trick with ♠Q before any ♠K/♠A is already
  //    in that trick, they probably lacked harmless low spade shields.
  if (prevGs.leadSuit === 'S' && prevGs.trick.length > 0 && card.s === 'S' && card.v === 12) {
    const highSpadeAlreadyInTrick = prevGs.trick.some(x => x.card?.s === 'S' && (x.card.v === 13 || x.card.v === 14));
    if (!highSpadeAlreadyInTrick) newSpadeBeliefs.probableNoLowSpades[player] = true;
  }

  // 2) If a player voluntarily uses ♠K/♠A before last position while ♠Q is
  //    still live, treat that player as a likely ♠Q-holder.
  const queenSpadesAlreadySeen = [...(prevGs.trickHistory ?? []), ...(prevGs.trick ?? []).map(x => x.card)]
    .some(c => c?.s === 'S' && c?.v === 12);
  if (newLeadSuit === 'S' && card.s === 'S' && (card.v === 13 || card.v === 14) && newTrick.length <= 3 && !queenSpadesAlreadySeen) {
    newSpadeBeliefs.suspectedQueenHolder[player] = true;
  }

  if (newTrick.length === 4) {
    const winner = trickWinner(newTrick);
    const net = newTrick.reduce((sum, x) => sum + cardPts(x.card), 0) + 10;
    const tricksPlayed = prevGs.tricksPlayed + 1;
    return {
      ...prevGs,
      hands: newHands,
      trick: newTrick,
      leadSuit: newLeadSuit,
      tricksPlayed,
      roundPts: prevGs.roundPts.map((v, i) => i === winner ? v + net : v),
      tricksWon: prevGs.tricksWon.map((v, i) => i === winner ? v + 1 : v),
      penaltyPlayed: [...prevGs.penaltyPlayed, ...newTrick.map(x => x.card).filter(isPenalty)],
      negativeTrickSuits: net < 0
        ? [...new Set([...(prevGs.negativeTrickSuits ?? []), newLeadSuit])]
        : [...(prevGs.negativeTrickSuits ?? [])],
      trickHistory: [...prevGs.trickHistory, ...newTrick.map(x => x.card)],
      knownVoids: newKnownVoids,
      spadeBeliefs: newSpadeBeliefs,
      currentPlayer: winner,
      _trickJustFinished: true,
      _trickWinner: winner,
      _trickNet: net,
      _trickCards: newTrick,
    };
  }

  return {
    ...prevGs,
    hands: newHands,
    trick: newTrick,
    leadSuit: newLeadSuit,
    knownVoids: newKnownVoids,
    spadeBeliefs: newSpadeBeliefs,
    currentPlayer: (player + 1) % 4,
    _trickJustFinished: false,
  };
};

export const clearFinishedTrick = gs => {
  if (!gs?._trickJustFinished) return gs;
  return {
    ...gs,
    trick: [],
    leadSuit: null,
    currentPlayer: gs._trickWinner,
    _trickJustFinished: false,
  };
};

export const applyQuetschSelections = (gs, selections) => {
  const newHands = gs.hands.map(h => [...h]);
  const toAdd = [[], [], [], []];

  for (let i = 0; i < 4; i++) {
    for (const card of selections[i]) {
      toAdd[(i + 1) % 4].push(card);
      const idx = newHands[i].findIndex(c => c.s === card.s && c.v === card.v);
      if (idx >= 0) newHands[i].splice(idx, 1);
    }
  }

  for (let i = 0; i < 4; i++) {
    newHands[i] = sortHand([...newHands[i], ...toAdd[i]]);
  }

  return {
    ...gs,
    hands: newHands,
    quetschSelections: [[], [], [], []],
    quetschPassedLeft: selections.map(sel => [...sel]),
  };
};

export const autoApplyAllQuetsch = (gs, pick = heuristicQuetschPick) => {
  const selections = gs.hands.map(hand => pick(hand));
  return applyQuetschSelections(gs, selections);
};

export const getValidCards = (gs, player) => {
  const hand = gs.hands[player];
  return getValidIdxs(hand, gs.leadSuit).map(i => hand[i]);
};

export const playOneHeuristicCard = (gs, player = gs.currentPlayer, choose = chooseHeuristicCard) => {
  const legal = getValidCards(gs, player);
  const card = choose(gs, player);
  if (!card || !legal.some(c => c.s === card.s && c.v === card.v)) {
    throw new Error(`Heuristic selected illegal card for player ${player}: ${JSON.stringify(card)}; lead=${gs.leadSuit}; trick=${JSON.stringify(gs.trick)}; hand=${JSON.stringify(gs.hands[player])}; valid=${JSON.stringify(legal)}; tricksPlayed=${gs.tricksPlayed}`);
  }
  const next = applyCard(gs, player, card);
  if (!next) throw new Error(`Could not apply selected card for player ${player}: ${JSON.stringify(card)}`);
  return next;
};

export const playFullHeuristicRound = (dealer = 0, { rng = Math.random, choose = chooseHeuristicCard } = {}) => {
  let gs = autoApplyAllQuetsch(dealRound(dealer, rng));
  let safety = 0;
  while (gs.tricksPlayed < 13) {
    const player = gs.currentPlayer;
    gs = playOneHeuristicCard(gs, player, choose);
    if (gs._trickJustFinished && gs.tricksPlayed < 13) {
      gs = clearFinishedTrick(gs);
    }
    safety += 1;
    if (safety > 60) throw new Error('Round simulation exceeded safety limit.');
  }
  return gs;
};

export const runLocalHeuristicMatch = ({ rounds = 8, rng = Math.random, choose = chooseHeuristicCard } = {}) => {
  let dealer = Math.floor(rng() * 4);
  const scores = [0, 0, 0, 0];
  const roundsOut = [];

  for (let round = 1; round <= rounds; round++) {
    const gs = playFullHeuristicRound(dealer, { rng, choose });
    for (let i = 0; i < 4; i++) scores[i] += gs.roundPts[i];
    roundsOut.push({ round, dealer, roundPts: [...gs.roundPts], totalScores: [...scores], tricksWon: [...gs.tricksWon] });
    dealer = (dealer + 1) % 4;
  }

  return { rounds, scores, roundsOut };
};

export const summarizeMatch = match => {
  const ranking = match.scores
    .map((score, player) => ({ player, score }))
    .sort((a, b) => b.score - a.score || a.player - b.player);
  return { scores: match.scores, ranking };
};
