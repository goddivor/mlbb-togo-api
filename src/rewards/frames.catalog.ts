// Avatar frames and level titles catalogue (#122). Pure data, no I/O.
// Ids, shapes, levels and temporary durations mirror the `F` array of
// tools/rewards-proposal/frames-preview.html (64 frames); the frontend renders
// each frame from the same id.

export type FrameShape = 'circle' | 'square';
export type FrameSource = 'level' | 'achievement' | 'award' | 'admin' | 'event' | 'ranking';
export type FrameAnimation = 'none' | 'subtle' | 'strong';
export type FrameTier =
  | 'bronze'
  | 'argent'
  | 'or'
  | 'platine'
  | 'diamant'
  | 'epique'
  | 'legende'
  | 'mythe'
  | 'champion'
  | 'mvp'
  | 'classement'
  | 'role'
  | 'fondateur'
  | 'event';

/** Default lifetime of a temporary frame. Absent = permanent. */
export type FrameExpiry = { days: number } | { until: 'next_champion' };

export interface FrameDef {
  id: string;
  name: { fr: string; en: string };
  shape: FrameShape;
  tier: FrameTier;
  source: FrameSource;
  /** Level that unlocks a `level` frame. */
  level?: number;
  /** Achievement whose unlock grants the frame. */
  achievement?: string;
  /** Season award categories that grant the frame (lane frames). */
  awards?: string[];
  animation: FrameAnimation;
  /** One variant per season (`S<number>`). */
  variantBySeason?: boolean;
  expiry?: FrameExpiry;
  /** Hidden in the locked part of the collection until owned. */
  secret?: boolean;
}

const lvl = (
  id: string,
  fr: string,
  en: string,
  tier: FrameTier,
  level: number,
  animation: FrameAnimation,
  shape: FrameShape = 'circle',
): FrameDef => ({ id, name: { fr, en }, shape, tier, source: 'level', level, animation });

const ach = (
  id: string,
  fr: string,
  en: string,
  tier: FrameTier,
  achievement: string,
  animation: FrameAnimation,
  shape: FrameShape = 'circle',
  extra: Partial<FrameDef> = {},
): FrameDef => ({ id, name: { fr, en }, shape, tier, source: 'achievement', achievement, animation, ...extra });

