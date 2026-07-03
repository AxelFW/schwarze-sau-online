#!/usr/bin/env node
import os from 'os';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { RL_POLICY } from '../shared/game/rlPolicyData.js';
import { NON_RESIDUAL_RL_POLICY } from '../shared/game/nonResidualRlPolicyData.js';
import {
  buildOneChallengerVsBaselinePolicies,
  isSeatWinner,
  parseArgs,
  relativeSeatMargin,
  runSimulatedMatch,
} from './rl-sim.js';

const evaluateRange = ({ start, matches, rounds, seed }) => {
  const margins = [];
  const seatMargins = [[], [], [], []];
  const seatWins = [0, 0, 0, 0];
  const failures = [];
  let wins = 0;

  for (let offset = 0; offset < matches; offset++) {
    const m = start + offset;
    const challengerSeat = m % 4;
    try {
      const match = runSimulatedMatch({
        rounds,
        seed: seed + m * 9973,
        policies: buildOneChallengerVsBaselinePolicies(
          NON_RESIDUAL_RL_POLICY,
          RL_POLICY,
          challengerSeat
        ),
      });
      const margin = relativeSeatMargin(match.scores, challengerSeat);
      margins.push(margin);
      seatMargins[challengerSeat].push(margin);
      if (isSeatWinner(match.scores, challengerSeat)) {
        wins += 1;
        seatWins[challengerSeat] += 1;
      }
    } catch (error) {
      failures.push({ match: m + 1, error: error.message });
      break;
    }
  }

  return {
    margins,
    seatMargins,
    seatWins,
    wins,
    failures,
  };
};

const splitMatchRanges = (matches, workers) => {
  const ranges = [];
  const size = Math.ceil(matches / workers);
  for (let start = 0; start < matches; start += size) {
    ranges.push({ start, matches: Math.min(size, matches - start) });
  }
  return ranges;
};

const mergeRangeResults = results => {
  const merged = {
    margins: [],
    seatMargins: [[], [], [], []],
    seatWins: [0, 0, 0, 0],
    wins: 0,
    failures: [],
  };
  for (const result of results) {
    merged.margins.push(...result.margins);
    for (let seat = 0; seat < 4; seat++) {
      merged.seatMargins[seat].push(...result.seatMargins[seat]);
      merged.seatWins[seat] += result.seatWins[seat];
    }
    merged.wins += result.wins;
    merged.failures.push(...result.failures);
  }
  return merged;
};

const evaluateParallel = async ({ matches, rounds, seed, workers }) => {
  const workerCount = Math.max(1, Math.min(Number(workers || 1), matches));
  if (workerCount <= 1) return evaluateRange({ start: 0, matches, rounds, seed });

  const ranges = splitMatchRanges(matches, workerCount);
  const workerUrl = new URL(import.meta.url);
  const results = await Promise.all(ranges.map(range => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        mode: 'evaluateRange',
        options: { ...range, rounds, seed },
      },
    });
    worker.on('message', message => {
      if (message?.ok) resolve(message.result);
      else reject(new Error(message?.error || 'Non-residual evaluator worker failed.'));
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Non-residual evaluator worker exited with code ${code}.`));
    });
  })));

  return mergeRangeResults(results);
};

const avg = values => values.length
  ? values.reduce((sum, x) => sum + x, 0) / values.length
  : 0;

const variance = values => {
  if (values.length < 2) return 0;
  const mean = avg(values);
  return values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (values.length - 1);
};

if (!isMainThread) {
  try {
    if (workerData?.mode !== 'evaluateRange') throw new Error('Unknown evaluator worker mode.');
    parentPort.postMessage({ ok: true, result: evaluateRange(workerData.options) });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
}

const main = async () => {
  const args = parseArgs(process.argv);
  const availableWorkers = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  const matches = Number(args.get('matches') ?? 500);
  const rounds = Number(args.get('rounds') ?? 8);
  const seed = Number(args.get('seed') ?? 991001);
  const workers = Math.max(1, Math.min(Number(args.get('workers') ?? availableWorkers), matches));
  const requireStronger = Boolean(args.get('require-stronger'));

  const {
    margins,
    seatMargins,
    seatWins,
    wins,
    failures,
  } = await evaluateParallel({ matches, rounds, seed, workers });

  const completed = margins.length;
  const stderr = margins.length ? Math.sqrt(variance(margins) / margins.length) : 0;
  const strongerThanResidual = avg(margins) > Math.max(0.25, 1.96 * stderr);

  const result = {
    completedMatches: completed,
    requestedMatches: matches,
    roundsPerMatch: rounds,
    seed,
    workers,
    challenger: {
      trained: NON_RESIDUAL_RL_POLICY.trained === true,
      candidateMode: NON_RESIDUAL_RL_POLICY.candidateMode,
      trainedAt: NON_RESIDUAL_RL_POLICY.metadata?.trainedAt ?? null,
    },
    baseline: {
      trained: RL_POLICY.trained === true,
      candidateMode: RL_POLICY.candidateMode,
      trainedAt: RL_POLICY.metadata?.trainedAt ?? null,
    },
    averageMarginVsResidual: Number(avg(margins).toFixed(3)),
    marginStdErr: Number(stderr.toFixed(3)),
    winRate: Number((wins / Math.max(1, completed)).toFixed(4)),
    seatBreakdown: seatMargins.map((values, seat) => ({
      seat,
      matches: values.length,
      averageMargin: Number(avg(values).toFixed(3)),
      wins: seatWins[seat],
      winRate: Number((seatWins[seat] / Math.max(1, values.length)).toFixed(4)),
    })),
    strongerThanResidual,
    failures,
  };

  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exit(1);
  if (requireStronger && !strongerThanResidual) process.exit(2);
};

if (isMainThread) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
