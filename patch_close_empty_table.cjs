#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(root, '.patch-backups', `close-empty-table-${stamp}`);
const touched = new Set();

function filePath(rel) {
  return path.join(root, rel);
}

function ensureFile(rel) {
  const p = filePath(rel);
  if (!fs.existsSync(p)) throw new Error(`File not found: ${rel}. Run this from the project root.`);
  return p;
}

function backup(rel) {
  if (touched.has(rel)) return;
  const src = ensureFile(rel);
  const dst = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  touched.add(rel);
}

function read(rel) {
  return fs.readFileSync(ensureFile(rel), 'utf8');
}

function write(rel, text) {
  backup(rel);
  fs.writeFileSync(filePath(rel), text);
}

function replaceRequired(rel, before, after, desc) {
  let text = read(rel);
  if (!text.includes(before)) throw new Error(`Could not apply patch '${desc}' in ${rel}. Expected text was not found.`);
  text = text.replace(before, after);
  write(rel, text);
  console.log(`ok: ${desc}`);
}

function insertAfterRequired(rel, anchor, insertion, marker, desc) {
  let text = read(rel);
  if (marker && text.includes(marker)) {
    console.log(`skip: ${desc}`);
    return;
  }
  if (!text.includes(anchor)) throw new Error(`Could not apply patch '${desc}' in ${rel}. Anchor text was not found.`);
  text = text.replace(anchor, anchor + insertion);
  write(rel, text);
  console.log(`ok: ${desc}`);
}

function insertBeforeRequired(rel, anchor, insertion, marker, desc) {
  let text = read(rel);
  if (marker && text.includes(marker)) {
    console.log(`skip: ${desc}`);
    return;
  }
  if (!text.includes(anchor)) throw new Error(`Could not apply patch '${desc}' in ${rel}. Anchor text was not found.`);
  text = text.replace(anchor, insertion + anchor);
  write(rel, text);
  console.log(`ok: ${desc}`);
}

function patchRooms() {
  const rel = 'server/rooms.js';
  ensureFile(rel);

  insertAfterRequired(
    rel,
    `function isConnectedHumanSeat(room, seat) {\n  const s = room.seats[seat];\n  return s?.type === "human" && Boolean(s.socketId);\n}\n`,
    `\nfunction hasConnectedHumanPlayers(room) {\n  return Boolean(room?.seats?.some((s) => s.type === "human" && Boolean(s.socketId)));\n}\n`,
    'function hasConnectedHumanPlayers(room)',
    'Add connected-human player detector'
  );

  insertBeforeRequired(
    rel,
    `export function leaveRoom({ roomCode, socketId }) {`,
    `export function closeRoomIfNoConnectedHumanPlayers(roomCode) {\n  const code = normalizeCode(roomCode);\n  const room = rooms.get(code);\n  if (!room) return false;\n  if (hasConnectedHumanPlayers(room)) return false;\n  rooms.delete(code);\n  log("Tisch geschlossen, keine verbundenen Menschen", { roomCode: code });\n  return true;\n}\n\n`,
    'export function closeRoomIfNoConnectedHumanPlayers',
    'Add close helper for empty human-player tables'
  );
}

