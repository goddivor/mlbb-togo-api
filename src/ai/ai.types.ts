export type AiLang = 'fr' | 'en';
export type AiSource = 'llm' | 'heuristic';

/** Hero row as read from the catalog (Prisma Hero, subset). */
export interface CatalogHero {
  id: string;
  name: string;
  role: string;
  roles: string[];
  laneKeys: string[];
  image: string | null;
  thumb: string | null;
  heroId: number | null;
  speciality: string[];
  stats: any;
}

/** Player context built from User (+ optional esport stats). */
export interface PlayerContext {
  id: string;
  username: string;
  rank: string;
  role: string;
  wins: number;
  losses: number;
  mvpCount: number;
  streak: number;
  favoriteHeroes: string[];
  gameFrequentHeroes: Array<{ name: string; matches?: number; winRate?: number }>;
  gameRoles: Array<{ role: string; matches?: number }>;
  gameStats: Record<string, any>;
}

/** Subset of MlbbService.getHeroMeta() used by the AI module. */
export interface HeroMeta {
  available: boolean;
  winRate: number;
  pickRate: number;
  banRate: number;
  synergy: { best: MetaHeroRef[]; worst: MetaHeroRef[] };
  counters: { strong: MetaHeroRef[]; weak: MetaHeroRef[] };
  /**
   * Full Academy matrix: every enemy (`counters`) and every teammate, where
   * `increaseWinRate` is the change (points) of THIS hero's win rate.
   */
  matrix?: { counters: MetaHeroRef[]; teammates: MetaHeroRef[] };
}

export interface MetaHeroRef {
  heroId: number | null;
  name: string | null;
  image: string | null;
  winRate: number;
  increaseWinRate: number;
}

export interface HeroCard {
  id: string;
  name: string;
  role: string;
  roles: string[];
  image: string | null;
  thumb: string | null;
  reason: string;
  confidence: number; // 0..1
}

export interface CoachTip {
  title: string;
  detail: string;
  priority: 'high' | 'medium' | 'low';
}

export interface CoachResponse {
  source: AiSource;
  summary: string;
  tips: CoachTip[];
  heroes: HeroCard[];
}

export interface HeroRecommendationsResponse {
  source: AiSource;
  filters: { role: string | null; lane: string | null };
  heroes: HeroCard[];
}

export interface BuildItem {
  name: string;
  reason: string;
  priority: 'core' | 'situational';
}

export interface BuildResponse {
  source: AiSource;
  hero: { id: string; name: string; role: string; image: string | null; thumb: string | null };
  metaAvailable: boolean;
  note: string;
  boots: { name: string; reason: string };
  items: BuildItem[];
  emblem: { name: string; talents: string[]; reason: string };
  spell: { name: string; reason: string };
}

export interface CounterCard extends HeroCard {
  effectiveness: number; // 0..1
  against: string[]; // enemy names this pick answers
}

export interface CounterResponse {
  source: AiSource;
  metaAvailable: boolean;
  enemies: Array<{ id: string; name: string; role: string; image: string | null; thumb: string | null }>;
  counters: CounterCard[];
}

export interface AnalysisPoint {
  category: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
}

export interface AnalysisResponse {
  source: AiSource;
  stats: { games: number; winRate: number; mvpRate: number; streak: number; rank: string; role: string };
  strengths: AnalysisPoint[];
  weaknesses: AnalysisPoint[];
  recommendations: string[];
}
