import crypto from "crypto";
import {
  dealRound,
  applyCard,
  applyQuetschSelections,
  clearFinishedTrick,
  getValidCards,
} from "../shared/game/engine.js";
import { heuristicQuetschPick, chooseHeuristicCard } from "../shared/game/heuristicBot.js";
import { sameCard, sortHand, cardPts } from "../shared/game/cards.js";

const rooms = new Map();
const MAX_ROUNDS = 8;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);

function log(message, data = {}) {
  console.log(`[room] ${message}`, data);
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Kein eindeutiger Raumcode konnte erstellt werden.");
}

function makeToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function cleanName(name) {
  const s = String(name || "").trim();
  return s.length ? s.slice(0, 24) : "Spieler";
}

function emptySeats() {
  return [0, 1, 2, 3].map((seat) => ({
    seat,
    type: "open", // "open" | "human" | "bot"
    name: null,
    socketId: null,
    reconnectToken: null,
    disconnected: false,
  }));
}

function touch(room) {
  room.lastActivity = Date.now();
}

function normalizeCode(roomCode) {
  return String(roomCode || "").trim().toUpperCase();
}

function requireRoom(roomCode) {
  const code = normalizeCode(roomCode);
  const room = rooms.get(code);
  if (!room) throw new Error("Raum nicht gefunden.");
  touch(room);
  return room;
}

function requireHost(room, socketId) {
  if (room.hostSocketId !== socketId) throw new Error("Das darf nur die Spielleitung machen.");
}

function assertLobby(room) {
  if (room.status !== "lobby") throw new Error("Der Raum ist nicht mehr in der Lobby.");
}

export function publicRoom(room) {
  return {
    roomCode: room.roomCode,
    hostSocketId: room.hostSocketId,
    status: room.status,
    seats: room.seats.map((s) => ({
      seat: s.seat,
      type: s.type,
      name: s.name,
      socketId: s.socketId,
      disconnected: Boolean(s.disconnected),
      isHost: Boolean(s.socketId && s.socketId === room.hostSocketId),
    })),
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
  };
}

function privateTokenForSocket(room, socketId) {
  const seat = findSeatForSocket(room, socketId);
  return seat?.reconnectToken || null;
}

export function publicRoomWithToken(room, socketId) {
  return { room: publicRoom(room), reconnectToken: privateTokenForSocket(room, socketId) };
}

function findSeatForSocket(room, socketId) {
  return room.seats.find((s) => s.type === "human" && s.socketId === socketId) || null;
}

function findSeatForToken(room, token) {
  if (!token) return null;
  return room.seats.find((s) => s.type === "human" && s.reconnectToken === token) || null;
}

function isConnectedHumanSeat(room, seat) {
  const s = room.seats[seat];
  return s?.type === "human" && Boolean(s.socketId);
}

function isBotControlledSeat(room, seat) {
  const s = room.seats[seat];
  return s?.type === "bot" || (s?.type === "human" && !s.socketId);
}

function validateCardsInHand(hand, cards, requiredCount) {
  if (!Array.isArray(cards) || cards.length !== requiredCount) {
    throw new Error(`Bitte genau ${requiredCount} Karten auswählen.`);
  }
  const handCopy = [...hand];
  const out = [];
  for (const raw of cards) {
    const card = { s: raw?.s, v: Number(raw?.v) };
    const idx = handCopy.findIndex((c) => sameCard(c, card));
    if (idx < 0) throw new Error("Diese Karte ist nicht auf deiner Hand.");
    out.push(handCopy[idx]);
    handCopy.splice(idx, 1);
  }
  return out;
}

function createGameState(dealer) {
  return {
    round: 1,
    maxRounds: MAX_ROUNDS,
    scores: [0, 0, 0, 0],
    dealer,
    phase: "quetsch", // "quetsch" | "play" | "round_done" | "gameover"
    gs: dealRound(dealer),
    quetschSelections: [null, null, null, null],
    currentQuetschSeat: null,
    lastTrick: null,
    lastRound: null,
  };
}

function ensureBotQuetschSelections(room) {
  const game = room.game;
  if (!game || game.phase !== "quetsch") return;
  for (let seat = 0; seat < 4; seat++) {
    if (isBotControlledSeat(room, seat) && !game.quetschSelections[seat]) {
      game.quetschSelections[seat] = heuristicQuetschPick(game.gs.hands[seat]);
      log("Bot wählt Quetsch-Karten", { roomCode: room.roomCode, seat });
    }
  }
}

function nextConnectedHumanQuetschSeat(room) {
  const game = room.game;
  if (!game || game.phase !== "quetsch") return null;
  for (let seat = 0; seat < 4; seat++) {
    if (isConnectedHumanSeat(room, seat) && !game.quetschSelections[seat]) return seat;
  }
  return null;
}