export const FRAMES: readonly FrameDef[] = [
  // ----- Level frames (circle) -----
  lvl('recrue', 'Recrue', 'Recruit', 'bronze', 1, 'none'),
  lvl('bronze_forge', 'Bronze forgé', 'Forged Bronze', 'bronze', 10, 'none'),
  lvl('argent_lames', "Lames d'argent", 'Silver Blades', 'argent', 20, 'subtle'),
  lvl('argent_aile', "Aile d'argent", 'Silver Wing', 'argent', 30, 'subtle'),
  lvl('or_couronne', "Couronne d'or", 'Golden Crown', 'or', 40, 'subtle'),
  lvl('or_soleil', "Soleil d'or", 'Golden Sun', 'or', 50, 'subtle'),
  lvl('platine_cristal', 'Cristal de platine', 'Platinum Crystal', 'platine', 60, 'subtle'),
  lvl('platine_runes', 'Runes de platine', 'Platinum Runes', 'platine', 70, 'subtle'),
  lvl('diamant_eclat', 'Éclat de diamant', 'Diamond Shard', 'diamant', 80, 'subtle'),
  lvl('diamant_givre', 'Givre de diamant', 'Diamond Frost', 'diamant', 90, 'subtle'),
  lvl('epique_arcane', 'Arcane épique', 'Epic Arcana', 'epique', 100, 'strong'),
  lvl('epique_tempete', 'Tempête épique', 'Epic Storm', 'epique', 115, 'strong'),
  lvl('legende_flamme', 'Flamme légendaire', 'Legendary Flame', 'legende', 130, 'strong'),
  lvl('legende_ailes', 'Ailes légendaires', 'Legendary Wings', 'legende', 150, 'strong'),
  lvl('mythe_nebuleuse', 'Nébuleuse mythique', 'Mythic Nebula', 'mythe', 170, 'strong'),
  lvl('mythe_gardien', 'Gardien céleste', 'Celestial Warden', 'mythe', 185, 'strong'),
  lvl('souverain_aube', "Souverain de l'aube", 'Dawn Sovereign', 'mythe', 200, 'strong'),

  // ----- Achievement frames (circle) -----
  ach('etoile_arene', "Étoile de l'arène", 'Arena Star', 'epique', 'mvp_10', 'subtle'),
  ach('des_destin', 'Dés du destin', 'Dice of Fate', 'epique', 'draft_champion', 'subtle'),
  ach('porte_voix', 'Porte-voix', 'Megaphone', 'epique', 'community_voice', 'subtle'),
  ach('echiquier_stratege', 'Échiquier du stratège', "Strategist's Board", 'epique', 'draft_mastermind', 'subtle'),
  ach('intouchable', 'Intouchable', 'Untouchable', 'legende', 'untouchable', 'strong'),
  ach('lauriers_tournoi', 'Lauriers du tournoi', 'Tournament Laurels', 'legende', 'tournament_winner', 'subtle'),
  ach('reliquaire', 'Reliquaire', 'Reliquary', 'legende', 'collector', 'subtle'),
  ach('sceau_fidelite', 'Sceau de fidélité', 'Seal of Loyalty', 'legende', 'unconditional', 'subtle'),
  ach('chasseur_trophees', 'Chasseur de trophées', 'Trophy Hunter', 'mythe', 'trophy_hunter', 'strong'),
  ach('sommet_mythique', 'Sommet mythique', 'Mythic Summit', 'mythe', 'peak_immortal', 'strong'),

  // ----- Special frames (circle) -----
  ach('champion_saison', 'Champion de saison', 'Season Champion', 'champion', 'season_champion', 'strong', 'circle', {
    variantBySeason: true,
  }),
  ach('dynastie', 'Dynastie', 'Dynasty', 'champion', 'dynasty', 'strong'),
  ach('mvp_saison', 'MVP de saison', 'Season MVP', 'mvp', 'season_mvp', 'strong', 'circle', {
    variantBySeason: true,
  }),
  ...(
    [
      ['voie_gold', "Voie de l'or", 'Gold Lane', 'best_gold'],
      ['voie_mid', 'Voie du milieu', 'Mid Lane', 'best_mid'],
      ['voie_jungle', 'Voie de la jungle', 'Jungle', 'best_jungle'],
      ['voie_roam', 'Voie du roam', 'Roam', 'best_roam'],
      ['voie_exp', "Voie de l'EXP", 'EXP Lane', 'best_exp'],
    ] as const
  ).map(
    ([id, fr, en, award]): FrameDef => ({
      id,
      name: { fr, en },
      shape: 'circle',
      tier: 'role',
      source: 'award',
      awards: [award],
      animation: 'subtle',
      variantBySeason: true,
    }),
  ),
  ach('fondateur', 'Fondateur', 'Founder', 'fondateur', 'pioneer', 'subtle'),
  ach('independance', '27 Avril', 'Independence', 'event', 'independence_day', 'subtle', 'circle', { source: 'event' }),
  ach('harmattan', 'Harmattan', 'Harmattan', 'event', 'harmattan', 'subtle', 'circle', { source: 'event' }),
  ach('anniversaire', 'Anniversaire', 'Anniversary', 'event', 'site_anniversary', 'strong', 'circle', {
    source: 'event',
  }),

  // ----- Level frames (square) -----
  lvl('ecu_bronze', 'Écu de bronze', 'Bronze Plate', 'bronze', 5, 'none', 'square'),
  lvl('argent_filigrane', "Filigrane d'argent", 'Silver Filigree', 'argent', 25, 'subtle', 'square'),
  lvl('or_gemmes', "Écrin d'or", 'Golden Casket', 'or', 45, 'subtle', 'square'),
  lvl('platine_runique', 'Bastion runique', 'Runic Bastion', 'platine', 65, 'subtle', 'square'),
  lvl('diamant_cristaux', 'Angles de cristal', 'Crystal Corners', 'diamant', 85, 'subtle', 'square'),
  lvl('epique_circuit', 'Circuit arcanique', 'Arcane Circuit', 'epique', 110, 'strong', 'square'),
  lvl('legende_brasier', 'Brasier', 'Blaze', 'legende', 140, 'strong', 'square'),
  lvl('mythe_dragons', 'Dragons jumeaux', 'Twin Dragons', 'mythe', 180, 'strong', 'square'),

  // ----- Achievement frames (square) -----
  ach('garde_lames', 'Garde des lames', 'Crossguard', 'epique', 'wins_50', 'subtle', 'square'),
  ach('hud_scanner', 'Viseur tactique', 'Tactical Scope', 'epique', 'kda_5', 'subtle', 'square'),
  ach('projecteur', 'Sous les projecteurs', 'In the Spotlight', 'epique', 'viral', 'subtle', 'square'),
  ach('kente_royal', 'Kente royal', 'Royal Kente', 'epique', 'togo_tour', 'subtle', 'square'),
  ach('crocs_serpent', 'Crocs du serpent', 'Serpent Fangs', 'epique', 'rampage', 'subtle', 'square'),
  ach('arbre_bracket', 'Arbre du bracket', 'Bracket Tree', 'epique', 'circuit_regular', 'subtle', 'square'),
  ach('cage_eclairs', "Cage d'éclairs", 'Lightning Cage', 'epique', 'perfect_month', 'strong', 'square'),
  ach('blason_clan', 'Blason de clan', 'Clan Crest', 'legende', 'scene_icon', 'subtle', 'square'),
  ach('bannieres_guerre', 'Bannières de guerre', 'War Banners', 'legende', 'seasons_5', 'subtle', 'square'),
  ach('couronne_imperiale', 'Couronne impériale', 'Imperial Crown', 'legende', 'tournament_mvp', 'subtle', 'square'),
  ach('forteresse', 'Forteresse invaincue', 'Unbroken Fortress', 'mythe', 'invincibles', 'strong', 'square', {
    secret: true,
  }),

  // ----- Special frames (square) -----
  {
    id: 'champion_en_titre',
    name: { fr: 'Champion en titre', en: 'Reigning Champion' },
    shape: 'square',
    tier: 'champion',
    source: 'award',
    animation: 'strong',
    expiry: { until: 'next_champion' },
  },
  {
    id: 'mvp_semaine',
    name: { fr: 'MVP de la semaine', en: 'MVP of the Week' },
    shape: 'square',
    tier: 'mvp',
    source: 'ranking',
    animation: 'strong',
    expiry: { days: 7 },
  },
  {
    id: 'numero_un',
    name: { fr: 'Numéro un du mois', en: 'Monthly Number One' },
    shape: 'square',
    tier: 'classement',
    source: 'ranking',
    animation: 'strong',
    expiry: { days: 30 },
  },
  ach('coupe_independance', "Coupe de l'Indépendance", 'Independence Cup', 'event', 'independence_cup', 'subtle', 'square', {
    source: 'event',
    expiry: { days: 30 },
  }),
  ach('saison_pluies', 'Saison des pluies', 'Rainy Season', 'event', 'rainy_season', 'subtle', 'square', {
    source: 'event',
  }),
  ach('lanternes', "Lanternes de fin d'année", 'Year-End Lanterns', 'event', 'year_end_lights', 'strong', 'square', {
    source: 'event',
    expiry: { days: 14 },
  }),
];

