#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function file(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(file(rel), 'utf8');
}

function write(rel, text) {
  fs.writeFileSync(file(rel), text);
}

function backup(rel) {
  const src = file(rel);
  const dst = file(`${rel}.bak-rest-claim-comments-score-${stamp}`);
  if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
}

function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) {
    throw new Error(`Could not find block: ${label}`);
  }
  return text.replace(needle, replacement);
}

function replaceRegex(text, regex, replacement, label) {
  if (!regex.test(text)) {
    throw new Error(`Could not find regex block: ${label}`);
  }
  return text.replace(regex, replacement);
}

function patchRooms() {
  const rel = 'server/rooms.js';
  backup(rel);
  let text = read(rel);

  text = replaceOnce(
    text,
    'import { sameCard, sortHand, cardPts } from "../shared/game/cards.js";',
    'import { sameCard, sortHand, cardPts, isPenalty } from "../shared/game/cards.js";',
    'cards import'
  );

  text = replaceOnce(
    text,
    'const DISCONNECTED_HUMAN_BOT_DELAY_MS = Number(process.env.DISCONNECTED_HUMAN_BOT_DELAY_MS || 20_000);',
    `const DISCONNECTED_HUMAN_BOT_DELAY_MS = Number(process.env.DISCONNECTED_HUMAN_BOT_DELAY_MS || 20_000);
const REST_CLAIM_MAX_TRICKS = 4;
const COMMENT_CHOICES = [
  "Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];`,
    'server constants'
  );

  text = replaceOnce(
    text,
    `    lastTrick: null,
    trickReviewUntil: null,
    lastRound: null,`,
    `    lastTrick: null,
    trickReviewUntil: null,
    lastRound: null,
    lastRestClaim: null,
    comments: [],`,
    'createGameState trailing fields'
  );

  text = replaceOnce(
    text,
    `    tricksWon: [...gs.tricksWon],
  };`,
    `    tricksWon: [...gs.tricksWon],
    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,
  };`,
    'lastRound claimedRest field'
  );

  const helperBlock = `
function cleanCommentText(text) {
  const raw = String(text || "").trim();
  return COMMENT_CHOICES.includes(raw) ? raw : null;
}

function restClaimBaseLegal(game, claimantSeat) {
  if (!game || game.phase !== "play") return false;
  if (!Number.isInteger(claimantSeat) || claimantSeat < 0 || claimantSeat > 3) return false;
  const gs = game.gs;
  if (!gs || gs.currentPlayer !== claimantSeat) return false;
  if (Array.isArray(gs.trick) && gs.trick.length > 0) return false;
  const claimantCards = Array.isArray(gs.hands?.[claimantSeat]) ? gs.hands[claimantSeat].length : 0;
  if (claimantCards <= 0 || claimantCards > REST_CLAIM_MAX_TRICKS) return false;
  // Empty-trick endgames should have equal hand sizes. If the state is unusual,
  // stay conservative and do not offer an automatic claim.
  if (!gs.hands?.every((hand) => Array.isArray(hand) && hand.length === claimantCards)) return false;
  return true;
}

function canForceEveryRemainingTrick(gs, claimantSeat, depth = 0) {
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
      return canForceEveryRemainingTrick(clearFinishedTrick(next), claimantSeat, depth + 1);
    }

    return canForceEveryRemainingTrick(next, claimantSeat, depth + 1);
  };

  // The claimant only needs one winning line. Opponents must be unable to stop it.
  if (player === claimantSeat) return legal.some(tryCard);
  return legal.every(tryCard);
}

function canClaimRestForSeat(room, claimantSeat) {
  const game = room?.game;
  if (!restClaimBaseLegal(game, claimantSeat)) return false;
  return canForceEveryRemainingTrick(game.gs, claimantSeat);
}

function applyRestClaim(room, claimantSeat, source = "manual") {
  if (!canClaimRestForSeat(room, claimantSeat)) {
    throw new Error("Rest zu mir ist gerade nicht sicher möglich.");
  }

  const game = room.game;
  const gs = game.gs;
  const remainingTricks = gs.hands[claimantSeat].length;
  const remainingCards = gs.hands.flatMap((hand) => hand.map((card) => ({ ...card })));
  const claimPts = remainingCards.reduce((sum, card) => sum + cardPts(card), 0) + remainingTricks * 10;
  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);
  const nextTricksWon = gs.tricksWon.map((count, seat) => seat === claimantSeat ? count + remainingTricks : count);

  game.lastRestClaim = {
    seat: claimantSeat,
    name: room.seats[claimantSeat]?.name || ("Platz " + (claimantSeat + 1)),
    remainingTricks,
    pts: claimPts,
    source,
  };
  game.lastTrick = {
    winner: claimantSeat,
    pts: claimPts,
    trick: [],
    isFinal: true,
    claimedRest: true,
    remainingTricks,
  };
  game.trickReviewUntil = null;
  game.gs = {
    ...gs,
    hands: gs.hands.map(() => []),
    trick: [],
    leadSuit: null,
    currentPlayer: claimantSeat,
    tricksPlayed: Math.min(13, (gs.tricksPlayed || 0) + remainingTricks),
    roundPts: nextRoundPts,
    tricksWon: nextTricksWon,
    penaltyPlayed: [...(gs.penaltyPlayed || []), ...remainingCards.filter(isPenalty)],
    trickHistory: [...(gs.trickHistory || []), ...remainingCards],
    _trickJustFinished: false,
    _trickWinner: undefined,
    _trickNet: undefined,
    _trickCards: undefined,
  };

  finishRound(room);
  log("Rest wurde geclaimt", { roomCode: room.roomCode, seat: claimantSeat, remainingTricks, claimPts, source });
}
`;

  text = replaceOnce(
    text,
    '\nexport function advanceNonCardPhases(room) {',
    `${helperBlock}\nexport function advanceNonCardPhases(room) {`,
    'insert rest claim helpers'
  );

  text = replaceOnce(
    text,
    `  const card = chooseHeuristicCard(botDecisionGameState(room), player);
  log("Bot spielt Karte", { roomCode: room.roomCode, seat: player, card });
  applyOnlineCard(room, player, card);`,
    `  if (canClaimRestForSeat(room, player)) {
    applyRestClaim(room, player, "bot");
    advanceNonCardPhases(room);
    touch(room);
    return true;
  }

  const card = chooseHeuristicCard(botDecisionGameState(room), player);
  log("Bot spielt Karte", { roomCode: room.roomCode, seat: player, card });
  applyOnlineCard(room, player, card);`,
    'bot rest claim branch'
  );

  text = replaceOnce(
    text,
    `  game.lastTrick = null;
  advanceNonCardPhases(room);`,
    `  game.lastTrick = null;
  game.lastRestClaim = null;
  game.comments = [];
  advanceNonCardPhases(room);`,
    'next round reset rest claim/comments'
  );

  const newExports = `
export function claimRestOnline({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  applyRestClaim(room, seat.seat, "human");
  touch(room);
  return room;
}

export function sendOnlineComment({ roomCode, socketId, text }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  const clean = cleanCommentText(text);
  if (!clean) throw new Error("Diesen Spruch gibt es nicht.");
  const now = Date.now();
  const comment = {
    id: String(now) + "-" + String(seat.seat) + "-" + Math.random().toString(36).slice(2, 8),
    seat: seat.seat,
    text: clean,
    at: now,
  };
  room.game.comments = [...(room.game.comments || []), comment].slice(-6);
  touch(room);
  log("Spruch gesendet", { roomCode: room.roomCode, seat: seat.seat, text: clean });
  return room;
}

`;

  text = replaceOnce(
    text,
    'export function submitOnlineQuetsch({ roomCode, socketId, cards }) {',
    `${newExports}export function submitOnlineQuetsch({ roomCode, socketId, cards }) {`,
    'insert claim/comment exports'
  );

  text = replaceOnce(
    text,
    `  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));
  return {`,
    `  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));
  const canClaimRest = seatIndex !== null ? canClaimRestForSeat(room, seatIndex) : false;
  const comments = (game.comments || []).slice(-6).map((comment) => ({ ...comment }));
  return {`,
    'private view computed fields'
  );

  text = replaceOnce(
    text,
    `    suggestion,
    quetschSuggestion,`,
    `    suggestion,
    quetschSuggestion,
    canClaimRest,
    comments,
    commentChoices: [...COMMENT_CHOICES],`,
    'private view claim/comment fields'
  );

  write(rel, text);
}

