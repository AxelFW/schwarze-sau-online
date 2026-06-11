export const FIXED_BENCHMARK_ROUNDS = 4;

export const BENCHMARK_DECKS = [
  {
    id: "sauprobe-a",
    name: "Sauprobe A",
    description: "Vier harte Mischdruck-Spiele.",
    seeds: [
      0x7C3E9A21,
      0x9B0F62D4,
      0x58F7C9E2,
      0x17A45B8D,
    ],
  },
  {
    id: "herzdruck-b",
    name: "Herzdruck B",
    description: "Vier feste Spiele mit hohen Herzen, aber ohne Start-Void.",
    seeds: [
      359102,
      18764,
      14052,
      43091,
    ],
  },
  {
    id: "pikklemme-c",
    name: "Pikklemme C",
    description: "Vier feste Spiele mit heiklen Pik-Konstellationen.",
    seeds: [
      0xB9C01736,
      0x73E5A812,
      0x0F6D39C4,
      0xE8A14B6F,
    ],
  },
];

const DECKS_BY_ID = new Map(BENCHMARK_DECKS.map((deck) => [deck.id, deck]));

export function normalizeBenchmarkDeckId(value) {
  const id = String(value || "").trim();
  return DECKS_BY_ID.has(id) ? id : null;
}

export function getBenchmarkDeck(id) {
  return DECKS_BY_ID.get(normalizeBenchmarkDeckId(id)) || null;
}

export function benchmarkRoundSeed(id, round) {
  const deck = getBenchmarkDeck(id);
  const roundIndex = Number(round) - 1;
  if (!deck || !Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= FIXED_BENCHMARK_ROUNDS) {
    return null;
  }
  return deck.seeds[roundIndex] >>> 0;
}
