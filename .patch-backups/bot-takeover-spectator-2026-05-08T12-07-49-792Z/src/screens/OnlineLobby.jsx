import { useEffect, useMemo, useState } from "react";
import { socket } from "../multiplayer/socketClient.js";
import { SYM, VN, isRed, sameCard, cardPts, unplayedPenaltyCards } from "../../shared/game/cards.js";

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
  "Agnes"
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

function CardFace({ card, highlighted, dimmed, selected, onClick, size = "md" }) {
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
          : highlighted
          ? "2px solid rgba(244,196,48,0.55)"
          : isSau
          ? "1.5px solid #C0392B"
          : "1px solid #ccc",
        boxShadow: selected
          ? "0 0 14px rgba(244,196,48,0.8),1px 3px 6px rgba(0,0,0,0.3)"
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
        transform: selected ? "translateY(-12px) scale(1.05)" : highlighted && onClick ? "translateY(-5px)" : "none",
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
  return `${card.s}${card.v}`;
}

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

function ScoreStrip({ game }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 5, marginTop: 12 }}>
      {game.names.map((name, i) => (
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
          <div style={{ fontSize: 18, fontWeight: "bold", color: i === game.currentPlayer ? "#f4c430" : "white", lineHeight: 1.15 }}>{game.runScores[i]}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.45)", whiteSpace: "nowrap" }}>{game.tricksWon[i]}✦ · Sp {game.roundPts[i] >= 0 ? "+" : ""}{game.roundPts[i]}</div>
        </div>
      ))}
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
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center", alignItems: "flex-start" }}>
        {lt.trick.map(({ player, card }, idx) => (
          <div
            key={idx}
            style={{
              width: 72,
              flex: "0 0 72px",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: "100%",
                fontSize: 10,
                color: "#6dbf8a",
                marginBottom: 5,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                textAlign: "center",
              }}
              title={game.names[player]}
            >
              {game.names[player]}
            </div>
            <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
              <CardFace card={card} size="sm" />
            </div>
          </div>
        ))}
      </div>
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

