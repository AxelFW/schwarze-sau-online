#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { parseArgs } from './rl-sim.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const policyPath = path.join(rootDir, 'shared/game/nonResidualRlPolicyData.js');
const metricsPath = path.join(rootDir, 'shared/game/nonResidualRlPolicyTraining.json');
const resultsPath = path.join(rootDir, 'shared/game/nonResidualRlWeekendResults.json');

const readTextIfExists = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const writeTextIfValue = (file, value) => {
  if (value === null || value === undefined) return;
  fs.writeFileSync(file, value);
};
const readJsonIfExists = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

const validationScore = metrics => {
  const validation = metrics?.trainingSummary?.validation;
  if (!validation) return -Infinity;
  const avgMargin = Number(validation.avgMargin ?? -Infinity);
  const avgDelta = Number(validation.avgDelta ?? avgMargin);
  return avgMargin + 0.5 * avgDelta;
};

const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const args = parseArgs(process.argv);
const hours = Number(args.get('hours') ?? 48);
const workers = Number(args.get('workers') ?? 12);
const startedAt = Date.now();
const deadline = startedAt + Math.max(0.01, hours) * 60 * 60 * 1000;
const maxRuns = Number(args.get('max-runs') ?? 1000);
const gateEvery = Number(args.get('gate-every') ?? 3);
const quick = Boolean(args.get('quick'));
const population = Number(args.get('population') ?? (quick ? 8 : 48));
const validationMatches = Number(args.get('validation-matches') ?? (quick ? 12 : 2500));

const configs = quick ? [
  { seed: 2101001, prior: 8, sigma: 0.22, raw: 0.9, penalty: 1.25, matches: 6, generations: 1 },
] : [
  { seed: 2101001, prior: 8, sigma: 0.22, raw: 0.9, penalty: 1.25, matches: 700, generations: 8 },
  { seed: 2201001, prior: 6, sigma: 0.24, raw: 1.0, penalty: 1.4, matches: 700, generations: 8 },
  { seed: 2301001, prior: 10, sigma: 0.20, raw: 0.9, penalty: 1.5, matches: 800, generations: 8 },
  { seed: 2401001, prior: 4, sigma: 0.18, raw: 1.1, penalty: 1.2, matches: 800, generations: 8 },
  { seed: 2501001, prior: 12, sigma: 0.26, raw: 1.0, penalty: 1.6, matches: 900, generations: 7 },
  { seed: 2601001, prior: 8, sigma: 0.14, raw: 1.2, penalty: 1.4, matches: 1000, generations: 7 },
];

let bestPolicy = readTextIfExists(policyPath);
let bestMetricsText = readTextIfExists(metricsPath);
let bestMetrics = readJsonIfExists(metricsPath);
let bestScore = validationScore(bestMetrics);
const history = readJsonIfExists(resultsPath) ?? {
  startedAt: new Date(startedAt).toISOString(),
  baseline: 'residual RL policy from shared/game/rlPolicyData.js',
  runs: [],
};

console.log(JSON.stringify({
  event: 'weekend-start',
  hours,
  workers,
  quick,
  population,
  validationMatches,
  deadline: new Date(deadline).toISOString(),
  initialBestScore: bestScore,
  initialBestValidation: bestMetrics?.trainingSummary?.validation ?? null,
}, null, 2));

for (let runIndex = 0; runIndex < maxRuns && Date.now() < deadline; runIndex++) {
  const baseConfig = configs[runIndex % configs.length];
  const cycle = Math.floor(runIndex / configs.length);
  const config = {
    ...baseConfig,
    seed: baseConfig.seed + cycle * 1000003,
  };

  const previousPolicy = readTextIfExists(policyPath);
  const previousMetrics = readTextIfExists(metricsPath);

  const trainArgs = [
    'scripts/train-nonresidual-rl.mjs',
    '--workers', String(workers),
    '--generations', String(config.generations),
    '--population', String(population),
    '--matches', String(config.matches),
    '--validation-matches', String(validationMatches),
    '--rounds', '8',
    '--heuristic-prior', String(config.prior),
    '--sigma', String(config.sigma),
    '--sigma-decay', '0.9',
    '--raw-margin-weight', String(config.raw),
    '--negative-raw-margin-penalty', String(config.penalty),
    '--seed', String(config.seed),
  ];

  console.log(JSON.stringify({ event: 'weekend-run-start', runIndex: runIndex + 1, config }));
  const status = run('node', trainArgs);
  const metrics = readJsonIfExists(metricsPath);
  const score = validationScore(metrics);
  const validation = metrics?.trainingSummary?.validation ?? null;
  const accepted = status === 0 && score > bestScore;

  history.runs.push({
    runIndex: runIndex + 1,
    completedAt: new Date().toISOString(),
    status,
    config,
    validation,
    score,
    accepted,
  });

  if (accepted) {
    bestScore = score;
    bestPolicy = readTextIfExists(policyPath);
    bestMetricsText = readTextIfExists(metricsPath);
    bestMetrics = metrics;
    console.log(JSON.stringify({ event: 'weekend-new-best', runIndex: runIndex + 1, score, validation }, null, 2));
  } else {
    writeTextIfValue(policyPath, previousPolicy);
    writeTextIfValue(metricsPath, previousMetrics);
    console.log(JSON.stringify({ event: 'weekend-restore-best', runIndex: runIndex + 1, score, bestScore, validation }, null, 2));
  }

  fs.writeFileSync(resultsPath, JSON.stringify({
    ...history,
    updatedAt: new Date().toISOString(),
    bestScore,
    bestValidation: bestMetrics?.trainingSummary?.validation ?? null,
  }, null, 2) + '\n');

  if ((runIndex + 1) % gateEvery === 0 && bestScore > 0) {
    writeTextIfValue(policyPath, bestPolicy);
    writeTextIfValue(metricsPath, bestMetricsText);
    const gateStatus = run('node', [
      'scripts/evaluate-nonresidual-rl-bot.mjs',
      '--matches', '5000',
      '--rounds', '8',
      '--seed', String(991001 + runIndex * 1009),
      '--require-stronger',
    ]);
    history.runs[history.runs.length - 1].gateStatus = gateStatus;
    fs.writeFileSync(resultsPath, JSON.stringify({
      ...history,
      updatedAt: new Date().toISOString(),
      bestScore,
      bestValidation: bestMetrics?.trainingSummary?.validation ?? null,
    }, null, 2) + '\n');
    if (gateStatus === 0) {
      console.log(JSON.stringify({ event: 'weekend-gate-passed', runIndex: runIndex + 1 }, null, 2));
      process.exit(0);
    }
  }
}

writeTextIfValue(policyPath, bestPolicy);
writeTextIfValue(metricsPath, bestMetricsText);
console.log(JSON.stringify({
  event: 'weekend-complete-without-gate',
  bestScore,
  bestValidation: bestMetrics?.trainingSummary?.validation ?? null,
  resultsPath,
}, null, 2));
process.exit(quick ? 0 : 2);