const BY_ID = new Map(FRAMES.map((f) => [f.id, f]));

export function getFrame(id: string | null | undefined): FrameDef | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isTemporaryFrame(frame: FrameDef | undefined): boolean {
  return !!frame?.expiry;
}

/** Level frames unlocked at `level` (every frame with `level <= level`). */
export function levelFramesUpTo(level: number): FrameDef[] {
  return FRAMES.filter((f) => f.source === 'level' && (f.level ?? Infinity) <= level);
}

/** Frames granted by an achievement unlock. */
export function framesForAchievement(achievementId: string): FrameDef[] {
  return FRAMES.filter((f) => f.achievement === achievementId);
}

/** Frames granted by a season award category (lane frames). */
export function framesForAward(category: string): FrameDef[] {
  return FRAMES.filter((f) => f.awards?.includes(category));
}

// ----- Equipped key (`frameId` or `frameId:variant`) -----

export function frameKey(frameId: string, variant?: string | null): string {
  return variant ? `${frameId}:${variant}` : frameId;
}

export function parseFrameKey(key: string): { frameId: string; variant: string } {
  const i = key.indexOf(':');
  return i < 0 ? { frameId: key, variant: '' } : { frameId: key.slice(0, i), variant: key.slice(i + 1) };
}

/** Season variant label (`S<number>`), validated. */
export const SEASON_VARIANT = /^S\d{1,3}$/;