function allQuetschSelectionsReady(room) {
  return room.game.quetschSelections.every((selection) => Array.isArray(selection) && selection.length === 3);
}

function startPlayAfterQuetsch(room) {
  const game = room.game;
  const selections = game.quetschSelections.map((sel) => [...sel]);
  game.gs = applyQuetschSelections(game.gs, selections);
  game.quetschSelections = [null, null, null, null];
  game.currentQuetschSeat = null;
  game.phase = "play";
  log("Quetsch beendet", { roomCode: room.roomCode, round: game.round });
}

function finishRound(room) {
  const game = room.game;
  const gs = game.gs;
  const nextScores = game.scores.map((score, seat) => score + gs.roundPts[seat]);

  game.lastRound = {
    round: game.round,
    dealer: game.dealer,
    roundPts: [...gs.roundPts],
    totalScores: [...nextScores],
    tricksWon: [...gs.tricksWon],
  };
  game.scores = nextScores;

  if (game.round >= game.maxRounds) {
    game.phase = "gameover";
    log("Spiel beendet", { roomCode: room.roomCode, scores: game.scores });
    return;
  }

  game.phase = "round_done";
  game.currentQuetschSeat = null;
  log("Runde beendet, wartet auf nächste Runde", {
    roomCode: room.roomCode,
    round: game.round,
    roundPts: game.lastRound.roundPts,
    scores: game.scores,
  });
}

function applyOnlineCard(room, player, card) {
  const game = room.game;
  const legal = getValidCards(game.gs, player);
  if (!legal.some((c) => sameCard(c, card))) throw new Error("Diese Karte darf hier nicht gespielt werden.");

  const next = applyCard(game.gs, player, card);
  if (!next) throw new Error("Die Karte konnte nicht gespielt werden.");

  if (next._trickJustFinished) {
    game.lastTrick = {
      winner: next._trickWinner,
      pts: next._trickNet,
      trick: next._trickCards,
      isFinal: next.tricksPlayed >= 13,
    };
    game.gs = next;
    if (next.tricksPlayed >= 13) finishRound(room);
    else {
      game.gs = clearFinishedTrick(next);
      game.phase = "play";
    }
  } else {
    game.gs = next;
    game.phase = "play";
  }
}

export function advanceNonCardPhases(room) {
  if (!room?.game || room.status !== "playing") return false;
  let changed = false;
  let safety = 0;
  while (room.game.phase === "quetsch") {
    if (++safety > 20) throw new Error("Quetsch-Fortschritt überschreitet Sicherheitslimit.");
    ensureBotQuetschSelections(room);
    changed = true;
    const nextHuman = nextConnectedHumanQuetschSeat(room);
    if (nextHuman !== null) {
      room.game.currentQuetschSeat = nextHuman;
      return changed;
    }
    if (allQuetschSelectionsReady(room)) {
      startPlayAfterQuetsch(room);
      changed = true;
      continue;
    }
    throw new Error("Quetsch-Phase wartet in einem ungültigen Zustand.");
  }
  return changed;
}

export function advanceOneBotCard(room) {
  if (!room?.game || room.status !== "playing") return false;
  advanceNonCardPhases(room);
  const game = room.game;
  if (game.phase !== "play") return false;
  const player = game.gs.currentPlayer;
  if (!isBotControlledSeat(room, player)) return false;
  const card = chooseHeuristicCard(game.gs, player);
  log("Bot spielt Karte", { roomCode: room.roomCode, seat: player, card });
  applyOnlineCard(room, player, card);
  advanceNonCardPhases(room);
  touch(room);
  return true;
}

export function advanceGameUntilHumanDecision(room) {
  if (!room?.game || room.status !== "playing") return;
  let safety = 0;
  while (room.game.phase !== "gameover" && room.game.phase !== "round_done") {
    if (++safety > 250) throw new Error("Spielfortschritt überschreitet Sicherheitslimit.");
    advanceNonCardPhases(room);
    if (room.game.phase !== "play") return;
    const player = room.game.gs.currentPlayer;
    if (!isBotControlledSeat(room, player)) return;
    advanceOneBotCard(room);
  }
}

export function createRoom({ hostSocketId, name }) {
  const roomCode = makeRoomCode();
  const seats = emptySeats();
  seats[0] = {
    seat: 0,
    type: "human",
    name: cleanName(name),
    socketId: hostSocketId,
    reconnectToken: makeToken(),
    disconnected: false,
  };
  const room = {
    roomCode,
    hostSocketId,
    status: "lobby",
    seats,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    game: null,
  };
  rooms.set(roomCode, room);
  log("Raum erstellt", { roomCode, hostSocketId });
  return publicRoomWithToken(room, hostSocketId);
}

export function getInternalRoom(roomCode) {
  return requireRoom(roomCode);
}

