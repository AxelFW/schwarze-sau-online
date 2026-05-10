#!/usr/bin/env node
/*
  Patch: spade follow + lead-order heuristic refinement for Wuzz/Schwarze Sau.

  Applies to the repo version uploaded on 2026-05-10, where the heuristic lives in:
    shared/game/heuristicBot.js

  Changes:
  - Hearts keep their old dedicated follow logic.
  - Clubs/Diamonds use the new positive-follow logic.
  - Spades use adjusted positive-follow logic while ♠Q is still live:
      * 4th position can take positive tricks freely, including ♠K/♠A.
      * 2nd/3rd position may probabilistically overtake, but if ♠Q is not in
        the bot's hand, voluntary winning spades are capped at ♠J.
      * If ♠Q is completed, spades behave like clubs/diamonds.
      * If ♠Q is in the current trick, positive-take logic is disabled.
  - Leading preserves the last low spade shield when ♠Q is live outside and the
    bot holds ♠K/♠A, unless no alternative remains.
  - The serious-danger short-suit void preference is moved into midgame leading,
    after safe ♣/♦ ace openers, and only after filtering to beatable cards.
  - Easy-mode explanation texts are updated accordingly.
*/

const fs = require('fs');
const path = require('path');

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const file = fs.existsSync(root) && fs.statSync(root).isFile()
  ? root
  : path.join(root, 'shared', 'game', 'heuristicBot.js');

