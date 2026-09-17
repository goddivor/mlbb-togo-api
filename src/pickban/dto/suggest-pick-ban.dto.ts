export class SuggestPickBanDto {
  mode: 'ranked' | 'tournament';
  currentStep: number;
  blueTeam: {
    picks: Array<{ heroId: string; lane?: string }>;
    bans: Array<{ heroId: string }>;
  };
  redTeam: {
    picks: Array<{ heroId: string; lane?: string }>;
    bans: Array<{ heroId: string }>;
  };
}

export class HeroSuggestion {
  heroId: string;
  heroName: string;
  image?: string;
  thumb?: string;
  role?: string;
  reason: string; // e.g., "Counters Ling, covers Gold lane"
  score: number; // 0-100 for ordering
}

export class SuggestPickBanResponseDto {
  suggestions: HeroSuggestion[];
  action: 'pick' | 'ban';
  team: 'blue' | 'red';
}
