// ── Shared card primitives for Schwarze Sau ──────────────────────────────────
export const APP_SUITS = ['S', 'H', 'C', 'D'];       // UI order
export const PY_SUITS = ['C', 'D', 'H', 'S'];        // stable index order
export const SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const VALS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const QUEEN_SPADES = { s: 'S', v: 12 };

export const VN = v => v === 11 ? 'J' : v === 12 ? 'Q' : v === 13 ? 'K' : v === 14 ? 'A' : String(v);
export const isRed = s => s === 'H' || s === 'D';
export const sameCard = (a, b) => a?.s === b?.s && a?.v === b?.v;
export const suitIdx = s => PY_SUITS.indexOf(s);
export const cardKey = c => `${c.s}${c.v}`;
export const isComputerSeat = t => t !== 'human';

export const cardToIdx = c => PY_SUITS.indexOf(c.s) * 13 + (c.v - 2);
export const idxToCard = idx => ({ s: PY_SUITS[Math.floor(idx / 13)], v: idx % 13 + 2 });

export const createDeck = () => APP_SUITS.flatMap(s => VALS.map(v => ({ s, v })));

export const shuffle = (cards, rng = Math.random) => {
  const out = [...cards];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

export const cardPts = c => {
  if (c.s === 'S' && c.v === 12) return -35;
  if (c.s === 'H') return -c.v;
  return 0;
};

export const isPenalty = c => c.s === 'H' || (c.s === 'S' && c.v === 12);

export const NEGATIVE_CARDS = [QUEEN_SPADES, ...VALS.map(v => ({ s: 'H', v }))];

export const unplayedPenaltyCards = (played = [], trick = []) => {
  const seen = [
    ...played,
    ...trick.map(x => x?.card ?? x),
  ];
  return NEGATIVE_CARDS.filter(c => !seen.some(x => sameCard(x, c)));
};

export const getValidIdxs = (hand, leadSuit) => {
  if (!leadSuit) return hand.map((_, i) => i);
  const follow = hand.map((c, i) => c.s === leadSuit ? i : -1).filter(i => i >= 0);
  return follow.length > 0 ? follow : hand.map((_, i) => i);
};

export const trickWinner = trick => {
  const lead = trick[0].card.s;
  return trick.reduce((best, play) => (
    play.card.s === lead && play.card.v > best.card.v ? play : best
  ), trick[0]).player;
};

export const sortHand = hand => [...hand].sort(
  (a, b) => APP_SUITS.indexOf(a.s) - APP_SUITS.indexOf(b.s) || a.v - b.v
);

export const makeSeededRng = seed => {
  // Mulberry32: tiny deterministic RNG for simulations and tests.
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};