if (!fs.existsSync(file)) {
  console.error('Could not find heuristicBot.js. Run from project root or pass the file path.');
  console.error('Tried:', file);
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');
const original = src;

function replaceOnce(haystack, needle, replacement, label) {
  const count = haystack.split(needle).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}`);
  }
  return haystack.replace(needle, replacement);
}

function replaceRegexOnce(haystack, regex, replacement, label) {
  const matches = haystack.match(regex);
  if (!matches) throw new Error(`${label}: no match`);
  const after = haystack.replace(regex, replacement);
  if (after === haystack) throw new Error(`${label}: replacement did not change file`);
  return after;
}

// 1) Replace positiveFollowWinners with spade-aware version.
src = replaceOnce(src,
`const positiveFollowWinners = (cards, gs) =>
  cards.filter(c =>
    beatsCurrentTrick(c, gs) &&
    trickNetValue(gs) + cardPts(c) > 0
  );`,
`const positiveFollowWinners = (cards, gs, player) => {
  let winners = cards.filter(c =>
    beatsCurrentTrick(c, gs) &&
    trickNetValue(gs) + cardPts(c) > 0
  );

  if(gs.leadSuit !== 'S') return winners;

  // If ♠Q is already in the current trick, do not apply normal positive-take
  // logic; the dedicated spade-follow safety should decide instead.
  if(queenSpadesInTrick(gs)) return [];

  // Once ♠Q is completed/out, spades are a normal suit again.
  if(queenSpadesPlayed(gs)) return winners;

  // Last to act: nobody can still dump ♠Q on our ♠K/♠A, so taking a positive
  // spade trick is a safe way to spend high spades.
  if(gs.trick.length === 3) return winners;

  // Earlier positions while ♠Q is live: if we hold ♠Q, nobody else can dump it
  // on us, so high spades may be used.  Otherwise, voluntary overtake cards are
  // capped at ♠J to avoid inviting ♠Q onto ♠K/♠A.
  if(queenSpadesInHand(gs, player)) return winners;
  return winners.filter(c => c.s !== 'S' || c.v <= 11);
};`,
'positiveFollowWinners');

// 2) Add lead-only last-spade-shield filter after voidCreationLeadCandidates.
src = replaceOnce(src,
`const voidCreationLeadCandidates = (cards, gs, player) => {
  // Low-priority leading preference under serious danger.  It only sees cards
  // that survived the earlier safety filters, then tries to create a short-suit
  // void for future dumps.  It is a preference, not a hard filter: callers only
  // apply it when this function returns a non-empty option set.
  if(!cards.length || !seriousDangerOnHand(gs, player)) return [];

  let eligible = cards;
  if(heartDangerOnHand(gs, player)) {
    const nonHearts = eligible.filter(c => c.s !== 'H');
    if(nonHearts.length) eligible = nonHearts;
  }

  if(!eligible.length) return [];

  const minCount = Math.min(...eligible.map(c => handSuitCount(gs, player, c.s)));
  const shortestSuitCards = eligible.filter(c => handSuitCount(gs, player, c.s) === minCount);
  return smallestCards(shortestSuitCards);
};`,
`const voidCreationLeadCandidates = (cards, gs, player) => {
  // Low-priority leading preference under serious danger.  It only sees cards
  // that survived the earlier safety filters, then tries to create a short-suit
  // void for future dumps.  It is a preference, not a hard filter: callers only
  // apply it when this function returns a non-empty option set.
  if(!cards.length || !seriousDangerOnHand(gs, player)) return [];

  let eligible = cards;
  if(heartDangerOnHand(gs, player)) {
    const nonHearts = eligible.filter(c => c.s !== 'H');
    if(nonHearts.length) eligible = nonHearts;
  }

  if(!eligible.length) return [];

  const minCount = Math.min(...eligible.map(c => handSuitCount(gs, player, c.s)));
  const shortestSuitCards = eligible.filter(c => handSuitCount(gs, player, c.s) === minCount);
  return smallestCards(shortestSuitCards);
};

const queenSpadesLiveOutside = (gs, player) =>
  !queenSpadesInHand(gs, player) && !queenSpadesPlayed(gs) && !queenSpadesInTrick(gs);

const preserveLastLowSpadeShieldLead = (cards, gs, player) => {
  // Lead-only candidate filter: if ♠Q is still outside and we hold ♠K/♠A, keep
  // one low spade shield (<♠Q) when possible.  Do not make the bot unable to
  // lead; if all candidates burn the shield, keep the original candidates.
  if(!cards.length || !queenSpadesLiveOutside(gs, player)) return cards;

  const hand = gs.hands[player] || [];
  const holdsHighSpade = hand.some(c => c.s === 'S' && (c.v === 13 || c.v === 14));
  if(!holdsHighSpade) return cards;

  const lowSpadesInHand = hand.filter(c => c.s === 'S' && c.v < 12);
  if(lowSpadesInHand.length !== 1) return cards;

  const shield = lowSpadesInHand[0];
  const filtered = cards.filter(c => !sameCard(c, shield));
  return filtered.length ? filtered : cards;
};`,
'voidCreationLeadCandidates + spade shield');

// 3) Replace midgameLeadCandidates with beatable-first + danger-short-suit tie-break.
src = replaceOnce(src,
`const midgameLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return [];

  // Full cautious midgame is now only the general small/beatable preference.
  // Negative suit history is handled separately from trick 2 onward.
  const beatable = cards.filter(c => hasHigherUnplayedOutsideOwnHand(c, gs, player));
  if(beatable.length) cards = beatable;

  return smallestCards(cards);
};`,
`const midgameLeadCandidates = (cards, gs, player) => {
  if(!cards.length) return [];

  // First keep only leads that can still be overtaken from outside.  This
  // prevents the short-suit idea from selecting a dead suit that nobody else
  // can take, which can load the bot with dumped penalty cards.
  const beatable = cards.filter(c => hasHigherUnplayedOutsideOwnHand(c, gs, player));
  const pool = beatable.length ? beatable : cards;

  // Under serious danger, void creation is now only a midgame tie-breaker after
  // the beatable filter and after safe ♣/♦ ace openers.  Prefer the suit closest
  // to emptying, but do not use this preference if nothing is beatable.
  if(seriousDangerOnHand(gs, player) && beatable.length) {
    let eligible = pool;
    if(heartDangerOnHand(gs, player)) {
      const nonHearts = eligible.filter(c => c.s !== 'H');
      if(nonHearts.length) eligible = nonHearts;
    }

    if(eligible.length) {
      const minCount = Math.min(...eligible.map(c => handSuitCount(gs, player, c.s)));
      const shortestSuitCards = eligible.filter(c => handSuitCount(gs, player, c.s) === minCount);
      return smallestCards(shortestSuitCards);
    }
  }

  return smallestCards(pool);
};`,
'midgameLeadCandidates');

// 4) Update easy-mode explanation texts.
const reasonReplacements = [
  [
`    case 'spade_safety_lead':
      return 'Der Bot vermeidet einen gefährlichen Pik-Anspieler, solange die ♠Q noch problematisch ist.' + suffix;`,
`    case 'spade_safety_lead':
      return 'Der Bot vermeidet gefährliche Pik-Anspiele und behält mit ♠K/♠A möglichst eine kleine Pik-Schutzkarte.' + suffix;`
  ],
  [
`    case 'void_creation_lead':
      return 'Unter Gefahr versucht der Bot eine kurze Farbe leerzuspielen, um später besser abwerfen zu können.' + suffix;`,
`    case 'void_creation_lead':
      return 'Unter Gefahr bevorzugt der Bot im Mittelspiel eine kurze, noch übernehmbare Farbe, um später besser abwerfen zu können.' + suffix;`
  ],
  [
`    case 'midgame_lead':
      return 'Im Mittelspiel bevorzugt der Bot kleine, noch übernehmbare Karten aus einer sicheren Farbe.' + suffix;`,
`    case 'midgame_lead':
      return 'Im Mittelspiel bevorzugt der Bot zuerst noch übernehmbare Karten; unter Gefahr nimmt er danach eher eine kurze Farbe.' + suffix;`
  ],
  [
`    case 'positive_follow_take':
      return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich.' + suffix;`,
