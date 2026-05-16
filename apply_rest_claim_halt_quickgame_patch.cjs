#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const roomsPath = path.join(root, 'server', 'rooms.js');
const indexPath = path.join(root, 'server', 'index.js');
const onlinePath = path.join(root, 'src', 'screens', 'OnlineLobby.jsx');

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing file: ${path.relative(root, file)}`);
  return fs.readFileSync(file, 'utf8');
}
function write(file, text) { fs.writeFileSync(file, text); }
function backup(file, suffix) {
  fs.copyFileSync(file, file + suffix);
}
function replaceOnce(text, needle, replacement, label) {
  if (!text.includes(needle)) throw new Error(`Could not find block: ${label}`);
  return text.replace(needle, replacement);
}
function replaceRegex(text, regex, replacement, label) {
  if (!regex.test(text)) throw new Error(`Could not find regex block: ${label}`);
  return text.replace(regex, replacement);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const suffix = `.bak-rest-claim-halt-quickgame-${stamp}`;

let rooms = read(roomsPath);
let index = read(indexPath);
let online = read(onlinePath);

// ---------------------------------------------------------------------------
// server/rooms.js
// ---------------------------------------------------------------------------
backup(roomsPath, suffix);

rooms = replaceOnce(
  rooms,
  `const REST_CLAIM_MAX_TRICKS = 4;\nconst REST_CLAIM_REVEAL_MS = Number(process.env.REST_CLAIM_REVEAL_MS || 1250);`,
  `const REST_CLAIM_MIN_TRICKS = 2;\nconst REST_CLAIM_MAX_TRICKS = 4;\nconst REST_CLAIM_REVEAL_MS = Number(process.env.REST_CLAIM_REVEAL_MS || 1250);\nconst QUICK_GAME_DELAY_FACTOR = 0.62;`,
  'rest claim constants'
);

rooms = replaceOnce(
  rooms,
  `    showPenaltyTracker: settings.showPenaltyTracker !== false,\n    easyMode: settings.easyMode === true,`,
  `    showPenaltyTracker: settings.showPenaltyTracker !== false,\n    easyMode: settings.easyMode === true,\n    quickGame: settings.quickGame === true,`,
  'defaultRoomSettings quickGame'
);

rooms = replaceOnce(
  rooms,
  `function defaultRoomSettings(settings = {}) {\n  return {\n    matchRutschen: normalizeMatchRutschen(settings.matchRutschen ?? DEFAULT_MATCH_RUNDEN),\n    showPenaltyTracker: settings.showPenaltyTracker !== false,\n    easyMode: settings.easyMode === true,\n    quickGame: settings.quickGame === true,\n  };\n}\n`,
  `function defaultRoomSettings(settings = {}) {\n  return {\n    matchRutschen: normalizeMatchRutschen(settings.matchRutschen ?? DEFAULT_MATCH_RUNDEN),\n    showPenaltyTracker: settings.showPenaltyTracker !== false,\n    easyMode: settings.easyMode === true,\n    quickGame: settings.quickGame === true,\n  };\n}\n\nfunction quickGameDelayMs(room, normalMs) {\n  const base = Number(normalMs);\n  if (!Number.isFinite(base)) return normalMs;\n  const settings = defaultRoomSettings(room?.settings);\n  if (!settings.quickGame) return Math.max(0, base);\n  return Math.max(450, Math.round(base * QUICK_GAME_DELAY_FACTOR));\n}\n\nfunction restClaimRevealDelayMs(room) {\n  return quickGameDelayMs(room, REST_CLAIM_REVEAL_MS);\n}\n`,
  'quickGameDelay helpers'
);

rooms = replaceOnce(
  rooms,
  `    const reviewDelayMs = isFinalTrick ? FINAL_TRICK_DISPLAY_MS : TRICK_DISPLAY_MS;`,
  `    const reviewDelayMs = quickGameDelayMs(room, isFinalTrick ? FINAL_TRICK_DISPLAY_MS : TRICK_DISPLAY_MS);`,
  'quick trick review delay'
);

rooms = replaceOnce(
  rooms,
  `  if (claimantCards <= 0 || claimantCards > REST_CLAIM_MAX_TRICKS) return false;`,
  `  if (claimantCards < REST_CLAIM_MIN_TRICKS || claimantCards > REST_CLAIM_MAX_TRICKS) return false;`,
  'rest claim min/max window'
);

rooms = replaceOnce(
  rooms,
  `function advanceRestClaimReveal(room) {\n  const game = room.game;\n  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;\n  if (Date.now() < (game.restClaimReveal.revealUntil || 0)) return false;\n\n  const reveal = game.restClaimReveal;\n  if ((reveal.activeIndex || 0) < (reveal.tricks?.length || 1) - 1) {\n    reveal.activeIndex = (reveal.activeIndex || 0) + 1;\n    reveal.revealUntil = Date.now() + REST_CLAIM_REVEAL_MS;\n    return true;\n  }\n\n  return finishRestClaimReveal(room);\n}\n`,
  `function stepRestClaimRevealForward(room) {\n  const game = room.game;\n  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;\n\n  const reveal = game.restClaimReveal;\n  if ((reveal.activeIndex || 0) < (reveal.tricks?.length || 1) - 1) {\n    reveal.activeIndex = (reveal.activeIndex || 0) + 1;\n    reveal.paused = false;\n    reveal.pausedAt = null;\n    reveal.revealUntil = Date.now() + restClaimRevealDelayMs(room);\n    return true;\n  }\n\n  return finishRestClaimReveal(room);\n}\n\nfunction advanceRestClaimReveal(room) {\n  const game = room.game;\n  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;\n  if (game.restClaimReveal.paused) return false;\n  if (Date.now() < (game.restClaimReveal.revealUntil || 0)) return false;\n  return stepRestClaimRevealForward(room);\n}\n\nfunction requireRestClaimRevealPlayer(room, socketId) {\n  const seat = findSeatForSocket(room, socketId);\n  if (!seat) throw new Error("Nur mitspielende Personen können die Restanzeige steuern.");\n  if (room.status !== "playing" || !room.game || room.game.phase !== "rest_claim_reveal" || !room.game.restClaimReveal) {\n    throw new Error("Es läuft gerade keine Restanzeige.");\n  }\n  return seat;\n}\n`,
  'pausable rest claim reveal functions'
);

rooms = replaceOnce(
  rooms,
  `    revealUntil: Date.now() + REST_CLAIM_REVEAL_MS,\n    tricks: claimTricks,`,
  `    revealUntil: Date.now() + restClaimRevealDelayMs(room),\n    paused: false,\n    pausedAt: null,\n    tricks: claimTricks,`,
  'initial rest claim reveal delay and pause state'
);


rooms = replaceOnce(
  rooms,
  `export function setRoomSettings({ roomCode, socketId, matchRutschen, showPenaltyTracker, easyMode }) {\n  const room = requireRoom(roomCode);\n  assertLobby(room);\n  requireHost(room, socketId);\n  const next = defaultRoomSettings(room.settings);\n  if (matchRutschen !== undefined) next.matchRutschen = normalizeMatchRutschen(matchRutschen);\n  if (showPenaltyTracker !== undefined) next.showPenaltyTracker = showPenaltyTracker !== false;\n  if (easyMode !== undefined) next.easyMode = easyMode === true;\n  room.settings = next;`,
  `export function setRoomSettings({ roomCode, socketId, matchRutschen, showPenaltyTracker, easyMode, quickGame }) {\n  const room = requireRoom(roomCode);\n  assertLobby(room);\n  requireHost(room, socketId);\n  const next = defaultRoomSettings(room.settings);\n  if (matchRutschen !== undefined) next.matchRutschen = normalizeMatchRutschen(matchRutschen);\n  if (showPenaltyTracker !== undefined) next.showPenaltyTracker = showPenaltyTracker !== false;\n  if (easyMode !== undefined) next.easyMode = easyMode === true;\n  if (quickGame !== undefined) next.quickGame = quickGame === true;\n  room.settings = next;`,
  'setRoomSettings quickGame'
);

rooms = replaceOnce(
  rooms,
  `export function respondRestClaimOnline({ roomCode, socketId, accept }) {`,
  `export function pauseRestClaimRevealOnline({ roomCode, socketId }) {\n  const room = requireRoom(roomCode);\n  requireRestClaimRevealPlayer(room, socketId);\n  const reveal = room.game.restClaimReveal;\n  reveal.paused = true;\n  reveal.pausedAt = Date.now();\n  reveal.revealUntil = null;\n  touch(room);\n  log("Restanzeige pausiert", { roomCode: room.roomCode, socketId });\n  return room;\n}\n\nexport function continueRestClaimRevealOnline({ roomCode, socketId }) {\n  const room = requireRoom(roomCode);\n  requireRestClaimRevealPlayer(room, socketId);\n  const reveal = room.game.restClaimReveal;\n  if (!reveal.paused) throw new Error("Die Restanzeige ist nicht angehalten.");\n  stepRestClaimRevealForward(room);\n  touch(room);\n  log("Restanzeige fortgesetzt", { roomCode: room.roomCode, socketId });\n  return room;\n}\n\nexport function respondRestClaimOnline({ roomCode, socketId, accept }) {`,
  'export pause/continue rest claim reveal'
);

// Include pause fields in the private/spectator game view.
rooms = replaceOnce(
  rooms,
  `      ...trick,\n      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n    })),\n  } : null;`,
  `      ...trick,\n      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),\n    })),\n    paused: Boolean(game.restClaimReveal.paused),\n    pausedAt: game.restClaimReveal.pausedAt || null,\n    revealUntil: game.restClaimReveal.revealUntil || null,\n  } : null;`,
  'restClaimReveal paused in game view'
);

rooms = replaceOnce(
  rooms,
  `    easyMode: settings.easyMode,\n    suggestion,`,
  `    easyMode: settings.easyMode,\n    quickGame: settings.quickGame,\n    suggestion,`,
  'quickGame in game view'
);

write(roomsPath, rooms);

// ---------------------------------------------------------------------------
// server/index.js
// ---------------------------------------------------------------------------
backup(indexPath, suffix);

index = replaceOnce(
  index,
  `  claimRestOnline,\n  respondRestClaimOnline,\n  sendOnlineComment,`,
  `  claimRestOnline,\n  pauseRestClaimRevealOnline,\n  continueRestClaimRevealOnline,\n  respondRestClaimOnline,\n  sendOnlineComment,`,
  'import pause/continue rest claim reveal'
);

index = replaceOnce(
  index,
  `  if (phase === "gameover" || phase === "round_done" || phase === "rest_claim_pending") return false;\n\n  // Review phases are automatic: the server has to wake up after the visible\n  // review time and transition to the next playable state.\n  if (phase === "quetsch_review" || phase === "trick_done" || phase === "rest_claim_reveal") return true;`,
  `  if (phase === "gameover" || phase === "round_done" || phase === "rest_claim_pending") return false;\n\n  // Review phases are automatic: the server has to wake up after the visible\n  // review time and transition to the next playable state. Paused rest-claim\n  // reveals intentionally have no wake-up timer until a player presses Weiter.\n  if (phase === "rest_claim_reveal") return !game.restClaimReveal?.paused;\n  if (phase === "quetsch_review" || phase === "trick_done") return true;`,
  'roomNeedsAutomaticAdvance paused reveal'
);

