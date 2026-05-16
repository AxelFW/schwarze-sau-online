#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupSuffix = `.bak-bot-comments-custom-input-${ts}`;

function read(rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${rel}`);
  return fs.readFileSync(file, 'utf8');
}

function write(rel, content, original) {
  const file = path.join(root, rel);
  if (content === original) return false;
  fs.writeFileSync(file + backupSuffix, original);
  fs.writeFileSync(file, content);
  return true;
}

function replaceOnce(src, needle, replacement, label) {
  if (!src.includes(needle)) throw new Error(`Could not find block: ${label}`);
  return src.replace(needle, replacement);
}

function insertBefore(src, needle, insertion, label) {
  if (!src.includes(needle)) throw new Error(`Could not find insertion point: ${label}`);
  return src.replace(needle, insertion + needle);
}

function ensureNotAlready(src, marker, label) {
  if (src.includes(marker)) {
    console.log(`ℹ️ ${label} already present; leaving it in place.`);
    return true;
  }
  return false;
}

let changed = [];

// ─────────────────────────────────────────────────────────────────────────────
// server/rooms.js
// ─────────────────────────────────────────────────────────────────────────────
{
  const rel = 'server/rooms.js';
  const original = read(rel);
  let src = original;

  src = replaceOnce(src,
`const COMMENT_TTL_MS = 5_000;
const COMMENT_CHOICES = [
  "Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];`,
`const COMMENT_TTL_MS = 5_000;
const COMMENT_MAX_LENGTH = 80;
const COMMENT_CHOICES = [
  "Klassischer Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];`,
'comment constants');

  src = replaceOnce(src,
`    restClaimReveal: null,
    comments: [],`,
`    restClaimReveal: null,
    comments: [],
    quetschGiftSources: [],`,
'game state quetschGiftSources');

  src = replaceOnce(src,
`function startQuetschReview(room) {
  const game = room.game;
  const selections = game.quetschSelections.map((sel) => [...sel]);
  const received = [[], [], [], []];
  for (let seat = 0; seat < 4; seat++) {
    received[(seat + 1) % 4] = [...selections[seat]];
  }
  game.gs = applyQuetschSelections(game.gs, selections);
  game.quetschReceived = received;`,
`function startQuetschReview(room) {
  const game = room.game;
  const selections = game.quetschSelections.map((sel) => [...sel]);
  const received = [[], [], [], []];
  const quetschGiftSources = [];
  for (let seat = 0; seat < 4; seat++) {
    const targetSeat = (seat + 1) % 4;
    received[targetSeat] = [...selections[seat]];
    for (const card of selections[seat]) {
      quetschGiftSources.push({ from: seat, to: targetSeat, card: { ...card } });
    }
  }
  game.gs = applyQuetschSelections(game.gs, selections);
  game.quetschReceived = received;
  game.quetschGiftSources = quetschGiftSources;`,
'startQuetschReview tracks card sources');

  const helperMarker = 'function addAutomaticBotComment(room, seat, text, reason = "bot_auto")';
  if (!src.includes(helperMarker)) {
    const helpers = `function seatDisplayName(room, seat) {
  return room?.seats?.[seat]?.name || ("Platz " + (Number(seat) + 1));
}

function isActiveHumanSeat(room, seat) {
  return room?.seats?.[seat]?.type === "human" && !isBotControlledSeat(room, seat);
}

function isAutomaticBotSeat(room, seat) {
  return isBotControlledSeat(room, seat);
}

function addAutomaticBotComment(room, seat, text, reason = "bot_auto") {
  if (!room?.game || !isAutomaticBotSeat(room, seat)) return false;
  const clean = cleanCommentText(text);
  if (!clean) return false;
  const now = Date.now();
  room.game.comments = [{
    id: String(now) + "-bot-" + String(seat) + "-" + Math.random().toString(36).slice(2, 8),
    seat,
    text: clean,
    at: now,
    automatic: true,
    reason,
  }];
  return true;
}

function projectedOverallLeadersBeforeTrick(room, gsBefore) {
  const projected = (room?.game?.scores || [0, 0, 0, 0]).map((score, seat) => score + (gsBefore?.roundPts?.[seat] || 0));
  const best = Math.max(...projected);
  return projected
    .map((score, seat) => score === best ? seat : null)
    .filter((seat) => seat !== null);
}

function currentWinningPlayBefore(trick, uptoIndex) {
  if (!Array.isArray(trick) || uptoIndex <= 0) return null;
  const leadSuit = trick[0]?.card?.s;
  let best = trick[0] || null;
  for (let i = 1; i < uptoIndex; i++) {
    const play = trick[i];
    if (play?.card?.s === leadSuit && best?.card?.s === leadSuit && play.card.v > best.card.v) {
      best = play;
    }
  }
  return best;
}

function quetschSourceForReceivedCard(game, toSeat, card) {
  return (game?.quetschGiftSources || []).find((entry) => (
    entry?.to === toSeat && sameCard(entry.card, card)
  )) || null;
}

function maybeAddBotCommentForFinishedTrick(room, gsBefore, gsAfter) {
  const game = room?.game;
  if (!game || !gsAfter?._trickJustFinished) return false;

  const trick = Array.isArray(gsAfter._trickCards) ? gsAfter._trickCards : [];
  if (trick.length !== 4) return false;

  const winner = gsAfter._trickWinner;
  const leader = trick[0]?.player;
  const net = Number(gsAfter._trickNet || 0);
  const isFinalTrick = Number(gsAfter.tricksPlayed || 0) >= 13;
  const winnerPlay = trick.find((play) => play.player === winner) || null;

  // 1) Quetsch heart trap: a human had to overtake a negative heart trick with
  //    a high heart received from a bot.  The bot that passed the heart comments.
  if (net < 0 && trick[0]?.card?.s === "H" && isActiveHumanSeat(room, winner) && winnerPlay?.card?.s === "H" && winnerPlay.card.v >= 10) {
    const winnerIndex = trick.findIndex((play) => play === winnerPlay);
    const previousWinner = currentWinningPlayBefore(trick, winnerIndex);
    const overtookHeart = previousWinner?.card?.s === "H" && winnerPlay.card.v > previousWinner.card.v;
    const source = overtookHeart ? quetschSourceForReceivedCard(game, winner, winnerPlay.card) : null;
    if (source && isAutomaticBotSeat(room, source.from)) {
      return addAutomaticBotComment(room, source.from, "Kommt von Herzen", "quetsch_heart_trap");
    }
  }

  // 2) Bot places Q♠ into a trick that is won by the current overall game leader
  //    as measured before this trick was scored.  Ties for the lead count.
  const overallLeaders = projectedOverallLeadersBeforeTrick(room, gsBefore);
  if (overallLeaders.includes(winner)) {
    const queenPlay = trick.find((play) => isAutomaticBotSeat(room, play.player) && play.card?.s === "S" && play.card?.v === 12);
    if (queenPlay) {
      return addAutomaticBotComment(room, queenPlay.player, "Treffer - Versenkt!", "queen_spades_to_leader");
    }
  }

  // 3) Human-led heavily negative self-fopp.  The bot that supplied the largest
  //    negative card in the trick comments.
  if (net <= -20 && winner === leader && isActiveHumanSeat(room, winner)) {
    const negativeBotPlay = trick
      .filter((play) => isAutomaticBotSeat(room, play.player) && cardPts(play.card) < 0)
      .sort((a, b) => cardPts(a.card) - cardPts(b.card))[0];
    if (negativeBotPlay) {
      return addAutomaticBotComment(room, negativeBotPlay.player, "Klassischer Selbstfopp", "classic_selbstfopp");
    }
  }

  // 4) At the final trick, a bot that wins the trick and has at least +30 points
  //    for the current Spiel celebrates the plushies.
  if (isFinalTrick && isAutomaticBotSeat(room, winner) && Number(gsAfter.roundPts?.[winner] || 0) >= 30) {
    return addAutomaticBotComment(room, winner, "Ich liebe Plüssis", "pluessis_round_score");
  }

  return false;
}

`;
    src = insertBefore(src, 'function applyOnlineCard(room, player, card) {', helpers, 'bot comment helpers before applyOnlineCard');
  }

  src = replaceOnce(src,
`  const next = applyCard(game.gs, player, card);
  if (!next) throw new Error("Die Karte konnte nicht gespielt werden.");

  if (next._trickJustFinished) {`,
`  const gsBefore = game.gs;
  const next = applyCard(gsBefore, player, card);
  if (!next) throw new Error("Die Karte konnte nicht gespielt werden.");

  if (next._trickJustFinished) {
    maybeAddBotCommentForFinishedTrick(room, gsBefore, next);`,
'applyOnlineCard remembers previous trick state and emits bot comments');

  src = replaceOnce(src,
`function cleanCommentText(text) {
  const raw = String(text || "").trim();
  return COMMENT_CHOICES.includes(raw) ? raw : null;
}`,
`function cleanCommentText(text) {
  const raw = String(text || "")
    .replace(/[\\u0000-\\u001F\\u007F]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  if (!raw) return null;
  return raw.slice(0, COMMENT_MAX_LENGTH);
}`,
'comment text sanitizer allows custom comments');

  src = replaceOnce(src,
`  if (!clean) throw new Error("Diesen Spruch gibt es nicht.");`,
`  if (!clean) throw new Error("Der Spruch ist leer.");`,
'sendOnlineComment error text');

  src = replaceOnce(src,
`  game.restClaimReveal = null;
  game.comments = [];`,
`  game.restClaimReveal = null;
  game.comments = [];
  game.quetschGiftSources = [];`,
'startNextOnlineRound resets quetschGiftSources');

  if (write(rel, src, original)) changed.push(rel);
}

