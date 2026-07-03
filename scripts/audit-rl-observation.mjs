#!/usr/bin/env node
import { dealRound, applyQuetschSelections, applyCard, clearFinishedTrick } from '../shared/game/engine.js';
import { heuristicQuetschPick } from '../shared/game/heuristicBot.js';
import { chooseRlCardFromModel, chooseSeededHeuristicCard } from '../shared/game/rlBot.js';
import { RL_POLICY } from '../shared/game/rlPolicyData.js';
import { NON_RESIDUAL_RL_POLICY } from '../shared/game/nonResidualRlPolicyData.js';
import { cardKey, makeSeededRng, sameCard } from '../shared/game/cards.js';
import { gameStateForDecision, parseArgs } from './rl-sim.js';

const args = parseArgs(process.argv);
const rounds = Number(args.get('rounds') ?? 400);
const seed = Number(args.get('seed') ?? 515151);
const policyName = String(args.get('policy') ?? 'nonresidual');
const model = policyName === 'residual' ? RL_POLICY : NON_RESIDUAL_RL_POLICY;
const rng = makeSeededRng(seed);
const scores = [0, 0, 0, 0];

const redactOpponentHands = (gs, player) => ({
  ...gs,
  hands: gs.hands.map((hand, seat) => seat === player
    ? hand
    : Array.from({ length: hand.length }, () => ({ s: 'X', v: -1 }))
  ),
});

const withSeededMathRandom = (seedValue, fn) => {
  const originalRandom = Math.random;
  Math.random = makeSeededRng(seedValue);
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
};

const failures = [];
let decisions = 0;

for (let round = 0; round < rounds; round++) {
  let gs = dealRound(round % 4, rng);
  let dgs = gameStateForDecision(gs, scores);
  gs = applyQuetschSelections(gs, gs.hands.map((hand, player) =>
    heuristicQuetschPick(hand, dgs, player)
  ));

  let safety = 0;
  while (gs.tricksPlayed < 13) {
    const player = gs.currentPlayer;
    dgs = gameStateForDecision(gs, scores);
    const decisionSeed = seed + decisions * 7919;
    const fullChoice = withSeededMathRandom(decisionSeed, () =>
      chooseRlCardFromModel(dgs, player, { model, rng })
    );
    const redactedChoice = withSeededMathRandom(decisionSeed, () =>
      chooseRlCardFromModel(redactOpponentHands(dgs, player), player, { model, rng })
    );
    decisions += 1;

    if (!sameCard(fullChoice, redactedChoice)) {
      failures.push({
        round,
        trick: gs.tricksPlayed + 1,
        player,
        fullChoice: fullChoice ? cardKey(fullChoice) : null,
        redactedChoice: redactedChoice ? cardKey(redactedChoice) : null,
      });
      break;
    }

    const card = chooseSeededHeuristicCard(dgs, player, rng);
    gs = applyCard(gs, player, card);
    if (gs._trickJustFinished && gs.tricksPlayed < 13) gs = clearFinishedTrick(gs);
    if (++safety > 60) throw new Error('Round simulation exceeded safety limit.');
  }

  if (failures.length) break;
}

const result = {
  policy: policyName,
  rounds,
  seed,
  decisions,
  hiddenOpponentHandIndependent: failures.length === 0,
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
