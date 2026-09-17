// Curated, real MLBB equipment used by the deterministic build heuristic.
// Only names present here can appear in a heuristic build.

export type HeroClass = 'tank' | 'fighter' | 'assassin' | 'mage' | 'marksman' | 'support';

export const HERO_CLASSES: HeroClass[] = [
  'tank',
  'fighter',
  'assassin',
  'mage',
  'marksman',
  'support',
];

export const LANE_KEYS = ['gold', 'exp', 'jungle', 'mid', 'roam'] as const;
export type LaneKey = (typeof LANE_KEYS)[number];

export const RANK_ORDER = [
  'warrior',
  'elite',
  'master',
  'grandmaster',
  'epic',
  'legend',
  'mythic',
  'mythical-honor',
  'mythical-glory',
  'mythical-immortal',
];

export interface ItemEntry {
  name: string;
  // Reason keys are resolved through AI_TEXT below (fr/en).
  reasonKey: string;
}

export interface ClassBuild {
  boots: ItemEntry;
  core: ItemEntry[];
  situational: ItemEntry[];
  emblem: { name: string; talents: string[]; reasonKey: string };
  spell: { name: string; reasonKey: string };
}

export const CLASS_BUILDS: Record<HeroClass, ClassBuild> = {
  tank: {
    boots: { name: 'Tough Boots', reasonKey: 'item.toughBoots' },
    core: [
      { name: 'Dominance Ice', reasonKey: 'item.dominanceIce' },
      { name: 'Antique Cuirass', reasonKey: 'item.antiqueCuirass' },
      { name: "Athena's Shield", reasonKey: 'item.athenasShield' },
      { name: 'Immortality', reasonKey: 'item.immortality' },
    ],
    situational: [
      { name: 'Radiant Armor', reasonKey: 'item.radiantArmor' },
      { name: 'Blade Armor', reasonKey: 'item.bladeArmor' },
      { name: 'Guardian Helmet', reasonKey: 'item.guardianHelmet' },
      { name: 'Cursed Helmet', reasonKey: 'item.cursedHelmet' },
    ],
    emblem: {
      name: 'Tank Emblem',
      talents: ['Vitality', 'Tenacity', 'Concussive Blast'],
      reasonKey: 'emblem.tank',
    },
    spell: { name: 'Flicker', reasonKey: 'spell.flicker' },
  },
  fighter: {
    boots: { name: 'Warrior Boots', reasonKey: 'item.warriorBoots' },
    core: [
      { name: 'War Axe', reasonKey: 'item.warAxe' },
      { name: 'Bloodlust Axe', reasonKey: 'item.bloodlustAxe' },
      { name: 'Blade of Despair', reasonKey: 'item.bladeOfDespair' },
      { name: 'Immortality', reasonKey: 'item.immortality' },
    ],
    situational: [
      { name: 'Malefic Roar', reasonKey: 'item.maleficRoar' },
      { name: "Queen's Wings", reasonKey: 'item.queensWings' },
      { name: "Athena's Shield", reasonKey: 'item.athenasShield' },
      { name: 'Antique Cuirass', reasonKey: 'item.antiqueCuirass' },
    ],
    emblem: {
      name: 'Fighter Emblem',
      talents: ['Thrill', 'Festival of Blood', 'Brave Smite'],
      reasonKey: 'emblem.fighter',
    },
    spell: { name: 'Execute', reasonKey: 'spell.execute' },
  },
  assassin: {
    boots: { name: 'Magic Shoes', reasonKey: 'item.magicShoes' },
    core: [
      { name: 'Hunter Strike', reasonKey: 'item.hunterStrike' },
      { name: 'Blade of the Heptaseas', reasonKey: 'item.bladeOfHeptaseas' },
      { name: 'Blade of Despair', reasonKey: 'item.bladeOfDespair' },
      { name: 'Malefic Roar', reasonKey: 'item.maleficRoar' },
    ],
    situational: [
      { name: 'Endless Battle', reasonKey: 'item.endlessBattle' },
      { name: 'Rose Gold Meteor', reasonKey: 'item.roseGoldMeteor' },
      { name: 'Immortality', reasonKey: 'item.immortality' },
      { name: 'Sea Halberd', reasonKey: 'item.seaHalberd' },
    ],
    emblem: {
      name: 'Assassin Emblem',
      talents: ['Rupture', 'Master Assassin', 'Killing Spree'],
      reasonKey: 'emblem.assassin',
    },
    spell: { name: 'Retribution', reasonKey: 'spell.retribution' },
  },
  mage: {
    boots: { name: 'Arcane Boots', reasonKey: 'item.arcaneBoots' },
    core: [
      { name: 'Enchanted Talisman', reasonKey: 'item.enchantedTalisman' },
      { name: 'Lightning Truncheon', reasonKey: 'item.lightningTruncheon' },
      { name: 'Genius Wand', reasonKey: 'item.geniusWand' },
      { name: 'Holy Crystal', reasonKey: 'item.holyCrystal' },
    ],
    situational: [
      { name: 'Divine Glaive', reasonKey: 'item.divineGlaive' },
      { name: 'Blood Wings', reasonKey: 'item.bloodWings' },
      { name: 'Winter Truncheon', reasonKey: 'item.winterTruncheon' },
      { name: 'Ice Queen Wand', reasonKey: 'item.iceQueenWand' },
    ],
    emblem: {
      name: 'Mage Emblem',
      talents: ['Agility', 'Weapon Master', 'Lethal Ignition'],
      reasonKey: 'emblem.mage',
    },
    spell: { name: 'Flameshot', reasonKey: 'spell.flameshot' },
  },
  marksman: {
    boots: { name: 'Swift Boots', reasonKey: 'item.swiftBoots' },
    core: [
      { name: 'Windtalker', reasonKey: 'item.windtalker' },
      { name: "Berserker's Fury", reasonKey: 'item.berserkersFury' },
      { name: 'Scarlet Phantom', reasonKey: 'item.scarletPhantom' },
      { name: 'Blade of Despair', reasonKey: 'item.bladeOfDespair' },
    ],
    situational: [
      { name: 'Malefic Roar', reasonKey: 'item.maleficRoar' },
      { name: 'Demon Hunter Sword', reasonKey: 'item.demonHunterSword' },
      { name: 'Wind of Nature', reasonKey: 'item.windOfNature' },
      { name: 'Immortality', reasonKey: 'item.immortality' },
    ],
    emblem: {
      name: 'Marksman Emblem',
      talents: ['Agility', 'Weapon Master', 'Quantum Charge'],
      reasonKey: 'emblem.marksman',
    },
    spell: { name: 'Inspire', reasonKey: 'spell.inspire' },
  },
  support: {
    boots: { name: 'Tough Boots', reasonKey: 'item.toughBoots' },
    core: [
      { name: 'Enchanted Talisman', reasonKey: 'item.enchantedTalisman' },
      { name: 'Fleeting Time', reasonKey: 'item.fleetingTime' },
      { name: 'Oracle', reasonKey: 'item.oracle' },
      { name: 'Dominance Ice', reasonKey: 'item.dominanceIce' },
    ],
    situational: [
      { name: 'Immortality', reasonKey: 'item.immortality' },
      { name: 'Necklace of Durance', reasonKey: 'item.necklaceOfDurance' },
      { name: "Athena's Shield", reasonKey: 'item.athenasShield' },
      { name: 'Antique Cuirass', reasonKey: 'item.antiqueCuirass' },
    ],
    emblem: {
      name: 'Support Emblem',
      talents: ['Agility', 'Tenacity', 'Focusing Mark'],
      reasonKey: 'emblem.support',
    },
    spell: { name: 'Flicker', reasonKey: 'spell.flicker' },
  },
};

