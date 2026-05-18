#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const touched = [];

function file(rel) {
  return path.join(root, rel);
}
function read(rel) {
  const p = file(rel);
  if (!fs.existsSync(p)) throw new Error(`Missing file: ${rel}`);
  return fs.readFileSync(p, 'utf8');
}
function write(rel, text) {
  const p = file(rel);
  const bak = `${p}.bak-spiel-review-log-${stamp}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  fs.writeFileSync(p, text);
  touched.push(rel);
}
function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) throw new Error(`Could not find block: ${label}`);
  return text.replace(search, replacement);
}
function insertOnce(text, marker, insertion, label) {
  if (text.includes(insertion.trim().split('\n')[0])) return text;
  if (!text.includes(marker)) throw new Error(`Could not find insertion marker: ${label}`);
  return text.replace(marker, insertion + marker);
}

// ── server/rooms.js ─────────────────────────────────────────────────────────
let rooms = read('server/rooms.js');
if (rooms.includes('function sanitizeSpielLog')) {
  console.log('ℹ️ server/rooms.js already contains the Spiel review log helpers; skipping server changes.');
} else {
  rooms = replaceOnce(
    rooms,
    `    lastTrick: null,\n    // During the completed-trick pause, keep lastTrick as the previous`,
    `    lastTrick: null,\n    // Compact trick-by-trick review for the current Spiel. It stays server-side\n    // during live play and is only sent as part of lastRound once the Spiel ends.\n    spielLog: [],\n    // During the completed-trick pause, keep lastTrick as the previous`,
    'createGameState lastTrick/spielLog'
  );

  const helpers = `
function normalizeSpielLogPlay(play) {
  if (!play || !play.card) return null;
  const player = Number(play.player);
  const v = Number(play.card.v);
  const s = String(play.card.s || '');
  if (!Number.isInteger(player) || player < 0 || player > 3 || !s || !Number.isFinite(v)) return null;
  return { player, card: { s, v } };
}

function normalizeSpielLogTrick(entry, fallbackTrickNo = null) {
  const plays = (Array.isArray(entry?.trick) ? entry.trick : [])
    .map(normalizeSpielLogPlay)
    .filter(Boolean);
  if (!plays.length) return null;

  const trickNo = Number(entry?.trickNo ?? entry?.n ?? fallbackTrickNo ?? 0);
  const leaderRaw = Number(entry?.leader ?? entry?.l ?? plays[0]?.player);
  const winnerRaw = Number(entry?.winner ?? entry?.w);
  const ptsRaw = Number(entry?.pts ?? entry?.p ?? 0);

  return {
    trickNo: Number.isFinite(trickNo) && trickNo > 0 ? trickNo : fallbackTrickNo,
    leader: Number.isInteger(leaderRaw) ? leaderRaw : plays[0]?.player,
    winner: Number.isInteger(winnerRaw) ? winnerRaw : null,
    pts: Number.isFinite(ptsRaw) ? ptsRaw : 0,
    claimedRest: Boolean(entry?.claimedRest),
    trick: plays,
  };
}

function sanitizeSpielLog(log) {
  if (!Array.isArray(log)) return [];
  return log
    .map((entry, idx) => normalizeSpielLogTrick(entry, idx + 1))
    .filter(Boolean)
    .slice(0, 13);
}

function appendSpielLogTrick(game, entry) {
  if (!game) return null;
  const current = sanitizeSpielLog(game.spielLog);
  const normalized = normalizeSpielLogTrick(entry, current.length + 1);
  if (!normalized) return null;
  game.spielLog = [...current, normalized].slice(0, 13);
  return normalized;
}

`;
  rooms = insertOnce(rooms, 'function startQuetschReview(room) {', helpers, 'spiel log helpers before startQuetschReview');

  rooms = replaceOnce(
    rooms,
    `  if (next._trickJustFinished) {\n    maybeAddBotCommentForFinishedTrick(room, gsBefore, next);\n    const isFinalTrick = next.tricksPlayed >= 13;`,
    `  if (next._trickJustFinished) {\n    maybeAddBotCommentForFinishedTrick(room, gsBefore, next);\n    appendSpielLogTrick(game, {\n      trickNo: next.tricksPlayed,\n      leader: next._trickCards?.[0]?.player,\n      winner: next._trickWinner,\n      pts: next._trickNet,\n      trick: next._trickCards,\n    });\n    const isFinalTrick = next.tricksPlayed >= 13;`,
    'append normal completed trick to spielLog'
  );

  rooms = replaceOnce(
    rooms,
    `  const claimPts = claimCards.reduce((sum, card) => sum + cardPts(card), 0) + claimTricks.length * 10;\n  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);`,
    `  const claimPts = claimCards.reduce((sum, card) => sum + cardPts(card), 0) + claimTricks.length * 10;\n  game.spielLog = [\n    ...sanitizeSpielLog(game.spielLog),\n    ...claimTricks.map((trick) => normalizeSpielLogTrick({ ...trick, claimedRest: true })).filter(Boolean),\n  ].slice(0, 13);\n  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);`,
    'append Rest-zu-mir tricks to spielLog'
  );

  rooms = replaceOnce(
    rooms,
    `    tricksWon: [...gs.tricksWon],\n    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,\n  };`,
    `    tricksWon: [...gs.tricksWon],\n    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,\n    spielLog: sanitizeSpielLog(game.spielLog),\n  };`,
    'attach spielLog to lastRound'
  );

  rooms = replaceOnce(
    rooms,
    `  game.lastTrick = null;\n  game.pendingLastTrick = null;`,
    `  game.lastTrick = null;\n  game.spielLog = [];\n  game.pendingLastTrick = null;`,
    'reset spielLog on next round'
  );

  rooms = replaceOnce(
    rooms,
    `  const restClaimReveal = game.restClaimReveal ? {\n    ...game.restClaimReveal,\n    tricks: (game.restClaimReveal.tricks || []).map((trick) => ({\n      ...trick,\n      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n    })),\n    paused: Boolean(game.restClaimReveal.paused),\n    pausedAt: game.restClaimReveal.pausedAt || null,\n    revealUntil: game.restClaimReveal.revealUntil || null,\n  } : null;\n  return {`,
    `  const restClaimReveal = game.restClaimReveal ? {\n    ...game.restClaimReveal,\n    tricks: (game.restClaimReveal.tricks || []).map((trick) => ({\n      ...trick,\n      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n    })),\n    paused: Boolean(game.restClaimReveal.paused),\n    pausedAt: game.restClaimReveal.pausedAt || null,\n    revealUntil: game.restClaimReveal.revealUntil || null,\n  } : null;\n  const includeSpielReview = game.phase === "round_done" || game.phase === "gameover";\n  const lastRoundForView = game.lastRound ? {\n    ...game.lastRound,\n    spielLog: includeSpielReview ? sanitizeSpielLog(game.lastRound.spielLog) : [],\n  } : null;\n  return {`,
    'prepare lastRoundForView with payload-gated spielLog'
  );

  rooms = replaceOnce(
    rooms,
    `    lastRound: game.lastRound,`,
    `    lastRound: lastRoundForView,`,
    'use payload-gated lastRoundForView'
  );

  write('server/rooms.js', rooms);
}

