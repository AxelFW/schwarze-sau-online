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
  const bak = `${p}.bak-rutsche-continuation-stability-${stamp}`;
  if (!fs.existsSync(bak)) fs.copyFileSync(p, bak);
  fs.writeFileSync(p, text);
  touched.push(rel);
}

function replaceOnce(text, search, replacement, label) {
  const count = text.split(search).length - 1;
  if (count !== 1) throw new Error(`Could not find unique block for ${label}. Found ${count}.`);
  return text.replace(search, replacement);
}

function replaceIfPresent(text, search, replacement, label) {
  const count = text.split(search).length - 1;
  if (count === 0) return text;
  if (count !== 1) throw new Error(`Could not find unique block for ${label}. Found ${count}.`);
  return text.replace(search, replacement);
}

function insertBefore(text, marker, insertion, label) {
  if (text.includes(insertion.trim().split('\n')[0])) return text;
  if (!text.includes(marker)) throw new Error(`Could not find insertion marker for ${label}.`);
  return text.replace(marker, insertion + marker);
}

function insertAfter(text, marker, insertion, label) {
  if (text.includes(insertion.trim().split('\n')[0])) return text;
  if (!text.includes(marker)) throw new Error(`Could not find insertion marker for ${label}.`);
  return text.replace(marker, marker + insertion);
}

// ── server/rooms.js ─────────────────────────────────────────────────────────
let rooms = read('server/rooms.js');

rooms = rooms.replace(
  'const DEFAULT_MATCH_RUNDEN = Number(process.env.DEFAULT_MATCH_RUNDEN || 2);',
  'const DEFAULT_MATCH_RUNDEN = Number(process.env.DEFAULT_MATCH_RUNDEN || 1);'
);

if (!rooms.includes('function startFreshGameForSameSeats(room, settings = room.settings)')) {
  const helper = `
function startFreshGameForSameSeats(room, settings = room.settings) {
  const dealer = Math.floor(Math.random() * 4);
  room.status = "playing";
  room.game = createGameState(dealer, settings);
  advanceNonCardPhases(room);
  return room;
}

`;
  rooms = insertBefore(rooms, 'export function startOnlineGame({ roomCode, socketId }) {', helper, 'fresh same-seat game helper');
}

if (!rooms.includes('export function restartOnlineGame({ roomCode, socketId })')) {
  const restartFn = `
export function restartOnlineGame({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  if (room.game.phase !== "gameover") throw new Error("Ein neues Spiel kann erst nach dem Rutschenende gestartet werden.");

  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  if (room.hostSocketId && room.hostSocketId !== socketId) {
    throw new Error("Nur der Host kann ein neues Spiel starten.");
  }

  startFreshGameForSameSeats(room, room.settings);
  touch(room);
  log("Neues Spiel in gleicher Konstellation gestartet", { roomCode: room.roomCode, socketId });
  return room;
}

`;
  rooms = insertBefore(rooms, 'export function claimRestOnline({ roomCode, socketId }) {', restartFn, 'restartOnlineGame export');
}

rooms = replaceIfPresent(
  rooms,
  `  const dealer = Math.floor(Math.random() * 4);\n  room.status = "playing";\n  room.game = createGameState(dealer, room.settings);\n  advanceNonCardPhases(room);\n  log("Spiel gestartet", { roomCode: room.roomCode, dealer });`,
  `  startFreshGameForSameSeats(room, room.settings);\n  log("Spiel gestartet", { roomCode: room.roomCode, dealer: room.game?.dealer });`,
  'startOnlineGame uses fresh-game helper'
);

rooms = replaceIfPresent(
  rooms,
  'export function startNextOnlineRound({ roomCode, socketId }) {',
  'export function startNextOnlineRound({ roomCode, socketId, continueMatch = false }) {',
  'startNextOnlineRound signature'
);

rooms = replaceIfPresent(
  rooms,
  `  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");\n  if (room.game.phase !== "round_done") throw new Error("Die nächste Rutsche kann gerade nicht gestartet werden.");`,
  `  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");\n  const continuingFinishedMatch = room.game.phase === "gameover" && continueMatch === true;\n  if (room.game.phase !== "round_done" && !continuingFinishedMatch) {\n    throw new Error("Das nächste Spiel kann gerade nicht gestartet werden.");\n  }`,
  'startNextOnlineRound allows continue after gameover'
);

rooms = replaceIfPresent(
  rooms,
  `  const game = room.game;\n  const nextDealer = (game.dealer + 1) % 4;`,
  `  const game = room.game;\n  if (continuingFinishedMatch) {\n    game.maxRounds = Math.max(Number(game.maxRounds || 0), Number(game.round || 0)) + GAMES_PER_RUNDE;\n    game.matchRutschen = Math.ceil(game.maxRounds / GAMES_PER_RUNDE);\n  }\n  const nextDealer = (game.dealer + 1) % 4;`,
  'extend maxRounds when continuing after gameover'
);