// Lane-driven overrides: the jungler always needs Retribution, the roamer
// benefits from Vengeance/Flicker.
export const LANE_SPELL: Partial<Record<LaneKey, { name: string; reasonKey: string }>> = {
  jungle: { name: 'Retribution', reasonKey: 'spell.retribution' },
};

// Anti-magic / anti-physical picks added when the hero's known counters lean
// one way. Names are real items.
export const ANTI_MAGIC_ITEM: ItemEntry = { name: "Athena's Shield", reasonKey: 'item.athenasShield' };
export const ANTI_PHYSICAL_ITEM: ItemEntry = { name: 'Antique Cuirass', reasonKey: 'item.antiqueCuirass' };

export const ALL_KNOWN_ITEM_NAMES: Set<string> = new Set(
  Object.values(CLASS_BUILDS).flatMap((b) => [
    b.boots.name,
    ...b.core.map((i) => i.name),
    ...b.situational.map((i) => i.name),
  ]),
);
export const ALL_KNOWN_EMBLEMS = new Set(Object.values(CLASS_BUILDS).map((b) => b.emblem.name));
export const ALL_KNOWN_SPELLS = new Set([
  'Flicker',
  'Execute',
  'Retribution',
  'Inspire',
  'Sprint',
  'Revitalize',
  'Aegis',
  'Petrify',
  'Purify',
  'Flameshot',
  'Arrival',
  'Vengeance',
]);

