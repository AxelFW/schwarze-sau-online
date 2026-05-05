import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { Server } from "socket.io";

import {
  createRoom,
  joinRoom,
  claimSeat,
  setSeatBot,
  setSeatOpen,
  leaveRoom,
  leaveAllRoomsForSocket,
  reconnectSeat,
  startOnlineGame,
  startNextOnlineRound,
  submitOnlineQuetsch,
  playOnlineCard,
  getInternalRoom,
  publicRoom,
  getPrivateGameView,
  publicRoomWithToken,
  advanceOneBotCard,
  advanceNonCardPhases,
  pruneExpiredRooms,
} from "./rooms.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || "development";
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS || 650);
const EXPIRY_SWEEP_MS = Number(process.env.EXPIRY_SWEEP_MS || 60_000);

const app = express();
app.use(cors({ origin: NODE_ENV === "production" ? false : true }));

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "schwarze-sau-online", env: NODE_ENV });
});

if (NODE_ENV === "production") {
  app.use(express.static(path.join(ROOT, "dist")));
  app.use((req, res) => {
    res.sendFile(path.join(ROOT, "dist", "index.html"));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: NODE_ENV === "production"
    ? undefined
    : { origin: true, methods: ["GET", "POST"] },
});

const advanceTimers = new Map();

function log(message, data = {}) {
  console.log(`[server] ${message}`, data);
}

function sendError(socket, message) {
  socket.emit("roomError", { message });
}

function acknowledge(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function emitRoomAndGame(room) {
  const publicState = publicRoom(room);
  io.to(room.roomCode).emit("roomUpdated", publicState);
  if (room.status !== "playing" || !room.game) return;

  for (const seat of room.seats) {
    if (seat.type === "human" && seat.socketId) {
      io.to(seat.socketId).emit("gameUpdated", {
        room: publicState,
        game: getPrivateGameView(room, seat.socketId),
      });
    }
  }
}

function emitRoomAndGameByCode(roomCode) {
  const room = getInternalRoom(roomCode);
  emitRoomAndGame(room);
}

function scheduleAdvance(roomCode, immediate = false) {
  if (advanceTimers.has(roomCode)) return;
  const delay = immediate ? 0 : BOT_DELAY_MS;
  const timer = setTimeout(() => {
    advanceTimers.delete(roomCode);
    let room;
    try {
      room = getInternalRoom(roomCode);
      advanceNonCardPhases(room);
      emitRoomAndGame(room);
      const moved = advanceOneBotCard(room);
      emitRoomAndGame(room);
      if (moved && room.status === "playing" && room.game?.phase !== "gameover") {
        scheduleAdvance(roomCode, false);
      }
    } catch (err) {
      log("Automatischer Spielfortschritt fehlgeschlagen", { roomCode, error: err.message });
      if (room) emitRoomAndGame(room);
    }
  }, delay);
  advanceTimers.set(roomCode, timer);
}

function saveTokenPayload(payload) {
  const token = payload?.reconnectToken || null;
  return token ? { ...payload, reconnectToken: token } : payload;
}

io.on("connection", (socket) => {
  log("Socket verbunden", { socketId: socket.id });

  socket.emit("serverHello", {
    socketId: socket.id,
    message: "Mit dem Schwarze-Sau-Server verbunden.",
  });

  socket.on("createRoom", (payload = {}, ack) => {
    try {
      const result = createRoom({ hostSocketId: socket.id, name: payload.name });
      socket.join(result.room.roomCode);
      io.to(result.room.roomCode).emit("roomUpdated", result.room);
      acknowledge(ack, { ok: true, ...saveTokenPayload(result) });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("joinRoom", (payload = {}, ack) => {
    try {
      const roomCode = String(payload.roomCode || "").trim().toUpperCase();
      const room = joinRoom({ roomCode });
      socket.join(room.roomCode);
      io.to(room.roomCode).emit("roomUpdated", room);
      acknowledge(ack, { ok: true, room });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("claimSeat", (payload = {}, ack) => {
    try {
      const result = claimSeat({ roomCode: payload.roomCode, socketId: socket.id, name: payload.name, seat: payload.seat });
      socket.join(result.room.roomCode);
      io.to(result.room.roomCode).emit("roomUpdated", result.room);
      acknowledge(ack, { ok: true, ...saveTokenPayload(result) });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("reconnectSeat", (payload = {}, ack) => {
    try {
      const result = reconnectSeat({ roomCode: payload.roomCode, socketId: socket.id, token: payload.reconnectToken });
      socket.join(result.room.roomCode);
      io.to(result.room.roomCode).emit("roomUpdated", result.room);
      io.to(socket.id).emit("gameUpdated", { room: result.room, game: getPrivateGameView(getInternalRoom(result.room.roomCode), socket.id) });
      acknowledge(ack, { ok: true, ...saveTokenPayload(result) });
      scheduleAdvance(result.room.roomCode, true);
    } catch (err) {
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("setSeatBot", (payload = {}, ack) => {
    try {
      const room = setSeatBot({ roomCode: payload.roomCode, socketId: socket.id, seat: payload.seat });
      io.to(room.roomCode).emit("roomUpdated", room);
      acknowledge(ack, { ok: true, room });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("setSeatOpen", (payload = {}, ack) => {
    try {
      const room = setSeatOpen({ roomCode: payload.roomCode, socketId: socket.id, seat: payload.seat });
      io.to(room.roomCode).emit("roomUpdated", room);
      acknowledge(ack, { ok: true, room });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("startGame", (payload = {}, ack) => {
    try {
      const room = startOnlineGame({ roomCode: payload.roomCode, socketId: socket.id });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, true);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("submitQuetsch", (payload = {}, ack) => {
    try {
      const room = submitOnlineQuetsch({ roomCode: payload.roomCode, socketId: socket.id, cards: payload.cards });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, true);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("startNextRound", (payload = {}, ack) => {
    try {
      const room = startNextOnlineRound({ roomCode: payload.roomCode, socketId: socket.id });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, true);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("playCard", (payload = {}, ack) => {
    try {
      const room = playOnlineCard({ roomCode: payload.roomCode, socketId: socket.id, card: payload.card });
      emitRoomAndGame(room);
      acknowledge(ack, { ok: true });
      scheduleAdvance(room.roomCode, false);
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("leaveRoom", (payload = {}, ack) => {
    try {
      const result = leaveRoom({ roomCode: payload.roomCode, socketId: socket.id });
      socket.leave(String(payload.roomCode || "").trim().toUpperCase());
      if (result.closed) {
        io.to(result.roomCode).emit("roomClosed", { message: "Der Host hat die Lobby verlassen. Der Raum wurde geschlossen." });
      } else {
        emitRoomAndGameByCode(result.room.roomCode);
        scheduleAdvance(result.room.roomCode, true);
      }
      acknowledge(ack, { ok: true });
    } catch (err) {
      sendError(socket, err.message);
      acknowledge(ack, { ok: false, message: err.message });
    }
  });

  socket.on("disconnect", () => {
    log("Socket getrennt", { socketId: socket.id });
    const results = leaveAllRoomsForSocket(socket.id);
    for (const result of results) {
      if (result.closed) {
        io.to(result.roomCode).emit("roomClosed", { message: "Der Host wurde getrennt. Die Lobby wurde geschlossen." });
      } else {
        try {
          emitRoomAndGameByCode(result.room.roomCode);
          scheduleAdvance(result.room.roomCode, true);
        } catch (err) {
          log("Update nach Trennung fehlgeschlagen", { error: err.message });
        }
      }
    }
  });
});

setInterval(() => {
  for (const roomCode of pruneExpiredRooms()) {
    io.to(roomCode).emit("roomClosed", { message: "Der Raum wurde wegen Inaktivität geschlossen." });
  }
}, EXPIRY_SWEEP_MS).unref?.();

httpServer.listen(PORT, () => {
  log(`Schwarze-Sau-Server läuft`, { port: PORT, env: NODE_ENV, botDelayMs: BOT_DELAY_MS });
});
