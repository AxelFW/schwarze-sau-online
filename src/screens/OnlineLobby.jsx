import { useEffect, useMemo, useState } from "react";
import { socket } from "../multiplayer/socketClient.js";
import { SYM, VN, isRed, sameCard, cardPts, unplayedPenaltyCards } from "../../shared/game/cards.js";
import { BENCHMARK_DECKS, FIXED_BENCHMARK_ROUNDS } from "../../shared/game/benchmarkDecks.js";

const envFlagEnabled = (value) =>
  value === undefined || value === null || String(value).trim().toLowerCase() !== "false";

// This flag controls only whether the Easy Mode checkbox is shown in the lobby.
// Easy Mode itself can still be requested by URL, e.g. ?easyMode=true.
const EASY_MODE_OPTION_VISIBLE =
  envFlagEnabled(import.meta.env.VITE_ENABLE_EASY_MODE) &&
  envFlagEnabled(import.meta.env.VITE_EASY_MODE_ENABLED);

const urlFlagValue = (...names) => {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search || "");
  for (const name of names) {
    if (!params.has(name)) continue;
    const raw = String(params.get(name) ?? "").trim().toLowerCase();
    if (["1", "true", "yes", "ja", "on"].includes(raw)) return true;
    if (["0", "false", "no", "nein", "off"].includes(raw)) return false;
  }
  return null;
};

const INITIAL_EASY_MODE_FROM_URL = urlFlagValue("easyMode", "easy", "botTips");

const page = {
  minHeight: "100vh",
  background:
    "radial-gradient(ellipse at 50% 0%,#1d5c40 0%,#0f3422 40%,#061910 100%)",
  color: "white",
  fontFamily: "Georgia,serif",
  padding: 24,
  boxSizing: "border-box",
};

// Wuzz tweak: old German first-name pool for humans and bots.
const OLD_GERMAN_FIRST_NAMES = [
  "Ferdi",
  "Leopold",
  "Wilhelm",
  "Heinrich",
  "Albert",
  "Otto",
  "Peter",
  "Thomas",
  "Gerhard",
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
  "Sigrun",
  "Egbert",
  "Agnes",
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
const randomFirstName = (used = []) => {
  const usedBase = new Set(used.map(n => String(n || '').replace(/\s*\(B\)$/, '')));
  const available = OLD_GERMAN_FIRST_NAMES.filter(n => !usedBase.has(n));
  const pool = available.length ? available : OLD_GERMAN_FIRST_NAMES;
  return pool[Math.floor(Math.random() * pool.length)];
};
const randomBotName = (used = []) => randomFirstName(used) + ' (B)';
const randomLocalSeatNames = () => {
  const human = randomFirstName();
  const names = [human];
  while (names.length < 4) names.push(randomBotName(names));
  return names;
};


const panel = {
  maxWidth: 860,
  margin: "0 auto",
  background: "rgba(0,0,0,0.35)",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 18,
  padding: 20,
};

function Button({ children, onClick, disabled, style = {} }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        background: disabled
          ? "rgba(255,255,255,0.1)"
          : "linear-gradient(135deg,#f4c430,#d4a017)",
        color: disabled ? "rgba(255,255,255,0.35)" : "#1a1a1a",
        border: "none",
        borderRadius: 10,
        padding: "10px 16px",
        fontWeight: "bold",
        cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "Georgia,serif",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      style={{
        width: "100%",
        padding: "11px 12px",
        borderRadius: 10,
        border: "1px solid rgba(255,255,255,0.2)",
        background: "rgba(255,255,255,0.08)",
        color: "white",
        fontSize: 16,
        boxSizing: "border-box",
        marginTop: 6,
      }}
    />
  );
}

function CardFace({ card, highlighted, dimmed, selected, suggested, onClick, size = "md" }) {
  const w = size === "sm" ? 42 : 58;
  const h = size === "sm" ? 59 : 81;
  const fs = size === "sm" ? 11 : 13;
  const sfs = size === "sm" ? 18 : 26;
  const isSau = card.s === "S" && card.v === 12;
  const red = isRed(card.s);
  const color = red ? '#C0392B' : '#1a1a2e';
  const queenSpadesGlow = isSau ? '0 0 0 2px rgba(248,113,113,0.9), 0 0 18px rgba(248,113,113,0.95), 0 6px 12px rgba(0,0,0,0.25)' : undefined;

  return (
    <div
      onClick={onClick}
      style={{
        width: w,
        height: h,
        background: selected ? "#fff8dc" : isSau ? "#fff8f8" : "#fff",
        borderRadius: 6,
        border: selected
          ? "2.5px solid #f4c430"
          : suggested
          ? "2.5px solid #60a5fa"
          : highlighted
          ? "2px solid rgba(244,196,48,0.55)"
          : isSau
          ? "1.5px solid #C0392B"
          : "1px solid #ccc",
        boxShadow: selected
          ? "0 0 14px rgba(244,196,48,0.8),1px 3px 6px rgba(0,0,0,0.3)"
          : suggested
          ? "0 0 16px rgba(96,165,250,0.85),1px 3px 6px rgba(0,0,0,0.3)"
          : "1px 2px 5px rgba(0,0,0,0.3)",
        cursor: onClick ? "pointer" : "default",
        opacity: dimmed ? 0.3 : 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "3px 4px",
        color,
        fontSize: fs,
        fontWeight: "bold",
        fontFamily: "Georgia,serif",
        transition: "transform 0.12s",
        transform: selected ? "translateY(-12px) scale(1.05)" : suggested && onClick ? "translateY(-8px) scale(1.03)" : highlighted && onClick ? "translateY(-5px)" : "none",
        userSelect: "none",
        flexShrink: 0,
        position: "relative",
      }}
    >
      <div style={{ lineHeight: 1.1 }}>
        {VN(card.v)}
        <br />
        {SYM[card.s]}
      </div>
      <div style={{ textAlign: "center", fontSize: sfs, lineHeight: 1 }}>{SYM[card.s]}</div>
      <div style={{ lineHeight: 1.1, transform: "rotate(180deg)", alignSelf: "flex-end" }}>
        {VN(card.v)}
        <br />
        {SYM[card.s]}
      </div>
      {isSau && (
        <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", fontSize: 14, opacity: 0.22, pointerEvents: "none" }}>
          🐷
        </div>
      )}
    </div>
  );
}

