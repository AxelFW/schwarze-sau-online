const fs = require('fs');
const path = require('path');

function backup(file, suffix) {
  if (!fs.existsSync(file)) return false;
  const bak = file + suffix;
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  return true;
}

function lines(...xs) {
  return xs.join('\n');
}

function replaceOnce(text, search, replacement, label) {
  if (!text.includes(search)) {
    throw new Error(`Could not find expected block: ${label}`);
  }
  return text.replace(search, replacement);
}

const root = process.cwd();
const onlineLobbyPath = path.join(root, 'src', 'screens', 'OnlineLobby.jsx');

if (!fs.existsSync(onlineLobbyPath)) {
  throw new Error(`Missing file: ${onlineLobbyPath}`);
}

backup(onlineLobbyPath, '.bak-keep-hand-trick-pause');
let app = fs.readFileSync(onlineLobbyPath, 'utf8');

// Ensure the helper exists. The hand should remain visible during trick_done,
// but the current-player headline must not render because currentPlayer is null.
if (!app.includes('const isTrickPause = game.phase === "trick_done";')) {
  app = replaceOnce(
    app,
    lines(
      '  async function startNextRound() {',
      '    const res = await emitAck("startNextRound", { roomCode: room.roomCode });',
      '    if (!res?.ok) setError(res?.message || "Nächste Runde konnte nicht gestartet werden.");',
      '  }',
      ''
    ),
    lines(
      '  async function startNextRound() {',
      '    const res = await emitAck("startNextRound", { roomCode: room.roomCode });',
      '    if (!res?.ok) setError(res?.message || "Nächste Runde konnte nicht gestartet werden.");',
      '  }',
      '',
      '  const isTrickPause = game.phase === "trick_done";',
      '  const displayedTrickNo = isTrickPause',
      '    ? Math.min(game.tricksPlayed || 1, 13)',
      '    : Math.min((game.tricksPlayed || 0) + 1, 13);',
      ''
    ),
    'insert trick-pause display helpers'
  );
}

// Use the completed trick number during the pause, not the next trick number.
app = app.replace(
  'Stich {game.tricksPlayed + 1}/13 {game.leadSuit ? `· Angespielt: ${SYM[game.leadSuit]}` : ""}',
  'Stich {displayedTrickNo}/13 {game.leadSuit ? `· Angespielt: ${SYM[game.leadSuit]}` : ""}'
);

const originalTurnAndHandBlock = lines(
  '          <h3 style={{ color: "#f4c430", textAlign: "center", marginTop: 18 }}>',
  '            {game.currentPlayer === game.yourSeat ? "Du bist am Zug" : `${game.names[game.currentPlayer]} ist am Zug`}',
  '          </h3>',
  '          {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}',
  '',
  '          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8 }}>',
  '            {game.hand.map((card) => {',
  '              const canPlay = game.currentPlayer === game.yourSeat && validHas(card);',
  '              return (',
  '                <CardFace',
  '                  key={cardId(card)}',
  '                  card={card}',
  '                  highlighted={canPlay}',
  '                  dimmed={game.currentPlayer === game.yourSeat && !validHas(card)}',
  '                  onClick={canPlay ? () => playCard(card) : null}',
  '                />',
  '              );',
  '            })}',
  '          </div>'
);

const previousHiddenHandBlock = lines(
  '          {!isTrickPause && (',
  '            <>',
  '              <h3 style={{ color: "#f4c430", textAlign: "center", marginTop: 18 }}>',
  '                {game.currentPlayer === game.yourSeat ? "Du bist am Zug" : `${game.names[game.currentPlayer]} ist am Zug`}',
  '              </h3>',
  '              {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}',
  '',
  '              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8 }}>',
  '                {game.hand.map((card) => {',
  '                  const canPlay = game.currentPlayer === game.yourSeat && validHas(card);',
  '                  return (',
  '                    <CardFace',
  '                      key={cardId(card)}',
  '                      card={card}',
  '                      highlighted={canPlay}',
  '                      dimmed={game.currentPlayer === game.yourSeat && !validHas(card)}',
  '                      onClick={canPlay ? () => playCard(card) : null}',
  '                    />',
  '                  );',
  '                })}',
  '              </div>',
  '            </>',
  '          )}'
);

const desiredBlock = lines(
  '          {!isTrickPause && (',
  '            <>',
  '              <h3 style={{ color: "#f4c430", textAlign: "center", marginTop: 18 }}>',
  '                {game.currentPlayer === game.yourSeat ? "Du bist am Zug" : `${game.names[game.currentPlayer]} ist am Zug`}',
  '              </h3>',
  '              {game.leadSuit && <div style={{ color: "#9dcfb0", textAlign: "center", marginBottom: 8 }}>Bedienen: {SYM[game.leadSuit]}</div>}',
  '            </>',
  '          )}',
  '',
  '          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", paddingBottom: 8, marginTop: isTrickPause ? 18 : 0 }}>',
  '            {game.hand.map((card) => {',
  '              const canPlay = !isTrickPause && game.currentPlayer === game.yourSeat && validHas(card);',
  '              return (',
  '                <CardFace',
  '                  key={cardId(card)}',
  '                  card={card}',
  '                  highlighted={canPlay}',
  '                  dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}',
  '                  onClick={canPlay ? () => playCard(card) : null}',
  '                />',
  '              );',
  '            })}',
  '          </div>'
);

if (app.includes(previousHiddenHandBlock)) {
  app = app.replace(previousHiddenHandBlock, desiredBlock);
} else if (app.includes(originalTurnAndHandBlock)) {
  app = app.replace(originalTurnAndHandBlock, desiredBlock);
} else if (app.includes('marginTop: isTrickPause ? 18 : 0')) {
  console.log('OnlineLobby.jsx already appears to keep the hand visible during trick pause.');
} else {
  throw new Error('Could not find the online turn/hand block. Upload the current OnlineLobby.jsx if this patch fails.');
}

fs.writeFileSync(onlineLobbyPath, app);
console.log('Patched src/screens/OnlineLobby.jsx: trick pause hides only the turn text, not the hand.');
console.log('Done. Run: npm run build');