// Localised copy for heuristic outputs. Keys are looked up with AI_TEXT[lang][key].
export const AI_TEXT: Record<'fr' | 'en', Record<string, string>> = {
  fr: {
    'item.toughBoots': 'Réduit les contrôles subis et augmente la défense.',
    'item.warriorBoots': 'Armure physique bon marché pour la lane.',
    'item.magicShoes': 'Réduction de temps de recharge pour enchaîner les combos.',
    'item.arcaneBoots': 'Pénétration magique pour les dégâts en début de partie.',
    'item.swiftBoots': 'Vitesse d’attaque pour les tireurs.',
    'item.dominanceIce': 'Réduit la vitesse d’attaque et les soins ennemis.',
    'item.antiqueCuirass': 'Réduit les dégâts physiques des combattants adverses.',
    'item.athenasShield': 'Bouclier contre les rafales magiques.',
    'item.immortality': 'Seconde chance en combat d’équipe.',
    'item.radiantArmor': 'Résistance magique contre les dégâts continus.',
    'item.bladeArmor': 'Renvoie les dégâts des attaques de base.',
    'item.guardianHelmet': 'Régénération pour rester sur la lane.',
    'item.cursedHelmet': 'Dégâts magiques de zone passifs.',
    'item.warAxe': 'Dégâts et pénétration croissants en combat prolongé.',
    'item.bloodlustAxe': 'Vol de vie sur les compétences.',
    'item.bladeOfDespair': 'Dégâts d’attaque massifs contre les cibles affaiblies.',
    'item.maleficRoar': 'Pénétration physique contre les tanks.',
    'item.queensWings': 'Réduction de dégâts à basse vie.',
    'item.hunterStrike': 'Dégâts et vitesse de déplacement pour chasser.',
    'item.bladeOfHeptaseas': 'Dégâts bonus sur la première attaque hors combat.',
    'item.endlessBattle': 'Dégâts réels après chaque compétence.',
    'item.roseGoldMeteor': 'Bouclier magique passif.',
    'item.seaHalberd': 'Anti-soin physique.',
    'item.enchantedTalisman': 'Mana et réduction de recharge.',
    'item.lightningTruncheon': 'Rafale magique de zone.',
    'item.geniusWand': 'Pénétration magique progressive.',
    'item.holyCrystal': 'Puissance magique brute.',
    'item.divineGlaive': 'Pénétration contre les cibles à haute résistance magique.',
    'item.bloodWings': 'Puissance magique et bouclier.',
    'item.winterTruncheon': 'Invulnérabilité temporaire.',
    'item.iceQueenWand': 'Ralentissement sur les compétences.',
    'item.windtalker': 'Vitesse d’attaque et coups critiques.',
    'item.berserkersFury': 'Dégâts critiques.',
    'item.scarletPhantom': 'Taux et vitesse de critique.',
    'item.demonHunterSword': 'Dégâts en pourcentage des PV contre les tanks.',
    'item.windOfNature': 'Immunité temporaire aux dégâts physiques.',
    'item.fleetingTime': 'Réduction de recharge sur les éliminations.',
    'item.oracle': 'Soins et boucliers renforcés.',
    'item.necklaceOfDurance': 'Anti-soin magique.',
    'emblem.tank': 'Robustesse et survie en ligne de front.',
    'emblem.fighter': 'Dégâts soutenus et sustain.',
    'emblem.assassin': 'Dégâts explosifs sur les cibles isolées.',
    'emblem.mage': 'Puissance magique et pénétration.',
    'emblem.marksman': 'Vitesse d’attaque et dégâts critiques.',
    'emblem.support': 'Réduction de recharge et utilité.',
    'spell.flicker': 'Repositionnement ou fuite.',
    'spell.execute': 'Achève les cibles à basse vie.',
    'spell.retribution': 'Indispensable pour le jungler.',
    'spell.inspire': 'Rafale de vitesse d’attaque.',
    'spell.flameshot': 'Dégâts à distance et repoussement.',
    'antiMagic': 'Les héros qui vous contrent infligent surtout des dégâts magiques.',
    'antiPhysical': 'Les héros qui vous contrent infligent surtout des dégâts physiques.',
    'build.metaUnavailable':
      'Statistiques méta indisponibles pour ce héros : build dérivé de sa classe.',
    'build.metaAvailable': 'Build dérivé de la classe du héros et de ses contres connus.',
    'build.metaPartial':
      'Taux de victoire méta connu mais contres indisponibles : build dérivé de sa classe.',
  },
  en: {
    'item.toughBoots': 'Reduces crowd control taken and adds defense.',
    'item.warriorBoots': 'Cheap physical armor for the lane.',
    'item.magicShoes': 'Cooldown reduction to chain combos.',
    'item.arcaneBoots': 'Magic penetration for early damage.',
    'item.swiftBoots': 'Attack speed for marksmen.',
    'item.dominanceIce': 'Lowers enemy attack speed and healing.',
    'item.antiqueCuirass': 'Reduces physical damage from enemy fighters.',
    'item.athenasShield': 'Shield against magic bursts.',
    'item.immortality': 'A second life in team fights.',
    'item.radiantArmor': 'Magic resistance against sustained damage.',
    'item.bladeArmor': 'Reflects basic-attack damage.',
    'item.guardianHelmet': 'Regeneration to stay on lane.',
    'item.cursedHelmet': 'Passive area magic damage.',
    'item.warAxe': 'Ramping damage and penetration in long fights.',
    'item.bloodlustAxe': 'Spell vamp on skills.',
    'item.bladeOfDespair': 'Massive attack against weakened targets.',
    'item.maleficRoar': 'Physical penetration against tanks.',
    'item.queensWings': 'Damage reduction at low HP.',
    'item.hunterStrike': 'Damage and movement speed to chase.',
    'item.bladeOfHeptaseas': 'Bonus damage on the first hit out of combat.',
    'item.endlessBattle': 'True damage after each skill.',
    'item.roseGoldMeteor': 'Passive magic shield.',
    'item.seaHalberd': 'Physical anti-heal.',
    'item.enchantedTalisman': 'Mana and cooldown reduction.',
    'item.lightningTruncheon': 'Area magic burst.',
    'item.geniusWand': 'Stacking magic penetration.',
    'item.holyCrystal': 'Raw magic power.',
    'item.divineGlaive': 'Penetration against high magic resistance.',
    'item.bloodWings': 'Magic power and shield.',
    'item.winterTruncheon': 'Temporary invulnerability.',
    'item.iceQueenWand': 'Slow on skills.',
    'item.windtalker': 'Attack speed and critical hits.',
    'item.berserkersFury': 'Critical damage.',
    'item.scarletPhantom': 'Critical rate and speed.',
    'item.demonHunterSword': 'Percent-HP damage against tanks.',
    'item.windOfNature': 'Temporary physical damage immunity.',
    'item.fleetingTime': 'Cooldown refund on takedowns.',
    'item.oracle': 'Stronger heals and shields.',
    'item.necklaceOfDurance': 'Magic anti-heal.',
    'emblem.tank': 'Toughness and front-line survival.',
    'emblem.fighter': 'Sustained damage and sustain.',
    'emblem.assassin': 'Burst on isolated targets.',
    'emblem.mage': 'Magic power and penetration.',
    'emblem.marksman': 'Attack speed and critical damage.',
    'emblem.support': 'Cooldown reduction and utility.',
    'spell.flicker': 'Repositioning or escape.',
    'spell.execute': 'Finishes low-HP targets.',
    'spell.retribution': 'Mandatory for the jungler.',
    'spell.inspire': 'Attack speed burst.',
    'spell.flameshot': 'Ranged damage and knockback.',
    'antiMagic': 'The heroes that counter you deal mostly magic damage.',
    'antiPhysical': 'The heroes that counter you deal mostly physical damage.',
    'build.metaUnavailable':
      'Meta statistics unavailable for this hero: build derived from its class.',
    'build.metaAvailable': 'Build derived from the hero class and its known counters.',
    'build.metaPartial':
      'Meta win rate known but counters unavailable: build derived from its class.',
  },
};
