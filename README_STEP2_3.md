# Schwarze Sau local heuristic migration — steps 2 and 3

This bundle extracts the game logic and heuristic bot from the React component and verifies that a complete local 4-heuristic-player match can run without React and without any bot server.

## New structure

```text
src/
  App.jsx                  # local-only React app shell; no trained bot server
  game/
    cards.js               # card constants, sorting, scoring, valid-card helpers
    heuristicBot.js        # quetsch heuristic + play heuristic
    engine.js              # deal, applyCard, quetsch application, round/match simulation
scripts/
  simulate-local-heuristic.mjs
package.json              # includes Vite dev/build scripts
index.html                # Vite entry HTML
src/main.jsx              # React mount point
```

## Run the app

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Run the local simulation

```bash
npm run simulate:smoke
node scripts/simulate-local-heuristic.mjs --matches 1000 --seed 20260504
```

Expected result: `failures: []` and `completedMatches` equal to the requested match count.

## Notes

- The server/trained-bot path is removed from this local-only version.
- The app still supports 4 fixed seats, each either `human` or `heuristic`.
- The simulation uses the same `engine.js` and `heuristicBot.js` modules as the React app.
- While extracting, the quetsch-aware spade re-add step was fixed so it cannot empty the candidate list when the current candidates are already spades.