index = replaceOnce(
  index,
  `  if (phase === "rest_claim_reveal") {\n    const reveal = game.restClaimReveal || {};\n    return "rest_claim_reveal:" + Number(reveal.revealUntil || 0) + ":" + Number(reveal.activeIndex || 0) + ":" + Number(reveal.tricks?.length || 0);\n  }`,
  `  if (phase === "rest_claim_reveal") {\n    const reveal = game.restClaimReveal || {};\n    if (reveal.paused) return null;\n    return "rest_claim_reveal:" + Number(reveal.revealUntil || 0) + ":" + Number(reveal.activeIndex || 0) + ":" + Number(reveal.tricks?.length || 0);\n  }`,
  'automaticAdvanceKey paused reveal'
);

index = replaceOnce(
  index,
  `        showPenaltyTracker: payload.showPenaltyTracker,\n        easyMode: payload.easyMode,`,
  `        showPenaltyTracker: payload.showPenaltyTracker,\n        easyMode: payload.easyMode,\n        quickGame: payload.quickGame,`,
  'socket setRoomSettings quickGame'
);

index = replaceOnce(
  index,
  `  socket.on("respondRestClaim", (payload = {}, ack) => {`,
  `  socket.on("pauseRestClaimReveal", (payload = {}, ack) => {\n    try {\n      const room = pauseRestClaimRevealOnline({ roomCode: payload.roomCode, socketId: socket.id });\n      emitRoomAndGame(room);\n      acknowledge(ack, { ok: true });\n      scheduleAdvance(room.roomCode, false);\n    } catch (err) {\n      sendError(socket, err.message);\n      acknowledge(ack, { ok: false, message: err.message });\n    }\n  });\n\n  socket.on("continueRestClaimReveal", (payload = {}, ack) => {\n    try {\n      const room = continueRestClaimRevealOnline({ roomCode: payload.roomCode, socketId: socket.id });\n      emitRoomAndGame(room);\n      acknowledge(ack, { ok: true });\n      scheduleAdvance(room.roomCode, false);\n    } catch (err) {\n      sendError(socket, err.message);\n      acknowledge(ack, { ok: false, message: err.message });\n    }\n  });\n\n  socket.on("respondRestClaim", (payload = {}, ack) => {`,
  'socket handlers pause/continue rest claim reveal'
);