function patchServerIndex() {
  const rel = 'server/index.js';
  backup(rel);
  let text = read(rel);

  text = replaceOnce(
    text,
    `  submitOnlineQuetsch,
  playOnlineCard,`,
    `  submitOnlineQuetsch,
  playOnlineCard,
  claimRestOnline,
  sendOnlineComment,`,
    'index imports claim/comment'
  );

  const handlers = `

  socket.on("claimRest", (payload = {}, ack) => {
    try {
      const room = claimRestOnline({ roomCode: payload.roomCode, socketId: socket.id });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, false);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("sendComment", (payload = {}, ack) => {
    try {
      const room = sendOnlineComment({ roomCode: payload.roomCode, socketId: socket.id, text: payload.text });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });`;

  text = replaceOnce(
    text,
    `  socket.on("leaveRoom", (payload = {}, ack) => {`,
    `${handlers}\n\n  socket.on("leaveRoom", (payload = {}, ack) => {`,
    'insert claim/comment socket handlers'
  );

  write(rel, text);
}

function patchOnlineLobby() {
  const rel = 'src/screens/OnlineLobby.jsx';
  backup(rel);
  let text = read(rel);

  text = replaceOnce(
    text,
    `function cardLabel(card) {
  return VN(card.v) + SYM[card.s];
}
`,
    `function cardLabel(card) {
  return VN(card.v) + SYM[card.s];
}

const COMMENT_CHOICES = [
  "Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];
`,
    'client comment choices'
  );

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
            <div style={{ fontSize: 18, fontWeight: "bold", color: roundPts >= 0 ? "#4ade80" : "#f87171", lineHeight: 1.15 }}>
              Sp {roundPts >= 0 ? "+" : ""}{roundPts}
            </div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", whiteSpace: "nowrap" }}>
              {tricks}✦ · Gesamt {total}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LastTrickBanner`,
    'ScoreStrip function'
  );

  const commentComponents = `
function CommentBubbles({ game }) {
  const comments = Array.isArray(game?.comments) ? game.comments : [];
  if (!comments.length) return null;

  return (
    <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
      {comments.map((comment, idx) => (
        <div
          key={comment.id || (String(comment.seat) + "-" + comment.text + "-" + idx)}
          style={{
            maxWidth: 220,
            padding: "7px 10px",
            borderRadius: "16px 16px 16px 6px",
            background: "rgba(255,255,255,0.12)",
            border: "1px solid rgba(255,255,255,0.18)",
            boxShadow: "0 4px 10px rgba(0,0,0,0.18)",
            fontSize: 13,
            lineHeight: 1.25,
          }}
          title={game.names?.[comment.seat] || ""}
        >
          <span style={{ color: "#6dbf8a", fontSize: 10, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {game.names?.[comment.seat] || ("Platz " + (Number(comment.seat) + 1))}
          </span>
          <span>{comment.text}</span>
        </div>
      ))}
    </div>
  );
}

function CommentControls({ room, game, setError }) {
  if (!room || !game || game.yourSeat === null || game.phase === "gameover") return null;
  const choices = Array.isArray(game.commentChoices) && game.commentChoices.length ? game.commentChoices : COMMENT_CHOICES;

  async function sendComment(text) {
    const res = await emitAck("sendComment", { roomCode: room.roomCode, text });
    if (!res?.ok) setError(res?.message || "Spruch konnte nicht gesendet werden.");
  }

  return (
    <div style={{ marginTop: 10, display: "flex", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
      {choices.map((text) => (
        <button
          key={text}
          type="button"
          onClick={() => sendComment(text)}
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 999,
            padding: "6px 9px",
            background: "rgba(255,255,255,0.08)",
            color: "rgba(255,255,255,0.82)",
            fontFamily: "Georgia,serif",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          💬 {text}
        </button>
      ))}
    </div>
  );
}
`;

  text = replaceOnce(
    text,
    '\nfunction NegativeCardsBar({ game }) {',
    `${commentComponents}\nfunction NegativeCardsBar({ game }) {`,
    'comment components'
  );

  text = replaceOnce(
    text,
    `  async function playCard(card) {
    const res = await emitAck("playCard", { roomCode: room.roomCode, card });
    if (!res?.ok) setError(res?.message || "Karte konnte nicht gespielt werden.");
  }
`,
    `  async function playCard(card) {
    const res = await emitAck("playCard", { roomCode: room.roomCode, card });
    if (!res?.ok) setError(res?.message || "Karte konnte nicht gespielt werden.");
  }

  async function claimRest() {
    const res = await emitAck("claimRest", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Rest konnte nicht geclaimt werden.");
  }
`,
    'claimRest client function'
  );

  text = replaceOnce(
    text,
    `      <LastTrickBanner game={game} />
      <SuggestionPanel game={game} />`,
    `      <LastTrickBanner game={game} />
      <CommentBubbles game={game} />
      <CommentControls room={room} game={game} setError={setError} />
      <SuggestionPanel game={game} />`,
    'render comments around last trick'
  );

  text = replaceOnce(
    text,
    `              {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}
            </>
          )}`,
    `              {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}
              {game.canClaimRest && (
                <div style={{ textAlign: "center", marginTop: 8, marginBottom: 8 }}>
                  <Button onClick={claimRest}>Rest zu mir</Button>
                  <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                    Alle übrigen Stiche gehen sicher an dich.
                  </div>
                </div>
              )}
            </>
          )}`,
    'render Rest zu mir button'
  );


  text = replaceOnce(
    text,
    `        <div style={{ color: "#6dbf8a", textAlign: "center", marginBottom: 16 }}>
          Spielergebnis und Gesamtstand
        </div>`,
    `        <div style={{ color: "#6dbf8a", textAlign: "center", marginBottom: 16 }}>
          Spielergebnis und Gesamtstand
        </div>
        {summary?.claimedRest && (
          <div style={{ textAlign: "center", marginBottom: 14, color: "rgba(255,255,255,0.68)", fontSize: 13 }}>
            {summary.claimedRest.name} nimmt die restlichen {summary.claimedRest.remainingTricks} Stiche
            ({summary.claimedRest.pts >= 0 ? "+" : ""}{summary.claimedRest.pts} Punkte).
          </div>
        )}`,
    'round_done rest-claim note'
  );

  // Existing file contains a duplicate JSX prop in the quetsch hand; patching it
  // here keeps the build valid while preserving both meanings.
  text = text.replace(
    '                    selected={selectedHas(card)} highlighted={quetschSuggestedHas(card)}\n                    highlighted={!selectedHas(card) && selected.length < 3}',
    '                    selected={selectedHas(card)}\n                    highlighted={quetschSuggestedHas(card) || (!selectedHas(card) && selected.length < 3)}'
  );

  write(rel, text);
}

try {
  patchRooms();
  patchServerIndex();
  patchOnlineLobby();
  console.log('✅ Patch applied: Rest-claim, comments, and score-strip flip.');
  console.log('Backups were written next to each changed file with suffix .bak-rest-claim-comments-score-' + stamp);
} catch (err) {
  console.error('❌ Patch failed:', err.message);
  process.exit(1);
}