rooms = replaceIfPresent(
  rooms,
  `  log("Nächste Rutsche gestartet", { roomCode: room.roomCode, round: game.round, dealer: nextDealer, socketId });`,
  `  log(continuingFinishedMatch ? "Noch eine Rutsche gestartet" : "Nächstes Spiel gestartet", { roomCode: room.roomCode, round: game.round, maxRounds: game.maxRounds, dealer: nextDealer, socketId });`,
  'next round log wording'
);

if (!rooms.includes('const canHostControlFinishedMatch =')) {
  rooms = replaceIfPresent(
  rooms,
  `  const includeSpielReview = game.phase === "round_done" || game.phase === "gameover";\n  const lastRoundForView = game.lastRound ? {`,
  `  const includeSpielReview = game.phase === "round_done" || game.phase === "gameover";\n  const canHostControlFinishedMatch = game.phase === "gameover" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId);\n  const lastRoundForView = game.lastRound ? {`,
  'host controls after finished match'
);
}

if (!rooms.includes('canContinueMatch: canHostControlFinishedMatch')) {
  rooms = replaceIfPresent(
  rooms,
  `    canStartNextRound: game.phase === "round_done" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId),`,
  `    canStartNextRound: game.phase === "round_done" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId),\n    canContinueMatch: canHostControlFinishedMatch,\n    canRestartMatch: canHostControlFinishedMatch,`,
  'gameover continuation permissions'
);
}

write('server/rooms.js', rooms);

// ── server/index.js ─────────────────────────────────────────────────────────
let index = read('server/index.js');

if (!index.includes('restartOnlineGame,')) {
  index = replaceOnce(
    index,
    '  startOnlineGame,\n  startNextOnlineRound,',
    '  startOnlineGame,\n  startNextOnlineRound,\n  restartOnlineGame,',
    'import restartOnlineGame'
  );
}

if (!index.includes('const WS_PAYLOAD_WARN_BYTES')) {
  index = replaceOnce(
    index,
    'const EMPTY_TABLE_CLOSE_MS = Number(process.env.EMPTY_TABLE_CLOSE_MS || 60_000);',
    `const EMPTY_TABLE_CLOSE_MS = Number(process.env.EMPTY_TABLE_CLOSE_MS || 60_000);\n// Warn when a single outgoing websocket payload gets large. This does not change\n// gameplay, but it makes late-match crashes much easier to diagnose on Render.\nconst WS_PAYLOAD_WARN_BYTES = Number(process.env.WS_PAYLOAD_WARN_BYTES || 120_000);`
  ,
    'WS payload warning constant'
  );
}

if (!index.includes('function warnLargeWsPayload(eventName')) {
  const payloadHelper = `
function warnLargeWsPayload(eventName, roomCode, payload, target = "room") {
  if (!Number.isFinite(WS_PAYLOAD_WARN_BYTES) || WS_PAYLOAD_WARN_BYTES <= 0) return;
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch (err) {
    log("WS-Payload konnte nicht gemessen werden", { eventName, roomCode, target, error: err.message });
    return;
  }
  if (bytes < WS_PAYLOAD_WARN_BYTES) return;
  const game = payload?.game || null;
  log("Großes WS-Payload", {
    eventName,
    roomCode,
    target,
    kb: Math.round(bytes / 102.4) / 10,
    phase: game?.phase || payload?.phase || null,
    round: game?.round || null,
    maxRounds: game?.maxRounds || null,
  });
}

`;
  index = insertBefore(index, 'function sendError(socket, message) {', payloadHelper, 'large websocket payload helper');
}

if (!index.includes('warnLargeWsPayload("roomUpdated", room.roomCode, publicState);')) {
  index = replaceIfPresent(
  index,
  `  io.to(room.roomCode).emit("roomUpdated", publicState);`,
  `  warnLargeWsPayload("roomUpdated", room.roomCode, publicState);\n  io.to(room.roomCode).emit("roomUpdated", publicState);`,
  'warn for roomUpdated in emitRoomAndGame'
);
}

if (!index.includes('const privatePayload = {')) {
  index = replaceIfPresent(
  index,
  `      io.to(seat.socketId).emit("gameUpdated", {\n        room: publicState,\n        game: getPrivateGameView(room, seat.socketId),\n      });`,
  `      const privatePayload = {\n        room: publicState,\n        game: getPrivateGameView(room, seat.socketId),\n      };\n      warnLargeWsPayload("gameUpdated", room.roomCode, privatePayload, "seat:" + seat.seat);\n      io.to(seat.socketId).emit("gameUpdated", privatePayload);`,
  'warn for private gameUpdated'
);
}

