#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function file(rel) { return path.join(root, rel); }
function read(rel) { return fs.readFileSync(file(rel), 'utf8'); }
function write(rel, text) { fs.writeFileSync(file(rel), text); }
function backup(rel) {
  const src = file(rel);
  const dst = file(`${rel}.bak-rest-claim-reveal-refine-${stamp}`);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}
function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) throw new Error(`Could not find block: ${label}`);
  return text.replace(needle, replacement);
}
function replaceRegex(text, regex, replacement, label) {
  if (!regex.test(text)) throw new Error(`Could not find regex block: ${label}`);
  return text.replace(regex, replacement);
}

function patchRooms() {
  const rel = 'server/rooms.js';
  backup(rel);
  let text = read(rel);

  if (!text.includes('REST_CLAIM_MAX_TRICKS')) {
    throw new Error('The previous Rest-zu-mir patch is not installed. Apply apply_rest_claim_comments_score_patch.cjs first.');
  }

  text = replaceOnce(
    text,
    `const REST_CLAIM_MAX_TRICKS = 4;\nconst COMMENT_CHOICES = [`,
    `const REST_CLAIM_MAX_TRICKS = 4;\nconst REST_CLAIM_REVEAL_MS = Number(process.env.REST_CLAIM_REVEAL_MS || 1250);\nconst COMMENT_TTL_MS = 5_000;\nconst COMMENT_CHOICES = [`,
    'rest claim constants'
  );

  text = replaceOnce(
    text,
    `    phase: "quetsch", // "quetsch" | "quetsch_review" | "trick_done" | "play" | "round_done" | "gameover"`,
    `    phase: "quetsch", // "quetsch" | "quetsch_review" | "trick_done" | "rest_claim_pending" | "rest_claim_reveal" | "play" | "round_done" | "gameover"`,
    'phase comment'
  );

  text = replaceOnce(
    text,
    `    lastRound: null,\n    lastRestClaim: null,\n    comments: [],`,
    `    lastRound: null,\n    lastRestClaim: null,\n    restClaimRequest: null,\n    restClaimReveal: null,\n    comments: [],`,
    'createGameState rest claim fields'
  );

  text = replaceOnce(
    text,
    `function cleanCommentText(text) {\n  const raw = String(text || "").trim();\n  return COMMENT_CHOICES.includes(raw) ? raw : null;\n}\n\nfunction restClaimBaseLegal`,
    `function cleanCommentText(text) {\n  const raw = String(text || "").trim();\n  return COMMENT_CHOICES.includes(raw) ? raw : null;\n}\n\nfunction connectedPureHumanRoom(room) {\n  return Boolean(room?.seats?.length === 4) && room.seats.every((seat, idx) => (\n    seat?.type === "human" && Boolean(seat.socketId) && !isBotControlledSeat(room, idx)\n  ));\n}\n\nfunction restClaimBaseLegal`,
    'insert pure-human helper'
  );

  const oldClaimHelpers = `function canForceEveryRemainingTrick(gs, claimantSeat, depth = 0) {\n  if (!gs || depth > 80) return false;\n  if ((gs.tricksPlayed || 0) >= 13) return true;\n\n  const player = gs.currentPlayer;\n  if (!Number.isInteger(player) || player < 0 || player > 3) return false;\n  const legal = getValidCards(gs, player);\n  if (!legal.length) return (gs.tricksPlayed || 0) >= 13;\n\n  const tryCard = (card) => {\n    const next = applyCard(gs, player, card);\n    if (!next) return false;\n\n    if (next._trickJustFinished) {\n      if (next._trickWinner !== claimantSeat) return false;\n      if ((next.tricksPlayed || 0) >= 13) return true;\n      return canForceEveryRemainingTrick(clearFinishedTrick(next), claimantSeat, depth + 1);\n    }\n\n    return canForceEveryRemainingTrick(next, claimantSeat, depth + 1);\n  };\n\n  // The claimant only needs one winning line. Opponents must be unable to stop it.\n  if (player === claimantSeat) return legal.some(tryCard);\n  return legal.every(tryCard);\n}\n\nfunction canClaimRestForSeat(room, claimantSeat) {\n  const game = room?.game;\n  if (!restClaimBaseLegal(game, claimantSeat)) return false;\n  return canForceEveryRemainingTrick(game.gs, claimantSeat);\n}\n\nfunction applyRestClaim(room, claimantSeat, source = "manual") {\n  if (!canClaimRestForSeat(room, claimantSeat)) {\n    throw new Error("Rest zu mir ist gerade nicht sicher möglich.");\n  }\n\n  const game = room.game;\n  const gs = game.gs;\n  const remainingTricks = gs.hands[claimantSeat].length;\n  const remainingCards = gs.hands.flatMap((hand) => hand.map((card) => ({ ...card })));\n  const claimPts = remainingCards.reduce((sum, card) => sum + cardPts(card), 0) + remainingTricks * 10;\n  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);\n  const nextTricksWon = gs.tricksWon.map((count, seat) => seat === claimantSeat ? count + remainingTricks : count);\n\n  game.lastRestClaim = {\n    seat: claimantSeat,\n    name: room.seats[claimantSeat]?.name || ("Platz " + (claimantSeat + 1)),\n    remainingTricks,\n    pts: claimPts,\n    source,\n  };\n  game.lastTrick = {\n    winner: claimantSeat,\n    pts: claimPts,\n    trick: [],\n    isFinal: true,\n    claimedRest: true,\n    remainingTricks,\n  };\n  game.trickReviewUntil = null;\n  game.gs = {\n    ...gs,\n    hands: gs.hands.map(() => []),\n    trick: [],\n    leadSuit: null,\n    currentPlayer: claimantSeat,\n    tricksPlayed: Math.min(13, (gs.tricksPlayed || 0) + remainingTricks),\n    roundPts: nextRoundPts,\n    tricksWon: nextTricksWon,\n    penaltyPlayed: [...(gs.penaltyPlayed || []), ...remainingCards.filter(isPenalty)],\n    trickHistory: [...(gs.trickHistory || []), ...remainingCards],\n    _trickJustFinished: false,\n    _trickWinner: undefined,\n    _trickNet: undefined,\n    _trickCards: undefined,\n  };\n\n  finishRound(room);\n  log("Rest wurde geclaimt", { roomCode: room.roomCode, seat: claimantSeat, remainingTricks, claimPts, source });\n}\n`;

  const newClaimHelpers = `function canForceEveryRemainingTrick(gs, claimantSeat, depth = 0) {\n  if (!gs || depth > 80) return false;\n  if ((gs.tricksPlayed || 0) >= 13) return true;\n\n  const player = gs.currentPlayer;\n  if (!Number.isInteger(player) || player < 0 || player > 3) return false;\n  const legal = getValidCards(gs, player);\n  if (!legal.length) return (gs.tricksPlayed || 0) >= 13;\n\n  const tryCard = (card) => {\n    const next = applyCard(gs, player, card);\n    if (!next) return false;\n\n    if (next._trickJustFinished) {\n      if (next._trickWinner !== claimantSeat) return false;\n      if ((next.tricksPlayed || 0) >= 13) return true;\n      return canForceEveryRemainingTrick(clearFinishedTrick(next), claimantSeat, depth + 1);\n    }\n\n    return canForceEveryRemainingTrick(next, claimantSeat, depth + 1);\n  };\n\n  // The claimant only needs one winning line. Opponents must be unable to stop it.\n  if (player === claimantSeat) return legal.some(tryCard);\n  return legal.every(tryCard);\n}\n\nfunction oneClaimWinningLine(gs, claimantSeat, depth = 0) {\n  if (!gs || depth > 80) return null;\n  if ((gs.tricksPlayed || 0) >= 13) return [];\n\n  const player = gs.currentPlayer;\n  if (!Number.isInteger(player) || player < 0 || player > 3) return null;\n  const legal = getValidCards(gs, player);\n  if (!legal.length) return (gs.tricksPlayed || 0) >= 13 ? [] : null;\n\n  for (const card of legal) {\n    const next = applyCard(gs, player, card);\n    if (!next) continue;\n\n    if (next._trickJustFinished) {\n      if (next._trickWinner !== claimantSeat) continue;\n      const trick = {\n        leader: next._trickCards?.[0]?.player ?? claimantSeat,\n        winner: claimantSeat,\n        pts: next._trickNet || 0,\n        trick: (next._trickCards || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n      };\n      if ((next.tricksPlayed || 0) >= 13) return [trick];\n      const rest = oneClaimWinningLine(clearFinishedTrick(next), claimantSeat, depth + 1);\n      if (rest) return [trick, ...rest];\n      continue;\n    }\n\n    const rest = oneClaimWinningLine(next, claimantSeat, depth + 1);\n    if (rest) return rest;\n  }\n\n  return null;\n}\n\nfunction buildClaimantLedClaimLine(gs, claimantSeat) {\n  const hands = gs.hands.map((hand) => hand.map((card) => ({ ...card })));\n  const remainingTricks = hands[claimantSeat]?.length || 0;\n  const tricks = [];\n\n  for (let trickNo = 0; trickNo < remainingTricks; trickNo++) {\n    const claimantCard = hands[claimantSeat].shift();\n    if (!claimantCard) break;\n    const leadSuit = claimantCard.s;\n    const trick = [{ player: claimantSeat, card: claimantCard }];\n\n    for (let offset = 1; offset < 4; offset++) {\n      const player = (claimantSeat + offset) % 4;\n      const followIdx = hands[player].findIndex((card) => card.s === leadSuit);\n      const idx = followIdx >= 0 ? followIdx : 0;\n      const [card] = hands[player].splice(idx, 1);\n      if (card) trick.push({ player, card });\n    }\n\n    tricks.push({\n      leader: claimantSeat,\n      winner: claimantSeat,\n      pts: trick.reduce((sum, play) => sum + cardPts(play.card), 0) + 10,\n      trick,\n    });\n  }\n\n  return tricks;\n}\n\nfunction renumberClaimTricks(tricks, firstTrickNo) {\n  return tricks.map((trick, idx) => ({\n    ...trick,\n    index: idx,\n    trickNo: firstTrickNo + idx,\n    trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n  }));\n}\n\nfunction canClaimRestForSeat(room, claimantSeat) {\n  const game = room?.game;\n  if (!restClaimBaseLegal(game, claimantSeat)) return false;\n  return canForceEveryRemainingTrick(game.gs, claimantSeat);\n}\n\nfunction canStartHumanRestClaim(room, claimantSeat) {\n  return connectedPureHumanRoom(room) && restClaimBaseLegal(room?.game, claimantSeat);\n}\n\nfunction canShowRestClaimButton(room, claimantSeat) {\n  return canClaimRestForSeat(room, claimantSeat) || canStartHumanRestClaim(room, claimantSeat);\n}\n\nfunction finishRestClaimReveal(room) {\n  const game = room.game;\n  if (!game?.restClaimReveal) return false;\n  const reveal = game.restClaimReveal;\n  game.lastTrick = reveal.tricks?.[reveal.tricks.length - 1]\n    ? { ...reveal.tricks[reveal.tricks.length - 1], isFinal: true, claimedRest: true }\n    : game.lastTrick;\n  game.restClaimReveal = null;\n  finishRound(room);\n  return true;\n}\n\nfunction advanceRestClaimReveal(room) {\n  const game = room.game;\n  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;\n  if (Date.now() < (game.restClaimReveal.revealUntil || 0)) return false;\n\n  const reveal = game.restClaimReveal;\n  if ((reveal.activeIndex || 0) < (reveal.tricks?.length || 1) - 1) {\n    reveal.activeIndex = (reveal.activeIndex || 0) + 1;\n    reveal.revealUntil = Date.now() + REST_CLAIM_REVEAL_MS;\n    return true;\n  }\n\n  return finishRestClaimReveal(room);\n}\n\nfunction applyRestClaim(room, claimantSeat, source = "manual", options = {}) {\n  const forceSafe = options.forceSafe !== false;\n  const game = room.game;\n  if (!restClaimBaseLegal(game, claimantSeat)) {\n    throw new Error("Rest zu mir ist gerade nicht möglich.");\n  }\n  if (forceSafe && !canClaimRestForSeat(room, claimantSeat)) {\n    throw new Error("Rest zu mir ist gerade nicht sicher möglich.");\n  }\n\n  const gs = game.gs;\n  const remainingTricks = gs.hands[claimantSeat].length;\n  const firstClaimTrickNo = (gs.tricksPlayed || 0) + 1;\n  const safeLine = canClaimRestForSeat(room, claimantSeat) ? oneClaimWinningLine(gs, claimantSeat) : null;\n  const rawTricks = safeLine?.length ? safeLine : buildClaimantLedClaimLine(gs, claimantSeat);\n  const claimTricks = renumberClaimTricks(rawTricks, firstClaimTrickNo);\n  const claimCards = claimTricks.flatMap((trick) => trick.trick.map((play) => ({ ...play.card })));\n  const claimPts = claimCards.reduce((sum, card) => sum + cardPts(card), 0) + claimTricks.length * 10;\n  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);\n  const nextTricksWon = gs.tricksWon.map((count, seat) => seat === claimantSeat ? count + remainingTricks : count);\n\n  game.lastRestClaim = {\n    seat: claimantSeat,\n    name: room.seats[claimantSeat]?.name || ("Platz " + (claimantSeat + 1)),\n    remainingTricks,\n    pts: claimPts,\n    source,\n    safeLine: Boolean(safeLine?.length),\n    tricks: claimTricks,\n  };\n  game.restClaimRequest = null;\n  game.restClaimReveal = {\n    claimantSeat,\n    name: game.lastRestClaim.name,\n    remainingTricks,\n    pts: claimPts,\n    source,\n    activeIndex: 0,\n    revealUntil: Date.now() + REST_CLAIM_REVEAL_MS,\n    tricks: claimTricks,\n  };\n  game.lastTrick = claimTricks[0]\n    ? { ...claimTricks[0], claimedRest: true, remainingTricks, isFinal: claimTricks.length === 1 }\n    : null;\n  game.trickReviewUntil = null;\n  game.phase = "rest_claim_reveal";\n  game.gs = {\n    ...gs,\n    hands: gs.hands.map(() => []),\n    trick: [],\n    leadSuit: null,\n    currentPlayer: claimantSeat,\n    tricksPlayed: Math.min(13, (gs.tricksPlayed || 0) + remainingTricks),\n    roundPts: nextRoundPts,\n    tricksWon: nextTricksWon,\n    penaltyPlayed: [...(gs.penaltyPlayed || []), ...claimCards.filter(isPenalty)],\n    trickHistory: [...(gs.trickHistory || []), ...claimCards],\n    _trickJustFinished: false,\n    _trickWinner: undefined,\n    _trickNet: undefined,\n    _trickCards: undefined,\n  };\n\n  log("Rest wurde geclaimt", { roomCode: room.roomCode, seat: claimantSeat, remainingTricks, claimPts, source });\n}\n`;

  text = replaceOnce(text, oldClaimHelpers, newClaimHelpers, 'replace rest-claim helpers');

  text = replaceOnce(
    text,
    `  if (room.game.phase === "trick_done") {\n    changed = finishTrickReview(room) || changed;\n  }\n\n  return changed;`,
    `  if (room.game.phase === "trick_done") {\n    changed = finishTrickReview(room) || changed;\n  }\n  if (room.game.phase === "rest_claim_reveal") {\n    changed = advanceRestClaimReveal(room) || changed;\n  }\n\n  return changed;`,
    'advance rest claim reveal'
  );

  text = replaceOnce(
    text,
    `  game.lastTrick = null;\n  game.lastRestClaim = null;\n  game.comments = [];`,
    `  game.lastTrick = null;\n  game.lastRestClaim = null;\n  game.restClaimRequest = null;\n  game.restClaimReveal = null;\n  game.comments = [];`,
    'next round reset rest claim reveal'
  );

  const oldClaimExport = `export function claimRestOnline({ roomCode, socketId }) {\n  const room = requireRoom(roomCode);\n  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");\n  const seat = findSeatForSocket(room, socketId);\n  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");\n  applyRestClaim(room, seat.seat, "human");\n  touch(room);\n  return room;\n}\n\nexport function sendOnlineComment`;

  const newClaimExport = `export function claimRestOnline({ roomCode, socketId }) {\n  const room = requireRoom(roomCode);\n  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");\n  const seat = findSeatForSocket(room, socketId);\n  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");\n\n  if (canStartHumanRestClaim(room, seat.seat)) {\n    const approvals = [false, false, false, false];\n    approvals[seat.seat] = true;\n    room.game.restClaimRequest = {\n      claimantSeat: seat.seat,\n      name: seat.name || ("Platz " + (seat.seat + 1)),\n      approvals,\n      rejectedBy: null,\n      createdAt: Date.now(),\n    };\n    room.game.phase = "rest_claim_pending";\n    touch(room);\n    return room;\n  }\n\n  if (canClaimRestForSeat(room, seat.seat)) {\n    applyRestClaim(room, seat.seat, "human");\n    touch(room);\n    return room;\n  }\n\n  throw new Error("Rest zu mir ist gerade nicht möglich.");\n}\n\nexport function respondRestClaimOnline({ roomCode, socketId, accept }) {\n  const room = requireRoom(roomCode);\n  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");\n  const seat = findSeatForSocket(room, socketId);\n  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");\n  const request = room.game.restClaimRequest;\n  if (room.game.phase !== "rest_claim_pending" || !request) throw new Error("Es gibt gerade keine Rest-zu-mir-Anfrage.");\n  if (seat.seat === request.claimantSeat) throw new Error("Du hast den Rest bereits angefragt.");\n  if (!connectedPureHumanRoom(room)) throw new Error("Eine Abstimmung ist nur in reinen Menschenspielen möglich.");\n\n  if (accept === false) {\n    room.game.restClaimRequest = null;\n    room.game.phase = "play";\n    touch(room);\n    return room;\n  }\n\n  request.approvals[seat.seat] = true;\n  const allApproved = room.seats.every((s, idx) => (\n    s.type !== "human" || idx === request.claimantSeat || request.approvals[idx] === true\n  ));\n\n  if (allApproved) {\n    applyRestClaim(room, request.claimantSeat, "human-approved", { forceSafe: false });\n  }\n\n  touch(room);\n  return room;\n}\n\nexport function sendOnlineComment`;

  text = replaceOnce(text, oldClaimExport, newClaimExport, 'claim/respond exports');

  text = replaceOnce(
    text,
    `  room.game.comments = [...(room.game.comments || []), comment].slice(-6);`,
    `  room.game.comments = [comment];`,
    'single latest comment'
  );

  text = replaceOnce(
    text,
    `  const canClaimRest = seatIndex !== null ? canClaimRestForSeat(room, seatIndex) : false;\n  const comments = (game.comments || []).slice(-6).map((comment) => ({ ...comment }));`,
    `  const canClaimRest = seatIndex !== null ? canShowRestClaimButton(room, seatIndex) : false;\n  const nowForComments = Date.now();\n  const comments = (game.comments || [])\n    .filter((comment) => nowForComments - Number(comment.at || 0) < COMMENT_TTL_MS)\n    .slice(-1)\n    .map((comment) => ({ ...comment, expiresAt: Number(comment.at || 0) + COMMENT_TTL_MS }));\n  const restClaimNeedsApproval = seatIndex !== null && canStartHumanRestClaim(room, seatIndex);\n  const restClaimRequest = game.restClaimRequest ? {\n    ...game.restClaimRequest,\n    approvals: [...(game.restClaimRequest.approvals || [])],\n  } : null;\n  const restClaimReveal = game.restClaimReveal ? {\n    ...game.restClaimReveal,\n    tricks: (game.restClaimReveal.tricks || []).map((trick) => ({\n      ...trick,\n      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n    })),\n  } : null;`,
    'private view claim/comment computed fields'
  );

  text = replaceOnce(
    text,
    `    comments,\n    commentChoices: [...COMMENT_CHOICES],`,
    `    comments,\n    commentChoices: [...COMMENT_CHOICES],\n    restClaimNeedsApproval,\n    restClaimRequest,\n    restClaimReveal,`,
    'private view rest claim fields'
  );

  write(rel, text);
}