// ─────────────────────────────────────────────────────────────────────────────
// src/screens/OnlineLobby.jsx
// ─────────────────────────────────────────────────────────────────────────────
{
  const rel = 'src/screens/OnlineLobby.jsx';
  const original = read(rel);
  let src = original;

  src = replaceOnce(src,
`const COMMENT_CHOICES = [
  "Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];`,
`const COMMENT_CHOICES = [
  "Klassischer Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];`,
'client comment choices');

  src = replaceOnce(src,
`function CommentControls({ room, game, setError }) {
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
}`,
`function CommentControls({ room, game, setError }) {
  const [customComment, setCustomComment] = useState("");
  if (!room || !game || game.yourSeat === null || game.phase === "gameover") return null;
  const choices = Array.isArray(game.commentChoices) && game.commentChoices.length ? game.commentChoices : COMMENT_CHOICES;

  async function sendComment(text) {
    const res = await emitAck("sendComment", { roomCode: room.roomCode, text });
    if (!res?.ok) setError(res?.message || "Spruch konnte nicht gesendet werden.");
    return res;
  }

  async function submitCustomComment(event) {
    event.preventDefault();
    const text = customComment.trim();
    if (!text) return;
    const res = await sendComment(text);
    if (res?.ok) setCustomComment("");
  }

  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
      <div style={{ display: "flex", justifyContent: "center", gap: 6, flexWrap: "wrap" }}>
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
      <form onSubmit={submitCustomComment} style={{ display: "flex", justifyContent: "center", gap: 6, width: "min(100%, 420px)" }}>
        <input
          value={customComment}
          onChange={(event) => setCustomComment(event.target.value)}
          maxLength={80}
          placeholder="Eigener Spruch ..."
          style={{
            flex: 1,
            minWidth: 0,
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 999,
            padding: "7px 10px",
            background: "rgba(255,255,255,0.08)",
            color: "white",
            fontFamily: "Georgia,serif",
            fontSize: 12,
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!customComment.trim()}
          style={{
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 999,
            padding: "7px 11px",
            background: customComment.trim() ? "rgba(244,196,48,0.18)" : "rgba(255,255,255,0.05)",
            color: customComment.trim() ? "#f4c430" : "rgba(255,255,255,0.35)",
            fontFamily: "Georgia,serif",
            fontSize: 12,
            cursor: customComment.trim() ? "pointer" : "default",
          }}
        >
          Senden
        </button>
      </form>
    </div>
  );
}`,
'CommentControls custom input');

  if (write(rel, src, original)) changed.push(rel);
}

if (!changed.length) {
  console.log('No files changed. Patch may already be applied.');
} else {
  console.log('✅ Patch applied: bot comments, custom comments, and Klassischer Selbstfopp.');
  console.log(`Changed files: ${changed.join(', ')}`);
  console.log(`Backups were written with suffix ${backupSuffix}`);
}
