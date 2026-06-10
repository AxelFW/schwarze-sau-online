export const FIXED_BENCHMARK_ROUNDS = 8;

export const BENCHMARK_DECKS = [
  {
    id: "sauprobe-a",
    name: "Sauprobe A",
    description: "Ausgewogene feste 8-Spiele-Serie.",
    seeds: [
      0x17A45B8D,
      0x7C3E9A21,
      0xC25D41F0,
      0x4E81B73C,
      0x9B0F62D4,
      0x2D96E8A7,
      0xE34A105B,
      0x58F7C9E2,
    ],
  },
  {
    id: "herzdruck-b",
    name: "Herzdruck B",
    description: "Acht feste Spiele mit mehr Herz-Druck in kritischen Händen.",
    seeds: [
      0xA71C03E5,
      0x3B9E6D14,
      0xF0528C99,
      0x6D44A231,
      0xD8B7304E,
      0x1159F6C2,
      0x8CE40B7A,
      0x49A2D5F1,
    ],
  },
  {
    id: "pikklemme-c",
    name: "Pikklemme C",
    description: "Feste Serie mit mehreren heiklen Pik-Konstellationen.",
    seeds: [
      0x5E4B21A9,
      0xD13F8C70,
      0x28A6E45D,
      0xB9C01736,
      0x73E5A812,
      0x0F6D39C4,
      0xE8A14B6F,
      0x94C2F03B,
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