function patchServerIndex() {
  const rel = 'server/index.js';
  backup(rel);
  let text = read(rel);

  text = replaceOnce(
    text,
    `  claimRestOnline,\n  sendOnlineComment,`,
    `  claimRestOnline,\n  respondRestClaimOnline,\n  sendOnlineComment,`,
    'index import respondRestClaimOnline'
  );

  text = replaceOnce(
    text,
    `  if (phase === "gameover" || phase === "round_done") return false;`,
    `  if (phase === "gameover" || phase === "round_done" || phase === "rest_claim_pending") return false;`,
    'roomNeedsAutomaticAdvance pending'
  );

  text = replaceOnce(
    text,
    `  if (phase === "quetsch_review" || phase === "trick_done") return true;`,
    `  if (phase === "quetsch_review" || phase === "trick_done" || phase === "rest_claim_reveal") return true;`,
    'roomNeedsAutomaticAdvance reveal'
  );

  text = replaceOnce(
    text,
    `  if (phase === "trick_done") {\n    const trickLength = Array.isArray(game.lastTrick?.trick) ? game.lastTrick.trick.length : 0;\n    return "trick_done:" + Number(game.trickReviewUntil || 0) + ":" + (game.lastTrick?.winner ?? "") + ":" + (game.gs?.tricksPlayed ?? "") + ":" + trickLength;\n  }\n\n  return null;`,
    `  if (phase === "trick_done") {\n    const trickLength = Array.isArray(game.lastTrick?.trick) ? game.lastTrick.trick.length : 0;\n    return "trick_done:" + Number(game.trickReviewUntil || 0) + ":" + (game.lastTrick?.winner ?? "") + ":" + (game.gs?.tricksPlayed ?? "") + ":" + trickLength;\n  }\n\n  if (phase === "rest_claim_reveal") {\n    const reveal = game.restClaimReveal || {};\n    return "rest_claim_reveal:" + Number(reveal.revealUntil || 0) + ":" + Number(reveal.activeIndex || 0) + ":" + Number(reveal.tricks?.length || 0);\n  }\n\n  return null;`,
    'automatic key rest claim reveal'
  );

  const handler = `\n\n  socket.on("respondRestClaim", (payload = {}, ack) => {\n    try {\n      const room = respondRestClaimOnline({ roomCode: payload.roomCode, socketId: socket.id, accept: payload.accept !== false });\n      emitRoomAndGame(room);\n      acknowledge(ack, { ok: true });\n      scheduleAdvance(room.roomCode, false);\n    } catch (err) {\n      sendError(socket, err.message);\n      acknowledge(ack, { ok: false, message: err.message });\n    }\n  });`;

  text = replaceOnce(
    text,
    `  socket.on("sendComment", (payload = {}, ack) => {`,
    `${handler}\n\n  socket.on("sendComment", (payload = {}, ack) => {`,
    'respondRestClaim socket handler'
  );

  write(rel, text);
}