function emitAck(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function cardId(card) {
  return String(card.s) + String(card.v);
}

function cardLabel(card) {
  return VN(card.v) + SYM[card.s];
}

const COMPASS_POSITIONS = [
  { area: "north", label: "Nord", seat: 0 },
  { area: "east", label: "Ost", seat: 1 },
  { area: "south", label: "Süd", seat: 2 },
  { area: "west", label: "West", seat: 3 },
];

function firstTrickSeatFromDealer(dealer) {
  const value = Number(dealer);
  return Number.isInteger(value) ? (value + 1) % 4 : 0;
}

function playerTypeIcon(type) {
  return type === "human" ? "👤" : "🧠";
}

function FirstTrickNote({ names = [], seatTypes = [], dealer }) {
  const firstSeat = firstTrickSeatFromDealer(dealer);
  const name = names[firstSeat] || `Platz ${firstSeat + 1}`;
  return (
    <div style={{ margin: "10px auto 12px", maxWidth: 420, padding: "8px 10px", borderRadius: 10, background: "rgba(244,196,48,0.09)", border: "1px solid rgba(244,196,48,0.24)", color: "rgba(255,255,255,0.78)", fontSize: 13, lineHeight: 1.35, textAlign: "center" }}>
      Erster Stich: <strong style={{ color: "#f4c430" }}>{playerTypeIcon(seatTypes[firstSeat])} {name}</strong> spielt aus.
    </div>
  );
}

function CompassTrickTable({
  names = [],
  seatTypes = [],
  trick = [],
  activeSeat = null,
  winnerSeat = null,
  cardSize = "md",
  showPoints = false,
}) {
  const playedBySeat = new Map((Array.isArray(trick) ? trick : []).map((play, order) => [Number(play.player), { ...play, order }]));
  const cardBox = cardSize === "sm" ? { width: 42, height: 59 } : { width: 58, height: 81 };
  const slotByArea = Object.fromEntries(COMPASS_POSITIONS.map((position) => [position.area, position]));

  const renderSlot = ({ area, label, seat }) => {
    const play = playedBySeat.get(seat);
    const isActive = Number(activeSeat) === seat;
    const isWinner = Number(winnerSeat) === seat;
    const name = names[seat] || `Platz ${seat + 1}`;
    const pts = play?.card ? cardPts(play.card) : 0;

    return (
      <div
        key={area}
        style={{
          width: "100%",
          maxWidth: area === "north" || area === "south" ? 150 : 104,
          minWidth: 0,
          display: "grid",
          justifyItems: "center",
          gap: 5,
          padding: "6px 5px",
          borderRadius: 12,
          background: play ? "rgba(255,255,255,0.055)" : isActive ? "rgba(244,196,48,0.1)" : "rgba(255,255,255,0.025)",
          border: isWinner
            ? "1px solid rgba(244,196,48,0.55)"
            : isActive
            ? "1px solid rgba(244,196,48,0.32)"
            : "1px solid rgba(255,255,255,0.07)",
          boxSizing: "border-box",
        }}
      >
        <div
          title={`${label}: ${name}`}
          style={{
            width: "100%",
            color: isWinner ? "#f4c430" : isActive ? "#f4c430" : "#6dbf8a",
            fontSize: 10,
            lineHeight: 1.2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            textAlign: "center",
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.46)" }}>{label}</span> · {playerTypeIcon(seatTypes[seat])} {name}
        </div>
        {play?.card ? (
          <CardFace card={play.card} size={cardSize} />
        ) : (
          <div
            aria-hidden="true"
            style={{
              width: cardBox.width,
              height: cardBox.height,
              borderRadius: 6,
              border: "1.5px dashed rgba(255,255,255,0.13)",
              background: "rgba(0,0,0,0.12)",
              boxSizing: "border-box",
            }}
          />
        )}
        {showPoints && (
          <div style={{ minHeight: 13, fontSize: 10, color: pts < 0 ? "#f87171" : "rgba(255,255,255,0.42)", lineHeight: "13px" }}>
            {play?.card && pts !== 0 ? pts : ""}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(78px,1fr) minmax(84px,1fr) minmax(78px,1fr)",
        gap: 8,
        justifyItems: "center",
        alignItems: "center",
        width: "100%",
        maxWidth: cardSize === "sm" ? 340 : 390,
        margin: "0 auto",
      }}
    >
      <div style={{ width: "100%", display: "flex", justifyContent: "flex-end" }}>
        {renderSlot(slotByArea.west)}
      </div>
      <div style={{ width: "100%", display: "grid", gap: 8, justifyItems: "center" }}>
        {renderSlot(slotByArea.north)}
        {renderSlot(slotByArea.south)}
      </div>
      <div style={{ width: "100%", display: "flex", justifyContent: "flex-start" }}>
        {renderSlot(slotByArea.east)}
      </div>
    </div>
  );
}

const COMMENT_CHOICES = [
  "Klassischer Selbstfopp",
  "Treffer - Versenkt!",
  "Oma Stich",
  "Ich liebe Plüssis",
  "Kommt von Herzen",
];

const RECONNECT_KEY = "wuzzReconnect";

function saveReconnect(roomCode, reconnectToken) {
  if (!roomCode || !reconnectToken) return;
  localStorage.setItem(RECONNECT_KEY, JSON.stringify({ roomCode, reconnectToken }));
}

function loadReconnect() {
  try {
    return JSON.parse(localStorage.getItem(RECONNECT_KEY) || "null");
  } catch {
    return null;
  }
}

function clearReconnect() {
  localStorage.removeItem(RECONNECT_KEY);
}

function highscoreText(entry) {
  if (!entry) return "noch kein Highscore";
  const seat = Number.isInteger(entry.seat) ? " · Platz " + (entry.seat + 1) : "";
  return `${entry.playerName || "Spieler"}${seat}: ${entry.score} Punkte`;
}

function BenchmarkHighscoreLine({ deckId, highscores }) {
  if (!deckId) return null;
  const entry = highscores?.[deckId] || null;
  return (
    <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 12, marginTop: 6 }}>
      Aktueller Highscore: <span style={{ color: entry ? "#f4c430" : "rgba(255,255,255,0.45)", fontWeight: entry ? "bold" : "normal" }}>{highscoreText(entry)}</span>
    </div>
  );
}

function BenchmarkGameLine({ game }) {
  if (!game?.benchmarkDeck) return null;
  return (
    <div style={{ color: "rgba(255,255,255,0.62)", fontSize: 13, textAlign: "center", marginTop: 6 }}>
      Benchmark: <span style={{ color: "#bfdbfe", fontWeight: "bold" }}>{game.benchmarkDeck.name}</span>
      {" · "}feste {game.benchmarkDeck.rounds || FIXED_BENCHMARK_ROUNDS} Spiele
      {" · "}Highscore: <span style={{ color: game.benchmarkHighscore ? "#f4c430" : "rgba(255,255,255,0.42)", fontWeight: game.benchmarkHighscore ? "bold" : "normal" }}>{highscoreText(game.benchmarkHighscore)}</span>
    </div>
  );
}

function PublicTablesPanel({ tables, connected, onJoin, onRefresh }) {
  const rows = Array.isArray(tables) ? tables : [];
  return (
    <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "#6dbf8a", fontSize: 12, letterSpacing: 0.5 }}>ÖFFENTLICHE TISCHE</div>
          <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 3 }}>
            Laufende öffentliche Spiele, denen du beitreten oder bei denen du zuschauen kannst.
          </div>
        </div>
        <Button onClick={onRefresh} disabled={!connected} style={{ padding: "7px 11px", background: "rgba(255,255,255,0.12)", color: "white" }}>
          Aktualisieren
        </Button>
      </div>
      {rows.length === 0 ? (
        <div style={{ color: "rgba(255,255,255,0.42)", fontSize: 13, padding: "6px 0" }}>
          Gerade läuft kein öffentlicher Tisch.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {rows.map((table) => (
            <div key={table.roomCode} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 10, alignItems: "center", padding: 11, borderRadius: 11, background: "rgba(0,0,0,0.18)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
                  <strong style={{ color: "#f4c430" }}>{table.roomCode}</strong>
                  <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 999, background: "rgba(244,196,48,0.12)", border: "1px solid rgba(244,196,48,0.28)", color: "#f4c430" }}>läuft</span>
                  {table.benchmarkDeck && (
                    <span style={{ fontSize: 11, padding: "2px 7px", borderRadius: 999, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.28)", color: "#bfdbfe" }}>
                      Benchmark: {table.benchmarkDeck.name}
                    </span>
                  )}
                </div>
                <div style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  Host: {table.hostName || "Host"} · Menschen: {table.humanPlayers}/4 · Spiel {table.round}/{table.maxRounds}
                </div>
                {table.benchmarkDeck?.highscore && (
                  <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12, marginTop: 3 }}>
                    Highscore {table.benchmarkDeck.name}: {highscoreText(table.benchmarkDeck.highscore)}
                  </div>
                )}
              </div>
              <Button onClick={() => onJoin(table.roomCode)} disabled={!connected} style={{ padding: "8px 12px" }}>
                Beitreten
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreStrip({ game }) {
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

function PointsDevelopmentGraph({ game }) {
  const [open, setOpen] = useState(false);
  const names = Array.isArray(game?.names) ? game.names : [];
  const rawHistory = Array.isArray(game?.scoreHistory) ? game.scoreHistory : [];
  const cleanedHistory = rawHistory
    .map((entry) => ({
      round: Number(entry?.round || 0),
      totalScores: Array.isArray(entry?.totalScores) ? entry.totalScores.map((n) => Number(n || 0)) : [],
    }))
    .filter((entry) => entry.totalScores.length >= names.length);

  const history = cleanedHistory.length && cleanedHistory[0].round === 0
    ? cleanedHistory
    : [{ round: 0, totalScores: names.map(() => 0) }, ...cleanedHistory];

  if (history.length < 2 || names.length === 0) return null;

  const finalScores = Array.isArray(game?.scores) && game.scores.length >= names.length
    ? game.scores.map((n) => Number(n || 0))
    : history[history.length - 1].totalScores;
  const bestScore = Math.max(...finalScores);
  const winnerSeats = new Set(finalScores.map((score, seat) => (score === bestScore ? seat : null)).filter((seat) => seat !== null));
  const palette = ["#f4c430", "#60a5fa", "#fb7185", "#34d399"];
  const width = 720;
  const height = 310;
  const pad = { left: 48, right: 104, top: 28, bottom: 42 };
  const rounds = history.map((entry) => Number(entry.round || 0));
  const minRound = Math.min(...rounds);
  const maxRound = Math.max(1, ...rounds);
  const allScores = history.flatMap((entry) => entry.totalScores.slice(0, names.length));
  const minScoreRaw = Math.min(0, ...allScores);
  const maxScoreRaw = Math.max(0, ...allScores);
  const scoreSpan = Math.max(1, maxScoreRaw - minScoreRaw);
  const minScore = Math.floor((minScoreRaw - scoreSpan * 0.08) / 10) * 10;
  const maxScore = Math.ceil((maxScoreRaw + scoreSpan * 0.08) / 10) * 10;
  const safeScoreSpan = Math.max(1, maxScore - minScore);
  const xFor = (round) => pad.left + ((Number(round || 0) - minRound) / Math.max(1, maxRound - minRound)) * (width - pad.left - pad.right);
  const yFor = (score) => pad.top + ((maxScore - Number(score || 0)) / safeScoreSpan) * (height - pad.top - pad.bottom);
  const yTicks = Array.from(new Set([maxScore, 0, minScore])).filter((value) => value >= minScore && value <= maxScore).sort((a, b) => b - a);
  const roundTicks = history.map((entry) => entry.round);

  const pathForSeat = (seat) => history
    .map((entry, idx) => (idx === 0 ? "M" : "L") + " " + xFor(entry.round).toFixed(1) + " " + yFor(entry.totalScores[seat]).toFixed(1))
    .join(" ");

  return (
    <div style={{ marginTop: 16, textAlign: "center" }}>
      <Button onClick={() => setOpen((value) => !value)} style={{ padding: "9px 14px", background: open ? "rgba(255,255,255,0.12)" : undefined, color: open ? "white" : undefined }}>
        {open ? "Punkteverlauf ausblenden" : "Punkteverlauf anzeigen"}
      </Button>
      {open && (
        <div style={{ marginTop: 14, padding: 14, borderRadius: 16, background: "rgba(0,0,0,0.24)", border: "1px solid rgba(255,255,255,0.1)", overflowX: "auto" }}>
          <svg viewBox={"0 0 " + width + " " + height} style={{ width: "100%", minWidth: 560, maxWidth: 760, display: "block", margin: "0 auto" }} role="img" aria-label="Punkteverlauf über die Spiele">
            <line x1={pad.left} y1={pad.top} x2={pad.left} y2={height - pad.bottom} stroke="rgba(255,255,255,0.3)" />
            <line x1={pad.left} y1={height - pad.bottom} x2={width - pad.right} y2={height - pad.bottom} stroke="rgba(255,255,255,0.3)" />
            {yTicks.map((tick) => (
              <g key={"y-" + tick}>
                <line x1={pad.left} y1={yFor(tick)} x2={width - pad.right} y2={yFor(tick)} stroke="rgba(255,255,255,0.08)" />
                <text x={pad.left - 8} y={yFor(tick) + 4} textAnchor="end" fill="rgba(255,255,255,0.58)" fontSize="12">{tick}</text>
              </g>
            ))}
            {roundTicks.map((round) => (
              <g key={"x-" + round}>
                <line x1={xFor(round)} y1={height - pad.bottom} x2={xFor(round)} y2={height - pad.bottom + 5} stroke="rgba(255,255,255,0.28)" />
                <text x={xFor(round)} y={height - pad.bottom + 22} textAnchor="middle" fill="rgba(255,255,255,0.58)" fontSize="12">{round === 0 ? "Start" : round}</text>
              </g>
            ))}
            {names.map((name, seat) => {
              const color = palette[seat % palette.length];
              const isWinner = winnerSeats.has(seat);
              const end = history[history.length - 1];
              const endX = xFor(end.round);
              const endY = yFor(finalScores[seat]);
              const partyHat = finalScores[seat] < -100;
              return (
                <g key={seat}>
                  <path d={pathForSeat(seat)} fill="none" stroke={color} strokeWidth={isWinner ? 4 : 2.4} strokeLinecap="round" strokeLinejoin="round" opacity={isWinner ? 1 : 0.78} />
                  {history.map((entry) => (
                    <circle key={seat + "-" + entry.round} cx={xFor(entry.round)} cy={yFor(entry.totalScores[seat])} r={isWinner ? 4 : 3} fill={color} stroke="rgba(0,0,0,0.45)" strokeWidth="1" />
                  ))}
                  <text x={endX + 9} y={endY - 5} fill={color} fontSize={isWinner ? "13" : "12"} fontWeight={isWinner ? "bold" : "normal"}>
                    {isWinner ? "🏆 " : ""}{name}
                  </text>
                  <text x={endX + 9} y={endY + 11} fill="rgba(255,255,255,0.65)" fontSize="11">
                    {finalScores[seat]}{partyHat ? " 🥳" : ""}
                  </text>
                </g>
              );
            })}
          </svg>
          <div style={{ marginTop: 10, display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", textAlign: "left" }}>
            {names.map((name, seat) => {
              const isWinner = winnerSeats.has(seat);
              const partyHat = finalScores[seat] < -100;
              return (
                <div key={seat} style={{ padding: "7px 9px", borderRadius: 10, background: isWinner ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.055)", border: isWinner ? "1px solid rgba(244,196,48,0.35)" : "1px solid rgba(255,255,255,0.08)" }}>
                  <span style={{ color: palette[seat % palette.length], fontWeight: "bold" }}>{isWinner ? "🏆 " : ""}{name}</span>
                  <span style={{ float: "right", color: "#f4c430", fontWeight: "bold" }}>{finalScores[seat]}{partyHat ? " 🥳" : ""}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LastTrickBanner({ game }) {
  if (!game.lastTrick) return null;
  const lt = game.lastTrick;
  return (
    <div style={{ marginTop: 14, padding: 12, borderRadius: 14, background: "rgba(0,0,0,0.28)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <div style={{ color: lt.pts >= 0 ? "#4ade80" : "#f87171", fontWeight: "bold", marginBottom: 8 }}>
        Letzter Stich: {game.names[lt.winner]} {lt.pts >= 0 ? "+" : ""}{lt.pts} Punkte
      </div>
      <CompassTrickTable
        names={game.names}
        seatTypes={game.seatTypes}
        trick={lt.trick}
        winnerSeat={lt.winner}
        cardSize="sm"
      />
    </div>
  );
}


function SpielReviewPanel({ game, summary }) {
  const [open, setOpen] = useState(false);
  const log = Array.isArray(summary?.spielLog) ? summary.spielLog : [];
  if (!log.length) return null;

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
                <CompassTrickTable
                  names={game.names}
                  seatTypes={game.seatTypes}
                  trick={trick}
                  winnerSeat={entry.winner}
                  cardSize="sm"
                  showPoints
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CommentBubbles({ game }) {
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

function CommentControls({ room, game, setError }) {
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
}


function RestClaimRevealPanel({ game, onHalt, onWeiter }) {
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
      {game.yourSeat !== null && (
        <div style={{ marginTop: 10 }}>
          {reveal.paused ? (
            <Button onClick={onWeiter} style={{ padding: "7px 13px" }}>Weiter</Button>
          ) : (
            <Button onClick={onHalt} style={{ padding: "7px 13px", background: "rgba(255,255,255,0.12)", color: "white" }}>Halt</Button>
          )}
          {reveal.paused && (
            <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>Restanzeige angehalten.</div>
          )}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <CompassTrickTable
          names={game.names}
          seatTypes={game.seatTypes}
          trick={active.trick || []}
          winnerSeat={active.winner}
          cardSize="sm"
        />
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

function NegativeCardsBar({ game }) {
  const stillOpen = unplayedPenaltyCards(game.penaltyPlayed || [], game.trick || []);
  const openSau = stillOpen.find((c) => c.s === "S" && c.v === 12);
  const openHearts = stillOpen.filter((c) => c.s === "H").sort((a, b) => a.v - b.v);
  const played = game.penaltyPlayed || [];
  const playedSau = played.find((c) => c.s === "S" && c.v === 12);
  const playedHearts = played.filter((c) => c.s === "H").sort((a, b) => a.v - b.v);

  const Chip = ({ card, muted = false }) => (
    <span
      style={{
        background: card.s === "S" ? "rgba(139,0,0,0.5)" : muted ? "rgba(255,255,255,0.06)" : "rgba(192,57,43,0.22)",
        border: card.s === "S" ? "1px solid rgba(192,57,43,0.7)" : muted ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(192,57,43,0.4)",
        borderRadius: 6,
        padding: "2px 6px",
        fontSize: 12,
        fontWeight: "bold",
        color: muted ? "rgba(255,255,255,0.42)" : card.s === "S" ? "#ffb3b3" : "#ff9090",
      }}
    >
      {card.s === "S" ? "🐷♠Q" : `♥${VN(card.v)}`}
    </span>
  );

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 14, background: "rgba(0,0,0,0.24)", border: "1px solid rgba(255,255,255,0.08)", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: "rgba(255,255,255,0.48)", letterSpacing: 0.5, marginRight: 2 }}>NOCH OFFEN:</span>
        {stillOpen.length === 0 && <span style={{ fontSize: 11, color: "rgba(255,255,255,0.25)" }}>— keine Strafkarte mehr offen —</span>}
        {openSau && <Chip card={openSau} />}
        {openHearts.map((card) => <Chip key={`${card.s}${card.v}`} card={card} />)}
      </div>
      {(playedSau || playedHearts.length > 0) && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.28)", letterSpacing: 0.5, marginRight: 2 }}>GESPIELT:</span>
          {playedSau && <Chip card={playedSau} muted />}
          {playedHearts.map((card) => <Chip key={`played-${card.s}${card.v}`} card={card} muted />)}
        </div>
      )}
    </div>
  );
}


function QuetschSlots({ cards = [] }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", gap: 10, margin: "14px 0 16px" }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            width: 58,
            height: 81,
            borderRadius: 8,
            border: cards[i] ? "1.5px solid rgba(244,196,48,0.65)" : "2px dashed rgba(255,255,255,0.18)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: cards[i] ? "rgba(244,196,48,0.08)" : "rgba(255,255,255,0.035)",
            color: "rgba(255,255,255,0.28)",
            fontSize: 24,
          }}
        >
          {cards[i] ? <CardFace card={cards[i]} size="sm" /> : "?"}
        </div>
      ))}
    </div>
  );
}

function JoinInProgressScreen({ room, playerName, onTakeOverBot, onSpectate }) {
  const normalizedName = String(playerName || "").trim();
  const ownDisconnectedSeats = (room?.seats || []).filter((seat) =>
    seat.type === "human" && seat.disconnected && String(seat.name || "").trim() === normalizedName
  );
  const takeoverSeats = ownDisconnectedSeats.length
    ? ownDisconnectedSeats
    : (room?.seats || []).filter((seat) => seat.type === "bot");
  const canTakeOverBot = takeoverSeats.length > 0;

  return (
    <div style={{ marginTop: 28, textAlign: "center", padding: "28px 18px", borderRadius: 16, background: "rgba(0,0,0,0.24)", border: "1px solid rgba(255,255,255,0.1)" }}>
      <h2 style={{ color: "#f4c430", marginTop: 0 }}>Der Tisch spielt bereits</h2>
      <div style={{ color: "rgba(255,255,255,0.68)", lineHeight: 1.5, maxWidth: 620, margin: "0 auto" }}>
        Du kannst zuschauen oder einen Bot-Platz übernehmen und direkt mitspielen.
        Wenn du einen Bot übernimmst, spielst du mit dessen aktueller Hand, Punkten und Spielsituation weiter.
      </div>
      {ownDisconnectedSeats.length > 0 && (
        <div style={{ color: "#f4c430", fontSize: 13, marginTop: 12 }}>
          Für deinen Namen gibt es bereits einen unterbrochenen Platz. Deshalb kannst du nur diesen Platz wieder übernehmen.
        </div>
      )}
      {canTakeOverBot && (
        <div style={{ marginTop: 16, display: "grid", gap: 10, maxWidth: 520, marginLeft: "auto", marginRight: "auto" }}>
          {takeoverSeats.map((seat) => (
            <div key={seat.seat} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", textAlign: "left" }}>
              <div>
                <strong>Platz {seat.seat + 1}</strong> · {seat.name || `Bot ${seat.seat + 1}`}
                {seat.disconnected && <span style={{ color: "rgba(255,255,255,0.5)" }}> · bisheriger Platz</span>}
              </div>
              <Button onClick={() => onTakeOverBot(seat.seat)} style={{ padding: "8px 12px" }}>
                Übernehmen
              </Button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap", marginTop: 22 }}>
        <Button onClick={onSpectate} style={{ background: "rgba(255,255,255,0.12)", color: "white" }}>
          Zuschauen
        </Button>
      </div>
      {!canTakeOverBot && (
        <div style={{ color: "rgba(255,255,255,0.42)", fontSize: 13, marginTop: 12 }}>
          Aktuell gibt es keinen Bot-Platz zum Übernehmen.
        </div>
      )}
    </div>
  );
}

function SuggestionPanel({ game }) {
  const [open, setOpen] = useState(false);
  const suggestion = game?.suggestion;
  const cards = Array.isArray(suggestion?.cards) ? suggestion.cards : [];
  if (!game?.easyMode || game.phase !== "play" || game.currentPlayer !== game.yourSeat || !cards.length) return null;

  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 12, background: "rgba(96,165,250,0.12)", border: "1px solid rgba(96,165,250,0.38)", color: "rgba(255,255,255,0.86)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <strong style={{ color: "#bfdbfe" }}>Bot-Tipp:</strong>{" "}
          {cards.map(cardLabel).join(" oder ")}
        </div>
        <button
          type="button"
          onClick={() => setOpen((x) => !x)}
          title="Tipp erklären"
          style={{ width: 28, height: 28, borderRadius: "50%", border: "1px solid rgba(191,219,254,0.75)", background: "rgba(255,255,255,0.08)", color: "#bfdbfe", fontWeight: "bold", cursor: "pointer", fontFamily: "Georgia,serif" }}
        >
          ?
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45, color: "rgba(255,255,255,0.72)" }}>
          {cards.map((card) => (
            <div key={cardId(card)}>
              <strong>{cardLabel(card)}:</strong> {suggestion.reasonByCard?.[cardId(card)] || suggestion.reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OnlineGame({ room, game, setError, onTakeOverBot }) {
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    setSelected([]);
  }, [game.phase, game.round, game.yourSeat, game.hand.map(cardId).join(",")]);

  const selectedHas = (card) => selected.some((c) => sameCard(c, card));
  const validHas = (card) => game.validCards.some((c) => sameCard(c, card));
  const quetschSuggestion = game.quetschSuggestion || null;
  const quetschSuggestedHas = (card) => Boolean(quetschSuggestion?.cards?.some((c) => sameCard(c, card)));
  const suggestedHas = (card) => Array.isArray(game.suggestion?.cards) && game.suggestion.cards.some((c) => sameCard(c, card));

  function toggleQuetsch(card) {
    setSelected((prev) => {
      if (prev.some((c) => sameCard(c, card))) return prev.filter((c) => !sameCard(c, card));
      if (prev.length >= 3) return prev;
      return [...prev, card];
    });
  }

  async function submitQuetsch() {
    const res = await emitAck("submitQuetsch", { roomCode: room.roomCode, cards: selected });
    if (res?.ok) setSelected([]);
    if (!res?.ok) setError(res?.message || "Quetsch-Karten konnten nicht weitergegeben werden.");
  }

  async function playCard(card) {
    const res = await emitAck("playCard", { roomCode: room.roomCode, card });
    if (!res?.ok) setError(res?.message || "Karte konnte nicht gespielt werden.");
  }

  async function claimRest() {
    const res = await emitAck("claimRest", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Rest konnte nicht geclaimt werden.");
  }

  async function respondRestClaim(accept) {
    const res = await emitAck("respondRestClaim", { roomCode: room.roomCode, accept });
    if (!res?.ok) setError(res?.message || "Antwort konnte nicht gesendet werden.");
  }

  async function haltRestClaimReveal() {
    const res = await emitAck("pauseRestClaimReveal", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Restanzeige konnte nicht angehalten werden.");
  }

  async function continueRestClaimReveal() {
    const res = await emitAck("continueRestClaimReveal", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Restanzeige konnte nicht fortgesetzt werden.");
  }

  async function startNextRound() {
    const res = await emitAck("startNextRound", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Nächstes Spiel konnte nicht gestartet werden.");
  }

  async function continueMatch() {
    const res = await emitAck("startNextRound", { roomCode: room.roomCode, continueMatch: true });
    if (!res?.ok) setError(res?.message || "Noch eine Rutsche konnte nicht gestartet werden.");
  }

  async function restartGame() {
    const res = await emitAck("restartGame", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Neues Spiel konnte nicht gestartet werden.");
  }


  async function takeOverBotFromGame() {
    if (typeof onTakeOverBot === "function") await onTakeOverBot();
  }

  const isTrickPause = game.phase === "trick_done";
  const displayedTrickNo = isTrickPause
    ? Math.min(game.tricksPlayed || 1, 13)
    : Math.min((game.tricksPlayed || 0) + 1, 13);

  if (game.phase === "gameover") {
    const ranked = game.names
      .map((name, seat) => ({ name, seat, score: game.scores[seat], type: game.seatTypes[seat] }))
      .sort((a, b) => b.score - a.score || a.seat - b.seat);
    const medals = ["🥇", "🥈", "🥉", "4."];

    return (
      <div style={{ marginTop: 22 }}>
        <h2 style={{ color: "#f4c430", textAlign: "center" }}>Rutschenende</h2>
        <BenchmarkGameLine game={game} />
        {ranked.map((p, i) => (
          <div key={p.seat} style={{ display: "flex", justifyContent: "space-between", padding: 13, marginTop: 8, borderRadius: 12, background: i === 0 ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.06)" }}>
            <span>{medals[i]} {p.type === "human" ? "👤" : "🧠"} {p.name}{p.score < -100 ? " 🥳" : ""}</span>
            <strong style={{ color: "#f4c430" }}>{p.score}</strong>
          </div>
        ))}
        <SpielReviewPanel game={game} summary={game.lastRound} />
        <PointsDevelopmentGraph game={game} />
        <div style={{ marginTop: 20, display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {game.canContinueMatch && (
            <Button onClick={continueMatch}>Noch eine Rutsche</Button>
          )}
          {game.canRestartMatch && (
            <Button onClick={restartGame} style={{ background: "rgba(255,255,255,0.12)", color: "white" }}>Neues Spiel</Button>
          )}
          {!game.canContinueMatch && !game.canRestartMatch && (
            <div style={{ color: "rgba(255,255,255,0.58)", textAlign: "center" }}>Warte, bis der Host entscheidet…</div>
          )}
        </div>
      </div>
    );
  }

  if (game.phase === "round_done") {
    const summary = game.lastRound;
    return (
      <div style={{ marginTop: 22 }}>
        <h2 style={{ color: "#f4c430", textAlign: "center" }}>Spiel {summary?.round ?? game.round} beendet</h2>
        <BenchmarkGameLine game={game} />
        <div style={{ color: "#6dbf8a", textAlign: "center", marginBottom: 16 }}>
          Spielergebnis und Gesamtstand
        </div>
        {summary?.claimedRest && (
          <div style={{ textAlign: "center", marginBottom: 14, color: "rgba(255,255,255,0.68)", fontSize: 13 }}>
            {summary.claimedRest.name} nimmt die restlichen {summary.claimedRest.remainingTricks} Stiche
            ({summary.claimedRest.pts >= 0 ? "+" : ""}{summary.claimedRest.pts} Punkte).
          </div>
        )}
        <div style={{ background: "rgba(0,0,0,0.22)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 68px 68px", gap: 6, padding: "8px 9px", color: "#6dbf8a", fontSize: 11, letterSpacing: 0.5, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            <span>SPIELER</span><span style={{ textAlign: "right" }}>SPIEL</span><span style={{ textAlign: "right" }}>GESAMT</span>
          </div>
          {game.names.map((name, seat) => {
            const rp = summary?.roundPts?.[seat] ?? 0;
            const total = summary?.totalScores?.[seat] ?? game.scores[seat];
            return (
              <div key={seat} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 68px 68px", gap: 6, alignItems: "center", padding: "10px 9px", background: seat % 2 ? "rgba(255,255,255,0.025)" : "transparent" }}>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{game.seatTypes[seat] === "human" ? "👤" : "🧠"} {name}</span>
                <strong style={{ textAlign: "right", color: rp >= 0 ? "#4ade80" : "#f87171" }}>{rp >= 0 ? "+" : ""}{rp}</strong>
                <strong style={{ textAlign: "right", color: "#f4c430", fontSize: 18 }}>{total}</strong>
              </div>
            );
          })}
        </div>
        <SpielReviewPanel game={game} summary={summary} />
        <div style={{ marginTop: 20, textAlign: "center" }}>
          {game.canStartNextRound ? (
            <Button onClick={startNextRound}>Spiel {game.round + 1} starten</Button>
          ) : (
            <div style={{ color: "rgba(255,255,255,0.58)" }}>Warte, bis der Host das nächste Spiel startet…</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "rgba(255,255,255,0.55)" }}>Tisch {room.roomCode}</div>
          <h2 style={{ color: "#f4c430", margin: "4px 0" }}>Wuzz · Spiel {game.round}/{game.maxRounds} · Rutsche {Math.ceil(game.round / 4)}/{game.matchRutschen ?? Math.ceil(game.maxRounds / 4)}</h2>
          {game.benchmarkDeck && (
            <div style={{ color: "rgba(255,255,255,0.58)", fontSize: 13 }}>
              Benchmark: <span style={{ color: "#bfdbfe", fontWeight: "bold" }}>{game.benchmarkDeck.name}</span> · feste {game.benchmarkDeck.rounds || FIXED_BENCHMARK_ROUNDS} Spiele
            </div>
          )}
        </div>
        <div style={{ color: "rgba(255,255,255,0.7)", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span>Dein Sitz: {game.yourSeat === null ? "Zuschauer" : `Sitz ${game.yourSeat + 1}`}</span>
          {game.yourSeat === null && room.seats?.some((seat) => seat.type === "bot" || (seat.type === "human" && seat.disconnected && String(seat.name || "").trim() === String(localStorage.getItem("wuzzName") || "").trim())) && (
            <Button onClick={takeOverBotFromGame} style={{ padding: "8px 12px" }}>
              Bot übernehmen
            </Button>
          )}
        </div>
      </div>

      <ScoreStrip game={game} />
      {game.showPenaltyTracker && <NegativeCardsBar game={game} />}
      {game.phase !== "rest_claim_reveal" && <LastTrickBanner game={game} />}
      <CommentBubbles game={game} />
      <SuggestionPanel game={game} />

      {game.lastRound && (
        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.48)", textAlign: "center", fontSize: 12 }}>
          Letztes Spiel: {game.lastRound.roundPts.map((pts, i) => `${game.names[i]} ${pts >= 0 ? "+" : ""}${pts}`).join(" · ")}
        </div>
      )}

      {game.phase === "rest_claim_reveal" && <RestClaimRevealPanel game={game} onHalt={haltRestClaimReveal} onWeiter={continueRestClaimReveal} />}
      {game.phase === "rest_claim_pending" && <RestClaimPendingPanel game={game} onRespond={respondRestClaim} />}

      {game.phase === "quetsch" && (
        <div style={{ marginTop: 22 }}>
          {game.yourSeat === null ? (
            <div style={{ textAlign: "center", padding: "30px 16px", color: "rgba(255,255,255,0.72)" }}>
              <h3 style={{ color: "#f4c430", marginTop: 0 }}>Quetsch läuft</h3>
              <FirstTrickNote names={game.names} seatTypes={game.seatTypes} dealer={game.dealer} />
              <div style={{ color: "rgba(255,255,255,0.58)", lineHeight: 1.45 }}>
                Du schaust zu. Die Quetsch-Karten bleiben verdeckt.
              </div>
              {Array.isArray(game.pendingQuetschSeats) && game.pendingQuetschSeats.length > 0 && (
                <div style={{ color: "rgba(255,255,255,0.42)", fontSize: 13, marginTop: 12 }}>
                  Noch offen: {game.pendingQuetschSeats.map((seat) => game.names[seat]).join(", ")}
                </div>
              )}
            </div>
          ) : game.quetschNeeded ? (
            <>
              <h3 style={{ color: "#f4c430", textAlign: "center" }}>Quetsch: 3 Karten an {game.names[game.quetschTarget]}</h3>
              <FirstTrickNote names={game.names} seatTypes={game.seatTypes} dealer={game.dealer} />
              {quetschSuggestion?.cards?.length ? (
                <div style={{ margin: "8px 0 12px", padding: 10, borderRadius: 12, background: "rgba(244,196,48,0.12)", border: "1px solid rgba(244,196,48,0.35)" }}>
                  <div style={{ fontWeight: "bold", marginBottom: 6 }}>Bot-Vorschlag für den Quetsch</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                    {quetschSuggestion.cards.map((card) => <CardFace key={cardId(card)} card={card} highlighted size="sm" />)}
                  </div>
                  <div style={{ opacity: 0.85, fontSize: 13 }}>{quetschSuggestion.reason}</div>
                </div>
              ) : null}
              <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 16 }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ width: 50, height: 70, borderRadius: 8, border: `2px solid ${selected[i] ? "#f4c430" : "rgba(255,255,255,0.14)"}`, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(255,255,255,0.04)" }}>
                    {selected[i] ? <CardFace card={selected[i]} size="sm" /> : "?"}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                {game.hand.map((card) => (
                  <CardFace
                    key={cardId(card)}
                    card={card}
                    selected={selectedHas(card)}
                    highlighted={quetschSuggestedHas(card) || (!selectedHas(card) && selected.length < 3)}
                    onClick={() => toggleQuetsch(card)}
                  />
                ))}
              </div>
              <CommentControls room={room} game={game} setError={setError} />
              <div style={{ textAlign: "center", marginTop: 18 }}>
                <Button onClick={submitQuetsch} disabled={selected.length !== 3}>Karten weitergeben</Button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "30px 16px", color: "rgba(255,255,255,0.72)" }}>
              <h3 style={{ color: "#f4c430", marginTop: 0 }}>Quetsch abgegeben</h3>
              <FirstTrickNote names={game.names} seatTypes={game.seatTypes} dealer={game.dealer} />
              <div style={{ color: "rgba(255,255,255,0.58)", lineHeight: 1.45 }}>
                {(game.quetschReceived || []).length === 3
                  ? <>Diese 3 Karten kommen von {game.names[game.quetschSource]}.<br /></>
                  : <>Du bekommst gleich 3 neue Karten von {game.names[game.quetschSource]}.<br /></>}
                Warte, bis alle ihre Quetsch-Karten ausgewählt haben.
              </div>
              <QuetschSlots cards={game.quetschReceived || []} />
              {game.yourSeat !== null && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ color: "#6dbf8a", fontSize: 11, letterSpacing: 0.5, marginBottom: 8 }}>DEINE HAND OHNE ABGEGEBENE KARTEN</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "center", padding: 10, borderRadius: 12, background: "rgba(0,0,0,0.18)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    {game.hand.map((card) => <CardFace key={cardId(card)} card={card} size="sm" />)}
                  </div>
                </div>
              )}
              {Array.isArray(game.pendingQuetschSeats) && game.pendingQuetschSeats.length > 0 && (
                <div style={{ color: "rgba(255,255,255,0.42)", fontSize: 13 }}>
                  Noch offen: {game.pendingQuetschSeats.map((seat) => game.names[seat]).join(", ")}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {game.phase === "quetsch_review" && (
        <div style={{ marginTop: 22, textAlign: "center", padding: "28px 16px", color: "rgba(255,255,255,0.75)" }}>
          <h3 style={{ color: "#f4c430", marginTop: 0 }}>Spiel beginnt gleich</h3>
          <FirstTrickNote names={game.names} seatTypes={game.seatTypes} dealer={game.dealer} />
          <div style={{ color: "rgba(255,255,255,0.6)", lineHeight: 1.45 }}>
            {game.yourSeat === null
              ? "Die Quetschphase ist abgeschlossen. Gleich beginnt die Spielphase."
              : <>Diese 3 Karten kommen von {game.names[game.quetschSource]}. Gleich beginnt die Spielphase.</>}
          </div>
          {game.yourSeat !== null && <QuetschSlots cards={game.quetschReceived || []} />}
          {game.yourSeat !== null && (
            <div style={{ marginTop: 16 }}>
              <div style={{ color: "#6dbf8a", fontSize: 11, letterSpacing: 0.5, marginBottom: 8 }}>DEINE HAND NACH DEM QUETSCH</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 7, justifyContent: "center", padding: 10, borderRadius: 12, background: "rgba(0,0,0,0.18)", border: "1px solid rgba(255,255,255,0.06)" }}>
                {game.hand.map((card) => <CardFace key={cardId(card)} card={card} size="sm" />)}
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: "rgba(255,255,255,0.42)" }}>Bereit machen für den ersten Stich…</div>
        </div>
      )}

        {(game.phase === "play" || game.phase === "trick_done") && (
        <div style={{ marginTop: 22 }}>
          <div style={{ textAlign: "center", color: "#6dbf8a", marginBottom: 10 }}>
            Stich {displayedTrickNo}/13 {game.leadSuit ? `· Ausgespielt: ${SYM[game.leadSuit]}` : ""}
          </div>

          <div style={{ minHeight: 185, padding: 14, borderRadius: 14, background: "rgba(0,0,0,0.2)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CompassTrickTable
              names={game.names}
              seatTypes={game.seatTypes}
              trick={game.trick}
              activeSeat={game.phase === "play" ? game.currentPlayer : null}
              cardSize="md"
              showPoints
            />
          </div>

          {!isTrickPause && (
            <>
              <h3 style={{ color: "#f4c430", textAlign: "center", marginTop: 18 }}>
            {game.phase === "trick_done" || game.currentPlayer === null || game.currentPlayer === undefined
              ? " "
              : game.currentPlayer === game.yourSeat
              ? "Du bist am Zug"
              : `${game.names[game.currentPlayer]} ist am Zug`}
          </h3>
              {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}
              {game.canClaimRest && (
                <div style={{ textAlign: "center", marginTop: 8, marginBottom: 8 }}>
                  <Button onClick={claimRest}>Rest zu mir</Button>
                  <div style={{ marginTop: 5, color: "rgba(255,255,255,0.45)", fontSize: 12 }}>
                    {game.restClaimNeedsApproval ? "Fragt die anderen: Na gut oder Nix da." : "Alle übrigen Stiche gehen sicher an dich."}
                  </div>
                </div>
              )}
            </>
          )}

          {game.yourSeat === null ? (
            <div style={{ textAlign: "center", color: "rgba(255,255,255,0.5)", fontSize: 13, marginTop: isTrickPause ? 18 : 0 }}>
              Du schaust zu. Die Handkarten der Spieler bleiben verdeckt.
            </div>
          ) : (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8, marginTop: isTrickPause ? 18 : 0 }}>
                {game.hand.map((card) => {
                  const canPlay = !isTrickPause && game.currentPlayer === game.yourSeat && validHas(card);
                  return (
                    <CardFace
                      key={cardId(card)}
                      card={card}
                      highlighted={canPlay}
                      suggested={!isTrickPause && game.currentPlayer === game.yourSeat && suggestedHas(card)}
                      dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}
                      onClick={canPlay ? () => playCard(card) : null}
                    />
                  );
                })}
              </div>
              <CommentControls room={room} game={game} setError={setError} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function OnlineLobby({ onBack }) {
  const [connected, setConnected] = useState(socket.connected);
  const [socketId, setSocketId] = useState(socket.id || null);
  const [name, setName] = useState(localStorage.getItem("wuzzName") || randomFirstName());
  const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(1);
  const [preferredShowPenaltyTracker, setPreferredShowPenaltyTracker] = useState(true);
  const [preferredEasyMode, setPreferredEasyMode] = useState(INITIAL_EASY_MODE_FROM_URL === true);
  const [preferredQuickGame, setPreferredQuickGame] = useState(false);
  const [preferredPublicTable, setPreferredPublicTable] = useState(false);
  const [preferredBenchmarkDeckId, setPreferredBenchmarkDeckId] = useState("");
  const [easyModeOptionVisible, setEasyModeOptionVisible] = useState(EASY_MODE_OPTION_VISIBLE);
  const [joinCode, setJoinCode] = useState("");
  const [room, setRoom] = useState(null);
  const [game, setGame] = useState(null);
  const [publicTables, setPublicTables] = useState([]);
  const [benchmarkHighscores, setBenchmarkHighscores] = useState({});
  const [error, setError] = useState("");

  useEffect(() => {
    if (!socket.connected) socket.connect();

    const onConnect = async () => {
      setConnected(true);
      setSocketId(socket.id);

      const saved = loadReconnect();
      if (saved?.roomCode && saved?.reconnectToken) {
        const res = await emitAck("reconnectSeat", saved);
        if (res?.ok) {
          saveReconnect(res.room?.roomCode, res.reconnectToken);
        }
      }

      const lobby = await emitAck("listPublicRooms", {});
      if (Array.isArray(lobby?.rooms)) setPublicTables(lobby.rooms);
      if (lobby?.benchmarkHighscores && typeof lobby.benchmarkHighscores === "object") {
        setBenchmarkHighscores(lobby.benchmarkHighscores);
      }
    };

    const onDisconnect = () => {
      setConnected(false);
      setSocketId(null);
    };

    const onHello = (msg = {}) => {
      setSocketId(msg.socketId);
      if (msg.features?.easyMode !== undefined) {
        // Server uses this flag only to tell the client whether the checkbox should be visible.
        // Do not reset preferredEasyMode here: URL-enabled hidden Easy Mode must stay possible.
        setEasyModeOptionVisible(Boolean(msg.features.easyMode));
      }
      if (msg.benchmarkHighscores && typeof msg.benchmarkHighscores === "object") {
        setBenchmarkHighscores(msg.benchmarkHighscores);
      }
    };

    const onPublicRoomsUpdated = (payload = {}) => {
      if (Array.isArray(payload.rooms)) setPublicTables(payload.rooms);
      if (payload.benchmarkHighscores && typeof payload.benchmarkHighscores === "object") {
        setBenchmarkHighscores(payload.benchmarkHighscores);
      }
    };

    const onRoomUpdated = (nextRoom) => {
      setRoom(nextRoom);
      if (nextRoom.status !== "playing") setGame(null);
      setError("");
    };

    const onGameUpdated = (payload) => {
      if (payload.room) setRoom(payload.room);
      setGame(payload.game);
      setError("");
    };

    const onRoomError = (payload) => {
      setError(payload.message || "Unbekannter Lobby-Fehler.");
    };

    const onRoomClosed = (payload) => {
      setRoom(null);
      setGame(null);
      clearReconnect();
      setError(payload.message || "Der Tisch wurde geschlossen.");
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("serverHello", onHello);
    socket.on("roomUpdated", onRoomUpdated);
    socket.on("gameUpdated", onGameUpdated);
    socket.on("publicRoomsUpdated", onPublicRoomsUpdated);
    socket.on("roomError", onRoomError);
    socket.on("roomClosed", onRoomClosed);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("serverHello", onHello);
      socket.off("roomUpdated", onRoomUpdated);
      socket.off("gameUpdated", onGameUpdated);
      socket.off("publicRoomsUpdated", onPublicRoomsUpdated);
      socket.off("roomError", onRoomError);
      socket.off("roomClosed", onRoomClosed);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem("wuzzName", name);
  }, [name]);

  const isHost = useMemo(() => {
    return !!room && !!socketId && room.hostSocketId === socketId;
  }, [room, socketId]);

  const mySeat = useMemo(() => {
    if (!room || !socketId) return null;
    return room.seats.find((s) => s.socketId === socketId) || null;
  }, [room, socketId]);

  const canStart = useMemo(() => {
    return !!room && isHost && room.status === "lobby" && room.seats.every((s) => s.type === "human" || s.type === "bot");
  }, [room, isHost]);

  const selectedBenchmarkDeckId = room?.settings?.benchmarkDeckId || preferredBenchmarkDeckId || "";
  const selectedBenchmarkDeck = BENCHMARK_DECKS.find((deck) => deck.id === selectedBenchmarkDeckId) || null;
  const benchmarkMode = Boolean(selectedBenchmarkDeckId);
  const activeMatchRutschen = benchmarkMode ? 2 : (room?.settings?.matchRutschen ?? preferredMatchRutschen);
  const activePublicTable = benchmarkMode ? false : (room?.settings?.publicTable ?? preferredPublicTable);

  async function createRoom() {
    if (benchmarkMode) {
      await startSoloGame(selectedBenchmarkDeckId);
      return;
    }
    setError("");
    const res = await emitAck("createRoom", {
      name,
      settings: {
        matchRutschen: benchmarkMode ? 2 : preferredMatchRutschen,
        showPenaltyTracker: preferredShowPenaltyTracker,
        easyMode: preferredEasyMode,
        quickGame: preferredQuickGame,
        publicTable: benchmarkMode ? false : preferredPublicTable,
        benchmarkDeckId: preferredBenchmarkDeckId || null,
      },
    });
    if (res?.ok) saveReconnect(res.room?.roomCode, res.reconnectToken);
    if (!res?.ok) setError(res?.message || "Tisch konnte nicht erstellt werden.");
  }

  async function refreshPublicRooms() {
    const res = await emitAck("listPublicRooms", {});
    if (!res?.ok) {
      setError(res?.message || "Öffentliche Tische konnten nicht geladen werden.");
      return;
    }
    if (Array.isArray(res.rooms)) setPublicTables(res.rooms);
    if (res.benchmarkHighscores && typeof res.benchmarkHighscores === "object") {
      setBenchmarkHighscores(res.benchmarkHighscores);
    }
  }

  async function joinPublicRoom(roomCode) {
    setError("");
    const code = String(roomCode || "").trim().toUpperCase();
    if (!code) return;
    const res = await emitAck("joinRoom", { roomCode: code, name });
    if (!res?.ok) setError(res?.message || "Öffentlicher Tisch konnte nicht betreten werden.");
  }

  async function joinRoom() {
    setError("");
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setError("Bitte gib einen Tischcode ein.");
      return;
    }

    const res = await emitAck("joinRoom", { roomCode: code, name });
    if (!res?.ok) setError(res?.message || "Tisch konnte nicht betreten werden.");
  }

  async function claimSeat(seat) {
    if (!room) return;
    const res = await emitAck("claimSeat", {
      roomCode: room.roomCode,
      seat,
      name,
    });
    if (res?.ok) saveReconnect(res.room?.roomCode, res.reconnectToken);
    if (!res?.ok) setError(res?.message || "Platz konnte nicht belegt werden.");
  }

  async function spectateRoom() {
    if (!room) return;
    setError("");
    const res = await emitAck("spectateRoom", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Zuschauen ist gerade nicht möglich.");
  }

  async function takeOverBotSeat(seat = null) {
    if (!room) return;
    setError("");
    const saved = loadReconnect();
    const res = await emitAck("takeOverBotSeat", {
      roomCode: room.roomCode,
      seat,
      name,
      reconnectToken: saved?.roomCode === room.roomCode ? saved.reconnectToken : null,
    });
    if (res?.ok) saveReconnect(res.room?.roomCode, res.reconnectToken);
    if (!res?.ok) setError(res?.message || "Bot konnte nicht übernommen werden.");
  }

  async function setBot(seat) {
    if (!room) return;
    const res = await emitAck("setSeatBot", {
      roomCode: room.roomCode,
      seat,
    });
    if (!res?.ok) setError(res?.message || "Bot konnte nicht gesetzt werden.");
  }

  async function updateRoomSettings(nextSettings) {
    const hasBenchmarkDeckId = Object.prototype.hasOwnProperty.call(nextSettings, "benchmarkDeckId");
    const merged = {
      matchRutschen: nextSettings.matchRutschen ?? preferredMatchRutschen,
      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,
      easyMode: nextSettings.easyMode ?? preferredEasyMode,
      quickGame: nextSettings.quickGame ?? preferredQuickGame,
      publicTable: nextSettings.publicTable ?? preferredPublicTable,
      benchmarkDeckId: hasBenchmarkDeckId ? (nextSettings.benchmarkDeckId || null) : (preferredBenchmarkDeckId || null),
    };
    if (merged.benchmarkDeckId) {
      merged.matchRutschen = 2;
      merged.publicTable = false;
    }
    setPreferredMatchRutschen(merged.matchRutschen);
    setPreferredShowPenaltyTracker(merged.showPenaltyTracker);
    setPreferredEasyMode(merged.easyMode);
    setPreferredQuickGame(merged.quickGame);
    setPreferredPublicTable(merged.publicTable);
    setPreferredBenchmarkDeckId(merged.benchmarkDeckId || "");
    if (!room) return;
    const res = await emitAck("setRoomSettings", { roomCode: room.roomCode, ...merged });
    if (!res?.ok) setError(res?.message || "Einstellungen konnten nicht geändert werden.");
  }

  async function setOpen(seat) {
    if (!room) return;
    const res = await emitAck("setSeatOpen", {
      roomCode: room.roomCode,
      seat,
    });
    if (!res?.ok) setError(res?.message || "Platz konnte nicht geöffnet werden.");
  }

  async function startSoloGame(benchmarkDeckIdOverride = undefined) {
    setError("");
    const benchmarkDeckId = benchmarkDeckIdOverride === undefined
      ? (preferredBenchmarkDeckId || null)
      : (benchmarkDeckIdOverride || null);
    const isBenchmarkRun = Boolean(benchmarkDeckId);
    if (isBenchmarkRun) {
      setPreferredBenchmarkDeckId(benchmarkDeckId);
      setPreferredMatchRutschen(2);
      setPreferredPublicTable(false);
    }
    const created = await emitAck("createRoom", {
      name,
      settings: {
        matchRutschen: isBenchmarkRun ? 2 : preferredMatchRutschen,
        showPenaltyTracker: preferredShowPenaltyTracker,
        easyMode: preferredEasyMode,
        quickGame: preferredQuickGame,
        publicTable: isBenchmarkRun ? false : preferredPublicTable,
        benchmarkDeckId,
      },
    });
    if (!created?.ok) {
      setError(created?.message || "Solo-Spiel konnte nicht erstellt werden.");
      return;
    }
    saveReconnect(created.room?.roomCode, created.reconnectToken);
    const roomCode = created.room.roomCode;
    for (const seat of [1, 2, 3]) {
      const bot = await emitAck("setSeatBot", { roomCode, seat });
      if (!bot?.ok) {
        setError(bot?.message || "Bots konnten nicht gesetzt werden.");
        return;
      }
    }
    const started = await emitAck("startGame", { roomCode });
    if (!started?.ok) setError(started?.message || "Solo-Spiel konnte nicht gestartet werden.");
  }

  async function startBenchmarkGame(deckId) {
    await startSoloGame(deckId);
  }

  async function startGame() {
    if (!room) return;
    const res = await emitAck("startGame", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Spiel konnte nicht gestartet werden.");
  }

  async function leave() {
    if (room) {
      await emitAck("leaveRoom", { roomCode: room.roomCode });
    }
    clearReconnect();
    setRoom(null);
    setGame(null);
  }

  return (
    <div style={page}>
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h1 style={{ margin: 0, color: "#f4c430" }}>Online-Lobby</h1>
            <div style={{ color: "rgba(255,255,255,0.55)", marginTop: 4 }}>
              Server: {connected ? "verbunden" : "getrennt"}
            </div>
          </div>
          <Button onClick={room ? leave : onBack}>Zurück</Button>
        </div>

        {error && (
          <div
            style={{
              marginTop: 16,
              padding: 12,
              borderRadius: 10,
              background: "rgba(192,57,43,0.25)",
              border: "1px solid rgba(192,57,43,0.5)",
              color: "#ffb3b3",
            }}
          >
            {error}
          </div>
        )}

        {room?.status === "playing" ? (
          game ? (
            <OnlineGame room={room} game={game} setError={setError} onTakeOverBot={takeOverBotSeat} />
          ) : (
            <JoinInProgressScreen room={room} playerName={name} onTakeOverBot={takeOverBotSeat} onSpectate={spectateRoom} />
          )
        ) : !room ? (
          <div style={{ marginTop: 22, display: "grid", gap: 18 }}>
            <label>
              Spielername
              <TextInput value={name} onChange={(e) => setName(e.target.value)} />
            </label>

            <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ color: "#6dbf8a", fontSize: 12, letterSpacing: 0.5 }}>SPIELDAUER</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button disabled={benchmarkMode} onClick={() => { setPreferredMatchRutschen(1); if (room) updateRoomSettings({ matchRutschen: 1 }); }} style={{ padding: "8px 12px", background: activeMatchRutschen === 1 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: activeMatchRutschen === 1 ? "#1a1a1a" : "white" }}>1 Rutsche · 4 Spiele</Button>
                <Button disabled={benchmarkMode} onClick={() => { setPreferredMatchRutschen(2); if (room) updateRoomSettings({ matchRutschen: 2 }); }} style={{ padding: "8px 12px", background: activeMatchRutschen === 2 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: activeMatchRutschen === 2 ? "#1a1a1a" : "white" }}>2 Rutschen · 8 Spiele</Button>
              </div>
              {benchmarkMode && (
                <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>
                  Benchmark-Modus nutzt immer {FIXED_BENCHMARK_ROUNDS} feste Spiele.
                </div>
              )}
              <label style={{ display: "grid", gap: 5, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                Kartengebung
                <select
                  value={selectedBenchmarkDeckId}
                  onChange={(e) => updateRoomSettings({ benchmarkDeckId: e.target.value || null, matchRutschen: e.target.value ? 2 : preferredMatchRutschen })}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "white",
                    fontFamily: "Georgia,serif",
                    fontSize: 14,
                  }}
                >
                  <option value="">Zufällige Karten</option>
                  {BENCHMARK_DECKS.map((deck) => (
                    <option key={deck.id} value={deck.id}>{deck.name} · {FIXED_BENCHMARK_ROUNDS} Spiele</option>
                  ))}
                </select>
                {selectedBenchmarkDeck && (
                  <span style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>{selectedBenchmarkDeck.description}</span>
                )}
                <BenchmarkHighscoreLine deckId={selectedBenchmarkDeckId} highscores={benchmarkHighscores} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={activePublicTable} disabled={benchmarkMode} onChange={(e) => { setPreferredPublicTable(e.target.checked); if (room) updateRoomSettings({ publicTable: e.target.checked }); }} />
                Tisch nach Spielstart öffentlich auf der Startseite anzeigen
              </label>
              {benchmarkMode && (
                <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>
                  Benchmark-Spiele sind fair vergleichbar: ein Mensch gegen drei Bots, nicht öffentlich beitretbar.
                </div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.quickGame ?? preferredQuickGame} onChange={(e) => { setPreferredQuickGame(e.target.checked); if (room) updateRoomSettings({ quickGame: e.target.checked }); }} />
                Schnelles Spiel: Stiche kürzer anzeigen
              </label>
              {easyModeOptionVisible && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                  <input type="checkbox" checked={room?.settings?.easyMode ?? preferredEasyMode} onChange={(e) => { setPreferredEasyMode(e.target.checked); if (room) updateRoomSettings({ easyMode: e.target.checked }); }} />
                  Einfacher Modus: Bot-Tipps anzeigen
                </label>
              )}
            </div>

            {benchmarkMode ? (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <Button onClick={() => startBenchmarkGame(selectedBenchmarkDeckId)} disabled={!connected || !selectedBenchmarkDeckId}>
                  Benchmark starten
                </Button>
                <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>
                  Startet direkt mit dir und drei Bots.
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <Button onClick={createRoom} disabled={!connected}>
                  Tisch eröffnen
                </Button>
                <Button onClick={() => startSoloGame()} disabled={!connected}>
                  Spiel alleine
                </Button>
              </div>
            )}

            <PublicTablesPanel
              tables={publicTables}
              connected={connected}
              onJoin={joinPublicRoom}
              onRefresh={refreshPublicRooms}
            />

            <div
              style={{
                borderTop: "1px solid rgba(255,255,255,0.12)",
                paddingTop: 18,
              }}
            >
              <label>
                Tischcode
                <TextInput
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  placeholder="ABCD"
                  maxLength={4}
                />
              </label>
              <div style={{ marginTop: 12 }}>
                <Button onClick={joinRoom} disabled={!connected}>
                  Tisch beitreten
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 22 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <div>
                <div style={{ color: "rgba(255,255,255,0.55)" }}>Tischcode</div>
                <div style={{ fontSize: 38, fontWeight: "bold", letterSpacing: 5 }}>
                  {room.roomCode}
                </div>
              </div>

              <div
                style={{
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: isHost
                    ? "rgba(244,196,48,0.15)"
                    : "rgba(255,255,255,0.08)",
                  color: isHost ? "#f4c430" : "rgba(255,255,255,0.7)",
                }}
              >
                {isHost ? "Du bist Host" : "Warte auf den Host"}
              </div>
            </div>

            <div style={{ marginTop: 18 }}>
              {isHost && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ color: "#6dbf8a", fontSize: 12, letterSpacing: 0.5, marginBottom: 8 }}>Lobby-Einstellungen</div>
                  <div style={{ display: "grid", gap: 10, padding: 12, borderRadius: 12, background: "rgba(255,255,255,0.045)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ color: "#6dbf8a", fontSize: 12, letterSpacing: 0.5 }}>SPIELDAUER</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Button disabled={benchmarkMode} onClick={() => { setPreferredMatchRutschen(1); if (room) updateRoomSettings({ matchRutschen: 1 }); }} style={{ padding: "8px 12px", background: activeMatchRutschen === 1 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: activeMatchRutschen === 1 ? "#1a1a1a" : "white" }}>1 Rutsche · 4 Spiele</Button>
                <Button disabled={benchmarkMode} onClick={() => { setPreferredMatchRutschen(2); if (room) updateRoomSettings({ matchRutschen: 2 }); }} style={{ padding: "8px 12px", background: activeMatchRutschen === 2 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: activeMatchRutschen === 2 ? "#1a1a1a" : "white" }}>2 Rutschen · 8 Spiele</Button>
              </div>
              {benchmarkMode && (
                <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>
                  Benchmark-Modus nutzt immer {FIXED_BENCHMARK_ROUNDS} feste Spiele.
                </div>
              )}
              <label style={{ display: "grid", gap: 5, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                Kartengebung
                <select
                  value={selectedBenchmarkDeckId}
                  onChange={(e) => updateRoomSettings({ benchmarkDeckId: e.target.value || null, matchRutschen: e.target.value ? 2 : preferredMatchRutschen })}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.2)",
                    background: "rgba(255,255,255,0.08)",
                    color: "white",
                    fontFamily: "Georgia,serif",
                    fontSize: 14,
                  }}
                >
                  <option value="">Zufällige Karten</option>
                  {BENCHMARK_DECKS.map((deck) => (
                    <option key={deck.id} value={deck.id}>{deck.name} · {FIXED_BENCHMARK_ROUNDS} Spiele</option>
                  ))}
                </select>
                {selectedBenchmarkDeck && (
                  <span style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>{selectedBenchmarkDeck.description}</span>
                )}
                <BenchmarkHighscoreLine deckId={selectedBenchmarkDeckId} highscores={benchmarkHighscores} />
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={activePublicTable} disabled={benchmarkMode} onChange={(e) => { setPreferredPublicTable(e.target.checked); if (room) updateRoomSettings({ publicTable: e.target.checked }); }} />
                Tisch nach Spielstart öffentlich auf der Startseite anzeigen
              </label>
              {benchmarkMode && (
                <div style={{ color: "rgba(255,255,255,0.48)", fontSize: 12 }}>
                  Benchmark-Spiele sind fair vergleichbar: ein Mensch gegen drei Bots, nicht öffentlich beitretbar.
                </div>
              )}
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.quickGame ?? preferredQuickGame} onChange={(e) => { setPreferredQuickGame(e.target.checked); if (room) updateRoomSettings({ quickGame: e.target.checked }); }} />
                Schnelles Spiel: Stiche kürzer anzeigen
              </label>
              {easyModeOptionVisible && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                  <input type="checkbox" checked={room?.settings?.easyMode ?? preferredEasyMode} onChange={(e) => { setPreferredEasyMode(e.target.checked); if (room) updateRoomSettings({ easyMode: e.target.checked }); }} />
                  Einfacher Modus: Bot-Tipps anzeigen
                </label>
              )}
            </div>
                </div>
              )}
            </div>

            <div style={{ marginTop: 22, display: "grid", gap: 12 }}>
              {room.seats.map((seat) => {
                const isMine = seat.socketId && seat.socketId === socketId;
                const label =
                  seat.type === "open"
                    ? "Frei"
                    : seat.type === "bot"
                    ? seat.name || "Bot"
                    : seat.name || "Mensch";

                return (
                  <div
                    key={seat.seat}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "80px 1fr auto",
                      gap: 12,
                      alignItems: "center",
                      padding: 14,
                      borderRadius: 14,
                      background: isMine
                        ? "rgba(244,196,48,0.12)"
                        : "rgba(255,255,255,0.06)",
                      border: isMine
                        ? "1px solid rgba(244,196,48,0.4)"
                        : "1px solid rgba(255,255,255,0.1)",
                    }}
                  >
                    <strong>Platz {seat.seat + 1}</strong>
                    <div>
                      <div>
                        {seat.type === "human"
                          ? "👤"
                          : seat.type === "bot"
                          ? "🧠"
                          : "○"}{" "}
                        {label} {seat.isHost ? "(Host)" : ""}
                      </div>
                      {isMine && (
                        <div style={{ fontSize: 12, color: "#f4c430" }}>
                          dein Platz
                        </div>
                      )}
                    </div>

                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {seat.type === "open" && (
                        <Button onClick={() => claimSeat(seat.seat)}>
                          Belegen
                        </Button>
                      )}

                      {isHost && seat.type !== "human" && (
                        <>
                          {seat.type !== "bot" && (
                            <Button onClick={() => setBot(seat.seat)}>
                              Bot
                            </Button>
                          )}
                          {seat.type !== "open" && (
                            <Button onClick={() => setOpen(seat.seat)}>
                              Frei
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 20, color: "rgba(255,255,255,0.55)" }}>
              Dein aktueller Platz: {mySeat ? `Platz ${mySeat.seat + 1}` : "noch keiner"}
            </div>

            <div style={{ marginTop: 18 }}>
              <Button onClick={startGame} disabled={!canStart}>
                Rutsche starten
              </Button>
              {!canStart && isHost && (
                <div style={{ color: "rgba(255,255,255,0.45)", marginTop: 8, fontSize: 13 }}>
                  Besetze zuerst jeden freien Platz mit einem Menschen oder Bot – oder nutze „Spiel alleine“.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
