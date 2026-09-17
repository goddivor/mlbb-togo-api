// Deterministic, rule-based fallbacks used when the Anthropic key is missing
// or the LLM call fails. Pure functions: no I/O, no randomness.

import {
  AI_TEXT,
  ANTI_MAGIC_ITEM,
  ANTI_PHYSICAL_ITEM,
  CLASS_BUILDS,
  HERO_CLASSES,
  HeroClass,
  LANE_SPELL,
  LaneKey,
  RANK_ORDER,
} from './ai.constants';
import {
  AiLang,
  AnalysisPoint,
  AnalysisResponse,
  BuildItem,
  BuildResponse,
  CatalogHero,
  CoachResponse,
  CoachTip,
  CounterCard,
  CounterResponse,
  HeroCard,
  HeroMeta,
  HeroRecommendationsResponse,
  PlayerContext,
} from './ai.types';

const T: Record<AiLang, Record<string, string>> = {
  fr: {
    favorite: 'dans tes héros favoris',
    frequent: 'héros que tu joues le plus ({matches} parties)',
    frequentWr: '{wr}% de victoires avec ce héros',
    roleMatch: 'correspond à ton rôle principal ({role})',
    metaWr: '{wr}% de victoires dans la méta actuelle',
    classPick: 'héros solide de la classe {role}',
    laneFit: 'adapté à la lane {lane}',
    counterMeta: 'bat {enemies} selon les statistiques de duel (+{wr}% de victoires)',
    counterClass: 'la classe {role} est naturellement forte contre {enemies}',
    coachSummaryGood:
      'Tu es sur une bonne dynamique ({wr}% de victoires sur {games} parties). Continue à jouer ton rôle de {role} en gardant une pool de héros restreinte.',
    coachSummaryAvg:
      'Ton profil est équilibré ({wr}% de victoires sur {games} parties). Quelques ajustements de discipline peuvent te faire monter de rang.',
    coachSummaryLow:
      'Ton taux de victoire ({wr}% sur {games} parties) indique qu’il faut revoir les fondamentaux : farm, vision et prises de décision.',
    coachSummaryNoGames:
      'Pas encore assez de parties enregistrées pour un diagnostic précis : joue quelques matchs classés et reviens.',
    tipPoolTitle: 'Réduis ta pool de héros',
    tipPoolDetail:
      'Concentre-toi sur 2 ou 3 héros de {role} pour maîtriser leurs combos et leurs limites.',
    tipStreakTitle: 'Coupe la série de défaites',
    tipStreakDetail:
      'Après {n} défaites d’affilée, fais une pause : la tilt fait perdre plus de parties que le niveau.',
    tipStreakWinTitle: 'Profite de ta série',
    tipStreakWinDetail:
      'Tu enchaînes {n} victoires : garde le même héros et le même rythme tant que ça fonctionne.',
    tipMvpTitle: 'Transforme tes MVP en victoires',
    tipMvpDetail:
      'Tu portes souvent ton équipe. Communique davantage (pings objectifs) pour convertir ton avance.',
    tipObjTitle: 'Priorise les objectifs',
    tipObjDetail:
      'Tortue, Lord et tourelles font gagner les parties : évite les combats inutiles sans objectif derrière.',
    tipRankTitle: 'Objectif rang supérieur',
    tipRankDetail:
      'Au rang {rank}, les drafts comptent : apprends les contres de ton rôle avec l’onglet Counter.',
    tipFavTitle: 'Renseigne tes héros favoris',
    tipFavDetail:
      'Ajoute tes héros favoris dans ton profil pour obtenir des recommandations plus précises.',
    strengthWr: 'Taux de victoire',
    strengthWrDesc: '{wr}% de victoires sur {games} parties : au-dessus de la moyenne.',
    strengthMvp: 'Impact en partie',
    strengthMvpDesc: 'MVP dans {pct}% de tes parties : tu portes souvent ton équipe.',
    strengthStreak: 'Régularité',
    strengthStreakDesc: 'Série de {n} victoires en cours.',
    strengthPool: 'Pool de héros définie',
    strengthPoolDesc: 'Tu as {n} héros favoris : bonne base pour te spécialiser.',
    strengthRank: 'Expérience classée',
    strengthRankDesc: 'Rang {rank} atteint.',
    weakWr: 'Taux de victoire',
    weakWrDesc: '{wr}% de victoires sur {games} parties : en dessous de 50 %.',
    weakStreak: 'Tilt',
    weakStreakDesc: '{n} défaites d’affilée : le mental pèse sur tes décisions.',
    weakMvp: 'Impact limité',
    weakMvpDesc: 'Peu de MVP par rapport à ton nombre de parties : cherche à peser davantage.',
    weakData: 'Peu de données',
    weakDataDesc: 'Moins de 10 parties enregistrées : l’analyse restera approximative.',
    weakPool: 'Pool de héros vide',
    weakPoolDesc: 'Aucun héros favori renseigné : difficile de te spécialiser.',
    recoFocus: 'Joue 10 parties avec un seul héros de {role} pour stabiliser ton niveau.',
    recoVod: 'Revois tes 3 dernières défaites et note une erreur évitable par partie.',
    recoCounter: 'Avant chaque draft, vérifie les contres de ton héros dans l’onglet Counter.',
    recoKeep: 'Garde ta routine actuelle : elle fonctionne.',
    recoLink: 'Lie ton compte de jeu pour enrichir l’analyse avec tes vraies statistiques.',
  },
  en: {
    favorite: 'one of your favourite heroes',
    frequent: 'your most played hero ({matches} games)',
    frequentWr: '{wr}% win rate with this hero',
    roleMatch: 'matches your main role ({role})',
    metaWr: '{wr}% win rate in the current meta',
    classPick: 'solid {role} pick',
    laneFit: 'fits the {lane} lane',
    counterMeta: 'beats {enemies} according to duel statistics (+{wr}% win rate)',
    counterClass: 'the {role} class is naturally strong against {enemies}',
    coachSummaryGood:
      'You are on a good run ({wr}% win rate over {games} games). Keep playing your {role} role with a tight hero pool.',
    coachSummaryAvg:
      'Your profile is balanced ({wr}% win rate over {games} games). A few discipline tweaks can push you up a rank.',
    coachSummaryLow:
      'Your win rate ({wr}% over {games} games) suggests going back to fundamentals: farm, vision and decision making.',
    coachSummaryNoGames:
      'Not enough recorded games for a precise diagnosis yet: play a few ranked matches and come back.',
    tipPoolTitle: 'Narrow your hero pool',
    tipPoolDetail: 'Focus on 2 or 3 {role} heroes to master their combos and limits.',
    tipStreakTitle: 'Break the losing streak',
    tipStreakDetail: 'After {n} losses in a row, take a break: tilt loses more games than skill.',
    tipStreakWinTitle: 'Ride the streak',
    tipStreakWinDetail: 'You are {n} wins in: keep the same hero and pace while it works.',
    tipMvpTitle: 'Turn MVPs into wins',
    tipMvpDetail: 'You often carry. Communicate more (objective pings) to convert your lead.',
    tipObjTitle: 'Prioritise objectives',
    tipObjDetail: 'Turtle, Lord and turrets win games: avoid pointless fights with no objective behind.',
    tipRankTitle: 'Aim for the next rank',
    tipRankDetail: 'At {rank} rank, drafts matter: learn the counters of your role in the Counter tab.',
    tipFavTitle: 'Set your favourite heroes',
    tipFavDetail: 'Add favourite heroes to your profile to get sharper recommendations.',
    strengthWr: 'Win rate',
    strengthWrDesc: '{wr}% win rate over {games} games: above average.',
    strengthMvp: 'In-game impact',
    strengthMvpDesc: 'MVP in {pct}% of your games: you often carry your team.',
    strengthStreak: 'Consistency',
    strengthStreakDesc: '{n}-win streak in progress.',
    strengthPool: 'Defined hero pool',
    strengthPoolDesc: 'You have {n} favourite heroes: a good base to specialise.',
    strengthRank: 'Ranked experience',
    strengthRankDesc: '{rank} rank reached.',
    weakWr: 'Win rate',
    weakWrDesc: '{wr}% win rate over {games} games: below 50%.',
    weakStreak: 'Tilt',
    weakStreakDesc: '{n} losses in a row: mindset is weighing on your decisions.',
    weakMvp: 'Limited impact',
    weakMvpDesc: 'Few MVPs relative to your game count: look to have more influence.',
    weakData: 'Little data',
    weakDataDesc: 'Fewer than 10 recorded games: the analysis stays approximate.',
    weakPool: 'Empty hero pool',
    weakPoolDesc: 'No favourite heroes set: hard to specialise.',
    recoFocus: 'Play 10 games with a single {role} hero to stabilise your level.',
    recoVod: 'Review your last 3 losses and note one avoidable mistake per game.',
    recoCounter: 'Before each draft, check your hero counters in the Counter tab.',
    recoKeep: 'Keep your current routine: it works.',
    recoLink: 'Link your game account to enrich the analysis with your real statistics.',
  },
};