// ----- Level titles (optional, equipped like a frame) -----

export interface TitleDef {
  id: string;
  level: number;
  name: { fr: string; en: string };
}

export const TITLES: readonly TitleDef[] = [
  { id: 'aspirant', level: 5, name: { fr: 'Aspirant', en: 'Aspirant' } },
  { id: 'eclaireur', level: 15, name: { fr: 'Éclaireur', en: 'Scout' } },
  { id: 'sentinelle', level: 25, name: { fr: 'Sentinelle', en: 'Sentinel' } },
  { id: 'lame_affutee', level: 35, name: { fr: 'Lame affûtée', en: 'Honed Blade' } },
  { id: 'gardien_fort', level: 45, name: { fr: 'Gardien du fort', en: 'Keep Warden' } },
  { id: 'capitaine_escouade', level: 55, name: { fr: "Capitaine d'escouade", en: 'Squad Captain' } },
  { id: 'tacticien', level: 65, name: { fr: 'Tacticien', en: 'Tactician' } },
  { id: 'chef_guerre', level: 75, name: { fr: 'Chef de guerre', en: 'Warlord' } },
  { id: 'briseur_tours', level: 85, name: { fr: 'Briseur de tours', en: 'Tower Breaker' } },
  { id: 'maitre_armes', level: 95, name: { fr: "Maître d'armes", en: 'Weapon Master' } },
  { id: 'heraut', level: 110, name: { fr: 'Héraut', en: 'Herald' } },
  { id: 'seigneur_voies', level: 120, name: { fr: 'Seigneur des voies', en: 'Lord of the Lanes' } },
  { id: 'archonte', level: 140, name: { fr: 'Archonte', en: 'Archon' } },
  { id: 'parangon', level: 160, name: { fr: 'Parangon', en: 'Paragon' } },
  { id: 'titan', level: 180, name: { fr: 'Titan', en: 'Titan' } },
  { id: 'eternel', level: 190, name: { fr: 'Éternel', en: 'Eternal' } },
  { id: 'souverain_aube', level: 200, name: { fr: "Souverain de l'aube", en: 'Dawn Sovereign' } },
];

const TITLE_BY_ID = new Map(TITLES.map((t) => [t.id, t]));

export function getTitle(id: string | null | undefined): TitleDef | undefined {
  return id ? TITLE_BY_ID.get(id) : undefined;
}

export function isTitleUnlocked(id: string, level: number): boolean {
  const t = getTitle(id);
  return !!t && level >= t.level;
}

// ----- Level badge tiers (catalogue §4) -----

export const BADGE_TIERS: readonly { id: FrameTier; from: number; to: number }[] = [
  { id: 'bronze', from: 1, to: 19 },
  { id: 'argent', from: 20, to: 39 },
  { id: 'or', from: 40, to: 59 },
  { id: 'platine', from: 60, to: 79 },
  { id: 'diamant', from: 80, to: 99 },
  { id: 'epique', from: 100, to: 129 },
  { id: 'legende', from: 130, to: 169 },
  { id: 'mythe', from: 170, to: 200 },
];

export function badgeTierFor(level: number): FrameTier {
  return (BADGE_TIERS.find((t) => level >= t.from && level <= t.to) ?? BADGE_TIERS[BADGE_TIERS.length - 1]).id;
}
