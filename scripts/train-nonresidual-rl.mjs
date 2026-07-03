#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { RL_POLICY } from '../shared/game/rlPolicyData.js';
import { NON_RESIDUAL_RL_POLICY } from '../shared/game/nonResidualRlPolicyData.js';
import {
  RL_FEATURE_NAMES,
  makeInitialRlModel,
  normalizeRlModel,
} from '../shared/game/rlBot.js';
import { makeSeededRng } from '../shared/game/cards.js';
import {
  buildOneChallengerVsBaselinePolicies,
  isSeatWinner,
  parseArgs,
  relativeSeatMargin,
  runSimulatedMatch,
} from './rl-sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const randn = rng => {
  const u = Math.max(1e-12, rng());
  const v = Math.max(1e-12, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

const meanVectors = vectors => {
  const out = Array.from({ length: vectors[0]?.length ?? 0 }, () => 0);
  for (const vector of vectors) {
    for (let i = 0; i < out.length; i++) out[i] += vector[i] || 0;
  }
  return out.map(x => x / Math.max(1, vectors.length));
};

const clampWeights = weights => weights.map(w => Math.max(-12, Math.min(12, Number(w) || 0)));
const featureIndex = name => RL_FEATURE_NAMES.indexOf(name);

const makeLegalModel = weights => ({
  kind: 'residual-linear-card-policy',
  version: 1,
  trained: true,
  candidateMode: 'legal',
  featureNames: [...RL_FEATURE_NAMES],
  weights: clampWeights(weights),
  metadata: {
    source: 'non-residual-training-evaluation',
  },
});

const initialWeights = ({ heuristicPrior = 8, resumeCurrent = false } = {}) => {
  const current = resumeCurrent ? normalizeRlModel(NON_RESIDUAL_RL_POLICY) : null;
  if (current?.weights?.length === RL_FEATURE_NAMES.length) return [...current.weights];

  const residual = normalizeRlModel(RL_POLICY);
  const weights = residual?.weights?.length === RL_FEATURE_NAMES.length
    ? [...residual.weights]
    : makeInitialRlModel({ candidateMode: 'legal' }).weights;
  const heuristicCandidateIdx = featureIndex('heuristic_candidate');
  const heuristicSingletonIdx = featureIndex('heuristic_singleton');
  const notHeuristicIdx = featureIndex('not_heuristic_candidate');
  const notHeuristicPenaltyIdx = featureIndex('not_heuristic_penalty_abs');
  const notHeuristicQueenSpadesIdx = featureIndex('not_heuristic_is_queen_spades');
  const notHeuristicHighHeartIdx = featureIndex('not_heuristic_is_high_heart');
  const notHeuristicHighSpadeIdx = featureIndex('not_heuristic_is_high_spade');
  const notHeuristicBeatsIdx = featureIndex('not_heuristic_beats_current_trick');
  const notHeuristicNegativeTrickIdx = featureIndex('not_heuristic_current_trick_negative');
  if (heuristicCandidateIdx >= 0) weights[heuristicCandidateIdx] = heuristicPrior;
  if (heuristicSingletonIdx >= 0) weights[heuristicSingletonIdx] = Math.max(
    weights[heuristicSingletonIdx] ?? 0,
    heuristicPrior / 3
  );
  if (notHeuristicIdx >= 0) weights[notHeuristicIdx] = -heuristicPrior;
  if (notHeuristicPenaltyIdx >= 0) weights[notHeuristicPenaltyIdx] = -2.0;
  if (notHeuristicQueenSpadesIdx >= 0) weights[notHeuristicQueenSpadesIdx] = -4.0;
  if (notHeuristicHighHeartIdx >= 0) weights[notHeuristicHighHeartIdx] = -1.5;
  if (notHeuristicHighSpadeIdx >= 0) weights[notHeuristicHighSpadeIdx] = -1.2;
  if (notHeuristicBeatsIdx >= 0) weights[notHeuristicBeatsIdx] = -1.0;
  if (notHeuristicNegativeTrickIdx >= 0) weights[notHeuristicNegativeTrickIdx] = -1.0;
  return clampWeights(weights);
};

const evaluateWeights = (weights, {
  seed,
  matches,
  rounds,
  baselineModel = RL_POLICY,
  pairedBaseline = true,
  rawMarginWeight = 0.75,
  negativeRawMarginPenalty = 1.25,
  start = 0,
}) => {
  const model = makeLegalModel(weights);
  let marginSum = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  let wins = 0;
  let failures = 0;

  for (let m = 0; m < matches; m++) {
    const globalMatch = start + m;
    const challengerSeat = globalMatch % 4;
    const matchSeed = seed + globalMatch * 9973;
    try {
      const match = runSimulatedMatch({
        rounds,
        seed: matchSeed,
        policies: buildOneChallengerVsBaselinePolicies(model, baselineModel, challengerSeat),
      });
      const margin = relativeSeatMargin(match.scores, challengerSeat);
      marginSum += margin;
      if (pairedBaseline) {
        const baselineMatch = runSimulatedMatch({
          rounds,
          seed: matchSeed,
          policies: buildOneChallengerVsBaselinePolicies(baselineModel, baselineModel, challengerSeat),
        });
        deltaSum += margin - relativeSeatMargin(baselineMatch.scores, challengerSeat);
        deltaCount += 1;
      }
      if (isSeatWinner(match.scores, challengerSeat)) wins += 1;
    } catch (_error) {
      failures += 1;
      marginSum -= 1000;
      if (pairedBaseline) {
        deltaSum -= 1000;
        deltaCount += 1;
      }
    }
  }

  const avgMargin = marginSum / Math.max(1, matches);
  const avgDelta = deltaCount
    ? deltaSum / deltaCount
    : avgMargin;
  const rawMarginPenalty = avgMargin < 0 ? Math.abs(avgMargin) * negativeRawMarginPenalty : 0;
  return {
    fitness: avgDelta + rawMarginWeight * avgMargin - rawMarginPenalty - failures * 100,
    avgMargin,
    avgDelta,
    rawMarginWeight,
    negativeRawMarginPenalty,
    winRate: wins / Math.max(1, matches),
    failures,
  };
};

const evaluateWeightsRange = (weights, options) => {
  const result = evaluateWeights(weights, {
    ...options,
    matches: options.matches,
  });
  return {
    marginSum: result.avgMargin * options.matches,
    deltaSum: result.avgDelta * options.matches,
    deltaCount: options.pairedBaseline ? options.matches : 0,
    wins: result.winRate * options.matches,
    failures: result.failures,
    matches: options.matches,
  };
};

const scoreAggregates = (aggregates, {
  rawMarginWeight = 0.75,
  negativeRawMarginPenalty = 1.25,
}) => {
  const total = aggregates.reduce((out, aggregate) => ({
    marginSum: out.marginSum + aggregate.marginSum,
    deltaSum: out.deltaSum + aggregate.deltaSum,
    deltaCount: out.deltaCount + aggregate.deltaCount,
    wins: out.wins + aggregate.wins,
    failures: out.failures + aggregate.failures,
    matches: out.matches + aggregate.matches,
  }), {
    marginSum: 0,
    deltaSum: 0,
    deltaCount: 0,
    wins: 0,
    failures: 0,
    matches: 0,
  });
  const avgMargin = total.marginSum / Math.max(1, total.matches);
  const avgDelta = total.deltaCount ? total.deltaSum / total.deltaCount : avgMargin;
  const rawMarginPenalty = avgMargin < 0 ? Math.abs(avgMargin) * negativeRawMarginPenalty : 0;
  return {
    fitness: avgDelta + rawMarginWeight * avgMargin - rawMarginPenalty - total.failures * 100,
    avgMargin,
    avgDelta,
    rawMarginWeight,
    negativeRawMarginPenalty,
    winRate: total.wins / Math.max(1, total.matches),
    failures: total.failures,
  };
};

const splitMatchRanges = (matches, chunkCount) => {
  const chunks = [];
  const size = Math.ceil(matches / chunkCount);
  for (let start = 0; start < matches; start += size) {
    chunks.push({ start, matches: Math.min(size, matches - start) });
  }
  return chunks;
};

const evaluateWeightsParallel = async (weights, options) => {
  const workerCount = Math.max(1, Math.min(Number(options.workers || 1), options.matches));
  if (workerCount <= 1) return evaluateWeights(weights, options);

  const workerUrl = new URL(import.meta.url);
  const ranges = splitMatchRanges(options.matches, workerCount);
  const aggregates = await Promise.all(ranges.map((range, workerIndex) => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        mode: 'evaluateWeightsRange',
        weights,
        options: {
          ...options,
          ...range,
        },
        workerIndex,
      },
    });
    worker.on('message', message => {
      if (message?.ok) resolve(message.aggregate);
      else reject(new Error(message?.error || 'Non-residual RL validation worker failed.'));
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Non-residual RL validation worker exited with code ${code}.`));
    });
  })));

  return scoreAggregates(aggregates, options);
};

const splitIntoChunks = (items, chunkCount) => {
  const chunks = Array.from({ length: chunkCount }, () => []);
  for (let i = 0; i < items.length; i++) chunks[i % chunkCount].push(items[i]);
  return chunks.filter(chunk => chunk.length);
};

const evaluateCandidateChunk = (chunk, options) =>
  chunk.map(candidate => ({
    ...candidate,
    result: evaluateWeights(candidate.weights, {
      seed: options.evalSeed,
      matches: options.matches,
      rounds: options.rounds,
      baselineModel: options.baselineModel,
      pairedBaseline: options.pairedBaseline,
      rawMarginWeight: options.rawMarginWeight,
      negativeRawMarginPenalty: options.negativeRawMarginPenalty,
    }),
  }));

const evaluatePopulation = async (candidates, options) => {
  const workers = Math.max(1, Math.min(Number(options.workers || 1), candidates.length));
  if (workers <= 1) return evaluateCandidateChunk(candidates, options);

  const chunks = splitIntoChunks(candidates, workers);
  const workerUrl = new URL(import.meta.url);
  const batches = await Promise.all(chunks.map((chunk, workerIndex) => new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      workerData: {
        mode: 'evaluatePopulationChunk',
        chunk,
        options,
        workerIndex,
      },
    });
    worker.on('message', message => {
      if (message?.ok) resolve(message.evaluated);
      else reject(new Error(message?.error || 'Non-residual RL worker failed.'));
    });
    worker.on('error', reject);
    worker.on('exit', code => {
      if (code !== 0) reject(new Error(`Non-residual RL worker exited with code ${code}.`));
    });
  })));

  return batches.flat();
};

if (!isMainThread) {
  try {
    if (workerData?.mode === 'evaluatePopulationChunk') {
      const evaluated = evaluateCandidateChunk(workerData.chunk, workerData.options);
      parentPort.postMessage({ ok: true, evaluated });
    } else if (workerData?.mode === 'evaluateWeightsRange') {
      const aggregate = evaluateWeightsRange(workerData.weights, workerData.options);
      parentPort.postMessage({ ok: true, aggregate });
    } else {
      throw new Error('Unknown worker mode.');
    }
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error?.message || String(error) });
  }
}

const writePolicyData = (model, trainingSummary) => {
  const roundedModel = {
    ...model,
    weights: model.weights.map(w => Number(w.toFixed(8))),
    metadata: {
      ...(model.metadata ?? {}),
      trainingSummary,
    },
  };
  const policyPath = path.join(rootDir, 'shared/game/nonResidualRlPolicyData.js');
  fs.writeFileSync(
    policyPath,
    `// Generated by scripts/train-nonresidual-rl.mjs. Do not edit by hand.\n` +
      `export const NON_RESIDUAL_RL_POLICY = Object.freeze(${JSON.stringify(roundedModel, null, 2)});\n`
  );

  const metricsPath = path.join(rootDir, 'shared/game/nonResidualRlPolicyTraining.json');
  fs.writeFileSync(metricsPath, JSON.stringify(roundedModel.metadata, null, 2) + '\n');
};

const main = async () => {
  const args = parseArgs(process.argv);
  const availableWorkers = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  const generations = Number(args.get('generations') ?? 16);
  const population = Number(args.get('population') ?? 48);
  const eliteCount = Number(args.get('elite') ?? Math.max(4, Math.floor(population * 0.25)));
  const matches = Number(args.get('matches') ?? 80);
  const rounds = Number(args.get('rounds') ?? 8);
  const seed = Number(args.get('seed') ?? 303030);
  const sigmaInitial = Number(args.get('sigma') ?? 0.35);
  const sigmaDecay = Number(args.get('sigma-decay') ?? 0.9);
  const heuristicPrior = Number(args.get('heuristic-prior') ?? 8);
  const resumeCurrent = Boolean(args.get('resume-current'));
  const validationMatches = Number(args.get('validation-matches') ?? Math.max(200, matches * 3));
  const validationSeed = Number(args.get('validation-seed') ?? seed + 999000);
  const workers = Math.max(1, Math.min(Number(args.get('workers') ?? availableWorkers), population));
  const shouldWrite = !args.get('no-write');
  const pairedBaseline = !args.get('no-paired-baseline');
  const rawMarginWeight = Number(args.get('raw-margin-weight') ?? 0.75);
  const negativeRawMarginPenalty = Number(args.get('negative-raw-margin-penalty') ?? 1.25);

  let mean = initialWeights({ heuristicPrior, resumeCurrent });
  let sigma = sigmaInitial;
  let best = {
    weights: [...mean],
    train: evaluateWeights(mean, {
      seed,
      matches,
      rounds,
      pairedBaseline,
      rawMarginWeight,
      negativeRawMarginPenalty,
    }),
    generation: 0,
  };

  console.log(JSON.stringify({
    event: 'start',
    algorithm: 'parallel cross-entropy legal-action policy search',
    generations,
    population,
    eliteCount,
    matches,
    rounds,
    seed,
    sigmaInitial,
    sigmaDecay,
    heuristicPrior,
    resumeCurrent,
    workers,
    writePolicy: shouldWrite,
    pairedBaseline,
    rawMarginWeight,
    negativeRawMarginPenalty,
    availableWorkers,
    featureCount: RL_FEATURE_NAMES.length,
    baseline: {
      candidateMode: RL_POLICY.candidateMode,
      trainedAt: RL_POLICY.metadata?.trainedAt ?? null,
    },
  }, null, 2));

  for (let generation = 1; generation <= generations; generation++) {
    const rng = makeSeededRng(seed + generation * 100003);
    const candidates = [
      { weights: [...mean], source: 'mean', index: 0 },
      { weights: [...best.weights], source: 'best', index: 1 },
    ];
    while (candidates.length < population) {
      candidates.push({
        source: 'sample',
        index: candidates.length,
        weights: clampWeights(mean.map(w => w + randn(rng) * sigma)),
      });
    }

    const evalSeed = seed + generation * 50021;
    const evaluated = (await evaluatePopulation(candidates, {
      evalSeed,
      matches,
      rounds,
      workers,
      baselineModel: RL_POLICY,
      pairedBaseline,
      rawMarginWeight,
      negativeRawMarginPenalty,
    })).sort((a, b) => b.result.fitness - a.result.fitness);

    const elites = evaluated.slice(0, eliteCount);
    mean = clampWeights(meanVectors(elites.map(x => x.weights)));
    sigma *= sigmaDecay;

    if (evaluated[0].result.fitness > best.train.fitness) {
      best = {
        weights: [...evaluated[0].weights],
        train: evaluated[0].result,
        generation,
      };
    }

    console.log(JSON.stringify({
      event: 'generation',
      generation,
      sigma: Number(sigma.toFixed(4)),
      bestThisGeneration: evaluated[0].result,
      bestOverall: {
        generation: best.generation,
        train: best.train,
      },
    }));
  }

  const trainedAt = new Date().toISOString();
  const trainedModel = makeLegalModel(best.weights);
  const validation = await evaluateWeightsParallel(trainedModel.weights, {
    seed: validationSeed,
    matches: validationMatches,
    rounds,
    baselineModel: RL_POLICY,
    pairedBaseline,
    rawMarginWeight,
    negativeRawMarginPenalty,
    workers,
  });
  const trainingSummary = {
    algorithm: 'parallel cross-entropy legal-action policy search',
    generations,
    population,
    eliteCount,
    matchesPerCandidate: matches,
    roundsPerMatch: rounds,
    seed,
    validationSeed,
    validationMatches,
    candidateMode: 'legal',
    heuristicPrior,
    rawMarginWeight,
    negativeRawMarginPenalty,
    workers,
    bestGeneration: best.generation,
    train: best.train,
    validation,
    baseline: {
      policy: 'residual RL',
      candidateMode: RL_POLICY.candidateMode,
      trainedAt: RL_POLICY.metadata?.trainedAt ?? null,
    },
  };

  if (shouldWrite) {
    writePolicyData({
      ...trainedModel,
      metadata: {
        source: 'cross-entropy-non-residual-simulation-training',
        trainedAt,
      },
    }, trainingSummary);
  }

  console.log(JSON.stringify({
    event: 'complete',
    wrotePolicy: shouldWrite,
    trainingSummary,
  }, null, 2));
};

if (isMainThread) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
