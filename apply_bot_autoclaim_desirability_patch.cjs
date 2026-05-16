#!/usr/bin/env node
/*
  Incremental patch for Wuzz / Schwarze Sau online.

  Applies after the Rest-claim reveal/comment patches.

  Change:
  - Bot auto-claim now requires either:
      (a) claiming the rest is unavoidable anyway, or
      (b) claiming the rest is legal and has positive total value.
  - Human claim button/approval behavior is unchanged.
*/

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const file = path.join(root, 'server', 'rooms.js');

function die(msg) {
  console.error(`❌ Patch failed: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(file)) die('server/rooms.js not found. Run this from the repo root.');

let src = fs.readFileSync(file, 'utf8');
const original = src;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (src.includes('function canBotAutoClaimRest(')) {
  console.log('ℹ️ Bot auto-claim desirability helpers already present.');
} else {
  const anchor = `function oneClaimWinningLine(gs, claimantSeat, depth = 0) {`;
  if (!src.includes(anchor)) die('Could not find oneClaimWinningLine anchor. Make sure the previous Rest-claim patches are applied first.');

  const helpers = `function mustWinEveryRemainingTrick(gs, claimantSeat, depth = 0) {
  if (!gs || depth > 80) return false;
  if ((gs.tricksPlayed || 0) >= 13) return true;

  const player = gs.currentPlayer;
  if (!Number.isInteger(player) || player < 0 || player > 3) return false;
  const legal = getValidCards(gs, player);
  if (!legal.length) return (gs.tricksPlayed || 0) >= 13;

  const tryCard = (card) => {
    const next = applyCard(gs, player, card);
    if (!next) return false;

    if (next._trickJustFinished) {
      if (next._trickWinner !== claimantSeat) return false;
      if ((next.tricksPlayed || 0) >= 13) return true;
      return mustWinEveryRemainingTrick(clearFinishedTrick(next), claimantSeat, depth + 1);
    }

    return mustWinEveryRemainingTrick(next, claimantSeat, depth + 1);
  };

  // Unlike canForceEveryRemainingTrick, this treats the claimant's own choices
  // as universal too: if even a deliberately different play cannot avoid taking
  // the rest, the claim is unavoidable and the bot may claim even a bad rest.
  return legal.every(tryCard);
}

function claimRestTotalPts(gs, claimantSeat) {
  if (!gs || !Array.isArray(gs.hands) || !Array.isArray(gs.hands[claimantSeat])) return 0;
  const remainingTricks = gs.hands[claimantSeat].length;
  const remainingCardPts = gs.hands.reduce((sum, hand) => {
    if (!Array.isArray(hand)) return sum;
    return sum + hand.reduce((inner, card) => inner + cardPts(card), 0);
  }, 0);
  return remainingCardPts + remainingTricks * 10;
}

function canBotAutoClaimRest(room, claimantSeat) {
  if (!canClaimRestForSeat(room, claimantSeat)) return false;
  const gs = room?.game?.gs;
  const claimPts = claimRestTotalPts(gs, claimantSeat);

  // Positive rest: claiming is both legal and strategically useful.
  if (claimPts > 0) return true;

  // Bad or neutral rest: claim only if playing cannot avoid taking every
  // remaining trick anyway. This prevents cases like A♥/10♥ into K♥ where the
  // bot can technically claim, but should lead the 10♥ as an exit instead.
  return mustWinEveryRemainingTrick(gs, claimantSeat);
}

`;
  src = src.replace(anchor, helpers + anchor);
}

const oldAdvance = `  if (canClaimRestForSeat(room, player)) {\n    applyRestClaim(room, player, "bot");`;
const newAdvance = `  if (canBotAutoClaimRest(room, player)) {\n    applyRestClaim(room, player, "bot");`;
if (src.includes(oldAdvance)) {
  src = src.replace(oldAdvance, newAdvance);
} else if (src.includes(newAdvance)) {
  console.log('ℹ️ advanceOneBotCard already uses canBotAutoClaimRest.');
} else {
  die('Could not find bot auto-claim call in advanceOneBotCard.');
}

if (src === original) {
  console.log('ℹ️ No changes needed; patch already applied.');
  process.exit(0);
}

fs.writeFileSync(file + `.bak-bot-autoclaim-desirability-${stamp}`, original);
fs.writeFileSync(file, src);

console.log('✅ Patch applied: bot auto-claim now requires positive rest or unavoidable rest.');
console.log('Changed file: server/rooms.js');
console.log('Backup written next to server/rooms.js with suffix .bak-bot-autoclaim-desirability-*');
