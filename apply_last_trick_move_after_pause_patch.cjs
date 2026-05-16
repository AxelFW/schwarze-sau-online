#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suffix = `.bak-last-trick-after-pause-${stamp}`;

function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${rel}`);
  return fs.readFileSync(file, 'utf8');
}

function write(rel, text, original) {
  const file = path.join(root, rel);
  fs.writeFileSync(file + suffix, original);
  fs.writeFileSync(file, text);
}

function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) throw new Error(`Could not find block: ${label}`);
  return text.replace(needle, replacement);
}

function replaceRegex(text, regex, replacement, label) {
  if (!regex.test(text)) throw new Error(`Could not find regex block: ${label}`);
  return text.replace(regex, replacement);
}

let rooms = read('server/rooms.js');
const originalRooms = rooms;

if (!rooms.includes('pendingLastTrick')) {
  rooms = replaceOnce(
    rooms,
    '    lastTrick: null,\n    trickReviewUntil: null,',
    '    lastTrick: null,\n    // During the completed-trick pause, keep lastTrick as the previous\n    // trick.  The just-finished trick stays on the table and moves here only\n    // after the pause, so the previous trick display does not jump early.\n    pendingLastTrick: null,\n    trickReviewUntil: null,',
    'createGameState lastTrick field'
  );
} else if (!rooms.includes('The just-finished trick stays on the table')) {
  console.log('ℹ️ server/rooms.js already has pendingLastTrick; leaving state field as-is.');
}

rooms = replaceOnce(
  rooms,
  `    game.lastTrick = {
      winner: next._trickWinner,
      pts: next._trickNet,
      trick: next._trickCards,
      isFinal: isFinalTrick,
    };
    game.trickReviewUntil = Date.now() + reviewDelayMs;`,
  `    game.pendingLastTrick = {
      winner: next._trickWinner,
      pts: next._trickNet,
      trick: next._trickCards,
      isFinal: isFinalTrick,
    };
    game.trickReviewUntil = Date.now() + reviewDelayMs;`,
  'applyOnlineCard writes completed trick to lastTrick'
);

rooms = replaceRegex(
  rooms,
  /function finishTrickReview\(room\) \{\n  const game = room\.game;\n  if \(!game \|\| game\.phase !== "trick_done"\) return false;\n  if \(Date\.now\(\) < \(game\.trickReviewUntil \|\| 0\)\) return false;\n  game\.trickReviewUntil = null;\n  if \(game\.lastTrick\?\.isFinal\) \{\n    finishRound\(room\);\n  \} else \{\n    game\.gs = clearFinishedTrick\(game\.gs\);\n    game\.phase = "play";\n  \}\n  log\("Stichanzeige beendet", \{ roomCode: room\.roomCode, round: game\.round \}\);\n  return true;\n\}/,
  `function finishTrickReview(room) {
  const game = room.game;
  if (!game || game.phase !== "trick_done") return false;
  if (Date.now() < (game.trickReviewUntil || 0)) return false;

  const reviewedTrick = game.pendingLastTrick || (game.gs?._trickJustFinished
    ? {
        winner: game.gs._trickWinner,
        pts: game.gs._trickNet,
        trick: game.gs._trickCards,
        isFinal: game.gs.tricksPlayed >= 13,
      }
    : null);

  game.trickReviewUntil = null;
  if (reviewedTrick) {
    game.lastTrick = { ...reviewedTrick };
  }
  game.pendingLastTrick = null;

  if (reviewedTrick?.isFinal) {
    finishRound(room);
  } else {
    game.gs = clearFinishedTrick(game.gs);
    game.phase = "play";
  }
  log("Stichanzeige beendet", { roomCode: room.roomCode, round: game.round });
  return true;
}`,
  'finishTrickReview function'
);

rooms = replaceOnce(
  rooms,
  '  game.lastTrick = reveal.tricks?.[reveal.tricks.length - 1]\n    ? { ...reveal.tricks[reveal.tricks.length - 1], isFinal: true, claimedRest: true }\n    : game.lastTrick;\n  game.restClaimReveal = null;',
  '  game.lastTrick = reveal.tricks?.[reveal.tricks.length - 1]\n    ? { ...reveal.tricks[reveal.tricks.length - 1], isFinal: true, claimedRest: true }\n    : game.lastTrick;\n  game.pendingLastTrick = null;\n  game.restClaimReveal = null;',
  'finishRestClaimReveal clears pendingLastTrick'
);

rooms = replaceOnce(
  rooms,
  '  game.trickReviewUntil = null;\n  game.phase = "rest_claim_reveal";',
  '  game.pendingLastTrick = null;\n  game.trickReviewUntil = null;\n  game.phase = "rest_claim_reveal";',
  'applyRestClaim clears pendingLastTrick'
);

rooms = replaceOnce(
  rooms,
  '  game.lastTrick = null;\n  game.lastRestClaim = null;',
  '  game.lastTrick = null;\n  game.pendingLastTrick = null;\n  game.lastRestClaim = null;',
  'startNextOnlineRound clears pendingLastTrick'
);

write('server/rooms.js', rooms, originalRooms);

let index = read('server/index.js');
const originalIndex = index;

index = replaceOnce(
  index,
  `  if (phase === "trick_done") {
    const trickLength = Array.isArray(game.lastTrick?.trick) ? game.lastTrick.trick.length : 0;
    return "trick_done:" + Number(game.trickReviewUntil || 0) + ":" + (game.lastTrick?.winner ?? "") + ":" + (game.gs?.tricksPlayed ?? "") + ":" + trickLength;
  }`,
  `  if (phase === "trick_done") {
    const reviewingTrick = game.pendingLastTrick || (game.gs?._trickJustFinished
      ? { winner: game.gs._trickWinner, trick: game.gs._trickCards }
      : null);
    const trickLength = Array.isArray(reviewingTrick?.trick) ? reviewingTrick.trick.length : 0;
    return "trick_done:" + Number(game.trickReviewUntil || 0) + ":" + (reviewingTrick?.winner ?? "") + ":" + (game.gs?.tricksPlayed ?? "") + ":" + trickLength;
  }`,
  'automaticAdvanceKey trick_done block'
);

write('server/index.js', index, originalIndex);

console.log('✅ Patch applied: completed tricks now move to Letzter Stich only after the display pause.');
console.log('Changed files: server/rooms.js, server/index.js');
console.log(`Backups were written with suffix ${suffix}`);