write(indexPath, index);

// ---------------------------------------------------------------------------
// src/screens/OnlineLobby.jsx
// ---------------------------------------------------------------------------
backup(onlinePath, suffix);

online = replaceOnce(
  online,
  `function RestClaimRevealPanel({ game }) {`,
  `function RestClaimRevealPanel({ game, onHalt, onWeiter }) {`,
  'RestClaimRevealPanel props'
);

online = replaceOnce(
  online,
  `      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start", marginTop: 10 }}>\n        {(active.trick || []).map(({ player, card }, idx) => (`,
  `      {game.yourSeat !== null && (\n        <div style={{ marginTop: 10 }}>\n          {reveal.paused ? (\n            <Button onClick={onWeiter} style={{ padding: "7px 13px" }}>Weiter</Button>\n          ) : (\n            <Button onClick={onHalt} style={{ padding: "7px 13px", background: "rgba(255,255,255,0.12)", color: "white" }}>Halt</Button>\n          )}\n          {reveal.paused && (\n            <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>Restanzeige angehalten.</div>\n          )}\n        </div>\n      )}\n      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start", marginTop: 10 }}>\n        {(active.trick || []).map(({ player, card }, idx) => (`,
  'Halt/Weiter controls in RestClaimRevealPanel'
);

online = replaceOnce(
  online,
  `  async function respondRestClaim(accept) {\n    const res = await emitAck("respondRestClaim", { roomCode: room.roomCode, accept });\n    if (!res?.ok) setError(res?.message || "Antwort konnte nicht gesendet werden.");\n  }\n\n  async function startNextRound() {`,
  `  async function respondRestClaim(accept) {\n    const res = await emitAck("respondRestClaim", { roomCode: room.roomCode, accept });\n    if (!res?.ok) setError(res?.message || "Antwort konnte nicht gesendet werden.");\n  }\n\n  async function haltRestClaimReveal() {\n    const res = await emitAck("pauseRestClaimReveal", { roomCode: room.roomCode });\n    if (!res?.ok) setError(res?.message || "Restanzeige konnte nicht angehalten werden.");\n  }\n\n  async function continueRestClaimReveal() {\n    const res = await emitAck("continueRestClaimReveal", { roomCode: room.roomCode });\n    if (!res?.ok) setError(res?.message || "Restanzeige konnte nicht fortgesetzt werden.");\n  }\n\n  async function startNextRound() {`,
  'OnlineGame rest reveal control functions'
);