export function joinRoom({ roomCode }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  return publicRoom(room);
}

export function claimSeat({ roomCode, socketId, name, seat }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  const seatIndex = Number(seat);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 3) throw new Error("Ungültiger Sitzplatz.");
  const target = room.seats[seatIndex];
  if (target.type !== "open") throw new Error("Dieser Sitzplatz ist nicht frei.");

  for (const s of room.seats) {
    if (s.type === "human" && s.socketId === socketId) {
      s.type = "open";
      s.name = null;
      s.socketId = null;
      s.reconnectToken = null;
      s.disconnected = false;
    }
  }

  target.type = "human";
  target.name = cleanName(name);
  target.socketId = socketId;
  target.reconnectToken = makeToken();
  target.disconnected = false;
  log("Sitzplatz belegt", { roomCode: room.roomCode, seat: seatIndex, socketId });
  return publicRoomWithToken(room, socketId);
}

export function reconnectSeat({ roomCode, socketId, token }) {
  const room = requireRoom(roomCode);
  const seat = findSeatForToken(room, token);
  if (!seat) throw new Error("Wiederverbindung nicht möglich.");
  seat.socketId = socketId;
  seat.disconnected = false;
  if (!room.hostSocketId && seat.reconnectToken === token) room.hostSocketId = socketId;
  log("Spieler wiederverbunden", { roomCode: room.roomCode, seat: seat.seat, socketId });
  return publicRoomWithToken(room, socketId);
}

export function setSeatBot({ roomCode, socketId, seat }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const seatIndex = Number(seat);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 3) throw new Error("Ungültiger Sitzplatz.");
  const target = room.seats[seatIndex];
  if (target.socketId === room.hostSocketId) throw new Error("Der Host-Sitz kann nicht zum Bot werden.");
  if (target.type === "human" && target.socketId) throw new Error("Aktive Menschen können nicht durch Bots ersetzt werden.");
  target.type = "bot";
  target.name = `Bot ${seatIndex + 1}`;
  target.socketId = null;
  target.reconnectToken = null;
  target.disconnected = false;
  log("Sitzplatz auf Bot gesetzt", { roomCode: room.roomCode, seat: seatIndex });
  return publicRoom(room);
}

export function setSeatOpen({ roomCode, socketId, seat }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const seatIndex = Number(seat);
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 3) throw new Error("Ungültiger Sitzplatz.");
  const target = room.seats[seatIndex];
  if (target.socketId === room.hostSocketId) throw new Error("Der Host-Sitz kann nicht geöffnet werden.");
  if (target.type === "human" && target.socketId) throw new Error("Aktive Menschen können nicht entfernt werden.");
  target.type = "open";
  target.name = null;
  target.socketId = null;
  target.reconnectToken = null;
  target.disconnected = false;
  log("Sitzplatz geöffnet", { roomCode: room.roomCode, seat: seatIndex });
  return publicRoom(room);
}