if (!index.includes('const spectatorPayload = {')) {
  index = replaceIfPresent(
  index,
  `      io.to(spectatorSocketId).emit("gameUpdated", {\n        room: publicState,\n        game: getSpectatorGameView(room),\n      });`,
  `      const spectatorPayload = {\n        room: publicState,\n        game: getSpectatorGameView(room),\n      };\n      warnLargeWsPayload("gameUpdated", room.roomCode, spectatorPayload, "spectator");\n      io.to(spectatorSocketId).emit("gameUpdated", spectatorPayload);`,
  'warn for spectator gameUpdated'
);
}

index = replaceIfPresent(
  index,
  `      const room = startNextOnlineRound({ roomCode: payload.roomCode, socketId: socket.id });`,
  `      const room = startNextOnlineRound({ roomCode: payload.roomCode, socketId: socket.id, continueMatch: payload.continueMatch === true });`,
  'pass continueMatch to startNextOnlineRound'
);

if (!index.includes('socket.on("restartGame"')) {
  const restartHandler = `
  socket.on("restartGame", (payload = {}, ack) => {
    try {
      const room = restartOnlineGame({ roomCode: payload.roomCode, socketId: socket.id });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, false);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

`;
  index = insertAfter(index, `  socket.on("startNextRound", (payload = {}, ack) => {\n    try {\n      const room = startNextOnlineRound({ roomCode: payload.roomCode, socketId: socket.id, continueMatch: payload.continueMatch === true });\n      emitRoomAndGame(room);\n      acknowledge(ack, { ok: true });\n      scheduleAdvance(room.roomCode, false);\n    } catch (err) {\n      sendError(socket, err.message);\n      acknowledge(ack, { ok: false, message: err.message });\n    }\n  });\n`, restartHandler, 'restartGame socket handler');
}

write('server/index.js', index);

// ── src/screens/OnlineLobby.jsx ─────────────────────────────────────────────
let lobby = read('src/screens/OnlineLobby.jsx');

lobby = lobby.replace(
  'const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(2);',
  'const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(1);'
);

if (!lobby.includes('async function continueMatch()')) {
  const clientFns = `
  async function continueMatch() {
    const res = await emitAck("startNextRound", { roomCode: room.roomCode, continueMatch: true });
    if (!res?.ok) setError(res?.message || "Noch eine Rutsche konnte nicht gestartet werden.");
  }

  async function restartGame() {
    const res = await emitAck("restartGame", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Neues Spiel konnte nicht gestartet werden.");
  }

`;
  lobby = insertAfter(lobby, `  async function startNextRound() {\n    const res = await emitAck("startNextRound", { roomCode: room.roomCode });\n    if (!res?.ok) setError(res?.message || "Nächste Rutsche konnte nicht gestartet werden.");\n  }\n`, clientFns, 'continue/restart client functions');
}

if (!lobby.includes('Noch eine Rutsche</Button>')) {
  lobby = replaceOnce(
  lobby,
  `        <SpielReviewPanel game={game} summary={game.lastRound} />\n        <PointsDevelopmentGraph game={game} />\n      </div>`,
  `        <SpielReviewPanel game={game} summary={game.lastRound} />\n        <PointsDevelopmentGraph game={game} />\n        <div style={{ marginTop: 20, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>\n          {game.canContinueMatch && (\n            <Button onClick={continueMatch}>Noch eine Rutsche</Button>\n          )}\n          {game.canRestartMatch && (\n            <Button onClick={restartGame} style={{ background: "rgba(255,255,255,0.12)", color: "white" }}>Neues Spiel</Button>\n          )}\n          {!game.canContinueMatch && !game.canRestartMatch && (\n            <div style={{ color: "rgba(255,255,255,0.58)", textAlign: "center" }}>Warte, bis der Host entscheidet…</div>\n          )}\n        </div>\n      </div>`,
  'gameover continuation buttons'
);
}

lobby = lobby.replaceAll('Nächste Rutsche konnte nicht gestartet werden.', 'Nächstes Spiel konnte nicht gestartet werden.');

write('src/screens/OnlineLobby.jsx', lobby);

// ── .env.example ────────────────────────────────────────────────────────────
let env = read('.env.example');
if (!env.includes('DEFAULT_MATCH_RUNDEN=')) {
  env += `\n# Default match length in the lobby: 1 means 1 Rutsche / 4 Spiele.\nDEFAULT_MATCH_RUNDEN=1\n`;
} else {
  env = env.replace(/DEFAULT_MATCH_RUNDEN=.*/g, 'DEFAULT_MATCH_RUNDEN=1');
}
if (!env.includes('WS_PAYLOAD_WARN_BYTES=')) {
  env += `# Warn in server logs when one websocket payload exceeds this size. Set 0 to disable.\nWS_PAYLOAD_WARN_BYTES=120000\n`;
}
write('.env.example', env);

console.log('✅ Rutschen continuation/stability patch applied.');
console.log('Changed files:');
for (const rel of touched) console.log(' - ' + rel);
console.log('\nNew behavior: default is 1 Rutsche; at Rutschenende the host can choose "Noch eine Rutsche" or "Neues Spiel".');
console.log('Server logs now warn about unusually large websocket payloads.');
