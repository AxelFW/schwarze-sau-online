#!/usr/bin/env node
import { RL_POLICY } from '../shared/game/rlPolicyData.js';
import {
  buildOneRlVsHeuristicPolicies,
  isSeatWinner,
  parseArgs,
  relativeSeatMargin,
  runSimulatedMatch,
} from './rl-sim.js';

const args = parseArgs(process.argv);
const matches = Number(args.get('matches') ?? 200);
const rounds = Number(args.get('rounds') ?? 8);
const seed = Number(args.get('seed') ?? 777001);

const margins = [];
const seatMargins = [[], [], [], []];
const seatWins = [0, 0, 0, 0];
let wins = 0;
const failures = [];

for (let m = 0; m < matches; m++) {
  const rlSeat = m % 4;
  try {
    const match = runSimulatedMatch({
      rounds,
      seed: seed + m * 9973,
      policies: buildOneRlVsHeuristicPolicies(RL_POLICY, rlSeat),
    });
    const margin = relativeSeatMargin(match.scores, rlSeat);
    margins.push(margin);
    seatMargins[rlSeat].push(margin);
    if (isSeatWinner(match.scores, rlSeat)) {
      wins += 1;
      seatWins[rlSeat] += 1;
    }
  } catch (error) {
    failures.push({ match: m + 1, error: error.message });
    break;
  }
}

const completed = matches - failures.length;
const avg = values => values.length
  ? values.reduce((sum, x) => sum + x, 0) / values.length
  : 0;
const variance = values => {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1);
};
const stderr = margins.length ? Math.sqrt(variance(margins) / margins.length) : 0;

const result = {
  completedMatches: completed,
  requestedMatches: matches,
  roundsPerMatch: rounds,
  seed,
  model: {
    trained: RL_POLICY.trained === true,
    candidateMode: RL_POLICY.candidateMode,
    trainedAt: RL_POLICY.metadata?.trainedAt ?? null,
  },
  averageMarginVsHeuristic: Number(avg(margins).toFixed(3)),
  marginStdErr: Number(stderr.toFixed(3)),
  winRate: Number((wins / Math.max(1, completed)).toFixed(4)),
  seatBreakdown: seatMargins.map((values, seat) => ({
    seat,
    matches: values.length,
    averageMargin: Number(avg(values).toFixed(3)),
    wins: seatWins[seat],
    winRate: Number((seatWins[seat] / Math.max(1, values.length)).toFixed(4)),
  })),
  strongerThanHeuristic: avg(margins) > Math.max(0.25, 1.96 * stderr),
  failures,
};

console.log(JSON.stringify(result, null, 2));
if (failures.length) process.exit(1);
if (args.get('require-stronger') && !result.strongerThanHeuristic) process.exit(2);

