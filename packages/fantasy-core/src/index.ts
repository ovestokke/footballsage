export type FantasyPosition = "GK" | "DEF" | "MID" | "FWD";

export type FantasyPlayer = {
  playerId: string;
  worldcupPlayerId?: string;
  name: string;
  team: string;
  teamAbbr: string;
  position: FantasyPosition;
  price: number;
};

export const squadRules = {
  budgetGroupStage: 100,
  budgetKnockout: 105,
  squadSize: 15,
  positions: { GK: 2, DEF: 5, MID: 5, FWD: 3 },
  maxPerNation: {
    group: 3,
    r32: 3,
    r16: 4,
    qf: 5,
    sf: 6,
    final: 8,
  },
} as const;
