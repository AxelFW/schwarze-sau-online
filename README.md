# Schwarze Sau Online

Render-ready multiplayer version of the Schwarze-Sau heuristic-bot app.

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
EXPIRY_SWEEP_MS=60000
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