function patchOnlineLobby() {
  const rel = 'src/screens/OnlineLobby.jsx';
  backup(rel);
  let text = read(rel);

  // Keep Gesamt as the primary score. Current Spiel remains visible, but does not overtake the total.
  text = replaceRegex(
    text,
    /function ScoreStrip\(\{ game \}\) \{[\s\S]*?\n\}\n\nfunction LastTrickBanner/,
    `function ScoreStrip({ game }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 5, marginTop: 12 }}>
      {game.names.map((name, i) => {
        const roundPts = game.roundPts?.[i] || 0;
        const total = game.runScores?.[i] ?? game.scores?.[i] ?? 0;
        const tricks = game.tricksWon?.[i] || 0;
        return (
          <div
            key={i}
            style={{
              minWidth: 0,
              padding: "7px 5px",
              borderRadius: 10,
              background: i === game.currentPlayer ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.06)",
              border: i === game.yourSeat ? "1px solid rgba(244,196,48,0.45)" : "1px solid rgba(255,255,255,0.08)",
              textAlign: "center",
            }}
          >
            <div style={{ color: "#6dbf8a", fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {game.seatTypes[i] === "human" ? "👤" : "🧠"} {name} {i === game.dealer ? "(G)" : ""}
            </div>
            <div style={{ fontSize: 21, fontWeight: "bold", color: "#f4c430", lineHeight: 1.12 }}>
              {total}
            </div>
            <div style={{ fontSize: 10.5, color: roundPts >= 0 ? "#4ade80" : "#f87171", whiteSpace: "nowrap" }}>
              Spiel {roundPts >= 0 ? "+" : ""}{roundPts} · {tricks}✦
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LastTrickBanner`,
    'ScoreStrip primary total'
  );

  text = replaceRegex(
    text,
    /function CommentBubbles\(\{ game \}\) \{[\s\S]*?\n\}\n\nfunction CommentControls/,
    `function CommentBubbles({ game }) {
  const latest = Array.isArray(game?.comments) && game.comments.length ? game.comments[game.comments.length - 1] : null;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!latest?.id) return undefined;
    const createdAt = Number(latest.at || Date.now());
    const expiresAt = Number(latest.expiresAt || createdAt + 5000);
    setNow(Date.now());
    const delay = Math.max(0, expiresAt - Date.now()) + 40;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [latest?.id, latest?.at, latest?.expiresAt]);

  if (!latest) return null;
  const createdAt = Number(latest.at || 0);
  const expiresAt = Number(latest.expiresAt || createdAt + 5000);
  if (now >= expiresAt) return null;

  return (
    <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
      <div
        style={{
          maxWidth: 260,
          padding: "8px 11px",
          borderRadius: "17px 17px 17px 6px",
          background: "rgba(255,255,255,0.13)",
          border: "1px solid rgba(255,255,255,0.2)",
          boxShadow: "0 4px 10px rgba(0,0,0,0.18)",
          fontSize: 13,
          lineHeight: 1.25,
          textAlign: "left",
        }}
        title={game.names?.[latest.seat] || ""}
      >
        <span style={{ color: "#6dbf8a", fontSize: 10, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {game.names?.[latest.seat] || ("Platz " + (Number(latest.seat) + 1))}
        </span>
        <span>{latest.text}</span>
      </div>
    </div>
  );
}

function CommentControls`,
    'single expiring comment bubble'
  );

  text = replaceOnce(
    text,
    `function CommentControls({ room, game, setError }) {\n  if (!room || !game || game.yourSeat === null || game.phase === "gameover") return null;`,
    `function CommentControls({ room, game, setError }) {\n  if (!room || !game || game.yourSeat === null || game.phase === "gameover") return null;`,
    'CommentControls guard noop'
  );

  text = replaceOnce(
    text,
    `  async function claimRest() {\n    const res = await emitAck("claimRest", { roomCode: room.roomCode });\n    if (!res?.ok) setError(res?.message || "Rest konnte nicht geclaimt werden.");\n  }\n\n  async function startNextRound`,
    `  async function claimRest() {\n    const res = await emitAck("claimRest", { roomCode: room.roomCode });\n    if (!res?.ok) setError(res?.message || "Rest konnte nicht geclaimt werden.");\n  }\n\n  async function respondRestClaim(accept) {\n    const res = await emitAck("respondRestClaim", { roomCode: room.roomCode, accept });\n    if (!res?.ok) setError(res?.message || "Antwort konnte nicht gesendet werden.");\n  }\n\n  async function startNextRound`,
    'respondRestClaim client function'
  );

  const components = `
function RestClaimRevealPanel({ game }) {
  const reveal = game.restClaimReveal;
  if (!reveal) return null;
  const activeIndex = Math.max(0, Math.min(Number(reveal.activeIndex || 0), (reveal.tricks?.length || 1) - 1));
  const active = reveal.tricks?.[activeIndex];
  if (!active) return null;

  return (
    <div style={{ marginTop: 18, padding: 14, borderRadius: 16, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(244,196,48,0.22)", textAlign: "center" }}>
      <div style={{ color: "#f4c430", fontWeight: "bold", fontSize: 18 }}>
        Rest zu mir: {reveal.name}
      </div>
      <div style={{ color: "rgba(255,255,255,0.65)", marginTop: 4, fontSize: 13 }}>
        Stich {active.trickNo || activeIndex + 1} von {reveal.tricks?.[reveal.tricks.length - 1]?.trickNo || "?"} · {reveal.remainingTricks} restliche Stiche ({reveal.pts >= 0 ? "+" : ""}{reveal.pts} Punkte)
      </div>
      <div style={{ color: active.pts >= 0 ? "#4ade80" : "#f87171", fontWeight: "bold", marginTop: 10 }}>
        Dieser Stich geht an {game.names?.[active.winner] || reveal.name}: {active.pts >= 0 ? "+" : ""}{active.pts}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start", marginTop: 10 }}>
        {(active.trick || []).map(({ player, card }, idx) => (
          <div key={idx} style={{ width: 72, flex: "0 0 72px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={{ width: "100%", fontSize: 10, color: player === active.winner ? "#f4c430" : "#6dbf8a", marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "center" }} title={game.names?.[player] || ""}>
              {game.names?.[player] || ("Platz " + (Number(player) + 1))}
            </div>
            <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
              <CardFace card={card} size="sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RestClaimPendingPanel({ game, onRespond }) {
  const request = game.restClaimRequest;
  if (!request) return null;
  const isClaimant = game.yourSeat === request.claimantSeat;
  const alreadyAccepted = game.yourSeat !== null && request.approvals?.[game.yourSeat] === true;

  return (
    <div style={{ marginTop: 18, padding: 14, borderRadius: 16, background: "rgba(0,0,0,0.26)", border: "1px solid rgba(244,196,48,0.22)", textAlign: "center" }}>
      <div style={{ color: "#f4c430", fontWeight: "bold", fontSize: 18 }}>
        {request.name} möchte „Rest zu mir“ sagen.
      </div>
      <div style={{ color: "rgba(255,255,255,0.62)", marginTop: 6, fontSize: 13 }}>
        In einem reinen Menschenspiel geht das nur, wenn alle anderen zustimmen.
      </div>
      {isClaimant || alreadyAccepted ? (
        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.62)" }}>Warte auf die anderen…</div>
      ) : game.yourSeat === null ? (
        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.5)" }}>Du schaust zu.</div>
      ) : (
        <div style={{ marginTop: 14, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          <Button onClick={() => onRespond(true)}>Na gut</Button>
          <Button onClick={() => onRespond(false)}>Nix da</Button>
        </div>
      )}
    </div>
  );
}
`;

  text = replaceOnce(
    text,
    `function NegativeCardsBar({ game }) {`,
    `${components}\nfunction NegativeCardsBar({ game }) {`,
    'insert rest claim UI panels'
  );

  text = replaceOnce(
    text,
    `      <LastTrickBanner game={game} />\n      <CommentBubbles game={game} />\n      <CommentControls room={room} game={game} setError={setError} />\n      <SuggestionPanel game={game} />`,
    `      {game.phase !== "rest_claim_reveal" && <LastTrickBanner game={game} />}\n      <CommentBubbles game={game} />\n      <SuggestionPanel game={game} />`,
    'remove global comment controls'
  );

  text = replaceOnce(
    text,
    `                  <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>\n                    Alle übrigen Stiche gehen sicher an dich.\n                  </div>`,
    `                  <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>\n                    {game.restClaimNeedsApproval ? "Fragt die anderen: Na gut oder Nix da." : "Alle übrigen Stiche gehen sicher an dich."}\n                  </div>`,
    'rest claim button helper text'
  );

  text = replaceOnce(
    text,
    `      {game.lastRound && (\n        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.6)", textAlign: "center", fontSize: 13 }}>\n          Letztes Spiel: {game.lastRound.roundPts.map((pts, i) => \`\${game.names[i]} \${pts >= 0 ? "+" : ""}\${pts}\`).join(" · ")}\n        </div>\n      )}\n\n      {game.phase === "quetsch" && (`,
    `      {game.lastRound && (\n        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.48)", textAlign: "center", fontSize: 12 }}>\n          Letztes Spiel: {game.lastRound.roundPts.map((pts, i) => \`\${game.names[i]} \${pts >= 0 ? "+" : ""}\${pts}\`).join(" · ")}\n        </div>\n      )}\n\n      {game.phase === "rest_claim_reveal" && <RestClaimRevealPanel game={game} />}\n      {game.phase === "rest_claim_pending" && <RestClaimPendingPanel game={game} onRespond={respondRestClaim} />}\n\n      {game.phase === "quetsch" && (`,
    'insert rest claim panels in play screen'
  );

  // Put comment buttons below the visible hand-card rows instead of above the table.
  text = replaceOnce(
    text,
    `            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8, marginTop: isTrickPause ? 18 : 0 }}>\n              {game.hand.map((card) => {\n                const canPlay = !isTrickPause && game.currentPlayer === game.yourSeat && validHas(card);\n                return (\n                  <CardFace\n                    key={cardId(card)}\n                    card={card}\n                    highlighted={canPlay}\n                    suggested={!isTrickPause && game.currentPlayer === game.yourSeat && suggestedHas(card)}\n                    dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}\n                    onClick={canPlay ? () => playCard(card) : null}\n                  />\n                );\n              })}\n            </div>`,
    `            <>\n              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8, marginTop: isTrickPause ? 18 : 0 }}>\n                {game.hand.map((card) => {\n                  const canPlay = !isTrickPause && game.currentPlayer === game.yourSeat && validHas(card);\n                  return (\n                    <CardFace\n                      key={cardId(card)}\n                      card={card}\n                      highlighted={canPlay}\n                      suggested={!isTrickPause && game.currentPlayer === game.yourSeat && suggestedHas(card)}\n                      dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}\n                      onClick={canPlay ? () => playCard(card) : null}\n                    />\n                  );\n                })}\n              </div>\n              <CommentControls room={room} game={game} setError={setError} />\n            </>`,
    'comment controls below play hand'
  );

  text = replaceRegex(
    text,
    /(              <div style=\{\{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" \}\}>\n                \{game\.hand\.map\(\(card\) => \(\n                  <CardFace\n                    key=\{cardId\(card\)\}\n                    card=\{card\}\n                    selected=\{selectedHas\(card\)\}\n                    highlighted=\{quetschSuggestedHas\(card\) \|\| \(!selectedHas\(card\) && selected\.length < 3\)\}\n                    onClick=\{\(\) => toggle(?:Select|Quetsch)\(card\)\}\n                  \/>\n                \)\)\}\n              <\/div>)/,
    `$1\n              <CommentControls room={room} game={game} setError={setError} />`,
    'comment controls below quetsch hand'
  );


  write(rel, text);
}

try {
  patchRooms();
  patchServerIndex();
  patchOnlineLobby();
  console.log('✅ Patch applied: Rest-claim reveal, 5s comments, and score hierarchy refinement.');
  console.log('Backups were written next to changed files with suffix .bak-rest-claim-reveal-refine-' + stamp);
} catch (err) {
  console.error('❌ Patch failed:', err.message);
  process.exit(1);
}
