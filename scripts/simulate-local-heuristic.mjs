#!/usr/bin/env node
import { makeSeededRng } from '../shared/game/cards.js';
import { runLocalHeuristicMatch, summarizeMatch } from '../shared/game/engine.js';

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const token = process.argv[i];
  if (token.startsWith('--')) {
    const key = token.slice(2);
    const value = process.argv[i + 1]?.startsWith('--') ? true : process.argv[++i];
    args.set(key, value);
  }
}

const matches = Number(args.get('matches') ?? 100);
const rounds = Number(args.get('rounds') ?? 8);
const seed = Number(args.get('seed') ?? 12345);
const rng = makeSeededRng(seed);

const aggregateScores = [0, 0, 0, 0];
const wins = [0, 0, 0, 0];
const failures = [];

for (let m = 1; m <= matches; m++) {
  try {
    const match = runLocalHeuristicMatch({ rounds, rng });
    const summary = summarizeMatch(match);
    for (let i = 0; i < 4; i++) aggregateScores[i] += match.scores[i];
    wins[summary.ranking[0].player] += 1;
  } catch (error) {
    failures.push({ match: m, error: error.message });
    break;
  }
}

const completed = matches - failures.length;
const averageScores = aggregateScores.map(s => completed ? Number((s / completed).toFixed(2)) : 0);

console.log(JSON.stringify({
  completedMatches: completed,
  requestedMatches: matches,
  roundsPerMatch: rounds,
  seed,
  averageScores,
  wins,
  failures,
}, null, 2));

if (failures.length) process.exit(1);
