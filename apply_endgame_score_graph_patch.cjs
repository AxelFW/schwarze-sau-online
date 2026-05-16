#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const suffix = `.bak-endgame-score-graph-${new Date().toISOString().replace(/[:.]/g, '-')}`;

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
  const abs = path.join(root, rel);
  fs.copyFileSync(abs, abs + suffix);
  fs.writeFileSync(abs, content);
}

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`Could not find unique block for ${label}. Found ${count}.`);
  }
  return source.replace(needle, replacement);
}

const serverRel = 'server/rooms.js';
const clientRel = 'src/screens/OnlineLobby.jsx';

let server = read(serverRel);

if (!server.includes('scoreHistory: [{ round: 0, roundPts: [0, 0, 0, 0], totalScores: [0, 0, 0, 0] }],')) {
  server = replaceOnce(
    server,
    '    scores: [0, 0, 0, 0],\n    dealer,',
    '    scores: [0, 0, 0, 0],\n    scoreHistory: [{ round: 0, roundPts: [0, 0, 0, 0], totalScores: [0, 0, 0, 0] }],\n    dealer,',
    'initial score history'
  );
}

if (!server.includes('game.scoreHistory = [\n    ...game.scoreHistory.filter')) {
  server = replaceOnce(
    server,
`  game.lastRound = {
    round: game.round,
    dealer: game.dealer,
    roundPts: [...gs.roundPts],
    totalScores: [...nextScores],
    tricksWon: [...gs.tricksWon],
    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,
  };
  game.scores = nextScores;`,
`  game.lastRound = {
    round: game.round,
    dealer: game.dealer,
    roundPts: [...gs.roundPts],
    totalScores: [...nextScores],
    tricksWon: [...gs.tricksWon],
    claimedRest: game.lastRestClaim ? { ...game.lastRestClaim } : null,
  };
  if (!Array.isArray(game.scoreHistory) || game.scoreHistory.length === 0) {
    game.scoreHistory = [{ round: 0, roundPts: [0, 0, 0, 0], totalScores: [0, 0, 0, 0] }];
  }
  game.scoreHistory = [
    ...game.scoreHistory.filter((entry) => Number(entry?.round) !== Number(game.round)),
    { round: game.round, roundPts: [...gs.roundPts], totalScores: [...nextScores] },
  ].sort((a, b) => Number(a.round || 0) - Number(b.round || 0));
  game.scores = nextScores;`,
    'finishRound score history update'
  );
}

if (!server.includes('scoreHistory: Array.isArray(game.scoreHistory) ? game.scoreHistory.map')) {
  server = replaceOnce(
    server,
`    roundPts: gs.roundPts,
    runScores,
    scores: game.scores,
    tricksWon: gs.tricksWon,`,
`    roundPts: gs.roundPts,
    runScores,
    scores: game.scores,
    scoreHistory: Array.isArray(game.scoreHistory) ? game.scoreHistory.map((entry) => ({
      round: Number(entry.round || 0),
      roundPts: Array.isArray(entry.roundPts) ? [...entry.roundPts] : [0, 0, 0, 0],
      totalScores: Array.isArray(entry.totalScores) ? [...entry.totalScores] : [0, 0, 0, 0],
    })) : [],
    tricksWon: gs.tricksWon,`,
    'private game view score history'
  );
}

write(serverRel, server);

let client = read(clientRel);

const graphComponent = `
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
`;

if (!client.includes('function PointsDevelopmentGraph({ game })')) {
  client = replaceOnce(
    client,
    '\nfunction LastTrickBanner({ game }) {',
    graphComponent + '\nfunction LastTrickBanner({ game }) {',
    'insert PointsDevelopmentGraph component'
  );
}

if (!client.includes('<PointsDevelopmentGraph game={game} />')) {
  client = replaceOnce(
    client,
`        {ranked.map((p, i) => (
          <div key={p.seat} style={{ display: "flex", justifyContent: "space-between", padding: 13, marginTop: 8, borderRadius: 12, background: i === 0 ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.06)" }}>
            <span>{medals[i]} {p.type === "human" ? "👤" : "🧠"} {p.name}</span>
            <strong style={{ color: "#f4c430" }}>{p.score}</strong>
          </div>
        ))}
      </div>
    );`,
`        {ranked.map((p, i) => (
          <div key={p.seat} style={{ display: "flex", justifyContent: "space-between", padding: 13, marginTop: 8, borderRadius: 12, background: i === 0 ? "rgba(244,196,48,0.12)" : "rgba(255,255,255,0.06)" }}>
            <span>{medals[i]} {p.type === "human" ? "👤" : "🧠"} {p.name}{p.score < -100 ? " 🥳" : ""}</span>
            <strong style={{ color: "#f4c430" }}>{p.score}</strong>
          </div>
        ))}
        <PointsDevelopmentGraph game={game} />
      </div>
    );`,
    'gameover graph button'
  );
}

write(clientRel, client);

console.log('✅ Patch applied: optional end-of-game points graph with winner highlight and party hats.');
console.log(`Backups were written with suffix ${suffix}`);