const ROLE_LABEL: Record<AiLang, Record<string, string>> = {
  fr: { tank: 'tank', fighter: 'combattant', assassin: 'assassin', mage: 'mage', marksman: 'tireur', support: 'support' },
  en: { tank: 'tank', fighter: 'fighter', assassin: 'assassin', mage: 'mage', marksman: 'marksman', support: 'support' },
};

export function roleLabel(lang: AiLang, role: string): string {
  const k = String(role ?? '').toLowerCase();
  return ROLE_LABEL[lang]?.[k] ?? role;
}

export function tx(lang: AiLang, key: string, params: Record<string, string | number> = {}): string {
  const raw = T[lang]?.[key] ?? T.fr[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

export function itemText(lang: AiLang, key: string): string {
  return AI_TEXT[lang]?.[key] ?? AI_TEXT.en[key] ?? key;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const norm = (s: string | null | undefined) => String(s ?? '').trim().toLowerCase();
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function heroClass(hero: CatalogHero): HeroClass {
  const c = norm(hero.role);
  if ((HERO_CLASSES as string[]).includes(c)) return c as HeroClass;
  const alt = (hero.roles ?? []).map(norm).find((r) => (HERO_CLASSES as string[]).includes(r));
  return (alt as HeroClass) ?? 'fighter';
}

export function heroHasRole(hero: CatalogHero, role: string): boolean {
  const r = norm(role);
  return norm(hero.role) === r || (hero.roles ?? []).some((x) => norm(x) === r);
}

export function heroHasLane(hero: CatalogHero, lane: string): boolean {
  const l = norm(lane);
  return (hero.laneKeys ?? []).some((x) => norm(x) === l);
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function toCard(hero: CatalogHero, reason: string, confidence: number): HeroCard {
  return {
    id: hero.id,
    name: hero.name,
    role: hero.role,
    roles: hero.roles ?? [],
    image: hero.image ?? hero.thumb ?? null,
    thumb: hero.thumb ?? hero.image ?? null,
    reason: capitalize(reason),
    confidence: Math.round(clamp(confidence, 0, 1) * 100) / 100,
  };
}

export function winRateOf(p: PlayerContext): { games: number; winRate: number } {
  const games = (p.wins ?? 0) + (p.losses ?? 0);
  return { games, winRate: games ? Math.round((p.wins / games) * 1000) / 10 : 0 };
}

/** Case-insensitive name index of the catalog. */
export function indexByName(catalog: CatalogHero[]): Map<string, CatalogHero> {
  return new Map(catalog.map((h) => [norm(h.name), h]));
}

// ---------------------------------------------------------------------------
// Hero recommendations
// ---------------------------------------------------------------------------

export interface RecommendInput {
  player: PlayerContext;
  catalog: CatalogHero[];
  role?: string | null;
  lane?: string | null;
  /** Meta win rate (%) by lowercase hero name, when the ranking is available. */
  metaWinRateByName?: Map<string, number>;
  lang: AiLang;
  limit?: number;
}

export function recommendHeroesHeuristic(input: RecommendInput): HeroRecommendationsResponse {
  const { player, catalog, lang } = input;
  const role = input.role ? norm(input.role) : null;
  const lane = input.lane ? norm(input.lane) : null;
  const limit = input.limit ?? 5;
  const favs = new Set((player.favoriteHeroes ?? []).map(norm));
  const frequent = new Map(
    (player.gameFrequentHeroes ?? []).filter((h) => h?.name).map((h) => [norm(h.name), h]),
  );

  const candidates = catalog.filter(
    (h) => (!role || heroHasRole(h, role)) && (!lane || heroHasLane(h, lane)),
  );

  const scored = candidates.map((h) => {
    let score = 0;
    const reasons: string[] = [];
    const key = norm(h.name);
    if (favs.has(key)) {
      score += 3;
      reasons.push(tx(lang, 'favorite'));
    }
    const fq = frequent.get(key);
    if (fq) {
      score += 3;
      reasons.push(tx(lang, 'frequent', { matches: fq.matches ?? 0 }));
      if (typeof fq.winRate === 'number') {
        score += clamp((fq.winRate - 50) / 10, -2, 2);
        reasons.push(tx(lang, 'frequentWr', { wr: fq.winRate }));
      }
    }
    if (player.role && heroHasRole(h, player.role)) {
      score += 1.5;
      reasons.push(tx(lang, 'roleMatch', { role: roleLabel(lang, player.role) }));
    }
    const wr = input.metaWinRateByName?.get(key);
    if (typeof wr === 'number' && wr > 0) {
      score += clamp((wr - 50) / 5, -2, 2);
      reasons.push(tx(lang, 'metaWr', { wr }));
    }
    if (lane && heroHasLane(h, lane)) reasons.push(tx(lang, 'laneFit', { lane }));
    if (!reasons.length) reasons.push(tx(lang, 'classPick', { role: roleLabel(lang, h.role) }));
    return { hero: h, score, reason: reasons.join(' · ') };
  });

  scored.sort((a, b) => b.score - a.score || byName(a.hero, b.hero));

  return {
    source: 'heuristic',
    filters: { role, lane },
    heroes: scored
      .slice(0, limit)
      .map((s) => toCard(s.hero, s.reason, 0.5 + s.score / 12)),
  };
}

// ---------------------------------------------------------------------------
// Counter picks
// ---------------------------------------------------------------------------

// Class-level fallback: which classes are strong against a given class.
const CLASS_COUNTERS: Record<HeroClass, HeroClass[]> = {
  marksman: ['assassin', 'fighter'],
  mage: ['assassin', 'fighter'],
  assassin: ['tank', 'fighter'],
  fighter: ['mage', 'marksman'],
  tank: ['marksman', 'mage'],
  support: ['assassin', 'mage'],
};

export interface CounterInput {
  enemies: CatalogHero[];
  /** getHeroMeta result per enemy id (null when unavailable). */
  metaByEnemyId: Map<string, HeroMeta | null>;
  catalog: CatalogHero[];
  /** Meta win rate (%) by lowercase hero name, used to rank class-based fallbacks. */
  metaWinRateByName?: Map<string, number>;
  lang: AiLang;
  limit?: number;
}

export function counterPicksHeuristic(input: CounterInput): CounterResponse {
  const { enemies, catalog, lang } = input;
  const limit = input.limit ?? 5;
  const enemyIds = new Set(enemies.map((e) => e.id));
  const nameIndex = indexByName(catalog);
  const acc = new Map<string, { hero: CatalogHero; score: number; against: Set<string>; wr: number }>();

  const bump = (hero: CatalogHero, enemy: CatalogHero, delta: number, wr: number) => {
    if (enemyIds.has(hero.id)) return;
    const cur = acc.get(hero.id) ?? { hero, score: 0, against: new Set<string>(), wr: 0 };
    cur.score += delta;
    cur.wr = Math.max(cur.wr, wr);
    cur.against.add(enemy.name);
    acc.set(hero.id, cur);
  };

  let metaAvailable = false;
  for (const enemy of enemies) {
    const meta = input.metaByEnemyId.get(enemy.id);
    // `counters.weak` = heroes this enemy is weak against, i.e. heroes that beat it.
    const refs = meta?.counters?.weak ?? [];
    if (refs.length) metaAvailable = true;
    for (const ref of refs) {
      const hero = ref.name ? nameIndex.get(norm(ref.name)) : undefined;
      if (!hero) continue;
      const gain = Math.abs(ref.increaseWinRate || 0) || Math.max(0, (ref.winRate || 50) - 50);
      bump(hero, enemy, 2 + gain, gain);
    }
  }

  // Class fallback (also fills in when meta covers only some enemies), ranked
  // by the hero's current meta win rate when the ranking is available.
  for (const enemy of enemies) {
    const strongClasses = CLASS_COUNTERS[heroClass(enemy)];
    for (const hero of catalog) {
      if (!strongClasses.includes(heroClass(hero))) continue;
      const wr = input.metaWinRateByName?.get(norm(hero.name));
      const bonus = typeof wr === 'number' && wr > 0 ? clamp((wr - 50) / 5, -1, 1) : 0;
      bump(hero, enemy, 0.5 + bonus, 0);
    }
  }

  const ranked = [...acc.values()].sort((a, b) => b.score - a.score || byName(a.hero, b.hero));

  const counters: CounterCard[] = ranked.slice(0, limit).map((r) => {
    const against = [...r.against].sort();
    const metaWr = input.metaWinRateByName?.get(norm(r.hero.name));
    const reason =
      r.wr > 0
        ? tx(lang, 'counterMeta', { enemies: against.join(', '), wr: r.wr })
        : tx(lang, 'counterClass', { role: roleLabel(lang, r.hero.role), enemies: against.join(', ') }) +
          (typeof metaWr === 'number' && metaWr > 0 ? ` · ${tx(lang, 'metaWr', { wr: metaWr })}` : '');
    const effectiveness = clamp(0.5 + r.score / 20, 0.5, 0.98);
    return { ...toCard(r.hero, reason, effectiveness), effectiveness: Math.round(effectiveness * 100) / 100, against };
  });

  return {
    source: 'heuristic',
    metaAvailable,
    enemies: enemies.map((e) => ({ id: e.id, name: e.name, role: e.role, image: e.image, thumb: e.thumb })),
    counters,
  };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildInput {
  hero: CatalogHero;
  meta: HeroMeta | null;
  catalog: CatalogHero[];
  lang: AiLang;
}

export function buildHeuristic(input: BuildInput): BuildResponse {
  const { hero, meta, catalog, lang } = input;
  const cls = heroClass(hero);
  const base = CLASS_BUILDS[cls];
  const lane = (hero.laneKeys ?? []).map(norm)[0] as LaneKey | undefined;
  const spell = (lane && LANE_SPELL[lane]) || base.spell;

  const items: BuildItem[] = base.core.map((i) => ({
    name: i.name,
    reason: itemText(lang, i.reasonKey),
    priority: 'core',
  }));

  const situational: BuildItem[] = [];
  const countersKnown = !!meta?.counters?.weak?.length;
  const metaAvailable = countersKnown || !!meta?.available;
  if (countersKnown) {
    const nameIndex = indexByName(catalog);
    let magic = 0;
    let physical = 0;
    for (const ref of meta!.counters.weak) {
      const h = ref.name ? nameIndex.get(norm(ref.name)) : undefined;
      if (!h) continue;
      const c = heroClass(h);
      if (c === 'mage' || c === 'support') magic++;
      else physical++;
    }
    if (magic || physical) {
      const anti = magic >= physical ? ANTI_MAGIC_ITEM : ANTI_PHYSICAL_ITEM;
      situational.push({
        name: anti.name,
        reason: `${itemText(lang, magic >= physical ? 'antiMagic' : 'antiPhysical')} ${itemText(lang, anti.reasonKey)}`,
        priority: 'situational',
      });
    }
  }
  for (const i of base.situational) {
    if (situational.length >= 3) break;
    if (situational.some((s) => s.name === i.name) || items.some((s) => s.name === i.name)) continue;
    situational.push({ name: i.name, reason: itemText(lang, i.reasonKey), priority: 'situational' });
  }

  return {
    source: 'heuristic',
    hero: { id: hero.id, name: hero.name, role: hero.role, image: hero.image, thumb: hero.thumb },
    metaAvailable,
    note: itemText(lang, countersKnown ? 'build.metaAvailable' : metaAvailable ? 'build.metaPartial' : 'build.metaUnavailable'),
    boots: { name: base.boots.name, reason: itemText(lang, base.boots.reasonKey) },
    items: [...items, ...situational],
    emblem: { name: base.emblem.name, talents: base.emblem.talents, reason: itemText(lang, base.emblem.reasonKey) },
    spell: { name: spell.name, reason: itemText(lang, spell.reasonKey) },
  };
}

// ---------------------------------------------------------------------------
// Coach
// ---------------------------------------------------------------------------

export interface CoachInput {
  player: PlayerContext;
  catalog: CatalogHero[];
  metaWinRateByName?: Map<string, number>;
  lang: AiLang;
}

export function coachHeuristic(input: CoachInput): CoachResponse {
  const { player, catalog, lang } = input;
  const { games, winRate } = winRateOf(player);
  const role = roleLabel(lang, player.role || 'fighter');
  const p = { wr: winRate, games, role, rank: player.rank, n: Math.abs(player.streak) };

  let summary: string;
  if (games === 0) summary = tx(lang, 'coachSummaryNoGames', p);
  else if (winRate >= 55) summary = tx(lang, 'coachSummaryGood', p);
  else if (winRate >= 48) summary = tx(lang, 'coachSummaryAvg', p);
  else summary = tx(lang, 'coachSummaryLow', p);

  const tips: CoachTip[] = [];
  if (player.streak <= -3) {
    tips.push({ title: tx(lang, 'tipStreakTitle'), detail: tx(lang, 'tipStreakDetail', p), priority: 'high' });
  } else if (player.streak >= 3) {
    tips.push({ title: tx(lang, 'tipStreakWinTitle'), detail: tx(lang, 'tipStreakWinDetail', p), priority: 'medium' });
  }
  if (games > 0 && winRate < 50) {
    tips.push({ title: tx(lang, 'tipObjTitle'), detail: tx(lang, 'tipObjDetail'), priority: 'high' });
  }
  if ((player.favoriteHeroes ?? []).length > 3 || games === 0 || winRate < 55) {
    tips.push({ title: tx(lang, 'tipPoolTitle'), detail: tx(lang, 'tipPoolDetail', p), priority: 'medium' });
  }
  if (games > 0 && player.mvpCount / games >= 0.15) {
    tips.push({ title: tx(lang, 'tipMvpTitle'), detail: tx(lang, 'tipMvpDetail'), priority: 'low' });
  }
  if (!(player.favoriteHeroes ?? []).length) {
    tips.push({ title: tx(lang, 'tipFavTitle'), detail: tx(lang, 'tipFavDetail'), priority: 'low' });
  }
  if (RANK_ORDER.indexOf(player.rank) >= RANK_ORDER.indexOf('epic')) {
    tips.push({ title: tx(lang, 'tipRankTitle'), detail: tx(lang, 'tipRankDetail', p), priority: 'low' });
  }

  const heroes = recommendHeroesHeuristic({
    player,
    catalog,
    metaWinRateByName: input.metaWinRateByName,
    lang,
    limit: 3,
  }).heroes;

  return { source: 'heuristic', summary, tips: tips.slice(0, 5), heroes };
}

// ---------------------------------------------------------------------------
// Player analysis
// ---------------------------------------------------------------------------

export function analysisHeuristic(player: PlayerContext, lang: AiLang): AnalysisResponse {
  const { games, winRate } = winRateOf(player);
  const mvpRate = games ? Math.round((player.mvpCount / games) * 1000) / 10 : 0;
  const favCount = (player.favoriteHeroes ?? []).length;
  const role = roleLabel(lang, player.role || 'fighter');
  const p = { wr: winRate, games, pct: mvpRate, n: Math.abs(player.streak), rank: player.rank, role };

  const strengths: AnalysisPoint[] = [];
  const weaknesses: AnalysisPoint[] = [];
  const recommendations: string[] = [];

  if (games >= 10 && winRate >= 52) {
    strengths.push({ category: tx(lang, 'strengthWr'), description: tx(lang, 'strengthWrDesc', p), impact: 'high' });
  } else if (games >= 10 && winRate < 50) {
    weaknesses.push({ category: tx(lang, 'weakWr'), description: tx(lang, 'weakWrDesc', p), impact: 'high' });
    recommendations.push(tx(lang, 'recoFocus', p), tx(lang, 'recoVod'));
  }
  if (games < 10) {
    weaknesses.push({ category: tx(lang, 'weakData'), description: tx(lang, 'weakDataDesc'), impact: 'medium' });
    recommendations.push(tx(lang, 'recoLink'));
  }
  if (games >= 10 && mvpRate >= 15) {
    strengths.push({ category: tx(lang, 'strengthMvp'), description: tx(lang, 'strengthMvpDesc', p), impact: 'high' });
  } else if (games >= 10 && mvpRate < 5) {
    weaknesses.push({ category: tx(lang, 'weakMvp'), description: tx(lang, 'weakMvpDesc'), impact: 'medium' });
  }
  if (player.streak >= 3) {
    strengths.push({ category: tx(lang, 'strengthStreak'), description: tx(lang, 'strengthStreakDesc', p), impact: 'medium' });
  } else if (player.streak <= -3) {
    weaknesses.push({ category: tx(lang, 'weakStreak'), description: tx(lang, 'weakStreakDesc', p), impact: 'high' });
  }
  if (favCount > 0) {
    strengths.push({ category: tx(lang, 'strengthPool'), description: tx(lang, 'strengthPoolDesc', { n: favCount }), impact: 'low' });
  } else {
    weaknesses.push({ category: tx(lang, 'weakPool'), description: tx(lang, 'weakPoolDesc'), impact: 'low' });
  }
  if (RANK_ORDER.indexOf(player.rank) >= RANK_ORDER.indexOf('legend')) {
    strengths.push({ category: tx(lang, 'strengthRank'), description: tx(lang, 'strengthRankDesc', p), impact: 'medium' });
  }
  recommendations.push(tx(lang, 'recoCounter'));
  if (!weaknesses.length) recommendations.push(tx(lang, 'recoKeep'));

  return {
    source: 'heuristic',
    stats: { games, winRate, mvpRate, streak: player.streak, rank: player.rank, role: player.role || 'fighter' },
    strengths,
    weaknesses,
    recommendations: [...new Set(recommendations)],
  };
}