function OnlineGame({ room, game, setError }) {
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    setSelected([]);
  }, [game.phase, game.round, game.yourSeat, game.hand.map(cardId).join(",")]);

  const selectedHas = (card) => selected.some((c) => sameCard(c, card));
  const validHas = (card) => game.validCards.some((c) => sameCard(c, card));

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

  async function startNextRound() {
    const res = await emitAck("startNextRound", { roomCode: room.roomCode });
    if (!res?.ok) setError(res?.message || "Nächste Rutsche konnte nicht gestartet werden.");
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
        {ranked.map((p, i) => (
          <div key={p.seat} style={{ display: "flex", justifyContent: "space-between", padding: 13, marginTop: 8, borderRadius: 12, background: i === 0 ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.06)" }}>
            <span>{medals[i]} {p.type === "human" ? "👤" : "🧠"} {p.name}</span>
            <strong style={{ color: "#f4c430" }}>{p.score}</strong>
          </div>
        ))}
      </div>
    );
  }

  if (game.phase === "round_done") {
    const summary = game.lastRound;
    return (
      <div style={{ marginTop: 22 }}>
        <h2 style={{ color: "#f4c430", textAlign: "center" }}>Spiel {summary?.round ?? game.round} beendet</h2>
        <div style={{ color: "#6dbf8a", textAlign: "center", marginBottom: 16 }}>
          Spielergebnis und Gesamtstand
        </div>
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
        </div>
        <div style={{ color: "rgba(255,255,255,0.7)" }}>
          Dein Sitz: {game.yourSeat === null ? "Zuschauer" : `Sitz ${game.yourSeat + 1}`}
        </div>
      </div>

      <ScoreStrip game={game} />
      {game.showPenaltyTracker && <NegativeCardsBar game={game} />}
      <LastTrickBanner game={game} />

      {game.lastRound && (
        <div style={{ marginTop: 12, color: "rgba(255,255,255,0.6)", textAlign: "center", fontSize: 13 }}>
          Letztes Spiel: {game.lastRound.roundPts.map((pts, i) => `${game.names[i]} ${pts >= 0 ? "+" : ""}${pts}`).join(" · ")}
        </div>
      )}

      {game.phase === "quetsch" && (
        <div style={{ marginTop: 22 }}>
          {game.quetschNeeded ? (
            <>
              <h3 style={{ color: "#f4c430", textAlign: "center" }}>Quetsch: 3 Karten an {game.names[game.quetschTarget]}</h3>
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
                    highlighted={!selectedHas(card) && selected.length < 3}
                    onClick={() => toggleQuetsch(card)}
                  />
                ))}
              </div>
              <div style={{ textAlign: "center", marginTop: 18 }}>
                <Button onClick={submitQuetsch} disabled={selected.length !== 3}>Karten weitergeben</Button>
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "30px 16px", color: "rgba(255,255,255,0.72)" }}>
              <h3 style={{ color: "#f4c430", marginTop: 0 }}>Quetsch abgegeben</h3>
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
          <div style={{ color: "rgba(255,255,255,0.6)", lineHeight: 1.45 }}>
            Diese 3 Karten kommen von {game.names[game.quetschSource]}. Gleich beginnt die Spielphase.
          </div>
          <QuetschSlots cards={game.quetschReceived || []} />
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

          <div style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "center", flexWrap: "wrap", minHeight: 105, padding: 14, borderRadius: 14, background: "rgba(0,0,0,0.2)" }}>
            {game.trick.length === 0 ? (
              <span style={{ color: "rgba(255,255,255,0.25)" }}>Noch keine Karte gespielt</span>
            ) : (
              game.trick.map(({ player, card }, idx) => (
                <div
                  key={idx}
                  style={{
                    width: 92,
                    flex: "0 0 92px",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    textAlign: "center",
                  }}
                >
                  <div
                    style={{
                      width: "100%",
                      fontSize: 11,
                      color: "#6dbf8a",
                      marginBottom: 4,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      textAlign: "center",
                    }}
                    title={game.names[player]}
                  >
                    {game.names[player]}
                  </div>
                  <div style={{ width: "100%", display: "flex", justifyContent: "center" }}>
                    <CardFace card={card} />
                  </div>
                  <div style={{ width: "100%", fontSize: 10, color: cardPts(card) < 0 ? "#f87171" : "rgba(255,255,255,0.4)", marginTop: 3, textAlign: "center" }}>
                    {cardPts(card) !== 0 ? cardPts(card) : ""}
                  </div>
                </div>
              ))
            )}
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
            </>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8, marginTop: isTrickPause ? 18 : 0 }}>
            {game.hand.map((card) => {
              const canPlay = !isTrickPause && game.currentPlayer === game.yourSeat && validHas(card);
              return (
                <CardFace
                  key={cardId(card)}
                  card={card}
                  highlighted={canPlay}
                  dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}
                  onClick={canPlay ? () => playCard(card) : null}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function OnlineLobby({ onBack }) {
  const [connected, setConnected] = useState(socket.connected);
  const [socketId, setSocketId] = useState(socket.id || null);
  const [name, setName] = useState(localStorage.getItem("wuzzName") || randomFirstName());
  const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(2);
  const [preferredShowPenaltyTracker, setPreferredShowPenaltyTracker] = useState(true);
  const [joinCode, setJoinCode] = useState("");
  const [room, setRoom] = useState(null);
  const [game, setGame] = useState(null);
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
    };

    const onDisconnect = () => {
      setConnected(false);
      setSocketId(null);
    };

    const onHello = (msg) => {
      setSocketId(msg.socketId);
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
    socket.on("roomError", onRoomError);
    socket.on("roomClosed", onRoomClosed);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("serverHello", onHello);
      socket.off("roomUpdated", onRoomUpdated);
      socket.off("gameUpdated", onGameUpdated);
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

  async function createRoom() {
    setError("");
    const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker } });
    if (res?.ok) saveReconnect(res.room?.roomCode, res.reconnectToken);
    if (!res?.ok) setError(res?.message || "Tisch konnte nicht erstellt werden.");
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

  async function setBot(seat) {
    if (!room) return;
    const res = await emitAck("setSeatBot", {
      roomCode: room.roomCode,
      seat,
    });
    if (!res?.ok) setError(res?.message || "Bot konnte nicht gesetzt werden.");
  }

  async function updateRoomSettings(nextSettings) {
    const merged = {
      matchRutschen: nextSettings.matchRutschen ?? preferredMatchRutschen,
      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,
    };
    setPreferredMatchRutschen(merged.matchRutschen);
    setPreferredShowPenaltyTracker(merged.showPenaltyTracker);
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

  async function startSoloGame() {
    setError("");
    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker } });
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
            <OnlineGame room={room} game={game} setError={setError} />
          ) : (
            <div style={{ marginTop: 32, textAlign: "center", color: "rgba(255,255,255,0.65)" }}>Warte auf Spielstand…</div>
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
                <Button onClick={() => { setPreferredMatchRutschen(1); if (room) updateRoomSettings({ matchRutschen: 1 }); }} style={{ padding: "8px 12px", background: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 1 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 1 ? "#1a1a1a" : "white" }}>1 Rutsche · 4 Spiele</Button>
                <Button onClick={() => { setPreferredMatchRutschen(2); if (room) updateRoomSettings({ matchRutschen: 2 }); }} style={{ padding: "8px 12px", background: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 2 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 2 ? "#1a1a1a" : "white" }}>2 Rutschen · 8 Spiele</Button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>
            </div>

            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Button onClick={createRoom} disabled={!connected}>
                Tisch eröffnen
              </Button>
              <Button onClick={startSoloGame} disabled={!connected}>
                Spiel alleine
              </Button>
            </div>

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
                <Button onClick={() => { setPreferredMatchRutschen(1); if (room) updateRoomSettings({ matchRutschen: 1 }); }} style={{ padding: "8px 12px", background: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 1 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 1 ? "#1a1a1a" : "white" }}>1 Rutsche · 4 Spiele</Button>
                <Button onClick={() => { setPreferredMatchRutschen(2); if (room) updateRoomSettings({ matchRutschen: 2 }); }} style={{ padding: "8px 12px", background: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 2 ? "linear-gradient(135deg,#f4c430,#d4a017)" : "rgba(255,255,255,0.12)", color: (room?.settings?.matchRutschen ?? preferredMatchRutschen) === 2 ? "#1a1a1a" : "white" }}>2 Rutschen · 8 Spiele</Button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>
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