// ── src/screens/OnlineLobby.jsx ─────────────────────────────────────────────
let lobby = read('src/screens/OnlineLobby.jsx');
if (lobby.includes('function SpielReviewPanel')) {
  console.log('ℹ️ src/screens/OnlineLobby.jsx already contains SpielReviewPanel; skipping UI changes.');
} else {
  const component = `
function SpielReviewPanel({ game, summary }) {
  const [open, setOpen] = useState(false);
  const log = Array.isArray(summary?.spielLog) ? summary.spielLog : [];
  if (!log.length) return null;

  const winnerPlayIndex = (entry) => {
    const trick = Array.isArray(entry?.trick) ? entry.trick : [];
    const leadSuit = trick[0]?.card?.s;
    if (!leadSuit) return -1;
    let bestIndex = -1;
    let bestRank = -Infinity;
    trick.forEach((play, idx) => {
      if (play?.card?.s === leadSuit && Number(play.card.v) > bestRank) {
        bestIndex = idx;
        bestRank = Number(play.card.v);
      }
    });
    return bestIndex;
  };

  return (
    <div style={{ marginTop: 18, textAlign: "center" }}>
      <Button onClick={() => setOpen((value) => !value)} style={{ padding: "9px 14px", background: open ? "rgba(255,255,255,0.12)" : undefined, color: open ? "white" : undefined }}>
        {open ? "Spielverlauf ausblenden" : "Spielverlauf anzeigen"}
      </Button>
      {open && (
        <div style={{ marginTop: 14, maxHeight: "62vh", overflowY: "auto", padding: 12, borderRadius: 16, background: "rgba(0,0,0,0.24)", border: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
          {log.map((entry, idx) => {
            const trick = Array.isArray(entry.trick) ? entry.trick : [];
            const leadSuit = trick[0]?.card?.s;
            const winIdx = winnerPlayIndex(entry);
            const pts = Number(entry.pts || 0);
            return (
              <div key={(entry.trickNo || idx + 1) + "-" + idx} style={{ padding: "12px 10px", borderRadius: 13, background: idx % 2 ? "rgba(255,255,255,0.035)" : "rgba(255,255,255,0.065)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 9 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 9 }}>
                  <strong style={{ color: "#f4c430" }}>Stich {entry.trickNo || idx + 1}{entry.claimedRest ? " · Rest" : ""}</strong>
                  <span style={{ color: "rgba(255,255,255,0.68)", fontSize: 13 }}>
                    {leadSuit ? <>Ausgespielt: {SYM[leadSuit]} · </> : null}
                    Gewinner: {game.names?.[entry.winner] ?? "?"} · <span style={{ color: pts >= 0 ? "#4ade80" : "#f87171", fontWeight: "bold" }}>{pts >= 0 ? "+" : ""}{pts}</span>
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                  {trick.map(({ player, card }, playIdx) => {
                    const isWinner = playIdx === winIdx;
                    const ptsCard = cardPts(card);
                    return (
                      <div key={playIdx} style={{ width: 72, flex: "0 0 72px", padding: 6, borderRadius: 10, background: isWinner ? "rgba(244,196,48,0.13)" : "rgba(0,0,0,0.12)", border: isWinner ? "1px solid rgba(244,196,48,0.45)" : "1px solid rgba(255,255,255,0.06)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
                        <div style={{ width: "100%", fontSize: 10, color: isWinner ? "#f4c430" : "#6dbf8a", marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={game.names?.[player]}>
                          {game.names?.[player] ?? ("P" + (Number(player) + 1))}
                        </div>
                        <CardFace card={card} size="sm" />
                        <div style={{ fontSize: 10, minHeight: 13, color: ptsCard < 0 ? "#f87171" : "rgba(255,255,255,0.42)", marginTop: 3 }}>
                          {ptsCard !== 0 ? ptsCard : ""}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

`;
  lobby = insertOnce(lobby, 'function CommentBubbles({ game }) {', component, 'SpielReviewPanel before CommentBubbles');

  lobby = replaceOnce(
    lobby,
    `        <PointsDevelopmentGraph game={game} />`,
    `        <SpielReviewPanel game={game} summary={game.lastRound} />\n        <PointsDevelopmentGraph game={game} />`,
    'add SpielReviewPanel to gameover screen'
  );

  lobby = replaceOnce(
    lobby,
    `        <div style={{ marginTop: 20, textAlign: "center" }}>\n          {game.canStartNextRound ? (`,
    `        <SpielReviewPanel game={game} summary={summary} />\n        <div style={{ marginTop: 20, textAlign: "center" }}>\n          {game.canStartNextRound ? (`,
    'add SpielReviewPanel to round_done screen'
  );

  write('src/screens/OnlineLobby.jsx', lobby);
}

console.log('✅ Spiel review log patch applied.');
console.log('Updated files:');
for (const rel of touched) console.log(' - ' + rel);
console.log('\nNext checks:');
console.log('  node --check server/rooms.js');
console.log('  npm run simulate:smoke');
console.log('  npm run build');