`    case 'positive_follow_take':
      return 'Der Bot übernimmt hier einen voraussichtlich positiven Stich; bei Pik bleibt die ♠Q-Sicherheit berücksichtigt.' + suffix;`
  ],
  [
`    case 'positive_follow_duck':
      return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler den Stich noch übernehmen könnten.' + suffix;`,
`    case 'positive_follow_duck':
      return 'Der Bot bleibt hier lieber unter dem Stich, weil spätere Spieler noch übernehmen oder abwerfen könnten.' + suffix;`
  ],
];
for (const [needle, replacement] of reasonReplacements) {
  src = replaceOnce(src, needle, replacement, 'botSuggestionReason text');
}

// 5) Insert lead shield filter after H3 / before passed-left low-spade pressure.
src = replaceOnce(src,
`    // H_Q1: If we passed ♠Q left, allow safe LOW spades to pressure that seat.
    // The no-high-spade-lead rule still applies: never re-add ♠K/♠A here.`,
`    // H3b: If ♠Q is still outside and we hold ♠K/♠A, avoid spending the last
    // low spade shield on lead when another candidate exists.
    candidates = preserveLastLowSpadeShieldLead(candidates, gs, player);

    // H_Q1: If we passed ♠Q left, allow safe LOW spades to pressure that seat.
    // The no-high-spade-lead rule still applies: never re-add ♠K/♠A here.`,
'insert lead shield filter');

// 6) Remove standalone void-creation block before safe aces.
src = replaceOnce(src,
`    // H6b: Under serious danger, prefer creating a short-suit void.
    const voidCreationLeads = voidCreationLeadCandidates(candidates, gs, player);
    if(voidCreationLeads.length) return finish(voidCreationLeads, 'void_creation_lead');

    // H7: Prefer safe ♣A / ♦A openers after risk filters.
`,
`    // H7: Prefer safe ♣A / ♦A openers after risk filters.  The serious-danger
    // short-suit idea is now handled inside midgameLeadCandidates, after this
    // safe-ace opener and only among beatable leads.
`,
'remove standalone void-creation lead block');

// 7) Replace follow-suit spade/positive-rule section comments and guards.
src = replaceOnce(src,
`  // Hearts deliberately keep the old dedicated heart-follow branch above.
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
  }`,
`  // Hearts deliberately keep the old dedicated heart-follow branch above.
  // Spades use dedicated safety while ♠Q is live, but the positive-follow rules
  // below are still allowed in an adjusted form: 4th position may spend ♠K/♠A,
  // while 2nd/3rd are capped at ♠J unless the bot holds ♠Q.
  const spadesAreCompleted = gs.leadSuit === 'S' && queenSpadesPlayed(gs);

  // H4: Spade-following intelligence while ♠Q is still live/current.
  if(gs.leadSuit === 'S' && !spadesAreCompleted) {
    candidates = spadeFollowCandidates(candidates, gs, player);
  }

  // New H9a: fourth position — always take truly positive tricks.  For spades,
  // this also allows safe ♠K/♠A wins while ♠Q is still live, because nobody can
  // play after the bot.
  if(gs.trick.length === 3) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);
    if(positiveWinners.length) {
      return finish(largestCards(positiveWinners), 'positive_follow_take');
    }
  }`,
'follow spade intro + fourth positive');

src = replaceOnce(src,
`  if(spadesAreNormal && gs.trick.length === 2) {
    const positiveWinners = positiveFollowWinners(candidates, gs);`,
`  if(gs.trick.length === 2) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);`,
'follow third positive guard');

src = replaceOnce(src,
`  if(spadesAreNormal && gs.trick.length === 1) {
    const positiveWinners = positiveFollowWinners(candidates, gs);`,
`  if(gs.trick.length === 1) {
    const positiveWinners = positiveFollowWinners(candidates, gs, player);`,
'follow second positive guard');

if (src === original) {
  throw new Error('Patch made no changes.');
}

const backup = `${file}.bak-spade-follow-lead-v4`;
if (!fs.existsSync(backup)) fs.writeFileSync(backup, original);
fs.writeFileSync(file, src);
console.log(`Patched ${file}`);
console.log(`Backup: ${backup}`);
console.log('Run: node --check shared/game/heuristicBot.js && npm run build');
