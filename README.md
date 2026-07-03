# Wuzz Online

Render-ready multiplayer version of the Wuzz heuristic-bot app.

## Local development

```bash
npm install
npm run dev
```

Client: http://localhost:5173  
Server: http://localhost:3001

## Production / Render

Use a **Render Web Service**.

Build command:

```bash
npm install && npm run build
```

Start command:

```bash
npm start
```

Health check path:

```text
/health
```

Suggested environment variables:

```text
NODE_ENV=production
ROOM_TTL_MS=1800000
BOT_DELAY_MS=650
TRICK_REVIEW_MS=1400
EXPIRY_SWEEP_MS=60000
QUETSCH_REVIEW_MS=2600
BOT_PLAY_POLICY=rl
```

`BOT_PLAY_POLICY=rl` uses the trained residual RL card policy in
`shared/game/rlPolicyData.js`. Set `BOT_PLAY_POLICY=heuristic` to force the old
heuristic card player.

## RL bot training

The RL bot is a dependency-free residual policy trained by simulation against
the heuristic bot. It keeps the heuristic's legal/safety candidate set and learns
a card tie-breaker from self-play outcomes.

```bash
npm run train:rl          # 12-worker training run
npm run evaluate:rl       # head-to-head evaluation
npm run evaluate:rl:gate  # 5,000-match gate; exits non-zero unless RL beats heuristic
```

The current checked-in policy passed:

```text
npm run evaluate:rl:gate
averageMarginVsHeuristic: +2.697
marginStdErr: 0.927
strongerThanHeuristic: true
```

## Features

- Four fixed seats.
- Human or heuristic bot per seat.
- Host starts the game from the lobby.
- Server-authoritative game state.
- Private player views; opponent hands are not sent to clients.
- Reconnect tokens stored in localStorage.
- Rooms expire after 30 minutes of inactivity by default.
- If the host disconnects during a running game, the game continues.
- Disconnected human seats are temporarily controlled by the heuristic bot.
- Bot card play has a small delay for a more tabletop-like feel.
- Hosts can mark running games as public so they appear on the start page for joining or spectating.
- Benchmark decks provide fixed 4-game deals with current server highscores per deck.
- Online quetsch selection is parallel for all humans. After submitting, players see empty incoming-card slots while waiting.
- After all quetsch cards are selected, each player briefly sees the three received cards before the first trick starts.