online = replaceOnce(
  online,
  `      {game.phase === "rest_claim_reveal" && <RestClaimRevealPanel game={game} />}`, 
  `      {game.phase === "rest_claim_reveal" && <RestClaimRevealPanel game={game} onHalt={haltRestClaimReveal} onWeiter={continueRestClaimReveal} />}`,
  'RestClaimRevealPanel invocation'
);

online = replaceOnce(
  online,
  `  const [preferredEasyMode, setPreferredEasyMode] = useState(INITIAL_EASY_MODE_FROM_URL === true);\n  const [easyModeOptionVisible, setEasyModeOptionVisible] = useState(EASY_MODE_OPTION_VISIBLE);`,
  `  const [preferredEasyMode, setPreferredEasyMode] = useState(INITIAL_EASY_MODE_FROM_URL === true);\n  const [preferredQuickGame, setPreferredQuickGame] = useState(false);\n  const [easyModeOptionVisible, setEasyModeOptionVisible] = useState(EASY_MODE_OPTION_VISIBLE);`,
  'preferredQuickGame state'
);

online = replaceOnce(
  online,
  `      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,\n      easyMode: nextSettings.easyMode ?? preferredEasyMode,`,
  `      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,\n      easyMode: nextSettings.easyMode ?? preferredEasyMode,\n      quickGame: nextSettings.quickGame ?? preferredQuickGame,`,
  'updateRoomSettings quickGame merged'
);

