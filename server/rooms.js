import crypto from "crypto";
import {
  dealRound,
  applyCard,
  applyQuetschSelections,
  clearFinishedTrick,
  getValidCards,
} from "../shared/game/engine.js";
import {
  BOT_TARGETING_PROFILE_LEADER_HUNTER,
  BOT_TARGETING_PROFILE_NEUTRAL,
  BOT_TARGETING_PROFILE_NORMAL,
  heuristicQuetschPick,
  chooseHeuristicCard,
  recommendHeuristicCards,
  recommendHeuristicQuetschCards,
} from "../shared/game/heuristicBot.js";
import {
  chooseRlCard,
  rlQuetschPick,
} from "../shared/game/rlBot.js";
import {
  chooseNonResidualRlCard,
  nonResidualRlQuetschPick,
} from "../shared/game/nonResidualRlBot.js";
import { sameCard, sortHand, cardPts, isPenalty, makeSeededRng } from "../shared/game/cards.js";
import {
  BENCHMARK_DECKS,
  FIXED_BENCHMARK_ROUNDS,
  benchmarkRoundSeed,
  getBenchmarkDeck,
  normalizeBenchmarkDeckId,
} from "../shared/game/benchmarkDecks.js";

const rooms = new Map();
const benchmarkHighscores = new Map();
const GAMES_PER_RUNDE = 4;
const DEFAULT_MATCH_RUNDEN = Number(process.env.DEFAULT_MATCH_RUNDEN || 1);
const MAX_ROUNDS = GAMES_PER_RUNDE * (DEFAULT_MATCH_RUNDEN === 1 ? 1 : 2);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 30 * 60 * 1000);
const QUETSCH_REVIEW_MS = Number(process.env.QUETSCH_REVIEW_MS || 2600);
// Delay after the fourth card of a trick is visible before the next trick starts.
const TRICK_DISPLAY_MS = Number(process.env.TRICK_DISPLAY_MS || process.env.TRICK_REVIEW_MS || 1400);
const FINAL_TRICK_DISPLAY_MS = Number(process.env.FINAL_TRICK_DISPLAY_MS || Math.max(TRICK_DISPLAY_MS, 2600));
const DISCONNECTED_HUMAN_BOT_DELAY_MS = Number(process.env.DISCONNECTED_HUMAN_BOT_DELAY_MS || 20_000);
const REST_CLAIM_MIN_TRICKS = 2;
const REST_CLAIM_MAX_TRICKS = 4;
const REST_CLAIM_REVEAL_MS = Number(process.env.REST_CLAIM_REVEAL_MS || 1250);
const QUICK_GAME_DELAY_FACTOR = (() => {
  const value = Number(process.env.QUICK_GAME_DELAY_FACTOR ?? 0.62);
  return Number.isFinite(value) && value > 0 ? value : 0.62;
})();
const COMMENT_TTL_MS = 5_000;
const COMMENT_MAX_LENGTH = 80;
const COMMENT_CHOICES = [
  "Klassischer Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];
const BOT_PLAY_POLICY = String(process.env.BOT_PLAY_POLICY || "rl").trim().toLowerCase();

const envFlagEnabled = (value) =>
  value === undefined || value === null || String(value).trim().toLowerCase() !== "false";

// This flag controls only whether the Easy Mode checkbox is advertised/shown.
// Easy Mode itself remains available for hidden URL-based access.
export const EASY_MODE_FEATURE_ENABLED =
  envFlagEnabled(process.env.ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(process.env.VITE_EASY_MODE_ENABLED);

// Wuzz tweak: old German first-name pool for bot seats.
const BOT_FIRST_NAMES = [
  "Ferdi",
  "Leopold",
  "Wilhelm",
  "Heinrich",
  "Albert",
  "Otto",
  "Peter",
  "Thomas",
  "Sigrun",
  "Ludwig",
  "Adelheid",
  "Mathilde",
  "Gerhild",
  "Ottilie",
  "Therese",
  "Oda",
  "Auguste",
  "Ursula",
  "Else",
  "Ingrid",
  "Günther",
  "Vollrath",
  "Millicent",
  "Jaspar",
  "Hasso",
  "Bia",
  "Asta",
  "Thora",
  "Benedikt",
  "Mary",
  "Dorothea",
];
function randomBotName(room) {
  const usedBase = new Set((room?.seats || []).map(s => String(s.name || '').replace(/\s*\(B\)$/, '')));
  const available = BOT_FIRST_NAMES.filter(name => !usedBase.has(name));
  const pool = available.length ? available : BOT_FIRST_NAMES;
  return pool[Math.floor(Math.random() * pool.length)] + ' (B)';
}

const botBaseName = (name) => String(name || "").replace(/\s*\(B\)\s*$/, "").trim();
const parseBotNameSet = (value, fallback = "") => new Set(
  String(value ?? fallback)
    .split(",")
    .map(botBaseName)
    .filter(Boolean)
);

const LEADER_HUNTER_BOT_NAMES = parseBotNameSet(process.env.BOT_LEADER_HUNTER_NAMES, "Vollrath");
const NEUTRAL_BOT_NAMES = parseBotNameSet(process.env.BOT_NEUTRAL_NAMES);

function botTargetingProfileForSeat(room, seatIndex) {
  const seat = room?.seats?.[seatIndex];
  if (seat?.type !== "bot") return BOT_TARGETING_PROFILE_NORMAL;

  const name = botBaseName(seat.name);
  if (LEADER_HUNTER_BOT_NAMES.has(name)) return BOT_TARGETING_PROFILE_LEADER_HUNTER;
  if (NEUTRAL_BOT_NAMES.has(name)) return BOT_TARGETING_PROFILE_NEUTRAL;
  return BOT_TARGETING_PROFILE_NORMAL;
}

function botTargetingProfiles(room) {
  return [0, 1, 2, 3].map((seat) => botTargetingProfileForSeat(room, seat));
}


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
  throw new Error("Kein eindeutiger Tischcode konnte erstellt werden.");
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
    disconnectedAt: null,
    botControlAfter: null,
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
  if (!room) throw new Error("Tisch nicht gefunden.");
  touch(room);
  return room;
}

function requireHost(room, socketId) {
  if (room.hostSocketId !== socketId) throw new Error("Das darf nur die Spielleitung machen.");
}

function assertLobby(room) {
  if (room.status !== "lobby") throw new Error("Der Tisch ist nicht mehr in der Lobby.");
}

function normalizeMatchRutschen(value) {
  return Number(value) === 1 ? 1 : 2;
}

function defaultRoomSettings(settings = {}) {
  const benchmarkDeckId = normalizeBenchmarkDeckId(settings.benchmarkDeckId);
  return {
    matchRutschen: benchmarkDeckId ? 2 : normalizeMatchRutschen(settings.matchRutschen ?? DEFAULT_MATCH_RUNDEN),
    showPenaltyTracker: settings.showPenaltyTracker !== false,
    easyMode: settings.easyMode === true,
    quickGame: settings.quickGame !== false,
    publicTable: benchmarkDeckId ? false : settings.publicTable !== false,
    benchmarkDeckId,
  };
}

function quickGameDelayMs(room, normalMs) {
  const base = Number(normalMs);
  if (!Number.isFinite(base)) return normalMs;
  const settings = defaultRoomSettings(room?.settings);
  if (!settings.quickGame) return Math.max(0, base);
  return Math.max(450, Math.round(base * QUICK_GAME_DELAY_FACTOR));
}

function restClaimRevealDelayMs(_room) {
  const base = Number(REST_CLAIM_REVEAL_MS);
  return Number.isFinite(base) ? Math.max(0, base) : 1250;
}

export function publicRoom(room) {
  return {
    roomCode: room.roomCode,
    hostSocketId: room.hostSocketId,
    hostSeat: Number.isInteger(room.hostSeat) ? room.hostSeat : 0,
    status: room.status,
    seats: room.seats.map((s) => ({
      seat: s.seat,
      type: s.type,
      name: s.name,
      socketId: s.socketId,
      disconnected: Boolean(s.disconnected),
      botControlled: isBotControlledSeat(room, s.seat),
      botControlAvailableAt: s.disconnected ? (s.botControlAfter || null) : null,
      isHost: Boolean(s.socketId && s.socketId === room.hostSocketId),
    })),
    createdAt: room.createdAt,
    lastActivity: room.lastActivity,
    settings: defaultRoomSettings(room.settings),
    spectatorCount: room.spectators?.size || 0,
  };
}

function privateTokenForSocket(room, socketId) {
  const seat = findSeatForSocket(room, socketId);
  return seat?.reconnectToken || null;
}

export function publicRoomWithToken(room, socketId) {
  return { room: publicRoom(room), reconnectToken: privateTokenForSocket(room, socketId) };
}

export function listBenchmarkDecks() {
  return BENCHMARK_DECKS.map((deck) => ({
    id: deck.id,
    name: deck.name,
    description: deck.description,
    rounds: FIXED_BENCHMARK_ROUNDS,
  }));
}

export function getBenchmarkHighscores() {
  const out = {};
  for (const deck of BENCHMARK_DECKS) {
    out[deck.id] = benchmarkHighscoreSnapshot(benchmarkHighscores.get(deck.id));
  }
  return out;
}

function roomHostName(room) {
  const hostSeatIndex = Number.isInteger(room?.hostSeat) ? room.hostSeat : 0;
  const originalHost = room?.seats?.[hostSeatIndex]?.name;
  if (originalHost) return originalHost;
  const connectedHost = room?.seats?.find((seat) => seat.socketId && seat.socketId === room.hostSocketId)?.name;
  if (connectedHost) return connectedHost;
  return room?.seats?.find((seat) => seat.type === "human" && seat.name)?.name || "Host";
}

function roomIsVisiblePublicTable(room) {
  if (!defaultRoomSettings(room.settings).publicTable) return false;
  if (room.status === "playing" && room.game) return true;
  return room.status === "lobby";
}

export function listPublicTables() {
  return [...rooms.values()]
    .filter(roomIsVisiblePublicTable)
    .map((room) => {
      const settings = defaultRoomSettings(room.settings);
      const isPlaying = room.status === "playing" && room.game;
      const deck = getBenchmarkDeck(settings.benchmarkDeckId);
      const highscore = deck ? benchmarkHighscoreSnapshot(benchmarkHighscores.get(deck.id)) : null;
      return {
        roomCode: room.roomCode,
        status: room.status,
        hostName: roomHostName(room),
        humanPlayers: room.seats.filter((seat) => seat.type === "human").length,
        connectedHumanPlayers: room.seats.filter((seat) => seat.type === "human" && Boolean(seat.socketId)).length,
        openSeats: room.seats.filter((seat) => seat.type === "open").length,
        availableBotSeats: room.seats.filter((seat) => seat.type === "bot").length,
        spectatorCount: room.spectators?.size || 0,
        round: isPlaying ? Number(room.game?.round || 1) : null,
        maxRounds: isPlaying ? Number(room.game?.maxRounds || 1) : GAMES_PER_RUNDE * settings.matchRutschen,
        phase: isPlaying ? (room.game?.phase || null) : null,
        startedAt: isPlaying ? (room.startedAt || room.createdAt) : room.createdAt,
        benchmarkDeck: deck ? {
          id: deck.id,
          name: deck.name,
          description: deck.description,
          rounds: FIXED_BENCHMARK_ROUNDS,
          highscore,
        } : null,
      };
    })
    .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
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

function hasConnectedHumanPlayers(room) {
  return Boolean(room?.seats?.some((s) => s.type === "human" && Boolean(s.socketId)));
}

function isDisconnectedHumanBotReady(seat, now = Date.now()) {
  return seat?.type === "human" && !seat.socketId && Boolean(seat.disconnected) &&
    Number.isFinite(Number(seat.botControlAfter)) && now >= Number(seat.botControlAfter);
}

function isBotControlledSeat(room, seat) {
  const s = room.seats[seat];
  return s?.type === "bot" || isDisconnectedHumanBotReady(s);
}

export function nextDisconnectedBotControlAt(room) {
  if (!room?.seats) return null;
  const futureTimes = room.seats
    .filter((s) => s.type === "human" && !s.socketId && Boolean(s.disconnected) && Number.isFinite(Number(s.botControlAfter)))
    .map((s) => Number(s.botControlAfter));
  return futureTimes.length ? Math.min(...futureTimes) : null;
}

function publicScoresForBot(room) {
  const scores = room?.game?.scores || [0, 0, 0, 0];
  const roundScores = room?.game?.gs?.roundPts || [0, 0, 0, 0];
  return {
    scores: [...scores],
    roundScores: [...roundScores],
    projectedScores: scores.map((score, i) => score + (roundScores[i] || 0)),
    scoreHigherIsBetter: true,
  };
}

function botDecisionGameState(room) {
  return {
    ...room.game.gs,
    ...publicScoresForBot(room),
    botTargetingProfiles: botTargetingProfiles(room),
  };
}

function chooseBotQuetschCards(hand, gs, seat) {
  if (BOT_PLAY_POLICY === "heuristic") return heuristicQuetschPick(hand, gs, seat);
  if (BOT_PLAY_POLICY === "nonresidual") return nonResidualRlQuetschPick(hand, gs, seat);
  return rlQuetschPick(hand, gs, seat);
}

function chooseBotCard(gs, player) {
  if (BOT_PLAY_POLICY === "heuristic") return chooseHeuristicCard(gs, player);
  if (BOT_PLAY_POLICY === "nonresidual") return chooseNonResidualRlCard(gs, player);
  return chooseRlCard(gs, player);
}

function playerOwnsDisconnectedSeat(seat, token, name) {
  if (!seat || seat.type !== "human" || seat.socketId || !seat.disconnected) return false;
  if (token && seat.reconnectToken && seat.reconnectToken === token) return true;
  return Boolean(name) && cleanName(name) === seat.name;
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

function dealRoundForSettings(settings, round, dealer) {
  const roomSettings = defaultRoomSettings(settings);
  if (roomSettings.benchmarkDeckId) {
    const seed = benchmarkRoundSeed(roomSettings.benchmarkDeckId, round);
    if (seed !== null) return dealRound(dealer, makeSeededRng(seed));
  }
  return dealRound(dealer);
}

function createGameState(dealer, settings = {}) {
  const roomSettings = defaultRoomSettings(settings);
  const benchmarkDeck = getBenchmarkDeck(roomSettings.benchmarkDeckId);
  return {
    round: 1,
    maxRounds: benchmarkDeck ? FIXED_BENCHMARK_ROUNDS : GAMES_PER_RUNDE * roomSettings.matchRutschen,
    matchRutschen: roomSettings.matchRutschen,
    benchmarkDeckId: benchmarkDeck?.id || null,
    scores: [0, 0, 0, 0],
    scoreHistory: [{ round: 0, roundPts: [0, 0, 0, 0], totalScores: [0, 0, 0, 0] }],
    dealer,
    phase: "quetsch", // "quetsch" | "quetsch_review" | "trick_done" | "rest_claim_pending" | "rest_claim_reveal" | "play" | "round_done" | "gameover"
    gs: dealRoundForSettings(roomSettings, 1, dealer),
    quetschSelections: [null, null, null, null],
    quetschReceived: [[], [], [], []],
    quetschReviewUntil: null,
    currentQuetschSeat: null,
    lastTrick: null,
    // Compact trick-by-trick review for the current Spiel. It stays server-side
    // during live play and is only sent as part of lastRound once the Spiel ends.
    spielLog: [],
    // During the completed-trick pause, keep lastTrick as the previous
    // trick.  The just-finished trick stays on the table and moves here only
    // after the pause, so the previous trick display does not jump early.
    pendingLastTrick: null,
    trickReviewUntil: null,
    lastRound: null,
    lastRestClaim: null,
    restClaimRequest: null,
    restClaimReveal: null,
    comments: [],
    quetschGiftSources: [],
  };
}

function ensureBotQuetschSelections(room) {
  const game = room.game;
  if (!game || game.phase !== "quetsch") return;
  for (let seat = 0; seat < 4; seat++) {
    if (isBotControlledSeat(room, seat) && !game.quetschSelections[seat]) {
      const decisionGs = botDecisionGameState(room);
      game.quetschSelections[seat] = chooseBotQuetschCards(game.gs.hands[seat], decisionGs, seat);
      log("Bot wählt Quetsch-Karten", {
        roomCode: room.roomCode,
        seat,
        botPolicy: BOT_PLAY_POLICY,
        botTargetingProfile: decisionGs.botTargetingProfiles?.[seat],
      });
    }
  }
}

function pendingHumanQuetschSeats(room) {
  const game = room.game;
  if (!game || game.phase !== "quetsch") return [];
  const pending = [];
  for (let seat = 0; seat < 4; seat++) {
    if (isConnectedHumanSeat(room, seat) && !game.quetschSelections[seat]) pending.push(seat);
  }
  return pending;
}

function allQuetschSelectionsReady(room) {
  return room.game.quetschSelections.every((selection) => Array.isArray(selection) && selection.length === 3);
}

function visibleQuetschReceivedForSeat(game, seatIndex) {
  if (!game || seatIndex === null || seatIndex === undefined) return [];

  if (game.phase === "quetsch") {
    const hasSubmittedOwnQuetsch = Array.isArray(game.quetschSelections?.[seatIndex]);
    if (!hasSubmittedOwnQuetsch) return [];

    const sourceSeat = (seatIndex + 3) % 4;
    const sourceSelection = game.quetschSelections?.[sourceSeat];
    return Array.isArray(sourceSelection) && sourceSelection.length === 3
      ? sourceSelection.map((card) => ({ ...card }))
      : [];
  }

  return Array.isArray(game.quetschReceived?.[seatIndex])
    ? game.quetschReceived[seatIndex].map((card) => ({ ...card }))
    : [];
}


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

function startQuetschReview(room) {
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
  game.quetschGiftSources = quetschGiftSources;
  game.quetschSelections = [null, null, null, null];
  game.currentQuetschSeat = null;
  game.quetschReviewUntil = Date.now() + QUETSCH_REVIEW_MS;
  game.phase = "quetsch_review";
  log("Quetsch beendet, zeige neue Karten", { roomCode: room.roomCode, round: game.round });
}

function finishQuetschReview(room) {
  const game = room.game;
  if (!game || game.phase !== "quetsch_review") return false;
  if (Date.now() < (game.quetschReviewUntil || 0)) return false;
  game.phase = "play";
  game.quetschReviewUntil = null;
  log("Spielphase nach Quetsch-Anzeige gestartet", { roomCode: room.roomCode, round: game.round });
  return true;
}

function finishTrickReview(room) {
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
}

function benchmarkHighscoreSnapshot(entry) {
  if (!entry) return null;
  return {
    deckId: entry.deckId,
    deckName: entry.deckName,
    playerName: entry.playerName,
    seat: entry.seat,
    score: entry.score,
    completedAt: entry.completedAt,
    roomCode: entry.roomCode,
    humanPlayers: entry.humanPlayers,
  };
}

function maybeRecordBenchmarkHighscore(room) {
  const game = room?.game;
  const deck = getBenchmarkDeck(game?.benchmarkDeckId);
  if (!deck || game?.phase !== "gameover") return false;
  if (Number(game.round || 0) < FIXED_BENCHMARK_ROUNDS) return false;

  const candidates = room.seats
    .filter((seat) => seat.type === "human")
    .map((seat) => ({
      deckId: deck.id,
      deckName: deck.name,
      playerName: seat.name || ("Platz " + (seat.seat + 1)),
      seat: seat.seat,
      score: Number(game.scores?.[seat.seat] || 0),
      completedAt: Date.now(),
      roomCode: room.roomCode,
      humanPlayers: room.seats.filter((s) => s.type === "human").length,
    }))
    .sort((a, b) => b.score - a.score || a.seat - b.seat);

  const candidate = candidates[0] || null;
  if (!candidate) return false;

  const current = benchmarkHighscores.get(deck.id);
  if (current && Number(current.score || 0) >= candidate.score) return false;
  benchmarkHighscores.set(deck.id, candidate);
  log("Benchmark-Highscore aktualisiert", { deckId: deck.id, playerName: candidate.playerName, score: candidate.score });
  return true;
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
    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,
    spielLog: sanitizeSpielLog(game.spielLog),
  };
  if (!Array.isArray(game.scoreHistory) || game.scoreHistory.length === 0) {
    game.scoreHistory = [{ round: 0, roundPts: [0, 0, 0, 0], totalScores: [0, 0, 0, 0] }];
  }
  game.scoreHistory = [
    ...game.scoreHistory.filter((entry) => Number(entry?.round) !== Number(game.round)),
    { round: game.round, roundPts: [...gs.roundPts], totalScores: [...nextScores] },
  ].sort((a, b) => Number(a.round || 0) - Number(b.round || 0));
  game.scores = nextScores;

  if (game.round >= game.maxRounds) {
    game.phase = "gameover";
    maybeRecordBenchmarkHighscore(room);
    log("Spiel beendet", { roomCode: room.roomCode, scores: game.scores });
    return;
  }

  game.phase = "round_done";
  game.currentQuetschSeat = null;
  log("Rutsche beendet, wartet auf nächste Rutsche", {
    roomCode: room.roomCode,
    round: game.round,
    roundPts: game.lastRound.roundPts,
    scores: game.scores,
  });
}

function seatDisplayName(room, seat) {
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

function applyOnlineCard(room, player, card) {
  const game = room.game;
  const legal = getValidCards(game.gs, player);
  if (!legal.some((c) => sameCard(c, card))) throw new Error("Diese Karte darf hier nicht gespielt werden.");

  const gsBefore = game.gs;
  const next = applyCard(gsBefore, player, card);
  if (!next) throw new Error("Die Karte konnte nicht gespielt werden.");

  if (next._trickJustFinished) {
    maybeAddBotCommentForFinishedTrick(room, gsBefore, next);
    appendSpielLogTrick(game, {
      trickNo: next.tricksPlayed,
      leader: next._trickCards?.[0]?.player,
      winner: next._trickWinner,
      pts: next._trickNet,
      trick: next._trickCards,
    });
    const isFinalTrick = next.tricksPlayed >= 13;
    const reviewDelayMs = quickGameDelayMs(room, isFinalTrick ? FINAL_TRICK_DISPLAY_MS : TRICK_DISPLAY_MS);
    game.pendingLastTrick = {
      winner: next._trickWinner,
      pts: next._trickNet,
      trick: next._trickCards,
      isFinal: isFinalTrick,
    };
    game.trickReviewUntil = Date.now() + reviewDelayMs;
    game.phase = "trick_done";
    game.gs = next;
  } else {
    game.gs = next;
    game.phase = "play";
  }
}

function cleanCommentText(text) {
  const raw = String(text || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return null;
  return raw.slice(0, COMMENT_MAX_LENGTH);
}

function connectedPureHumanRoom(room) {
  return Boolean(room?.seats?.length === 4) && room.seats.every((seat, idx) => (
    seat?.type === "human" && Boolean(seat.socketId) && !isBotControlledSeat(room, idx)
  ));
}

function restClaimBaseLegal(game, claimantSeat) {
  if (!game || game.phase !== "play") return false;
  if (!Number.isInteger(claimantSeat) || claimantSeat < 0 || claimantSeat > 3) return false;
  const gs = game.gs;
  if (!gs || gs.currentPlayer !== claimantSeat) return false;
  if (Array.isArray(gs.trick) && gs.trick.length > 0) return false;
  const claimantCards = Array.isArray(gs.hands?.[claimantSeat]) ? gs.hands[claimantSeat].length : 0;
  if (claimantCards < REST_CLAIM_MIN_TRICKS || claimantCards > REST_CLAIM_MAX_TRICKS) return false;
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

function mustWinEveryRemainingTrick(gs, claimantSeat, depth = 0) {
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

function oneClaimWinningLine(gs, claimantSeat, depth = 0) {
  if (!gs || depth > 80) return null;
  if ((gs.tricksPlayed || 0) >= 13) return [];

  const player = gs.currentPlayer;
  if (!Number.isInteger(player) || player < 0 || player > 3) return null;
  const legal = getValidCards(gs, player);
  if (!legal.length) return (gs.tricksPlayed || 0) >= 13 ? [] : null;

  for (const card of legal) {
    const next = applyCard(gs, player, card);
    if (!next) continue;

    if (next._trickJustFinished) {
      if (next._trickWinner !== claimantSeat) continue;
      const trick = {
        leader: next._trickCards?.[0]?.player ?? claimantSeat,
        winner: claimantSeat,
        pts: next._trickNet || 0,
        trick: (next._trickCards || []).map((play) => ({ player: play.player, card: { ...play.card } })),
      };
      if ((next.tricksPlayed || 0) >= 13) return [trick];
      const rest = oneClaimWinningLine(clearFinishedTrick(next), claimantSeat, depth + 1);
      if (rest) return [trick, ...rest];
      continue;
    }

    const rest = oneClaimWinningLine(next, claimantSeat, depth + 1);
    if (rest) return rest;
  }

  return null;
}

function buildClaimantLedClaimLine(gs, claimantSeat) {
  const hands = gs.hands.map((hand) => hand.map((card) => ({ ...card })));
  const remainingTricks = hands[claimantSeat]?.length || 0;
  const tricks = [];

  for (let trickNo = 0; trickNo < remainingTricks; trickNo++) {
    const claimantCard = hands[claimantSeat].shift();
    if (!claimantCard) break;
    const leadSuit = claimantCard.s;
    const trick = [{ player: claimantSeat, card: claimantCard }];

    for (let offset = 1; offset < 4; offset++) {
      const player = (claimantSeat + offset) % 4;
      const followIdx = hands[player].findIndex((card) => card.s === leadSuit);
      const idx = followIdx >= 0 ? followIdx : 0;
      const [card] = hands[player].splice(idx, 1);
      if (card) trick.push({ player, card });
    }

    tricks.push({
      leader: claimantSeat,
      winner: claimantSeat,
      pts: trick.reduce((sum, play) => sum + cardPts(play.card), 0) + 10,
      trick,
    });
  }

  return tricks;
}

function renumberClaimTricks(tricks, firstTrickNo) {
  return tricks.map((trick, idx) => ({
    ...trick,
    index: idx,
    trickNo: firstTrickNo + idx,
    trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),
  }));
}

function canClaimRestForSeat(room, claimantSeat) {
  const game = room?.game;
  if (!restClaimBaseLegal(game, claimantSeat)) return false;
  return canForceEveryRemainingTrick(game.gs, claimantSeat);
}

function canStartHumanRestClaim(room, claimantSeat) {
  return connectedPureHumanRoom(room) && restClaimBaseLegal(room?.game, claimantSeat);
}

function canShowRestClaimButton(room, claimantSeat) {
  return canClaimRestForSeat(room, claimantSeat) || canStartHumanRestClaim(room, claimantSeat);
}

function finishRestClaimReveal(room) {
  const game = room.game;
  if (!game?.restClaimReveal) return false;
  const reveal = game.restClaimReveal;
  game.lastTrick = reveal.tricks?.[reveal.tricks.length - 1]
    ? { ...reveal.tricks[reveal.tricks.length - 1], isFinal: true, claimedRest: true }
    : game.lastTrick;
  game.pendingLastTrick = null;
  game.restClaimReveal = null;
  finishRound(room);
  return true;
}

function stepRestClaimRevealForward(room) {
  const game = room.game;
  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;

  const reveal = game.restClaimReveal;
  if ((reveal.activeIndex || 0) < (reveal.tricks?.length || 1) - 1) {
    reveal.activeIndex = (reveal.activeIndex || 0) + 1;
    reveal.paused = false;
    reveal.pausedAt = null;
    reveal.revealUntil = Date.now() + restClaimRevealDelayMs(room);
    return true;
  }

  return finishRestClaimReveal(room);
}

function advanceRestClaimReveal(room) {
  const game = room.game;
  if (!game || game.phase !== "rest_claim_reveal" || !game.restClaimReveal) return false;
  if (game.restClaimReveal.paused) return false;
  if (Date.now() < (game.restClaimReveal.revealUntil || 0)) return false;
  return stepRestClaimRevealForward(room);
}

function requireRestClaimRevealPlayer(room, socketId) {
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Nur mitspielende Personen können die Restanzeige steuern.");
  if (room.status !== "playing" || !room.game || room.game.phase !== "rest_claim_reveal" || !room.game.restClaimReveal) {
    throw new Error("Es läuft gerade keine Restanzeige.");
  }
  return seat;
}

function applyRestClaim(room, claimantSeat, source = "manual", options = {}) {
  const forceSafe = options.forceSafe !== false;
  const game = room.game;
  if (!restClaimBaseLegal(game, claimantSeat)) {
    throw new Error("Rest zu mir ist gerade nicht möglich.");
  }
  if (forceSafe && !canClaimRestForSeat(room, claimantSeat)) {
    throw new Error("Rest zu mir ist gerade nicht sicher möglich.");
  }

  const gs = game.gs;
  const remainingTricks = gs.hands[claimantSeat].length;
  const firstClaimTrickNo = (gs.tricksPlayed || 0) + 1;
  const safeLine = canClaimRestForSeat(room, claimantSeat) ? oneClaimWinningLine(gs, claimantSeat) : null;
  const rawTricks = safeLine?.length ? safeLine : buildClaimantLedClaimLine(gs, claimantSeat);
  const claimTricks = renumberClaimTricks(rawTricks, firstClaimTrickNo);
  const claimCards = claimTricks.flatMap((trick) => trick.trick.map((play) => ({ ...play.card })));
  const claimPts = claimCards.reduce((sum, card) => sum + cardPts(card), 0) + claimTricks.length * 10;
  game.spielLog = [
    ...sanitizeSpielLog(game.spielLog),
    ...claimTricks.map((trick) => normalizeSpielLogTrick({ ...trick, claimedRest: true })).filter(Boolean),
  ].slice(0, 13);
  const nextRoundPts = gs.roundPts.map((pts, seat) => seat === claimantSeat ? pts + claimPts : pts);
  const nextTricksWon = gs.tricksWon.map((count, seat) => seat === claimantSeat ? count + remainingTricks : count);

  game.lastRestClaim = {
    seat: claimantSeat,
    name: room.seats[claimantSeat]?.name || ("Platz " + (claimantSeat + 1)),
    remainingTricks,
    pts: claimPts,
    source,
    safeLine: Boolean(safeLine?.length),
    tricks: claimTricks,
  };
  game.restClaimRequest = null;
  game.restClaimReveal = {
    claimantSeat,
    name: game.lastRestClaim.name,
    remainingTricks,
    pts: claimPts,
    source,
    activeIndex: 0,
    revealUntil: Date.now() + restClaimRevealDelayMs(room),
    paused: false,
    pausedAt: null,
    tricks: claimTricks,
  };
  game.lastTrick = claimTricks[0]
    ? { ...claimTricks[0], claimedRest: true, remainingTricks, isFinal: claimTricks.length === 1 }
    : null;
  game.pendingLastTrick = null;
  game.trickReviewUntil = null;
  game.phase = "rest_claim_reveal";
  game.gs = {
    ...gs,
    hands: gs.hands.map(() => []),
    trick: [],
    leadSuit: null,
    currentPlayer: claimantSeat,
    tricksPlayed: Math.min(13, (gs.tricksPlayed || 0) + remainingTricks),
    roundPts: nextRoundPts,
    tricksWon: nextTricksWon,
    penaltyPlayed: [...(gs.penaltyPlayed || []), ...claimCards.filter(isPenalty)],
    trickHistory: [...(gs.trickHistory || []), ...claimCards],
    _trickJustFinished: false,
    _trickWinner: undefined,
    _trickNet: undefined,
    _trickCards: undefined,
  };

  log("Rest wurde geclaimt", { roomCode: room.roomCode, seat: claimantSeat, remainingTricks, claimPts, source });
}

export function advanceNonCardPhases(room) {
  if (!room?.game || room.status !== "playing") return false;
  let changed = false;

  if (room.game.phase === "quetsch") {
    ensureBotQuetschSelections(room);
    changed = true;
    const pendingHumans = pendingHumanQuetschSeats(room);
    room.game.currentQuetschSeat = pendingHumans[0] ?? null;
    if (allQuetschSelectionsReady(room)) {
      startQuetschReview(room);
      changed = true;
    }
  }

  if (room.game.phase === "quetsch_review") {
    changed = finishQuetschReview(room) || changed;
  }
  if (room.game.phase === "trick_done") {
    changed = finishTrickReview(room) || changed;
  }
  if (room.game.phase === "rest_claim_reveal") {
    changed = advanceRestClaimReveal(room) || changed;
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
  if (canBotAutoClaimRest(room, player)) {
    applyRestClaim(room, player, "bot");
    advanceNonCardPhases(room);
    touch(room);
    return true;
  }

  const decisionGs = botDecisionGameState(room);
  const card = chooseBotCard(decisionGs, player);
  log("Bot spielt Karte", {
    roomCode: room.roomCode,
    seat: player,
    card,
    botPolicy: BOT_PLAY_POLICY,
    botTargetingProfile: decisionGs.botTargetingProfiles?.[player],
  });
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

export function createRoom({ hostSocketId, name, settings = {} }) {
  const roomCode = makeRoomCode();
  const seats = emptySeats();
  seats[0] = {
    seat: 0,
    type: "human",
    name: cleanName(name),
    socketId: hostSocketId,
    reconnectToken: makeToken(),
    disconnected: false,
    disconnectedAt: null,
    botControlAfter: null,
  };
  const room = {
    roomCode,
    hostSocketId,
    hostSeat: 0,
    status: "lobby",
    seats,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    startedAt: null,
    settings: defaultRoomSettings(settings),
    spectators: new Set(),
    game: null,
  };
  rooms.set(roomCode, room);
  log("Tisch erstellt", { roomCode, hostSocketId });
  return publicRoomWithToken(room, hostSocketId);
}

export function getInternalRoom(roomCode) {
  return requireRoom(roomCode);
}

export function joinRoom({ roomCode }) {
  const room = requireRoom(roomCode);
  return publicRoom(room);
}
export function spectateRoom({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Der Tisch spielt gerade nicht.");
  if (findSeatForSocket(room, socketId)) throw new Error("Du sitzt bereits an diesem Tisch.");
  if (!room.spectators) room.spectators = new Set();
  room.spectators.add(socketId);
  log("Zuschauer betritt Tisch", { roomCode: room.roomCode, socketId });
  return publicRoom(room);
}

export function takeOverBotSeat({ roomCode, socketId, name, seat = null, reconnectToken = null }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Der Tisch spielt gerade nicht.");
  if (room.game.benchmarkDeckId) {
    throw new Error("Benchmark-Spiele sind nur für einen Menschen und drei Bots.");
  }
  if (findSeatForSocket(room, socketId)) throw new Error("Du sitzt bereits an diesem Tisch.");

  const requestedSeat = seat === null || seat === undefined || seat === "" ? null : Number(seat);
  if (requestedSeat !== null && (!Number.isInteger(requestedSeat) || requestedSeat < 0 || requestedSeat > 3)) {
    throw new Error("Ungültiger Bot-Platz.");
  }

  const ownedDisconnectedSeats = room.seats.filter((s) => playerOwnsDisconnectedSeat(s, reconnectToken, name));
  let target = null;

  if (ownedDisconnectedSeats.length) {
    // If the joining client has a previous disconnected seat, do not allow it to
    // jump to an unrelated fresh bot seat.  This preserves seat/hand continuity.
    target = requestedSeat === null
      ? ownedDisconnectedSeats[0]
      : ownedDisconnectedSeats.find((s) => s.seat === requestedSeat);
    if (!target) throw new Error("Du kannst nur deinen bisherigen Platz wieder übernehmen.");
  } else {
    target = requestedSeat === null
      ? room.seats.find((s) => s.type === "bot")
      : room.seats[requestedSeat];
    if (!target || target.type !== "bot") throw new Error("Es gibt keinen Bot-Platz, den du übernehmen kannst.");
  }

  target.type = "human";
  target.name = cleanName(name || target.name);
  target.socketId = socketId;
  target.reconnectToken = makeToken();
  target.disconnected = false;
  target.disconnectedAt = null;
  target.botControlAfter = null;
  room.spectators?.delete(socketId);

  log(ownedDisconnectedSeats.length ? "Vorheriger Platz wurde wieder übernommen" : "Bot-Platz wurde übernommen", {
    roomCode: room.roomCode,
    seat: target.seat,
    socketId,
  });
  advanceNonCardPhases(room);
  return publicRoomWithToken(room, socketId);
}



export function claimSeat({ roomCode, socketId, name, seat }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  if (defaultRoomSettings(room.settings).benchmarkDeckId) {
    throw new Error("Benchmark-Spiele sind nur für einen Menschen und drei Bots.");
  }
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
      s.disconnectedAt = null;
      s.botControlAfter = null;
    }
  }

  target.type = "human";
  target.name = cleanName(name);
  target.socketId = socketId;
  target.reconnectToken = makeToken();
  target.disconnected = false;
  target.disconnectedAt = null;
  target.botControlAfter = null;
  log("Sitzplatz belegt", { roomCode: room.roomCode, seat: seatIndex, socketId });
  return publicRoomWithToken(room, socketId);
}

export function reconnectSeat({ roomCode, socketId, token }) {
  const room = requireRoom(roomCode);
  const seat = findSeatForToken(room, token);
  if (!seat) throw new Error("Wiederverbindung nicht möglich.");
  seat.socketId = socketId;
  seat.disconnected = false;
  seat.disconnectedAt = null;
  seat.botControlAfter = null;
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
  target.name = randomBotName(room);
  target.socketId = null;
  target.reconnectToken = null;
  target.disconnected = false;
  target.disconnectedAt = null;
  target.botControlAfter = null;
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
  target.disconnectedAt = null;
  target.botControlAfter = null;
  log("Sitzplatz geöffnet", { roomCode: room.roomCode, seat: seatIndex });
  return publicRoom(room);
}

export function setRoomSettings({ roomCode, socketId, matchRutschen, showPenaltyTracker, easyMode, quickGame, publicTable, benchmarkDeckId }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const nextBenchmarkDeckId = benchmarkDeckId !== undefined ? normalizeBenchmarkDeckId(benchmarkDeckId) : defaultRoomSettings(room.settings).benchmarkDeckId;
  if (nextBenchmarkDeckId) {
    const nonHostHumans = room.seats.filter((seat) => (
      seat.type === "human" && seat.socketId !== room.hostSocketId
    ));
    if (nonHostHumans.length) {
      throw new Error("Benchmark kann nur gestartet werden, wenn nur der Host als Mensch am Tisch sitzt.");
    }
  }
  const next = defaultRoomSettings(room.settings);
  if (matchRutschen !== undefined) next.matchRutschen = normalizeMatchRutschen(matchRutschen);
  if (showPenaltyTracker !== undefined) next.showPenaltyTracker = showPenaltyTracker !== false;
  if (easyMode !== undefined) next.easyMode = easyMode === true;
  if (quickGame !== undefined) next.quickGame = quickGame === true;
  if (publicTable !== undefined) next.publicTable = publicTable === true;
  if (benchmarkDeckId !== undefined) next.benchmarkDeckId = nextBenchmarkDeckId;
  if (next.benchmarkDeckId) {
    next.matchRutschen = 2;
    next.publicTable = false;
  }
  room.settings = next;
  log("Tischeinstellungen geändert", { roomCode: room.roomCode, settings: room.settings });
  return publicRoom(room);
}


function startFreshGameForSameSeats(room, settings = room.settings) {
  const normalizedSettings = defaultRoomSettings(settings);
  const dealer = normalizedSettings.benchmarkDeckId ? 0 : Math.floor(Math.random() * 4);
  room.status = "playing";
  room.startedAt = Date.now();
  room.game = createGameState(dealer, normalizedSettings);
  advanceNonCardPhases(room);
  return room;
}

export function startOnlineGame({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const openSeat = room.seats.find((s) => s.type === "open");
  if (openSeat) throw new Error("Alle Plätze müssen mit Menschen oder Bots besetzt sein.");
  const humanCount = room.seats.filter((s) => s.type === "human").length;
  if (humanCount < 1) throw new Error("Mindestens ein Mensch muss mitspielen.");
  const settings = defaultRoomSettings(room.settings);
  if (settings.benchmarkDeckId) {
    if (humanCount !== 1 || room.seats.some((s) => s.type !== "human" && s.type !== "bot")) {
      throw new Error("Benchmark-Spiele sind nur für einen Menschen und drei Bots.");
    }
    const hostSeat = room.seats.find((s) => s.type === "human");
    if (!hostSeat || hostSeat.socketId !== room.hostSocketId) {
      throw new Error("Benchmark-Spiele müssen vom einzigen menschlichen Spieler gestartet werden.");
    }
  }
  startFreshGameForSameSeats(room, room.settings);
  log("Spiel gestartet", { roomCode: room.roomCode, dealer: room.game?.dealer });
  return room;
}

export function startNextOnlineRound({ roomCode, socketId, continueMatch = false }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const continuingFinishedMatch = room.game.phase === "gameover" && continueMatch === true;
  if (room.game.phase !== "round_done" && !continuingFinishedMatch) {
    throw new Error("Das nächste Spiel kann gerade nicht gestartet werden.");
  }

  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  if (room.hostSocketId && room.hostSocketId !== socketId) {
    throw new Error("Nur der Host kann die nächste Rutsche starten.");
  }

  const game = room.game;
  if (game.benchmarkDeckId && continuingFinishedMatch) {
    throw new Error(`Benchmark-Spiele bestehen immer aus genau ${FIXED_BENCHMARK_ROUNDS} Spielen.`);
  }
  if (continuingFinishedMatch) {
    game.maxRounds = Math.max(Number(game.maxRounds || 0), Number(game.round || 0)) + GAMES_PER_RUNDE;
    game.matchRutschen = Math.ceil(game.maxRounds / GAMES_PER_RUNDE);
  }
  const settings = defaultRoomSettings(room.settings);
  const nextDealer = (game.dealer + 1) % 4;
  game.round += 1;
  game.dealer = nextDealer;
  game.phase = "quetsch";
  game.gs = dealRoundForSettings(settings, game.round, nextDealer);
  game.quetschSelections = [null, null, null, null];
  game.quetschReceived = [[], [], [], []];
  game.quetschReviewUntil = null;
  game.currentQuetschSeat = null;
  game.lastTrick = null;
  game.spielLog = [];
  game.pendingLastTrick = null;
  game.lastRestClaim = null;
  game.restClaimRequest = null;
  game.restClaimReveal = null;
  game.comments = [];
  game.quetschGiftSources = [];
  advanceNonCardPhases(room);
  log(continuingFinishedMatch ? "Noch eine Rutsche gestartet" : "Nächstes Spiel gestartet", { roomCode: room.roomCode, round: game.round, maxRounds: game.maxRounds, dealer: nextDealer, socketId });
  return room;
}



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

export function claimRestOnline({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");

  if (canStartHumanRestClaim(room, seat.seat)) {
    const approvals = [false, false, false, false];
    approvals[seat.seat] = true;
    room.game.restClaimRequest = {
      claimantSeat: seat.seat,
      name: seat.name || ("Platz " + (seat.seat + 1)),
      approvals,
      rejectedBy: null,
      createdAt: Date.now(),
    };
    room.game.phase = "rest_claim_pending";
    touch(room);
    return room;
  }

  if (canClaimRestForSeat(room, seat.seat)) {
    applyRestClaim(room, seat.seat, "human");
    touch(room);
    return room;
  }

  throw new Error("Rest zu mir ist gerade nicht möglich.");
}

export function pauseRestClaimRevealOnline({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  requireRestClaimRevealPlayer(room, socketId);
  const reveal = room.game.restClaimReveal;
  reveal.paused = true;
  reveal.pausedAt = Date.now();
  reveal.revealUntil = null;
  touch(room);
  log("Restanzeige pausiert", { roomCode: room.roomCode, socketId });
  return room;
}

export function continueRestClaimRevealOnline({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  requireRestClaimRevealPlayer(room, socketId);
  const reveal = room.game.restClaimReveal;
  if (!reveal.paused) throw new Error("Die Restanzeige ist nicht angehalten.");
  stepRestClaimRevealForward(room);
  touch(room);
  log("Restanzeige fortgesetzt", { roomCode: room.roomCode, socketId });
  return room;
}

export function respondRestClaimOnline({ roomCode, socketId, accept }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  const request = room.game.restClaimRequest;
  if (room.game.phase !== "rest_claim_pending" || !request) throw new Error("Es gibt gerade keine Rest-zu-mir-Anfrage.");
  if (seat.seat === request.claimantSeat) throw new Error("Du hast den Rest bereits angefragt.");
  if (!connectedPureHumanRoom(room)) throw new Error("Eine Abstimmung ist nur in reinen Menschenspielen möglich.");

  if (accept === false) {
    room.game.restClaimRequest = null;
    room.game.phase = "play";
    touch(room);
    return room;
  }

  request.approvals[seat.seat] = true;
  const allApproved = room.seats.every((s, idx) => (
    s.type !== "human" || idx === request.claimantSeat || request.approvals[idx] === true
  ));

  if (allApproved) {
    applyRestClaim(room, request.claimantSeat, "human-approved", { forceSafe: false });
  }

  touch(room);
  return room;
}

export function sendOnlineComment({ roomCode, socketId, text }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  const seat = findSeatForSocket(room, socketId);
  const isSpectator = !seat && room.spectators?.has(socketId);
  if (!seat && !isSpectator) throw new Error("Du bist nicht an diesem Tisch.");
  const clean = cleanCommentText(text);
  if (!clean) throw new Error("Der Spruch ist leer.");
  const now = Date.now();
  const authorSeat = seat?.seat ?? null;
  const comment = {
    id: String(now) + "-" + String(authorSeat ?? "spectator") + "-" + Math.random().toString(36).slice(2, 8),
    seat: authorSeat,
    name: seat ? seatDisplayName(room, seat.seat) : "Zuschauer",
    text: clean,
    at: now,
  };
  room.game.comments = [comment];
  touch(room);
  log("Spruch gesendet", { roomCode: room.roomCode, seat: authorSeat, spectator: isSpectator, text: clean });
  return room;
}

export function submitOnlineQuetsch({ roomCode, socketId, cards }) {
  const room = requireRoom(roomCode);
  if (room.status !== "playing" || !room.game) throw new Error("Es läuft kein Spiel.");
  if (room.game.phase !== "quetsch") throw new Error("Es ist gerade keine Quetsch-Phase.");
  const seat = findSeatForSocket(room, socketId);
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
  if (Array.isArray(room.game.quetschSelections[seat.seat])) throw new Error("Du hast deine Quetsch-Karten schon ausgewählt.");
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
  if (!seat) throw new Error("Du sitzt nicht an diesem Tisch.");
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
  const names = room.seats.map((s) => s.name || (s.type === "bot" ? "Bot (B)" : `Platz ${s.seat + 1}`));
  const seatTypes = room.seats.map((s) => (s.type === "human" && isBotControlledSeat(room, s.seat) ? "bot" : s.type));
  const ownQuetschSelection = seatIndex !== null && Array.isArray(game.quetschSelections?.[seatIndex])
    ? game.quetschSelections[seatIndex]
    : [];
  const hand = seatIndex === null
    ? []
    : sortHand((gs.hands[seatIndex] || []).filter((card) => !ownQuetschSelection.some((q) => sameCard(q, card))));
  const validCards = seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex ? getValidCards(gs, seatIndex) : [];
  const settings = defaultRoomSettings(room.settings);
  let suggestion = null;
  if (settings.easyMode && seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex && validCards.length) {
    const decisionGs = botDecisionGameState(room);
    const rec = recommendHeuristicCards(decisionGs, seatIndex);
    const residualCard = chooseRlCard(decisionGs, seatIndex, rec);
    const heuristicSuggestions = Array.isArray(rec?.cards)
      ? rec.cards.filter((card) => validCards.some((valid) => sameCard(valid, card)))
      : [];
    const residualSuggestion = residualCard && heuristicSuggestions.some((card) => sameCard(card, residualCard))
      ? [residualCard]
      : heuristicSuggestions;
    suggestion = {
      cards: residualSuggestion,
      rule: rec?.rule || "normal_follow",
      reason: rec?.reason || "Der Bot empfiehlt diese Karte nach seiner normalen Sicherheits- und Stichlogik.",
      reasonByCard: rec?.reasonByCard || {},
    };
    if (!suggestion.cards.length) suggestion = null;
  }
  let quetschSuggestion = null;
  const pendingQuetschSeats = game.phase === "quetsch" ? pendingHumanQuetschSeats(room) : [];
  const quetschSubmitted = seatIndex !== null && Array.isArray(game.quetschSelections?.[seatIndex]);
  const quetschReceived = visibleQuetschReceivedForSeat(game, seatIndex);
  if (settings.easyMode && seatIndex !== null && game.phase === "quetsch" && !quetschSubmitted && hand.length) {
    const rec = recommendHeuristicQuetschCards(hand, botDecisionGameState(room), seatIndex);
    quetschSuggestion = {
      cards: Array.isArray(rec?.cards) ? rec.cards.filter((card) => hand.some((own) => sameCard(own, card))) : [],
      rule: rec?.rule || "quetsch_suggestion",
      reason: rec?.reason || "Der Bot empfiehlt diese drei Karten nach seiner normalen Quetsch-Logik.",
      reasonByCard: rec?.reasonByCard || {},
    };
    if (!quetschSuggestion.cards.length) quetschSuggestion = null;
  }
  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));
  const canClaimRest = seatIndex !== null ? canShowRestClaimButton(room, seatIndex) : false;
  const nowForComments = Date.now();
  const comments = (game.comments || [])
    .filter((comment) => nowForComments - Number(comment.at || 0) < COMMENT_TTL_MS)
    .slice(-1)
    .map((comment) => ({ ...comment, expiresAt: Number(comment.at || 0) + COMMENT_TTL_MS }));
  const restClaimNeedsApproval = seatIndex !== null && canStartHumanRestClaim(room, seatIndex);
  const restClaimRequest = game.restClaimRequest ? {
    ...game.restClaimRequest,
    approvals: [...(game.restClaimRequest.approvals || [])],
  } : null;
  const restClaimReveal = game.restClaimReveal ? {
    ...game.restClaimReveal,
    tricks: (game.restClaimReveal.tricks || []).map((trick) => ({
      ...trick,
      trick: (trick.trick || []).map((play) => ({ player: play.player, card: { ...play.card } })),
    })),
    paused: Boolean(game.restClaimReveal.paused),
    pausedAt: game.restClaimReveal.pausedAt || null,
    revealUntil: game.restClaimReveal.revealUntil || null,
  } : null;
  const includeSpielReview = game.phase === "round_done" || game.phase === "gameover";
  const canHostControlFinishedMatch = game.phase === "gameover" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId);
  const lastRoundForView = game.lastRound ? {
    ...game.lastRound,
    spielLog: includeSpielReview ? sanitizeSpielLog(game.lastRound.spielLog) : [],
  } : null;
  const benchmarkDeck = getBenchmarkDeck(game.benchmarkDeckId);
  const benchmarkHighscore = benchmarkDeck ? benchmarkHighscoreSnapshot(benchmarkHighscores.get(benchmarkDeck.id)) : null;
  return {
    phase: game.phase,
    yourSeat: seatIndex,
    round: game.round,
    maxRounds: game.maxRounds,
    matchRutschen: game.matchRutschen ?? settings.matchRutschen,
    showPenaltyTracker: settings.showPenaltyTracker,
    easyMode: settings.easyMode,
    quickGame: settings.quickGame,
    benchmarkDeck: benchmarkDeck ? {
      id: benchmarkDeck.id,
      name: benchmarkDeck.name,
      description: benchmarkDeck.description,
      rounds: FIXED_BENCHMARK_ROUNDS,
    } : null,
    benchmarkHighscore,
    suggestion,
    quetschSuggestion,
    canClaimRest,
    comments,
    commentChoices: [...COMMENT_CHOICES],
    restClaimNeedsApproval,
    restClaimRequest,
    restClaimReveal,
    names,
    seatTypes,
    dealer: gs.dealer,
    currentPlayer: game.phase === "play" ? gs.currentPlayer : null,
    currentQuetschSeat: game.phase === "quetsch" ? game.currentQuetschSeat : null,
    pendingQuetschSeats,
    quetschSubmitted,
    quetschNeeded: game.phase === "quetsch" && seatIndex !== null && !quetschSubmitted,
    quetschTarget: seatIndex !== null ? (seatIndex + 1) % 4 : null,
    quetschSource: seatIndex !== null ? (seatIndex + 3) % 4 : null,
    quetschReceived,
    quetschPassed: ownQuetschSelection,
    quetschReviewRemainingMs: game.phase === "quetsch_review" ? Math.max(0, (game.quetschReviewUntil || Date.now()) - Date.now()) : 0, trickReviewRemainingMs: game.phase === "trick_done" ? Math.max(0, (game.trickReviewUntil || Date.now()) - Date.now()) : 0,
    hand,
    validCards,
    trick: gs.trick,
    leadSuit: gs.leadSuit,
    tricksPlayed: gs.tricksPlayed,
    roundPts: gs.roundPts,
    runScores,
    scores: game.scores,
    scoreHistory: Array.isArray(game.scoreHistory) ? game.scoreHistory.map((entry) => ({
      round: Number(entry.round || 0),
      roundPts: Array.isArray(entry.roundPts) ? [...entry.roundPts] : [0, 0, 0, 0],
      totalScores: Array.isArray(entry.totalScores) ? [...entry.totalScores] : [0, 0, 0, 0],
    })) : [],
    tricksWon: gs.tricksWon,
    penaltyPlayed: gs.penaltyPlayed,
    lastTrick: game.lastTrick,
    lastRound: lastRoundForView,
    cardPointPreview: hand.reduce((acc, c) => ({ ...acc, [`${c.s}${c.v}`]: cardPts(c) }), {}),
    canStartNextRound: game.phase === "round_done" && seatIndex !== null && (room.hostSocketId === socketId || !room.hostSocketId),
    canContinueMatch: canHostControlFinishedMatch && !benchmarkDeck,
    canRestartMatch: canHostControlFinishedMatch,
  };
}

export function getSpectatorGameView(room) {
  return getPrivateGameView(room, null);
}

export function closeRoomIfNoConnectedHumanPlayers(roomCode) {
  const code = normalizeCode(roomCode);
  const room = rooms.get(code);
  if (!room) return false;
  if (hasConnectedHumanPlayers(room)) return false;
  rooms.delete(code);
  log("Tisch geschlossen, keine verbundenen Menschen", { roomCode: code });
  return true;
}

export function leaveRoom({ roomCode, socketId }) {
  const room = requireRoom(roomCode);
  room.spectators?.delete(socketId);
  const isHost = room.hostSocketId === socketId;
  if (isHost && room.status === "lobby") {
    rooms.delete(room.roomCode);
    log("Host verlässt Lobby, Tisch geschlossen", { roomCode: room.roomCode });
    return { closed: true, roomCode: room.roomCode };
  }
  const now = Date.now();
  for (const s of room.seats) {
    if (s.type === "human" && s.socketId === socketId) {
      s.socketId = null;
      s.disconnected = true;
      s.disconnectedAt = now;
      s.botControlAfter = now + DISCONNECTED_HUMAN_BOT_DELAY_MS;
    }
  }
  if (isHost) room.hostSocketId = null;
  advanceNonCardPhases(room);
  log("Spieler verlässt Tisch", { roomCode: room.roomCode, socketId });
  return { closed: false, room: publicRoom(room) };
}

export function leaveAllRoomsForSocket(socketId) {
  const results = [];
  for (const room of [...rooms.values()]) {
    const isInRoom = room.hostSocketId === socketId || room.seats.some((s) => s.socketId === socketId) || room.spectators?.has(socketId);
    if (!isInRoom) continue;
    if (room.hostSocketId === socketId && room.status === "lobby") {
      rooms.delete(room.roomCode);
      results.push({ closed: true, roomCode: room.roomCode });
      log("Host getrennt, Lobby geschlossen", { roomCode: room.roomCode });
    } else {
      room.spectators?.delete(socketId);
      const now = Date.now();
      for (const s of room.seats) {
        if (s.type === "human" && s.socketId === socketId) {
          s.socketId = null;
          s.disconnected = true;
          s.disconnectedAt = now;
          s.botControlAfter = now + DISCONNECTED_HUMAN_BOT_DELAY_MS;
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
      log("Tisch wegen Inaktivität entfernt", { roomCode: room.roomCode });
    }
  }
  return expired;
}