function patchIndex() {
  const rel = 'server/index.js';
  ensureFile(rel);

  let text = read(rel);
  if (!text.includes('closeRoomIfNoConnectedHumanPlayers,')) {
    if (!text.includes('  pruneExpiredRooms,\n} from "./rooms.js";')) {
      throw new Error(`Could not add closeRoomIfNoConnectedHumanPlayers import in ${rel}. Import anchor not found.`);
    }
    text = text.replace(
      '  pruneExpiredRooms,\n} from "./rooms.js";',
      '  closeRoomIfNoConnectedHumanPlayers,\n  pruneExpiredRooms,\n} from "./rooms.js";'
    );
    write(rel, text);
    console.log('ok: Import close helper');
  } else {
    console.log('skip: Import close helper');
  }

  insertAfterRequired(
    rel,
    `const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS || 650);\nconst EXPIRY_SWEEP_MS = Number(process.env.EXPIRY_SWEEP_MS || 60_000);\n`,
    `const EMPTY_TABLE_CLOSE_MS = Number(process.env.EMPTY_TABLE_CLOSE_MS || 60_000);\n`,
    'EMPTY_TABLE_CLOSE_MS',
    'Add empty-table close delay setting'
  );

  insertAfterRequired(
    rel,
    `const advanceTimers = new Map();\n`,
    `const emptyTableCloseTimers = new Map();\n\nfunction roomHasConnectedHumanPlayer(publicState) {\n  return Boolean(publicState?.seats?.some((seat) => seat.type === "human" && Boolean(seat.socketId)));\n}\n\nfunction clearEmptyTableCloseTimer(roomCode) {\n  const code = String(roomCode || "").trim().toUpperCase();\n  const timer = emptyTableCloseTimers.get(code);\n  if (!timer) return;\n  clearTimeout(timer);\n  emptyTableCloseTimers.delete(code);\n}\n\nfunction scheduleEmptyTableCloseIfNeeded(room, publicState = null) {\n  if (!room || room.status !== "playing") return;\n  const roomCode = room.roomCode;\n  const state = publicState || publicRoom(room);\n  if (roomHasConnectedHumanPlayer(state)) {\n    clearEmptyTableCloseTimer(roomCode);\n    return;\n  }\n  if (emptyTableCloseTimers.has(roomCode)) return;\n\n  const timer = setTimeout(() => {\n    emptyTableCloseTimers.delete(roomCode);\n    try {\n      const closed = closeRoomIfNoConnectedHumanPlayers(roomCode);\n      if (!closed) return;\n      const advanceTimer = advanceTimers.get(roomCode);\n      if (advanceTimer) {\n        clearTimeout(advanceTimer);\n        advanceTimers.delete(roomCode);\n      }\n      io.to(roomCode).emit("roomClosed", {\n        message: "Alle Spieler haben den Tisch verlassen. Der Tisch wurde geschlossen.",\n      });\n      log("Tisch ohne verbundene Spieler geschlossen", { roomCode });\n    } catch (err) {\n      log("Leerer Tisch konnte nicht geschlossen werden", { roomCode, error: err.message });\n    }\n  }, EMPTY_TABLE_CLOSE_MS);\n\n  timer.unref?.();\n  emptyTableCloseTimers.set(roomCode, timer);\n  log("Schließe Tisch ohne verbundene Spieler bald", { roomCode, delayMs: EMPTY_TABLE_CLOSE_MS });\n}\n`,
    'emptyTableCloseTimers',
    'Add one-minute empty-table close timer'
  );

  text = read(rel);
  const oldEmit = `function emitRoomAndGame(room) {\n  const publicState = publicRoom(room);\n  io.to(room.roomCode).emit("roomUpdated", publicState);`;
  const newEmit = `function emitRoomAndGame(room) {\n  const publicState = publicRoom(room);\n  scheduleEmptyTableCloseIfNeeded(room, publicState);\n  io.to(room.roomCode).emit("roomUpdated", publicState);`;
  if (text.includes(oldEmit)) {
    text = text.replace(oldEmit, newEmit);
    write(rel, text);
    console.log('ok: Check empty-table close on game/room emits');
  } else if (text.includes('scheduleEmptyTableCloseIfNeeded(room, publicState);')) {
    console.log('skip: Check empty-table close on game/room emits');
  } else {
    throw new Error(`Could not patch emitRoomAndGame in ${rel}.`);
  }

  // Reconnect uses direct emits rather than emitRoomAndGame, so explicitly cancel a pending close timer.
  text = read(rel);
  const reconnectAnchor = `      socket.join(result.room.roomCode);\n      io.to(result.room.roomCode).emit("roomUpdated", result.room);`;
  const reconnectReplacement = `      socket.join(result.room.roomCode);\n      clearEmptyTableCloseTimer(result.room.roomCode);\n      io.to(result.room.roomCode).emit("roomUpdated", result.room);`;
  if (text.includes(reconnectReplacement)) {
    console.log('skip: Cancel empty-table close on reconnect');
  } else if (text.includes(reconnectAnchor)) {
    text = text.replace(reconnectAnchor, reconnectReplacement);
    write(rel, text);
    console.log('ok: Cancel empty-table close on reconnect');
  } else {
    console.log('note: Reconnect anchor not found; reconnect likely already goes through emitRoomAndGame in your version.');
  }

  // If a room is closed by the normal expiry sweep, also clear its empty-table timer.
  text = read(rel);
  const sweepOld = `setInterval(() => {\n  for (const roomCode of pruneExpiredRooms()) {\n    io.to(roomCode).emit("roomClosed", { message: "Der Tisch wurde wegen Inaktivität geschlossen." });\n  }\n}, EXPIRY_SWEEP_MS).unref?.();`;
  const sweepNew = `setInterval(() => {\n  for (const roomCode of pruneExpiredRooms()) {\n    clearEmptyTableCloseTimer(roomCode);\n    io.to(roomCode).emit("roomClosed", { message: "Der Tisch wurde wegen Inaktivität geschlossen." });\n  }\n}, EXPIRY_SWEEP_MS).unref?.();`;
  if (text.includes(sweepNew)) {
    console.log('skip: Clear empty-table timers on expiry');
  } else if (text.includes(sweepOld)) {
    text = text.replace(sweepOld, sweepNew);
    write(rel, text);
    console.log('ok: Clear empty-table timers on expiry');
  } else {
    console.log('note: Expiry sweep shape differed; no expiry-timer cleanup patch applied.');
  }
}

try {
  patchRooms();
  patchIndex();
  console.log(`\nBackups written to: ${path.relative(root, backupRoot) || backupRoot}`);
  console.log('Next: npm run build && npm run dev');
  console.log('Default close delay: EMPTY_TABLE_CLOSE_MS=60000');
} catch (err) {
  console.error(`\nPatch failed: ${err.message}`);
  if (touched.size) console.error(`Backups are in: ${backupRoot}`);
  process.exitCode = 1;
}