online = replaceOnce(
  online,
  `    setPreferredEasyMode(merged.easyMode);\n    if (!room) return;`,
  `    setPreferredEasyMode(merged.easyMode);\n    setPreferredQuickGame(merged.quickGame);\n    if (!room) return;`,
  'updateRoomSettings setPreferredQuickGame'
);

online = replaceOnce(
  online,
  `    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });`,
  `    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode, quickGame: preferredQuickGame } });`,
  'startSoloGame quickGame'
);

// There are two lobby settings blocks, one before a room exists and one in the host lobby.
const quickGameCheckbox = `
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.quickGame ?? preferredQuickGame} onChange={(e) => { setPreferredQuickGame(e.target.checked); if (room) updateRoomSettings({ quickGame: e.target.checked }); }} />
                Schnelles Spiel: Stiche kürzer anzeigen
              </label>`;
const showPenaltyTrackerLabel = `              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>`;
const showPenaltyOccurrences = online.split(showPenaltyTrackerLabel).length - 1;
if (showPenaltyOccurrences < 2) throw new Error(`Expected two settings blocks for Schnelles Spiel, found ${showPenaltyOccurrences}.`);
online = online.split(showPenaltyTrackerLabel).join(showPenaltyTrackerLabel + quickGameCheckbox);

// Add quickGame to any createRoom call from the normal lobby creation path.
online = replaceOnce(
  online,
  `const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });`,
  `const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode, quickGame: preferredQuickGame } });`,
  'createRoom quickGame'
);

write(onlinePath, online);

console.log('✅ Patch applied: Rest claim 2–4 only, pausable Restanzeige, and Schnelles Spiel lobby option.');
console.log('Changed files: server/rooms.js, server/index.js, src/screens/OnlineLobby.jsx');
console.log(`Backups were written with suffix ${suffix}`);