export function startOnlineGame({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const openSeat = room.seats.find((s) => s.type === "open");
  if (openSeat) throw new Error("Alle Plätze müssen mit Menschen oder Bots besetzt sein.");
  const humanCount = room.seats.filter((s) => s.type === "human").length;
  if (humanCount < 1) throw new Error("Mindestens ein Mensch muss mitspielen.");
  const dealer = Math.floor(Math.random() * 4);
  room.status = "playing";
  room.game = createGameState(dealer);
  advanceNonCardPhases(room);
  log("Spiel gestartet", { roomCode: room.roomCode, dealer });
  return room;
}

export function startNextOnlineRound({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  if (room.game.phase !== "round_done") throw new Error("Die nächste Runde kann gerade nicht gestartet werden.");

  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht in diesem Raum.");
  if (room.hostSocketId && room.hostSocketId !== socketId) {
    throw new Error("Nur der Host kann die nächste Runde starten.");
  }

  const game = room.game;
  const nextDealer = (game.dealer + 1) % 4;
  game.round += 1;
  game.dealer = nextDealer;
  game.phase = "quetsch";
  game.gs = dealRound(nextDealer);
  game.quetschSelections = [null, null, null, null];
  game.currentQuetschSeat = null;
  game.lastTrick = null;
  advanceNonCardPhases(room);
  log("Nächste Runde gestartet", { roomCode: room.roomCode, round: game.round, dealer: nextDealer, socketId });
  return room;
}

export function submitOnlineQuetsch({ roomCode, socketId, cards }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  if (room.game.phase !== "quetsch") throw new Error("Es ist gerade keine Quetsch-Phase.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht in diesem Raum.");
  if (room.game.currentQuetschSeat !== seat.seat) throw new Error("Du bist gerade nicht mit Quetschen dran.");
  room.game.quetschSelections[seat.seat] = validateCardsInHand(room.game.gs.hands[seat.seat], cards, 3);
  log("Mensch wählt Quetsch-Karten", { roomCode: room.roomCode, seat: seat.seat });
  advanceNonCardPhases(room);
  return room;
}

export function playOnlineCard({ roomCode, socketId, card }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  if (room.game.phase !== "play") throw new Error("Es ist gerade keine Kartenphase.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht in diesem Raum.");
  if (room.game.gs.currentPlayer !== seat.seat) throw new Error("Du bist nicht am Zug.");
  const hand = room.game.gs.hands[seat.seat];
  const [validated] = validateCardsInHand(hand, [card], 1);
  applyOnlineCard(room, seat.seat, validated);
  log("Mensch spielt Karte", { roomCode: room.roomCode, seat: seat.seat, card: validated });
  advanceNonCardPhases(room);
  return room;
}

export function getPrivateGameView(room, socketId) {
  if (!room?.game) return null;
  const seat = findSeatForSocket(room, socketId);
  const seatIndex = seat?.seat ?? null;
  const game = room.game;
  const gs = game.gs;
  const names = room.seats.map((s) => s.name || (s.type === "bot" ? `Bot ${s.seat + 1}` : `Platz ${s.seat + 1}`));
  const seatTypes = room.seats.map((s) => (s.type === "human" && s.disconnected ? "bot" : s.type));
  const hand = seatIndex === null ? [] : sortHand(gs.hands[seatIndex] || []);
  const validCards = seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex ? getValidCards(gs, seatIndex) : [];
  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));
  return {
    phase: game.phase,
    yourSeat: seatIndex,
    round: game.round,
    maxRounds: game.maxRounds,
    names,
    seatTypes,
    dealer: gs.dealer,
    currentPlayer: game.phase === "play" ? gs.currentPlayer : null,
    currentQuetschSeat: game.phase === "quetsch" ? game.currentQuetschSeat : null,
    quetschNeeded: game.phase === "quetsch" && seatIndex !== null && game.currentQuetschSeat === seatIndex,
    quetschTarget: seatIndex !== null ? (seatIndex + 1) % 4 : null,
    hand,
    validCards,
    trick: gs.trick,
    leadSuit: gs.leadSuit,
    tricksPlayed: gs.tricksPlayed,
    roundPts: gs.roundPts,
    runScores,
    scores: game.scores,
    tricksWon: gs.tricksWon,
    penaltyPlayed: gs.penaltyPlayed,
    lastTrick: game.lastTrick,
    lastRound: game.lastRound,
    cardPointPreview: hand.reduce((acc, c) => ({ ...acc, [`${c.s}${c.v}`]: cardPts(c) }), {}),
    canStartNextRound: game.phase === "round_done" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId),
  };
}

export function leaveRoom({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  const isHost = room.hostSocketId === socketId;
  if (isHost && room.status === "lobby") {
    rooms.delete(room.roomCode);
    log("Host verlässt Lobby, Raum geschlossen", { roomCode: room.roomCode });
    return { closed: true, roomCode: room.roomCode };
  }
  for (const s of room.seats) {
    if (s.type === "human" && s.socketId === socketId) {
      s.socketId = null;
      s.disconnected = true;
    }
  }
  if (isHost) room.hostSocketId = null;
  advanceNonCardPhases(room);
  log("Spieler verlässt Raum", { roomCode: room.roomCode, socketId });
  return { closed: false, room: publicRoom(room) };
}

export function leaveAllRoomsForSocket(socketId) {
  const results = [];
  for (const room of [...rooms.values()]) {
    const isInRoom = room.hostSocketId === socketId || room.seats.some((s) => s.socketId === socketId);
    if (!isInRoom) continue;
    if (room.hostSocketId === socketId && room.status === "lobby") {
      rooms.delete(room.roomCode);
      results.push({ closed: true, roomCode: room.roomCode });
      log("Host getrennt, Lobby geschlossen", { roomCode: room.roomCode });
    } else {
      for (const s of room.seats) {
        if (s.type === "human" && s.socketId === socketId) {
          s.socketId = null;
          s.disconnected = true;
        }
      }
      if (room.hostSocketId === socketId) room.hostSocketId = null;
      if (room.status === "playing" && room.game) advanceNonCardPhases(room);
      results.push({ closed: false, room: publicRoom(room) });
      log("Spieler getrennt", { roomCode: room.roomCode, socketId });
    }
  }
  return results;
}

export function pruneExpiredRooms(now = Date.now()) {
  const expired = [];
  for (const room of [...rooms.values()]) {
    if (now - room.lastActivity > ROOM_TTL_MS) {
      rooms.delete(room.roomCode);
      expired.push(room.roomCode);
      log("Raum wegen Inaktivität entfernt", { roomCode: room.roomCode });
    }
  }
  return expired;
}
