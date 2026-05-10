#!/usr/bin/env node
/*
  Patch: Easy mode bot suggestions for Wuzz online lobby.

  What it does:
  - Adds a lobby setting "easyMode".
  - Sends a server-side heuristic recommendation only to the current human player.
  - Highlights all suggested cards in the hand.
  - Adds a small dedicated "?" button/panel explaining the recommendation.
  - Keeps the actual bot play stochastic where it was stochastic before.

  Usage from repo root:
    node add-easy-mode-suggestions.cjs
*/

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(root, '.patch-backups', `easy-mode-suggestions-${stamp}`);

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function backup(rel) {
  const src = path.join(root, rel);
  const dst = path.join(backupRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function replaceOnce(text, from, to, rel) {
  if (!text.includes(from)) {
    throw new Error(`Could not find expected block in ${rel}:\n${from.slice(0, 240)}`);
  }
  return text.replace(from, to);
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  let escape = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('Could not find matching brace.');
}

function replaceExportedChooseFunction(src) {
  const marker = 'export const chooseHeuristicCard = (gs, player) => {';
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('Could not find chooseHeuristicCard export.');
  const open = src.indexOf('{', start);
  const close = findMatchingBrace(src, open);
  let end = close + 1;
  while (src[end] === ' ' || src[end] === '\t') end++;
  if (src.slice(end, end + 2) !== ';\n') throw new Error('Unexpected chooseHeuristicCard ending.');
  end += 2;
  return src.slice(0, start) + NEW_HEURISTIC_DECISION_BLOCK + src.slice(end);
}

const NEW_HEURISTIC_DECISION_BLOCK = String.raw`const uniqueCardsByKey = cards => {
  const seen = new Set();
  const out = [];
  for(const c of cards || []) {
    if(!c) continue;
    const key = cardKey(c);
    if(seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
};

const botSuggestionReason = (rule, detail = '') => {
  const suffix = detail ? ' ' + detail : '';
  switch(rule) {
    case 'void_dump':
      return 'Du kannst die angespielte Farbe nicht bedienen; der Bot nutzt das zum Abwerfen einer gefährlichen oder strategisch passenden Karte.' + suffix;
    case 'heart_follow_control':
      return 'Bei Herz versucht der Bot möglichst unter dem aktuellen Stich zu bleiben; falls das nicht geht, hält er den Schaden klein.' + suffix;
    case 'spade_cashout':
      return 'Die ♠Q ist hier ein Cashout: außen sind nur noch hohe Pik, daher muss jemand sie übernehmen.' + suffix;
    case 'spade_safety_lead':
      return 'Der Bot vermeidet einen gefährlichen Pik-Anspieler, solange die ♠Q noch problematisch ist.' + suffix;
    case 'harvest_lead':
      return 'Der Bot sieht nur noch wenig Strafkarten-Risiko und versucht einen positiven Stich zu gewinnen.' + suffix;
    case 'risky_heart_lead':
      return 'Der Bot meidet riskante Herz-Anspiele und nimmt die sicherere verbliebene Alternative.' + suffix;
    case 'void_risk_lead':
      return 'Der Bot meidet eine Farbe, in der ein Mitspieler vermutlich abwerfen kann, falls die Karte den Stich gewinnt.' + suffix;
    case 'negative_history_lead':
      return 'Der Bot meidet Farben, die schon negative Stiche erzeugt haben, außer die Karte ist ein sicherer Ausstieg.' + suffix;
    case 'void_creation_lead':
      return 'Unter Gefahr versucht der Bot eine kurze Farbe leerzuspielen, um später besser abwerfen zu können.' + suffix;
    case 'safe_ace_lead':
      return 'Der Bot spielt ein sicheres ♣/♦-Ass, weil es meist einen positiven Stich einsammelt.' + suffix;
    case 'midgame_lead':
      return 'Im Mittelspiel bevorzugt der Bot kleine, noch übernehmbare Karten aus einer sicheren Farbe.' + suffix;
    case 'positive_follow_take':
      return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich.' + suffix;
    case 'positive_follow_duck':
      return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler den Stich noch übernehmen könnten.' + suffix;
    case 'avoid_bad_follow_win':
      return 'Der Bot vermeidet es, einen aktuell negativen Stich selbst zu gewinnen.' + suffix;
    case 'midgame_follow':
      return 'Im Mittelspiel wirft der Bot die höchste Karte ab, die den Stich nicht gewinnt.' + suffix;
    case 'normal_follow':
      return 'Der Bot wählt unter den sicheren gültigen Karten nach seiner normalen Stichlogik.' + suffix;
    case 'normal_lead':
    default:
      return 'Der Bot empfiehlt diese Karte nach seiner normalen Sicherheits- und Stichlogik.' + suffix;
  }
};

const suggestionDecision = (cards, rule, detail = '') => {
  const cleanCards = uniqueCardsByKey(cards);
  const reason = botSuggestionReason(rule, detail);
  return {
    cards: cleanCards,
    rule,
    reason,
    reasonByCard: Object.fromEntries(cleanCards.map(c => [cardKey(c), reason])),
  };
};

const voidDumpRecommendationCandidates = (valid, gs, player) => {
  const emergencyDumps = criticalVoidDumpCandidates(valid, gs, player);
  if(emergencyDumps.length) return [emergencyDumps[0]];

  const strategicDump = strategicVoidDump(valid, gs, player);
  if(strategicDump) return [strategicDump];

  const highNegatives = valid.filter(isHighNegativeForDump);
  if(highNegatives.length) return [sortByNegativityDesc(highNegatives)[0]];

  if(queenSpadesStillOutNotInHand(gs, player) && spadesLowerThanQueenInHand(gs, player) < 2) {
    const highSpades = valid.filter(c => c.s === 'S' && (c.v === 13 || c.v === 14));
    if(highSpades.length) return largestCards(highSpades);
  }

  const midMinor = valid.filter(c => (c.s === 'D' || c.s === 'C') && c.v >= 5 && c.v <= 11);
  if(midMinor.length) {
    const minRemaining = Math.min(...midMinor.map(c => remainingPublicSuitCount(gs, player, c.s)));
    const shortestSuitCards = midMinor.filter(c => remainingPublicSuitCount(gs, player, c.s) === minRemaining);
    return largestCards(shortestSuitCards);
  }

  const smallHearts = valid.filter(c => c.s === 'H' && c.v <= 5);
  if(smallHearts.length) return largestCards(smallHearts);

  const lowSpades = valid.filter(c => c.s === 'S' && c.v < 12);
  if(lowSpades.length) return largestCards(lowSpades);

  return [sortByNegativityDesc(valid)[0]];
};

const heartFollowControlCandidates = (cards, gs) => {
  const losing = highestLosingCards(cards, gs);
  return losing.length ? losing : smallestCards(cards);
};

const heuristicDecision = (gs, player, { stochastic = true } = {}) => {
  const hand = gs.hands[player];
  const valid = getValidIdxs(hand, gs.leadSuit).map(i => hand[i]);
  const isLeading = !gs.leadSuit || gs.trick.length === 0;
  const finish = (cards, rule, detail = '') => {
    const clean = uniqueCardsByKey(cards);
    if(stochastic) return suggestionDecision([randomFrom(clean)], rule, detail);
    return suggestionDecision(clean, rule, detail);
  };

  if(!valid.length) return suggestionDecision([], 'normal_follow');

  // H1: Void dump — when unable to follow suit, dump worst penalty first.
  if(gs.leadSuit && !hand.some(c => c.s === gs.leadSuit)) {
    const cards = stochastic ? [voidDump(valid, gs, player)] : voidDumpRecommendationCandidates(valid, gs, player);
    return finish(cards, 'void_dump');
  }

  // H2: Heart-follow-control.
  // Exception: in harvest mode, take a positive heart trick when the card is
  // likely to remain winning.
  if(!isLeading && gs.leadSuit === 'H') {
    const harvestFollow = harvestFollowWinners(valid, gs, player);
    if(harvestFollow.length) return finish(harvestFollow, 'positive_follow_take');
    return finish(heartFollowControlCandidates(valid, gs), 'heart_follow_control');
  }

  if(isLeading) {
    let candidates = [...valid];
    const protectedSpadeFallback = protectedNonQueenSpadeFallbackCandidates(valid, gs, player);

    // H0L: ♠Q cashout. This rare tactic has priority over every normal lead
    // heuristic: if all outside spades are ♠K/♠A, ♠Q is guaranteed to be beaten.
    const queenCashout = queenSpadeCashoutLeadCandidates(valid, gs, player);
    if(queenCashout.length) return finish(queenCashout, 'spade_cashout');

    // H3: Spade-lead safety.
    // - If we hold ♠Q, do not lead any spade while an alternative exists.
    // - If ♠Q is not in our hand, do not lead ♠K/♠A while an alternative exists.
    //   These high spades are exactly the cards that can later be trapped by ♠Q.
    if(queenSpadesInHand(gs, player)) {
      const noSpade = candidates.filter(c => c.s !== 'S');
      if(noSpade.length) {
        candidates = noSpade;
      } else {
        // H0L did not fire, so leading ♠Q is unsafe. If the hand is all
        // spades, lead the lowest non-queen spade and only play ♠Q if forced.
        const nonQueenSpades = nonQueenSpadeLeadCandidates(candidates);
        if(nonQueenSpades.length) return finish(nonQueenSpades, 'spade_safety_lead');
        return finish([candidates.find(c => sameCard(c, QUEEN_SPADES)) ?? valid[0]], 'spade_safety_lead');
      }
    } else {
      const noSpadeAboveQueen = candidates.filter(c => !(c.s === 'S' && c.v > 12));
      if(noSpadeAboveQueen.length) candidates = noSpadeAboveQueen;
    }

    // H_Q1: If we passed ♠Q left, allow safe LOW spades to pressure that seat.
    // The no-high-spade-lead rule still applies: never re-add ♠K/♠A here.
    if(queenSpadesPassedLeft(gs, player)) {
      const spadesInHand = valid.filter(c => c.s === 'S' && c.v < 12);
      if(spadesInHand.length) {
        const unseenSpades = unseenCardsOfSuit(gs, player, 'S');
        const safeSpades = spadesInHand.filter(c => unseenSpades.some(u => u.v > c.v));
        if(safeSpades.length) {
          const nonSpadeCandidates = candidates.filter(c => c.s !== 'S');
          candidates = [
            ...nonSpadeCandidates,
            ...safeSpades.filter(c => !nonSpadeCandidates.some(x => sameCard(x, c))),
          ];
        }
      }
    }

    // H_HARVEST: If late-game penalty risk is low, stop over-avoiding
    // voids and prefer high-probability winners of positive tricks.
    // This runs after ♠Q safety, so it cannot accidentally expose ♠Q.
    const harvestLeads = harvestWinningLeads(candidates, gs, player);
    if(harvestLeads.length) return finish(harvestLeads, 'harvest_lead');

    // H5: Avoid risky heart leads.
    const hearts = candidates.filter(c => c.s === 'H');
    if(hearts.length) {
      const riskyHearts = hearts.filter(c => heartLeadRisk(c, gs, player));
      if(riskyHearts.length) {
        const filtered = candidates.filter(c => !riskyHearts.some(r => sameCard(r, c)));
        if(filtered.length) {
          candidates = filtered;
        } else if(protectedSpadeFallback.length) {
          return finish(protectedSpadeFallback, 'risky_heart_lead');
        } else {
          return finish(heartLeadPreferenceCandidates(hearts, gs, player), 'risky_heart_lead');
        }
      } else if(candidates.every(c => c.s === 'H')) {
        candidates = heartLeadPreferenceCandidates(hearts, gs, player);
      }
    }

    // H_V1: Known-void suits are only dangerous when the card is likely to win.
    const riskyVoidLeads = candidates.filter(c => voidRiskyWinningLead(c, gs, player));
    if(riskyVoidLeads.length) {
      const safeFromVoid = candidates.filter(c => !riskyVoidLeads.some(r => sameCard(r, c)));
      if(safeFromVoid.length) {
        candidates = safeFromVoid;
      } else if(protectedSpadeFallback.length) {
        return finish(protectedSpadeFallback, 'void_risk_lead');
      } else {
        candidates = leastBadVoidRiskLeadCandidates(candidates, gs, player);
      }
    }

    // H_NEGHIST: From trick 2 onward, avoid non-heart suits that have already
    // produced a negative trick, unless the candidate is a safe bleed/exit.
    if(gs.tricksPlayed >= 1) {
      const filteredByHistory = negativeHistoryNonHeartLeadCandidates(candidates, gs, player);
      if(filteredByHistory.length) {
        candidates = filteredByHistory;
      } else if(protectedSpadeFallback.length) {
        return finish(protectedSpadeFallback, 'negative_history_lead');
      }
    }

    // H6b: Under serious danger, prefer creating a short-suit void.
    const voidCreationLeads = voidCreationLeadCandidates(candidates, gs, player);
    if(voidCreationLeads.length) return finish(voidCreationLeads, 'void_creation_lead');

    // H7: Prefer safe ♣A / ♦A openers after risk filters.
    const safeAces = candidates.filter(c => (c.s === 'C' || c.s === 'D') && c.v === 14);
    if(safeAces.length) return finish(safeAces, 'safe_ace_lead');

    // H10 + H11: Midgame small-card, safe-suit preference.
    if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
      candidates = midgameLeadCandidates(candidates, gs, player);
      return finish(candidates, 'midgame_lead');
    }

    return finish(candidates, 'normal_lead');
  }

  // Following heuristics.
  let candidates = [...valid];

  // Hearts deliberately keep the old dedicated heart-follow branch above.
  // Spades keep their dedicated safety logic while ♠Q is still live; after
  // ♠Q is completed/out, spades can be treated as a normal suit.
  const spadesAreNormal = gs.leadSuit !== 'S' || queenSpadesPlayed(gs);

  // H4: Spade-following intelligence while ♠Q is still live.
  if(gs.leadSuit === 'S' && !spadesAreNormal) {
    candidates = spadeFollowCandidates(candidates, gs, player);
  }

  // New H9a: fourth position — always take truly positive tricks.
  if(spadesAreNormal && gs.trick.length === 3) {
    const positiveWinners = positiveFollowWinners(candidates, gs);
    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // H8 revised: avoid wasting King under Ace pressure.
  candidates = avoidKingUnderAcePressure(candidates, gs, player);

  // H6 follow-side: avoid currently winning net-negative tricks.
  const beforeRiskAvoidance = candidates;
  candidates = avoidRiskyFollowWinners(candidates, gs, player);
  const avoidedRiskyWin = beforeRiskAvoidance.length !== candidates.length || (
    beforeRiskAvoidance.length === candidates.length &&
    beforeRiskAvoidance.some((c, i) => !sameCard(c, candidates[i]))
  );

  // New H9b: third position — probabilistically overtake positive tricks.
  if(spadesAreNormal && gs.trick.length === 2) {
    const positiveWinners = positiveFollowWinners(candidates, gs);
    const losing = highestLosingCards(candidates, gs);

    if(positiveWinners.length && losing.length) {
      const fourthPlayer = (player + 1) % 4;
      const pTake = followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);
      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Chance, dass der nächste Spieler bedienen kann).';
      if(stochastic) {
        return Math.random() < pTake
          ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
          : finish(losing, 'positive_follow_duck', detail);
      }
      return pTake >= 0.5
        ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
        : finish(losing, 'positive_follow_duck', detail);
    }

    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // New H9c: second position — probabilistically overtake positive tricks,
  // but only as often as both later players are plausibly non-void.
  if(spadesAreNormal && gs.trick.length === 1) {
    const positiveWinners = positiveFollowWinners(candidates, gs);
    const losing = highestLosingCards(candidates, gs);

    if(positiveWinners.length && losing.length) {
      const thirdPlayer = (player + 1) % 4;
      const fourthPlayer = (player + 2) % 4;
      const pTake =
        followSuitNonVoidProbability(gs, player, thirdPlayer, gs.leadSuit) *
        followSuitNonVoidProbability(gs, player, fourthPlayer, gs.leadSuit);
      const detail = '(geschätzt: ' + (100 * pTake).toFixed(0) + '% Chance, dass beide späteren Spieler bedienen können).';
      if(stochastic) {
        return Math.random() < pTake
          ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
          : finish(losing, 'positive_follow_duck', detail);
      }
      return pTake >= 0.5
        ? finish(largestCards(positiveWinners), 'positive_follow_take', detail)
        : finish(losing, 'positive_follow_duck', detail);
    }

    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }

  // H10 revised: Midgame follow — shed the largest non-winning card.
  if(gs.tricksPlayed >= 4 && gs.tricksPlayed <= 10) {
    const losing = highestLosingCards(candidates, gs);
    candidates = losing.length ? losing : smallestCards(candidates);
    return finish(candidates, 'midgame_follow');
  }

  return finish(candidates, avoidedRiskyWin ? 'avoid_bad_follow_win' : 'normal_follow');
};

export const recommendHeuristicCards = (gs, player) => heuristicDecision(gs, player, { stochastic: false });

export const chooseHeuristicCard = (gs, player) => {
  const decision = heuristicDecision(gs, player, { stochastic: true });
  return decision.cards[0];
};
`;

function patchHeuristicBot() {
  const rel = 'shared/game/heuristicBot.js';
  backup(rel);
  let src = read(rel);
  if (src.includes('export const recommendHeuristicCards')) {
    console.log(`${rel}: already patched`);
    return;
  }
  src = replaceExportedChooseFunction(src);
  write(rel, src);
  console.log(`${rel}: patched`);
}

function patchRooms() {
  const rel = 'server/rooms.js';
  backup(rel);
  let src = read(rel);
  if (src.includes('recommendHeuristicCards') && src.includes('easyMode: settings.easyMode === true')) {
    console.log(`${rel}: already patched`);
    return;
  }

  src = replaceOnce(
    src,
    'import { heuristicQuetschPick, chooseHeuristicCard } from "../shared/game/heuristicBot.js";',
    'import { heuristicQuetschPick, chooseHeuristicCard, recommendHeuristicCards } from "../shared/game/heuristicBot.js";',
    rel
  );

  src = replaceOnce(
    src,
    `function defaultRoomSettings(settings = {}) {
  return {
    matchRutschen: normalizeMatchRutschen(settings.matchRutschen ?? DEFAULT_MATCH_RUNDEN),
    showPenaltyTracker: settings.showPenaltyTracker !== false,
  };
}`,
    `function defaultRoomSettings(settings = {}) {
  return {
    matchRutschen: normalizeMatchRutschen(settings.matchRutschen ?? DEFAULT_MATCH_RUNDEN),
    showPenaltyTracker: settings.showPenaltyTracker !== false,
    easyMode: settings.easyMode === true,
  };
}`,
    rel
  );

  src = replaceOnce(
    src,
    `export function setRoomSettings({ roomCode, socketId, matchRutschen, showPenaltyTracker }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const next = defaultRoomSettings(room.settings);
  if (matchRutschen !== undefined) next.matchRutschen = normalizeMatchRutschen(matchRutschen);
  if (showPenaltyTracker !== undefined) next.showPenaltyTracker = showPenaltyTracker !== false;
  room.settings = next;`,
    `export function setRoomSettings({ roomCode, socketId, matchRutschen, showPenaltyTracker, easyMode }) {
  const room = requireRoom(roomCode);
  assertLobby(room);
  requireHost(room, socketId);
  const next = defaultRoomSettings(room.settings);
  if (matchRutschen !== undefined) next.matchRutschen = normalizeMatchRutschen(matchRutschen);
  if (showPenaltyTracker !== undefined) next.showPenaltyTracker = showPenaltyTracker !== false;
  if (easyMode !== undefined) next.easyMode = easyMode === true;
  room.settings = next;`,
    rel
  );

  src = replaceOnce(
    src,
    `  const validCards = seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex ? getValidCards(gs, seatIndex) : [];
  const pendingQuetschSeats = game.phase === "quetsch" ? pendingHumanQuetschSeats(room) : [];
  const quetschSubmitted = seatIndex !== null && Array.isArray(game.quetschSelections?.[seatIndex]);
  const quetschReceived = visibleQuetschReceivedForSeat(game, seatIndex);
  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));`,
    `  const validCards = seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex ? getValidCards(gs, seatIndex) : [];
  const settings = defaultRoomSettings(room.settings);
  let suggestion = null;
  if (settings.easyMode && seatIndex !== null && game.phase === "play" && gs.currentPlayer === seatIndex && validCards.length) {
    const rec = recommendHeuristicCards(botDecisionGameState(room), seatIndex);
    suggestion = {
      cards: Array.isArray(rec?.cards) ? rec.cards.filter((card) => validCards.some((valid) => sameCard(valid, card))) : [],
      rule: rec?.rule || "normal_follow",
      reason: rec?.reason || "Der Bot empfiehlt diese Karte nach seiner normalen Sicherheits- und Stichlogik.",
      reasonByCard: rec?.reasonByCard || {},
    };
    if (!suggestion.cards.length) suggestion = null;
  }
  const pendingQuetschSeats = game.phase === "quetsch" ? pendingHumanQuetschSeats(room) : [];
  const quetschSubmitted = seatIndex !== null && Array.isArray(game.quetschSelections?.[seatIndex]);
  const quetschReceived = visibleQuetschReceivedForSeat(game, seatIndex);
  const runScores = game.scores.map((score, i) => score + (gs.roundPts?.[i] || 0));`,
    rel
  );

  src = replaceOnce(
    src,
    `    matchRutschen: game.matchRutschen ?? defaultRoomSettings(room.settings).matchRutschen,
    showPenaltyTracker: defaultRoomSettings(room.settings).showPenaltyTracker,`,
    `    matchRutschen: game.matchRutschen ?? settings.matchRutschen,
    showPenaltyTracker: settings.showPenaltyTracker,
    easyMode: settings.easyMode,
    suggestion,`,
    rel
  );

  write(rel, src);
  console.log(`${rel}: patched`);
}

function patchServerIndex() {
  const rel = 'server/index.js';
  backup(rel);
  let src = read(rel);
  if (src.includes('easyMode: payload.easyMode')) {
    console.log(`${rel}: already patched`);
    return;
  }

  src = replaceOnce(
    src,
    `      const room = setRoomSettings({
        roomCode: payload.roomCode,
        socketId: socket.id,
        matchRutschen: payload.matchRutschen,
        showPenaltyTracker: payload.showPenaltyTracker,
      });`,
    `      const room = setRoomSettings({
        roomCode: payload.roomCode,
        socketId: socket.id,
        matchRutschen: payload.matchRutschen,
        showPenaltyTracker: payload.showPenaltyTracker,
        easyMode: payload.easyMode,
      });`,
    rel
  );

  write(rel, src);
  console.log(`${rel}: patched`);
}

function patchOnlineLobby() {
  const rel = 'src/screens/OnlineLobby.jsx';
  backup(rel);
  let src = read(rel);
  if (src.includes('function SuggestionPanel({ game })') && src.includes('preferredEasyMode')) {
    console.log(`${rel}: already patched`);
    return;
  }

  src = replaceOnce(
    src,
    'function CardFace({ card, highlighted, dimmed, selected, onClick, size = "md" }) {',
    'function CardFace({ card, highlighted, dimmed, selected, suggested, onClick, size = "md" }) {',
    rel
  );

  src = replaceOnce(
    src,
    `        border: selected
          ? "2.5px solid #f4c430"
          : highlighted
          ? "2px solid rgba(244,196,48,0.55)"
          : isSau
          ? "1.5px solid #C0392B"
          : "1px solid #ccc",
        boxShadow: selected
          ? "0 0 14px rgba(244,196,48,0.8),1px 3px 6px rgba(0,0,0,0.3)"
          : "1px 2px 5px rgba(0,0,0,0.3)",`,
    `        border: selected
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
          : "1px 2px 5px rgba(0,0,0,0.3)",`,
    rel
  );

  src = replaceOnce(
    src,
    `        transform: selected ? "translateY(-12px) scale(1.05)" : highlighted && onClick ? "translateY(-5px)" : "none",`,
    `        transform: selected ? "translateY(-12px) scale(1.05)" : suggested && onClick ? "translateY(-8px) scale(1.03)" : highlighted && onClick ? "translateY(-5px)" : "none",`,
    rel
  );

  src = replaceOnce(
    src,
    'function cardId(card) {\n  return `${card.s}${card.v}`;\n}',
    'function cardId(card) {\n  return String(card.s) + String(card.v);\n}\n\nfunction cardLabel(card) {\n  return VN(card.v) + SYM[card.s];\n}',
    rel
  );

  src = replaceOnce(
    src,
    `function OnlineGame({ room, game, setError, onTakeOverBot }) {
  const [selected, setSelected] = useState([]);`,
    `function SuggestionPanel({ game }) {
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
  const [selected, setSelected] = useState([]);`,
    rel
  );

  src = replaceOnce(
    src,
    `  const selectedHas = (card) => selected.some((c) => sameCard(c, card));
  const validHas = (card) => game.validCards.some((c) => sameCard(c, card));`,
    `  const selectedHas = (card) => selected.some((c) => sameCard(c, card));
  const validHas = (card) => game.validCards.some((c) => sameCard(c, card));
  const suggestedHas = (card) => Array.isArray(game.suggestion?.cards) && game.suggestion.cards.some((c) => sameCard(c, card));`,
    rel
  );

  src = replaceOnce(
    src,
    `      <ScoreStrip game={game} />
      {game.showPenaltyTracker && <NegativeCardsBar game={game} />}
      <LastTrickBanner game={game} />`,
    `      <ScoreStrip game={game} />
      {game.showPenaltyTracker && <NegativeCardsBar game={game} />}
      <LastTrickBanner game={game} />
      <SuggestionPanel game={game} />`,
    rel
  );

  src = replaceOnce(
    src,
    `                    highlighted={canPlay}
                    dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}
                    onClick={canPlay ? () => playCard(card) : null}
                  />`,
    `                    highlighted={canPlay}
                    suggested={!isTrickPause && game.currentPlayer === game.yourSeat && suggestedHas(card)}
                    dimmed={!isTrickPause && game.currentPlayer === game.yourSeat && !validHas(card)}
                    onClick={canPlay ? () => playCard(card) : null}
                  />`,
    rel
  );

  src = replaceOnce(
    src,
    `  const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(2);
  const [preferredShowPenaltyTracker, setPreferredShowPenaltyTracker] = useState(true);`,
    `  const [preferredMatchRutschen, setPreferredMatchRutschen] = useState(2);
  const [preferredShowPenaltyTracker, setPreferredShowPenaltyTracker] = useState(true);
  const [preferredEasyMode, setPreferredEasyMode] = useState(false);`,
    rel
  );

  src = replaceOnce(
    src,
    `    const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker } });`,
    `    const res = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });`,
    rel
  );

  src = replaceOnce(
    src,
    `      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,
    };
    setPreferredMatchRutschen(merged.matchRutschen);
    setPreferredShowPenaltyTracker(merged.showPenaltyTracker);`,
    `      showPenaltyTracker: nextSettings.showPenaltyTracker ?? preferredShowPenaltyTracker,
      easyMode: nextSettings.easyMode ?? preferredEasyMode,
    };
    setPreferredMatchRutschen(merged.matchRutschen);
    setPreferredShowPenaltyTracker(merged.showPenaltyTracker);
    setPreferredEasyMode(merged.easyMode);`,
    rel
  );

  src = replaceOnce(
    src,
    `    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker } });`,
    `    const created = await emitAck("createRoom", { name, settings: { matchRutschen: preferredMatchRutschen, showPenaltyTracker: preferredShowPenaltyTracker, easyMode: preferredEasyMode } });`,
    rel
  );

  const easyModeCheckbox = `              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.easyMode ?? preferredEasyMode} onChange={(e) => { setPreferredEasyMode(e.target.checked); if (room) updateRoomSettings({ easyMode: e.target.checked }); }} />
                Einfacher Modus: Bot-Tipps anzeigen
              </label>`;

  const penaltyCheckbox = `              <label style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.72)", fontSize: 13 }}>
                <input type="checkbox" checked={room?.settings?.showPenaltyTracker ?? preferredShowPenaltyTracker} onChange={(e) => { setPreferredShowPenaltyTracker(e.target.checked); if (room) updateRoomSettings({ showPenaltyTracker: e.target.checked }); }} />
                Offene Herzen/♠Q anzeigen
              </label>`;

  const occurrences = src.split(penaltyCheckbox).length - 1;
  if (occurrences < 2) throw new Error(`Expected at least two penalty tracker checkboxes in ${rel}, found ${occurrences}`);
  src = src.replaceAll(penaltyCheckbox, `${penaltyCheckbox}\n${easyModeCheckbox}`);

  write(rel, src);
  console.log(`${rel}: patched`);
}

try {
  fs.mkdirSync(backupRoot, { recursive: true });
  patchHeuristicBot();
  patchRooms();
  patchServerIndex();
  patchOnlineLobby();
  console.log(`\nDone. Backups written to ${path.relative(root, backupRoot)}`);
} catch (err) {
  console.error(`\nPatch failed: ${err.message}`);
  process.exit(1);
}
