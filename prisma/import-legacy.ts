/**
 * Import of the legacy MLBB Togo site (issue goddivor/mlbb-togo#153).
 *
 *   npm run import:legacy -- --dump ../tools/mlbb-import/dump [--wipe-seed] [--dry-run]
 *
 * The dump is a read-only JSON export of their Supabase tables; this script
 * never calls their API. Every mapping decision lives in
 * `src/esport/legacy-import.logic.ts` (pure, unit tested) — here we only read
 * the files, talk to Prisma and print the report.
 *
 * The import is idempotent. Every row it creates is remembered in its own
 * registry (a single `AppSetting` document, see
 * `src/esport/legacy-import.registry.ts`): a re-run resolves what it already
 * wrote through that mapping, whatever a member or an admin has since done to
 * the rows (rename, Google adoption, game-account link, retyped note). Natural
 * keys (season name, team name, match (season, teams, date), sponsor logo,
 * placeholder mailbox) are only the fallback for rows created before the
 * registry existed.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import {
  BuiltGame,
  HeroRef,
  ImportedPerson,
  LegacyAward,
  LegacyGame,
  LegacyGamePlayer,
  LegacyHero,
  LegacyMatch,
  LegacyPlayer,
  LegacyPlayoffMatch,
  LegacySeason,
  LegacyTeam,
  IMPORTED_EMAIL_DOMAIN,
  assignUsernames,
  awardCategoryOf,
  buildGames,
  buildMatchPlayers,
  buildHeroIndex,
  dedupePlayers,
  dedupeTeams,
  formatOf,
  laneOf,
  mapSeasons,
  podiumFromBracket,
  postImages,
  resolveHeroTable,
  stageOf,
  typeOf,
  winnerOf,
  youtubeIdFrom,
} from '../src/esport/legacy-import.logic';
import { serializeGames } from '../src/esport/esport-match-details';
import {
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
  LegacyRegistry,
  RegistryMap,
  emptyRegistry,
  mergeRegistry,
  parseRegistry,
  registrySize,
  serializeRegistry,
} from '../src/esport/legacy-import.registry';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Teams the seed creates (prisma/seed.ts). */
const SEED_TEAM_NAMES = [
  'ETERNUM ALPHA',
  'ETERNUM BETA',
  'ETERNUM GAMMA',
  'ETERNUM DELTA',
  'ETERNUM EPSILON',
];


type Options = {
  dump: string;
  wipeSeed: boolean;
  dryRun: boolean;
  report: string | null;
  allowMissingRegistry: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dump: path.resolve(__dirname, '../../tools/mlbb-import/dump'),
    wipeSeed: false,
    dryRun: false,
    report: null,
    allowMissingRegistry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dump') opts.dump = path.resolve(argv[++i] ?? '');
    else if (arg === '--report') opts.report = path.resolve(argv[++i] ?? '');
    else if (arg === '--wipe-seed') opts.wipeSeed = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-missing-registry') opts.allowMissingRegistry = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run import:legacy -- [--dump <dir>] [--report <file.md>] [--wipe-seed] [--dry-run]\n' +
          '                               [--allow-missing-registry]',
      );
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

/**
 * The import rewrites seasons, teams, matches and profiles: it must never run
 * against the production cluster. Only local hosts are accepted, with no
 * escape hatch (the release manager imports production by hand, after the
 * owner has read the report).
 */
function assertLocalDatabase() {
  const url = process.env.DATABASE_URL || '';
  const host = (url.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/:?,]+)/) || [])[1] || '';
  if (!['localhost', '127.0.0.1', '::1', 'mongo', 'mongodb'].includes(host)) {
    console.error(
      `Refusing to import into "${host || 'unknown host'}": this command only runs against a local database.`,
    );
    process.exit(1);
  }
}

function readTable<T>(dir: string, name: string): T[] {
  const file = path.join(dir, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing dump file: ${file}`);
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) throw new Error(`${name}.json is not an array`);
  return rows as T[];
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

type Counter = { created: number; updated: number; unchanged: number; deleted: number };

class Report {
  readonly counts = new Map<string, Counter>();
  readonly notes: string[] = [];
  readonly merges: { key: string; variants: string[]; username: string }[] = [];
  readonly collisions: {
    pseudo: string;
    username: string;
    taken: string;
    adopted: boolean;
    duplicate: boolean;
  }[] = [];
  readonly skipped: { table: string; reason: string; rows: number }[] = [];
  readonly wipe: { entity: string; id: string; name: string; action: string; reason: string }[] = [];
  readonly natural: {
    entity: string;
    legacyId: string | number;
    id: string;
    label: string;
    reason: string;
  }[] = [];
  unmatchedHeroes: string[] = [];

  bump(entity: string, kind: keyof Counter, n = 1) {
    const c = this.counts.get(entity) ?? { created: 0, updated: 0, unchanged: 0, deleted: 0 };
    c[kind] += n;
    this.counts.set(entity, c);
  }

  note(line: string) {
    this.notes.push(line);
  }

  skip(table: string, rows: number, reason: string) {
    const existing = this.skipped.find((s) => s.table === table && s.reason === reason);
    if (existing) existing.rows += rows;
    else this.skipped.push({ table, rows, reason });
  }

  render(opts: Options): string {
    const lines: string[] = [];
    lines.push('# Rapport d’import des données du site historique (#153)');
    lines.push('');
    lines.push(`- Date : ${new Date().toISOString()}`);
    lines.push(`- Dump : \`${opts.dump}\``);
    lines.push(`- Mode : ${opts.dryRun ? 'simulation (--dry-run, aucune écriture)' : 'écriture'}`);
    lines.push(`- Nettoyage des données de démonstration : ${opts.wipeSeed ? 'oui (--wipe-seed)' : 'non'}`);
    lines.push('');
    lines.push('## Comptages par entité');
    lines.push('');
    lines.push('| Entité | Créés | Mis à jour | Inchangés | Supprimés |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const [entity, c] of this.counts) {
      lines.push(`| ${entity} | ${c.created} | ${c.updated} | ${c.unchanged} | ${c.deleted} |`);
    }
    lines.push('');
    lines.push('## Pseudos fusionnés');
    lines.push('');
    if (!this.merges.length) lines.push('Aucune variante détectée.');
    else {
      lines.push('| Variantes | Profil créé |');
      lines.push('| --- | --- |');
      for (const m of this.merges) {
        lines.push(`| ${m.variants.map((v) => `\`${v}\``).join(' + ')} | \`${m.username}\` |`);
      }
    }
    lines.push('');
    lines.push('## Collisions de pseudo');
    lines.push('');
    if (!this.collisions.length) lines.push('Aucune collision avec un membre existant.');
    else {
      lines.push('| Pseudo importé | Identifiant attribué | Identifiant déjà pris | À arbitrer |');
      lines.push('| --- | --- | --- | --- |');
      for (const c of this.collisions) {
        lines.push(
          `| ${c.pseudo} | \`${c.username}\` | \`${c.taken}\` | ${
            c.adopted
              ? `oui : \`${c.taken}\` appartient à un compte déjà adopté, il s’agit probablement de la même personne${
                  c.duplicate ? ' ; un profil importé distinct existe déjà, à fusionner' : ''
                }`
              : 'non'
          } |`,
        );
      }
    }
    lines.push('');
    lines.push('## Héros non résolus');
    lines.push('');
    lines.push(
      this.unmatchedHeroes.length
        ? this.unmatchedHeroes.map((h) => `- ${h}`).join('\n')
        : 'Aucun : les 120 héros de leur catalogue sont résolus dans le nôtre.',
    );
    lines.push('');
    lines.push('## Rapprochements par clé naturelle');
    lines.push('');
    lines.push(
      'Lignes que l’import a reliées (ou refusé de relier) à une ligne existante sans passer par le ' +
        'registre : nom, logo ou adresse de substitution. Hors première exécution, une ligne portant du ' +
        'contenu saisi par l’équipe n’est jamais reprise.',
    );
    lines.push('');
    if (!this.natural.length) lines.push('Aucun : tout a été résolu par le registre.');
    else {
      lines.push('| Entité | Id historique | Id interne | Libellé | Décision |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const n of this.natural) {
        lines.push(`| ${n.entity} | ${n.legacyId} | \`${n.id}\` | « ${n.label} » | ${n.reason} |`);
      }
    }
    lines.push('');
    if (this.wipe.length) {
      lines.push('## Nettoyage (`--wipe-seed`)');
      lines.push('');
      lines.push('| Entité | Identifiant | Nom | Action | Raison |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const w of this.wipe) {
        lines.push(`| ${w.entity} | \`${w.id}\` | « ${w.name} » | ${w.action} | ${w.reason} |`);
      }
      lines.push('');
    }
    lines.push('## Lignes ignorées');
    lines.push('');
    lines.push('| Table | Lignes | Raison |');
    lines.push('| --- | ---: | --- |');
    for (const s of this.skipped) lines.push(`| \`${s.table}\` | ${s.rows} | ${s.reason} |`);
    lines.push('');
    lines.push('## Remarques');
    lines.push('');
    lines.push(this.notes.length ? this.notes.map((n) => `- ${n}`).join('\n') : 'Aucune.');
    lines.push('');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a patch only when it actually changes something (idempotence). */
function diff<T extends Record<string, any>>(current: any, patch: T): Partial<T> | null {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(patch)) {
    const cur = current?.[k];
    const same =
      v instanceof Date && cur instanceof Date
        ? v.getTime() === cur.getTime()
        : Array.isArray(v) && Array.isArray(cur)
          ? JSON.stringify(v) === JSON.stringify(cur)
          : (cur ?? null) === (v ?? null);
    if (!same) out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<T>) : null;
}

/**
 * Placeholder id used in `--dry-run`: MongoDB refuses anything that is not a
 * 24-hex ObjectId, even in a `where`, so the fake ids must look real.
 */
const fakeId = (key: string): string =>
  crypto.createHash('md5').update(key).digest('hex').slice(0, 24);

/** Their `location` is free text ("Lomé, Togo.") and our `city` is a city. */
function cityOf(location: string | null | undefined): string | null {
  const first = String(location ?? '')
    .split(',')[0]
    .replace(/[.\s]+$/, '')
    .trim();
  return first || null;
}

/**
 * Decide whether a row found by a natural key (name, logo, mailbox) may be
 * treated as one this import created.
 *
 * Two rules, and the second one has no exception:
 *  1. a single candidate only — several rows with the same natural key is an
 *     ambiguity the import refuses to resolve;
 *  2. the row must carry no content a human typed. A team with a description,
 *     a match with a note, a post signed by someone else: those belong to the
 *     team and are never rewritten, not even on a first run.
 *
 * Every decision, taken or refused, is listed in the report with its ids.
 */
type NaturalMatch<T> = { row: T | null; adopt: boolean; reason: string };

function decideNatural<T extends { id: string }>(
  candidates: T[],
  firstRun: boolean,
  ownerContent: (row: T) => string[],
): NaturalMatch<T> {
  if (!candidates.length) return { row: null, adopt: false, reason: '' };
  if (candidates.length > 1)
    return {
      row: null,
      adopt: false,
      reason: `${candidates.length} lignes candidates (${candidates
        .map((c) => c.id)
        .join(', ')}) : ambiguïté, aucune reprise`,
    };
  const [row] = candidates;
  const owner = ownerContent(row);
  if (owner.length)
    return {
      row: null,
      adopt: false,
      reason: `ligne créée ou modifiée par l’équipe (${owner.join(', ')}) : laissée intacte, une ligne distincte est créée`,
    };
  return {
    row,
    adopt: true,
    reason: firstRun
      ? 'première exécution, ligne conforme à ce que l’import écrit'
      : 'hors registre, mais ligne conforme à ce que l’import écrit',
  };
}

const date = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertLocalDatabase();
  const report = new Report();

  // ---- Read the dump -----------------------------------------------------
  const seasonsSrc = readTable<LegacySeason>(opts.dump, 'seasons');
  const teamsSrc = readTable<LegacyTeam>(opts.dump, 'teams');
  const playersSrc = readTable<LegacyPlayer>(opts.dump, 'players');
  const matchesSrc = readTable<LegacyMatch>(opts.dump, 'matches');
  const gamesSrc = readTable<LegacyGame>(opts.dump, 'games');
  const gamePlayersSrc = readTable<LegacyGamePlayer>(opts.dump, 'game_players');
  const heroesSrc = readTable<LegacyHero>(opts.dump, 'heroes');
  const heroMetaSrc = readTable<any>(opts.dump, 'hero_meta');
  const screenshotsSrc = readTable<any>(opts.dump, 'match_screenshots');
  const awardsSrc = readTable<LegacyAward>(opts.dump, 'awards');
  const sponsorsSrc = readTable<any>(opts.dump, 'sponsors');
  const communicationsSrc = readTable<any>(opts.dump, 'communications');
  const playoffsSrc = readTable<LegacyPlayoffMatch>(opts.dump, 'playoffs_matches');
  const siteSettingsSrc = readTable<any>(opts.dump, 'site_settings');
  const adminUsersSrc = readTable<any>(opts.dump, 'admin_users');

  // ---- Heroes: resolve first, abort before touching anything -------------
  const catalog: HeroRef[] = await prisma.hero.findMany({ select: { id: true, name: true } });
  const heroIndex = buildHeroIndex(catalog);
  const played = new Set(gamePlayersSrc.map((gp) => gp.hero_id).filter(Boolean) as string[]);
  const heroes = resolveHeroTable(heroesSrc, heroIndex, played);
  report.unmatchedHeroes = heroes.unmatched;
  if (heroes.unmatchedPlayed.length) {
    console.error(
      `✗ Héros joués introuvables dans notre catalogue : ${heroes.unmatchedPlayed.join(', ')}.\n` +
        '  Complétez la table de correction dans src/esport/legacy-import.logic.ts puis relancez.',
    );
    process.exit(1);
  }

  const dry = opts.dryRun;
  const log = (s: string) => console.log(s);

  // ---- Registry (legacy id -> our id) ------------------------------------
  const registryRow = await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
  const previous: LegacyRegistry = parseRegistry(registryRow?.value);
  const alreadyImported = await prisma.user.count({ where: { provider: 'imported' } });

  /**
   * Losing the registry while imported rows exist is the worst case: without
   * the mapping the import cannot recognise an adopted profile, so it would
   * create a duplicate and move that member's history onto it. Rather than
   * guess, it stops and asks.
   */
  if (!registrySize(previous) && alreadyImported > 0 && !opts.allowMissingRegistry) {
    console.error(
      [
        `✗ ${alreadyImported} profil(s) importé(s) existent déjà, mais le registre \`${LEGACY_REGISTRY_KEY}\` est`,
        '  absent ou illisible. Continuer créerait des doublons et déplacerait l’historique des profils adoptés.',
        '',
        `  • Restaurez le registre (une sauvegarde de la version précédente est écrite sous \`${LEGACY_REGISTRY_BACKUP_KEY}\`),`,
        '  • ou relancez avec --allow-missing-registry si vous savez que la base ne contient',
        '    aucun profil adopté et acceptez la réconciliation par clés naturelles.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (!registrySize(previous) && alreadyImported > 0) {
    report.note(
      `⚠️ Registre absent ou illisible avec ${alreadyImported} profil(s) importé(s) en base : exécution forcée ` +
        'par `--allow-missing-registry`, la réconciliation se fait par clés naturelles.',
    );
  }

  // The new registry starts from the previous one: a run that stops halfway
  // must never make the mappings it had already recorded disappear.
  const registry: LegacyRegistry = mergeRegistry(emptyRegistry(), previous);
  let registryDirty = false;
  /** Persist the registry as it is filled (once per entity, plus at the end). */
  const saveRegistry = async () => {
    if (dry || !registryDirty) return;
    const value = serializeRegistry(registry);
    await prisma.appSetting.upsert({
      where: { key: LEGACY_REGISTRY_KEY },
      create: { key: LEGACY_REGISTRY_KEY, value },
      update: { value },
    });
    registryDirty = false;
  };
  const remember = (map: RegistryMap, legacyId: string | number, id: string) => {
    registry[map][String(legacyId)] = id;
    registryDirty = true;
  };
  // Keep the version we started from under a backup key, so a bad run can be
  // rolled back. On a first run there is nothing to copy yet: the backup is
  // then seeded at the end with what the run produced, so a registry deleted
  // later can always be restored.
  if (!dry && registryRow?.value) {
    await prisma.appSetting.upsert({
      where: { key: LEGACY_REGISTRY_BACKUP_KEY },
      create: { key: LEGACY_REGISTRY_BACKUP_KEY, value: registryRow.value },
      update: { value: registryRow.value },
    });
  }
  report.note(
    registrySize(previous)
      ? `Registre d’import précédent trouvé (${registrySize(previous)} correspondances, écrit le ${previous.updatedAt ?? 'inconnu'}) : il sert à retrouver les lignes déjà créées, et il est sauvegardé sous \`${LEGACY_REGISTRY_BACKUP_KEY}\` avant d’être réécrit.`
      : 'Aucun registre d’import précédent : première exécution, les lignes existantes sont retrouvées par leurs clés naturelles (nom, logo, adresse de substitution).',
  );
  /** True on a genuine first run: natural keys may then reconcile freely. */
  const firstRun = registrySize(previous) === 0;

  // ---- Optional cleanup of the seeded demo data --------------------------
  // Only the five teams `prisma/seed.ts` creates are candidates, and only while
  // nothing is attached to them. No season is ever deleted: the seed creates
  // none, so a season is always either the owner's or one this import created
  // in a previous run (and then it is updated, not removed). Sponsors are
  // adopted, never deleted. In `--dry-run` nothing is written, but the set of
  // rows the run would delete is still computed and honoured by every lookup,
  // so the simulated table is exactly what the write run will do.
  const wiped = new Set<string>();
  if (opts.wipeSeed) {
    const seededTeams = await prisma.esportTeam.findMany({
      where: { name: { in: SEED_TEAM_NAMES } },
      select: { id: true, name: true, image: true, description: true, honours: true, city: true },
    });
    const empty: string[] = [];
    for (const t of seededTeams) {
      const [members, matches, staff] = await Promise.all([
        prisma.esportTeamMember.count({ where: { teamId: t.id } }),
        prisma.esportMatch.count({ where: { OR: [{ teamAId: t.id }, { teamBId: t.id }] } }),
        prisma.esportTeamStaff.count({ where: { teamId: t.id } }),
      ]);
      const authored = (['description', 'honours', 'city'] as const).filter((f) => {
        const v = (t as any)[f];
        return v !== null && v !== undefined && v !== '';
      });
      const reasons: string[] = [];
      if (members) reasons.push(`${members} membre(s)`);
      if (matches) reasons.push(`${matches} match(s)`);
      if (staff) reasons.push(`${staff} membre(s) du staff`);
      if (authored.length) reasons.push(`champs renseignés : ${authored.join(', ')}`);
      if (reasons.length) {
        report.wipe.push({
          entity: 'EsportTeam',
          id: t.id,
          name: t.name,
          action: 'conservée',
          reason: reasons.join(' ; '),
        });
      } else {
        empty.push(t.id);
        report.wipe.push({
          entity: 'EsportTeam',
          id: t.id,
          name: t.name,
          action: 'supprimée',
          reason: 'aucun membre, aucun match, aucun champ renseigné',
        });
      }
    }
    for (const id of empty) wiped.add(id);
    if (!dry && empty.length) await prisma.esportTeam.deleteMany({ where: { id: { in: empty } } });
    report.note(
      `Nettoyage \`--wipe-seed\` : ${empty.length} équipe(s) de démonstration supprimée(s) (détail dans « Nettoyage »). ` +
        'Aucune saison ni aucun sponsor n’est supprimé : le seed n’en crée aucune côté saisons, et les sponsors du seed sont adoptés.',
    );
  }

  // ---- Esport organisation ----------------------------------------------
  let esport = await prisma.esport.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!esport && !dry) {
    esport = await prisma.esport.create({
      data: {
        name: 'ETERNUM ESPORTS',
        logo: teamsSrc.find((t) => t.logo_url)?.logo_url ?? null,
        description: 'Organisation e-sport togolaise sur Mobile Legends: Bang Bang.',
      },
    });
    report.bump('Esport', 'created');
  }

  // ---- Seasons -----------------------------------------------------------
  const seasons = mapSeasons(seasonsSrc);
  const seasonIdBySource = new Map<number, string>();
  for (const s of seasons) {
    const mapped = previous.seasons[String(s.sourceId)];
    let existing = mapped ? await prisma.esportSeason.findUnique({ where: { id: mapped } }) : null;
    if (existing && wiped.has(existing.id)) existing = null;
    if (!existing) {
      const candidates = (await prisma.esportSeason.findMany({ where: { name: s.name } })).filter(
        (r) => !wiped.has(r.id),
      );
      const decision = decideNatural(candidates, firstRun, (row) =>
        (['description', 'slogan', 'theme', 'banner', 'color', 'podiums', 'summary'] as const).filter((f) => {
          const v = (row as any)[f];
          return v !== null && v !== undefined && v !== '';
        }),
      );
      if (decision.row) {
        existing = decision.row;
        report.natural.push({ entity: 'EsportSeason', legacyId: s.sourceId, id: existing.id, label: s.name, reason: decision.reason });
      } else if (decision.reason) {
        report.natural.push({ entity: 'EsportSeason', legacyId: s.sourceId, id: candidates.map((c) => c.id).join(', ') || '—', label: s.name, reason: decision.reason });
      }
    }
    const data = {
      name: s.name,
      slug: s.slug,
      number: s.number,
      status: s.status,
      isActive: s.isActive,
    };
    if (!existing) {
      const created = dry ? { id: fakeId(`season-${s.sourceId}`) } : await prisma.esportSeason.create({ data });
      seasonIdBySource.set(s.sourceId, created.id);
      remember('seasons', s.sourceId, created.id);
      report.bump('EsportSeason', 'created');
    } else {
      seasonIdBySource.set(s.sourceId, existing.id);
      remember('seasons', s.sourceId, existing.id);
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportSeason.update({ where: { id: existing.id }, data: patch });
      report.bump('EsportSeason', patch ? 'updated' : 'unchanged');
    }
  }

  await saveRegistry();

  // ---- Teams -------------------------------------------------------------
  const teams = dedupeTeams(teamsSrc);
  const teamIdBySource = new Map<number, string>();
  // Teams somebody already plays for or that appear on a match: those are
  // live data, never a row the import may take over on a natural key.
  const teamsWithContent = new Set<string>([
    ...(await prisma.esportTeamMember.findMany({ select: { teamId: true } })).map((r) => r.teamId),
    ...(await prisma.esportMatch.findMany({ select: { teamAId: true, teamBId: true } })).flatMap((r) => [
      r.teamAId,
      r.teamBId,
    ]),
  ]);
  for (const t of teams) {
    const mapped = t.sourceIds.map((id) => previous.teams[String(id)]).find(Boolean);
    let existing = mapped ? await prisma.esportTeam.findUnique({ where: { id: mapped } }) : null;
    if (existing && wiped.has(existing.id)) existing = null;
    if (!existing) {
      const candidates = (await prisma.esportTeam.findMany({ where: { name: t.name } })).filter(
        (r) => !wiped.has(r.id),
      );
      const decision = decideNatural(candidates, firstRun, (row) => {
        // A team the import created is an `esport` team with no description, no
        // honours and no city, and nobody plays for it yet.
        const owner: string[] = [];
        if (row.type !== 'esport') owner.push(`type ${row.type}`);
        for (const f of ['description', 'honours', 'city'] as const) {
          const v = (row as any)[f];
          if (v !== null && v !== undefined && v !== '') owner.push(f);
        }
        if (teamsWithContent.has(row.id)) owner.push('membres ou matchs existants');
        return owner;
      });
      if (decision.row) {
        existing = decision.row;
        report.natural.push({ entity: 'EsportTeam', legacyId: t.sourceIds.join('/'), id: existing.id, label: t.name, reason: decision.reason });
      } else if (decision.reason) {
        report.natural.push({ entity: 'EsportTeam', legacyId: t.sourceIds.join('/'), id: candidates.map((c) => c.id).join(', ') || '—', label: t.name, reason: decision.reason });
      }
    }
    const data = { name: t.name, image: t.image, type: 'esport', esportId: esport?.id ?? null };
    let id: string;
    if (!existing) {
      const created = dry ? { id: fakeId(`team-${t.key}`) } : await prisma.esportTeam.create({ data });
      id = created.id;
      report.bump('EsportTeam', 'created');
    } else {
      id = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportTeam.update({ where: { id }, data: patch });
      report.bump('EsportTeam', patch ? 'updated' : 'unchanged');
    }
    for (const src of t.sourceIds) {
      teamIdBySource.set(src, id);
      remember('teams', src, id);
    }
  }

  await saveRegistry();

  // ---- People ------------------------------------------------------------
  const people = dedupePlayers(playersSrc);
  const personByPlayerId = new Map<number, ImportedPerson>();
  for (const p of people) for (const id of p.sourceIds) personByPlayerId.set(id, p);

  const existingUsers = await prisma.user.findMany();
  const byId = new Map(existingUsers.map((u) => [u.id, u]));
  const byEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

  /**
   * An imported profile a real person has since claimed: an admin replaced the
   * placeholder mailbox with his Gmail address, or he signed in with Google.
   * `googleLogin` never flips `provider` off `imported`, so the provider alone
   * cannot tell the two apart.
   */
  const isAdopted = (u: { email: string; googleId?: string | null }) =>
    !!u.googleId || !u.email.toLowerCase().endsWith(IMPORTED_EMAIL_DOMAIN);

  /**
   * The profile of a legacy player: the registry first (the only key nothing in
   * the app can rewrite), then the placeholder mailbox for the rows created
   * before the registry existed. `gameNickname` is deliberately NOT a key: the
   * game-link flow writes it and unlinking nulls it.
   */
  const findProfile = (person: ImportedPerson, email: string) => {
    for (const legacyId of person.sourceIds) {
      const mapped = previous.players[String(legacyId)];
      const user = mapped ? byId.get(mapped) : undefined;
      if (user) return { user, via: 'registre' as const };
    }
    // The placeholder mailbox is only conclusive for an account the import
    // itself created and nobody has claimed: `<slug>@imported.mlbbtogo.local`
    // with `provider: 'imported'`.
    const byMailbox = byEmail.get(email);
    if (!byMailbox) return null;
    if (byMailbox.provider !== 'imported' || isAdopted(byMailbox)) {
      report.natural.push({
        entity: 'User',
        legacyId: person.sourceIds.join('/'),
        id: byMailbox.id,
        label: person.displayName,
        reason: 'adresse de substitution portée par un compte qui n’est pas un profil importé libre : laissé intact',
      });
      return null;
    }
    report.natural.push({
      entity: 'User',
      legacyId: person.sourceIds.join('/'),
      id: byMailbox.id,
      label: person.displayName,
      reason: firstRun
        ? 'première exécution, rapproché par l’adresse de substitution'
        : 'rapproché par l’adresse de substitution (profil importé jamais adopté)',
    });
    return { user: byMailbox, via: 'adresse de substitution' as const };
  };

  // Usernames an imported profile must not steal: every real member, plus the
  // imported profiles that have been adopted (their owner may have renamed
  // them). Profiles still waiting to be claimed are excluded so a re-run finds
  // them again instead of suffixing every slug.
  const takenUsernames = existingUsers
    .filter((u) => u.provider !== 'imported' || isAdopted(u))
    .map((u) => u.username);
  const adoptedByUsername = new Map(
    existingUsers.filter((u) => isAdopted(u)).map((u) => [u.username.toLowerCase(), u]),
  );
  const assignments = new Map(assignUsernames(people, takenUsernames).map((a) => [a.key, a]));

  const userIdByPerson = new Map<string, string>();
  const adopted: string[] = [];
  for (const person of people) {
    const a = assignments.get(person.key)!;
    if (person.variants.length > 1) {
      report.merges.push({ key: person.key, variants: person.variants, username: a.username });
    }
    const found = findProfile(person, a.email);
    if (a.collidedWith) {
      // A slug held by an adopted account is very probably the same person.
      // It is never merged automatically, and it keeps being reported run
      // after run: the arbitration is only over once an admin has merged the
      // two accounts (and the natural slug is free again).
      const owner = adoptedByUsername.get(a.collidedWith);
      report.collisions.push({
        pseudo: person.displayName,
        username: a.username,
        taken: a.collidedWith,
        adopted: !!owner,
        duplicate: !!owner && !!found && found.user.id !== owner.id,
      });
    }
    // Fields that identify the account: only written while nobody owns it.
    const identity = {
      username: a.username,
      email: a.email,
      avatar: person.avatar,
      provider: 'imported',
    };
    // Fields that describe the legacy player. Written when the import created
    // the profile and nobody has claimed it; an adopted profile belongs to its
    // owner and the import never writes anything on it again.
    const legacy = {
      // Our `User` has no `displayName` column: it is derived from
      // `gameNickname`, which is where the original pseudo goes so the player
      // keeps his name everywhere (roster, match sheet, stats). The provenance
      // is written in the biography.
      gameNickname: person.displayName,
      bio: `Profil repris du site historique de la MTL. Pseudo d’origine : ${person.displayName}.`,
      role: person.lane ?? 'fighter',
      country: 'Togo',
    };
    if (!found) {
      const created = dry
        ? { id: fakeId(`user-${person.key}`) }
        : await prisma.user.create({
            // Unusable password: the profile has no password, no Google and no
            // game account until an admin fills a real address on it (the
            // Google sign-in then adopts it by email).
            data: {
              ...identity,
              ...legacy,
              password: await bcrypt.hash(crypto.randomUUID(), 10),
            },
          });
      userIdByPerson.set(person.key, created.id);
      report.bump('User (profils importés)', 'created');
    } else {
      const existing = found.user;
      userIdByPerson.set(person.key, existing.id);
      const claimed = isAdopted(existing);
      if (claimed) {
        // Read-only from here on: username, mailbox, avatar, pseudo, biography,
        // lane and country all belong to the member now.
        adopted.push(existing.username);
        report.bump('User (profils déjà adoptés, laissés intacts)', 'unchanged');
      } else {
        const patch = diff(existing, { ...identity, ...legacy });
        if (patch && !dry) await prisma.user.update({ where: { id: existing.id }, data: patch });
        report.bump('User (profils importés)', patch ? 'updated' : 'unchanged');
      }
    }
    for (const legacyId of person.sourceIds) {
      remember('players', legacyId, userIdByPerson.get(person.key)!);
    }
  }
  if (adopted.length)
    report.note(
      `${adopted.length} profil(s) importé(s) ont déjà été adoptés par leur propriétaire (${adopted
        .map((u) => `\`${u}\``)
        .join(', ')}) : l’import ne réécrit plus rien dessus (identifiant, adresse, avatar, pseudo, biographie, lane, pays).`,
    );

  const userIdOf = (playerId: number): string | null => {
    const person = personByPlayerId.get(playerId);
    return person ? userIdByPerson.get(person.key) ?? null : null;
  };
  const laneOfUser = (userId: string): string | null => {
    for (const person of people) {
      if (userIdByPerson.get(person.key) === userId) return person.lane;
    }
    return null;
  };

  await saveRegistry();

  // ---- Current rosters (season 3) + archived rosters ---------------------
  const lastSeason = seasons[seasons.length - 1];
  const rosterBySeason = new Map<number, { teamId: string; userId: string; role: string | null }[]>();
  for (const row of playersSrc) {
    if (!row.team_id) continue;
    const team = teamsSrc.find((t) => t.id === row.team_id);
    const teamId = teamIdBySource.get(row.team_id);
    const userId = userIdOf(row.id);
    if (!team || !teamId || !userId) continue;
    const list = rosterBySeason.get(team.season_id) ?? [];
    if (!list.some((m) => m.teamId === teamId && m.userId === userId)) {
      list.push({ teamId, userId, role: laneOf(row.role) });
    }
    rosterBySeason.set(team.season_id, list);
  }
  for (const m of rosterBySeason.get(lastSeason.sourceId) ?? []) {
    const existing = await prisma.esportTeamMember.findFirst({
      where: { teamId: m.teamId, userId: m.userId },
    });
    if (!existing) {
      if (!dry) await prisma.esportTeamMember.create({ data: { teamId: m.teamId, userId: m.userId, role: m.role } });
      report.bump('EsportTeamMember', 'created');
    } else {
      const patch = diff(existing, { role: m.role });
      if (patch && !dry) await prisma.esportTeamMember.update({ where: { id: existing.id }, data: patch });
      report.bump('EsportTeamMember', patch ? 'updated' : 'unchanged');
    }
  }

  // ---- Matches, games and picks ------------------------------------------
  const gamesByMatch = new Map<number, LegacyGame[]>();
  for (const g of gamesSrc) {
    const list = gamesByMatch.get(g.match_id) ?? [];
    list.push(g);
    gamesByMatch.set(g.match_id, list);
  }
  const playersByGame = new Map<string, LegacyGamePlayer[]>();
  for (const gp of gamePlayersSrc) {
    const list = playersByGame.get(gp.game_id) ?? [];
    list.push(gp);
    playersByGame.set(gp.game_id, list);
  }
  const shotsByMatch = new Map<number, string[]>();
  for (const s of [...screenshotsSrc].sort((a, b) => a.id - b.id)) {
    const list = shotsByMatch.get(s.match_id) ?? [];
    if (typeof s.url === 'string' && /^https?:\/\//.test(s.url) && list.length < 10) list.push(s.url);
    shotsByMatch.set(s.match_id, list);
  }

  let skippedMatches = 0;
  let orphanPicks = 0;
  let writtenGames = 0;
  let writtenPicks = 0;
  let droppedGames = 0;
  let droppedPicks = 0;
  const inconsistent: number[] = [];
  const matchIdBySource = new Map<number, string>();

  for (const m of [...matchesSrc].sort((a, b) => a.id - b.id)) {
    const seasonId = seasonIdBySource.get(m.season_id) ?? null;
    const teamAId = teamIdBySource.get(m.team1_id);
    const teamBId = teamIdBySource.get(m.team2_id);
    if (!seasonId || !teamAId || !teamBId) {
      skippedMatches++;
      continue;
    }
    const scheduledAt = date(m.played_at);
    const scoreA = m.score1 ?? 0;
    const scoreB = m.score2 ?? 0;
    const stage = stageOf(m.type);
    const sourceGames = gamesByMatch.get(m.id) ?? [];
    const built: BuiltGame[] = buildGames(
      sourceGames.map((g) => ({
        gameId: g.id,
        gameNumber: g.game_number,
        winnerTeamId: g.winner_team_id ? teamIdBySource.get(g.winner_team_id) ?? null : null,
        screenshot: null,
        players: (playersByGame.get(g.id) ?? []).flatMap((gp) => {
          const userId = userIdOf(gp.player_id);
          const teamId = teamIdBySource.get(gp.team_id);
          if (!userId || !teamId) {
            orphanPicks++;
            return [];
          }
          return [
            {
              userId,
              teamId,
              hero: gp.hero_id ? heroes.resolved.get(gp.hero_id) ?? null : null,
              isSub: gp.is_sub === true,
            },
          ];
        }),
      })),
    );
    // Upstream sometimes recorded only part of a series: the declared score and
    // the games then disagree. Our match sheet refuses such a pair (both admin
    // endpoints call `assertResultMatchesGames`), so the match would become
    // uneditable. The score wins, the partial games are dropped, and the match
    // is listed in the report so an admin can key the games in again.
    const wonA = built.filter((g) => g.winnerTeamId === teamAId).length;
    const wonB = built.filter((g) => g.winnerTeamId === teamBId).length;
    const diverges = built.length > 0 && (wonA !== scoreA || wonB !== scoreB);
    if (diverges) inconsistent.push(m.id);
    const games = diverges ? [] : built;
    const countPicks = (list: BuiltGame[]) => list.reduce((n, g) => n + (g.picks?.length ?? 0), 0);
    writtenGames += games.length;
    writtenPicks += countPicks(games);
    if (diverges) {
      droppedGames += built.length;
      droppedPicks += countPicks(built);
    }

    const shots = shotsByMatch.get(m.id) ?? [];
    const data = {
      seasonId,
      teamAId,
      teamBId,
      type: typeOf(stage),
      stage,
      format: formatOf(m.best_of, scoreA, scoreB, games.length),
      scheduledAt,
      status: 'completed',
      scoreA,
      scoreB,
      winnerTeamId: winnerOf(scoreA, scoreB, teamAId, teamBId),
      games: serializeGames(games as any),
      screenshots: shots.length ? JSON.stringify(shots) : null,
      // `notes` is the admin's own text box, shown to every member on the match
      // sheet: the import never writes in it. Being a legacy match is recorded
      // in the registry instead.
    };
    const mapped = previous.matches[String(m.id)];
    let existing = mapped ? await prisma.esportMatch.findUnique({ where: { id: mapped } }) : null;
    if (!existing) {
      const candidates = await prisma.esportMatch.findMany({
        where: { seasonId, teamAId, teamBId, scheduledAt },
      });
      const decision = decideNatural(candidates, firstRun, (row) => {
        const owner: string[] = [];
        if (row.notes) owner.push('notes');
        if (row.vodUrl || row.streamUrl) owner.push('liens');
        if (row.mvpUserId) owner.push('MVP');
        return owner;
      });
      if (decision.row) existing = decision.row;
      if (decision.reason)
        report.natural.push({
          entity: 'EsportMatch',
          legacyId: m.id,
          id: decision.row?.id ?? (candidates.map((c) => c.id).join(', ') || '—'),
          label: `${teamAId} vs ${teamBId}`,
          reason: decision.reason,
        });
    }
    let matchId: string;
    if (!existing) {
      const created = dry ? { id: fakeId(`match-${m.id}`) } : await prisma.esportMatch.create({ data });
      matchId = created.id;
      report.bump('EsportMatch', 'created');
    } else {
      matchId = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportMatch.update({ where: { id: matchId }, data: patch });
      report.bump('EsportMatch', patch ? 'updated' : 'unchanged');
    }
    matchIdBySource.set(m.id, matchId);
    remember('matches', m.id, matchId);

    // One row per player of the series: hero = his most used one, no KDA.
    const rows = buildMatchPlayers(games as any, laneOfUser);
    // Rows left over from a previous run (a match whose games were dropped)
    // must go, otherwise the sheet keeps players nothing references any more.
    const stale = (await prisma.esportMatchPlayer.findMany({ where: { matchId }, select: { id: true, userId: true } }))
      .filter((r) => !rows.some((row) => row.userId === r.userId))
      .map((r) => r.id);
    if (stale.length) {
      if (!dry) await prisma.esportMatchPlayer.deleteMany({ where: { id: { in: stale } } });
      report.bump('EsportMatchPlayer', 'deleted', stale.length);
    }
    for (const row of rows) {
      const rowData = {
        matchId,
        userId: row.userId,
        teamId: row.teamId,
        hero: row.hero,
        heroId: row.heroId,
        role: row.role,
        isMvp: false,
      };
      const existingRow = await prisma.esportMatchPlayer.findFirst({
        where: { matchId, userId: row.userId },
      });
      if (!existingRow) {
        if (!dry) await prisma.esportMatchPlayer.create({ data: rowData });
        report.bump('EsportMatchPlayer', 'created');
      } else {
        const patch = diff(existingRow, rowData);
        if (patch && !dry) await prisma.esportMatchPlayer.update({ where: { id: existingRow.id }, data: patch });
        report.bump('EsportMatchPlayer', patch ? 'updated' : 'unchanged');
      }
    }
  }
  if (skippedMatches) report.skip('matches', skippedMatches, 'saison ou équipe introuvable');
  if (orphanPicks) report.skip('game_players', orphanPicks, 'joueur ou équipe introuvable');
  if (inconsistent.length)
    report.note(
      `Score et games divergents en amont pour ${inconsistent.length} matchs (identifiants source ${inconsistent.join(', ')}) : ` +
        'le score déclaré fait foi et leurs games partielles ne sont pas importées, sinon la fiche serait ' +
        'impossible à rouvrir côté administration. Ces matchs sont à ressaisir à la main.',
    );
  report.note(
    `${writtenGames} games et ${writtenPicks} picks écrits dans le JSON \`EsportMatch.games\` ` +
      `(sur ${gamesSrc.length} games et ${gamePlayersSrc.length} picks en amont ; ${droppedGames} games ` +
      `et ${droppedPicks} picks écartés avec les matchs divergents ci-dessous). Aucune table dédiée, ` +
      'aucun changement de schéma Prisma.',
  );
  report.skip('games', gamesSrc.length, 'stockées dans EsportMatch.games (pas de table dédiée)');
  report.skip('match_screenshots', screenshotsSrc.length, 'stockées dans EsportMatch.screenshots');

  await saveRegistry();

  // ---- Awards ------------------------------------------------------------
  for (const a of [...awardsSrc].sort((x, y) => x.id - y.id)) {
    const seasonId = seasonIdBySource.get(a.season_id);
    if (!seasonId) continue;
    const category = awardCategoryOf(a.title);
    const title = category === 'custom' ? (a.custom_label || a.title || '').trim() || null : null;
    const userId = a.player_id ? userIdOf(a.player_id) : null;
    const teamId = a.team_id ? teamIdBySource.get(a.team_id) ?? null : null;
    const data = { seasonId, category, title, userId, teamId, description: a.description?.trim() || null };
    const existing = await prisma.seasonAward.findFirst({
      where: category === 'custom' ? { seasonId, category, title } : { seasonId, category },
    });
    if (!existing) {
      if (!dry) await prisma.seasonAward.create({ data });
      report.bump('SeasonAward', 'created');
    } else {
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.seasonAward.update({ where: { id: existing.id }, data: patch });
      report.bump('SeasonAward', patch ? 'updated' : 'unchanged');
    }
  }

  await saveRegistry();

  // ---- Sponsors ----------------------------------------------------------
  // The seeded sponsors carry the very same logo URLs as the legacy rows (they
  // were copied from that site), so they are ADOPTED rather than deleted and
  // recreated: the row keeps its id and the seasons an admin may already have
  // attached to it. A sponsor is matched by the registry first, then by logo
  // (whatever its name: renaming the row must not create a duplicate), then by
  // name. `isActive` is never written back: hiding a partner is the owner's
  // decision and must survive a re-run.
  const allSponsors = await prisma.sponsor.findMany();
  let adoptedSponsors = 0;
  for (const s of [...sponsorsSrc].sort((a, b) => a.id - b.id)) {
    const seasonId = seasonIdBySource.get(s.season_id);
    const logo = String(s.logo_url ?? '').trim();
    const name = s.name?.trim() || null;
    const mapped = previous.sponsors[String(s.id)];
    let existing = mapped ? allSponsors.find((row) => row.id === mapped) : undefined;
    if (!existing) {
      const candidates = allSponsors.filter(
        (row) => row.logo.trim() === logo || (name && row.name && row.name.trim() === name),
      );
      const decision = decideNatural(candidates, firstRun, (row) => {
        // The logo is the sponsor's identity: the seeded rows carry the very
        // same file as the legacy ones. A row matched only by name, with a
        // different logo, is somebody else's and is left alone.
        if (row.logo.trim() === logo) return [];
        return ['logo différent'];
      });
      if (decision.row) {
        existing = decision.row;
        if (!decision.row.name) adoptedSponsors++;
      }
      if (decision.reason)
        report.natural.push({
          entity: 'Sponsor',
          legacyId: s.id,
          id: decision.row?.id ?? (candidates.map((c) => c.id).join(', ') || '—'),
          label: name ?? logo,
          reason: decision.reason,
        });
    }
    const data = {
      name,
      logo,
      url: s.link_url || null,
      description: s.description?.trim() || null,
      sort: Number(s.weight) || 0,
      // Add our season to the ones already attached instead of replacing them.
      seasonIds: Array.from(new Set([...(existing?.seasonIds ?? []), ...(seasonId ? [seasonId] : [])])),
    };
    let sponsorId: string;
    if (!existing) {
      const created = dry
        ? { id: fakeId(`sponsor-${s.id}`) }
        : await prisma.sponsor.create({ data: { ...data, isActive: true } });
      sponsorId = created.id;
      report.bump('Sponsor', 'created');
    } else {
      sponsorId = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.sponsor.update({ where: { id: sponsorId }, data: patch });
      report.bump('Sponsor', patch ? 'updated' : 'unchanged');
    }
    remember('sponsors', s.id, sponsorId);
  }
  if (adoptedSponsors)
    report.note(
      `${adoptedSponsors} sponsor(s) du seed adoptés par leur logo (identifiant, palier, visibilité et saisons conservés) plutôt que supprimés puis recréés.`,
    );
  report.note(
    'Champs de `Sponsor` que l’import écrit à chaque exécution : `name`, `logo`, `url`, `description`, ' +
      '`sort` et `seasonIds` (nos saisons ajoutées aux existantes). Il ne touche jamais `isActive` ni ' +
      '`tier` : masquer un partenaire ou lui donner un palier reste une décision de l’équipe.',
  );

  await saveRegistry();

  // ---- Communications: posts, stream videos, offline events --------------
  // Their communications were published by the site itself (`author_name` is
  // null on every row), so they are attributed to an admin when there is one,
  // else to a dedicated system account hidden from every player-facing list.
  const IMPORT_AUTHOR = { username: 'mlbb-togo', email: 'system@imported.mlbbtogo.local' };
  let author: { id: string; username: string } | null =
    (await prisma.user.findFirst({ where: { roleUser: 'admin' }, orderBy: { createdAt: 'asc' } })) ??
    (await prisma.user.findFirst({ where: { email: IMPORT_AUTHOR.email } }));
  if (!author) {
    // In `--dry-run` the account is only simulated, so the report still counts
    // the posts, the videos and the events the real run would write.
    author = dry
      ? { id: fakeId('import-author'), username: IMPORT_AUTHOR.username }
      : await prisma.user.create({
          data: {
            ...IMPORT_AUTHOR,
            password: await bcrypt.hash(crypto.randomUUID(), 10),
            provider: 'imported',
            isSystemAccount: true,
            bio: 'Compte technique : auteur des publications reprises du site historique.',
          },
        });
    report.bump('User (auteur système des publications)', 'created');
  }

  for (const c of [...communicationsSrc].sort((a, b) => a.id - b.id)) {
    const createdAt = date(c.created_at) ?? new Date();
    const title = (c.title || '').trim() || 'Sans titre';
    if (c.kind === 'offline') {
      const mappedEvent = previous.events[String(c.id)];
      let existing = mappedEvent ? await prisma.event.findUnique({ where: { id: mappedEvent } }) : null;
      if (!existing) {
        const candidates = await prisma.event.findMany({ where: { title, date: c.event_date || null } });
        const decision = decideNatural(candidates, firstRun, (row) =>
          (['organizer', 'time', 'duration'] as const).filter((f) => {
            const v = (row as any)[f];
            return v !== null && v !== undefined && v !== '';
          }),
        );
        if (decision.row) existing = decision.row;
        if (decision.reason)
          report.natural.push({
            entity: 'Event',
            legacyId: c.id,
            id: decision.row?.id ?? (candidates.map((x) => x.id).join(', ') || '—'),
            label: title,
            reason: decision.reason,
          });
      }
      const data = {
        title,
        type: 'offline',
        description: (c.content || '').trim() || null,
        date: c.event_date || null,
        city: cityOf(c.location),
        isPublic: true,
      };
      if (!existing) {
        const created = dry ? { id: fakeId(`event-${c.id}`) } : await prisma.event.create({ data });
        remember('events', c.id, created.id);
        report.bump('Event', 'created');
      } else {
        remember('events', c.id, existing.id);
        const patch = diff(existing, data);
        if (patch && !dry) await prisma.event.update({ where: { id: existing.id }, data: patch });
        report.bump('Event', patch ? 'updated' : 'unchanged');
      }
      continue;
    }
    const images = postImages(c.images, c.image_url);
    const data = {
      authorId: author.id,
      authorName: (c.author_name || author.username || 'MLBB Togo').trim(),
      category: c.kind === 'stream' ? 'stream' : c.kind === 'community' ? 'community' : 'announcement',
      title,
      content: (c.content || '').trim(),
      images: JSON.stringify(images),
      isSponsored: c.is_sponsored === true,
      createdAt,
    };
    const mappedPost = previous.posts[String(c.id)];
    let existing = mappedPost ? await prisma.post.findUnique({ where: { id: mappedPost } }) : null;
    if (!existing) {
      const candidates = await prisma.post.findMany({ where: { title, category: data.category } });
      const decision = decideNatural(candidates, firstRun, (row) => {
        // A post the import created is signed by the author it chose and has
        // never been pinned by the team.
        const owner: string[] = [];
        if (row.authorId !== author!.id) owner.push('autre auteur');
        if (row.isPinned) owner.push('épinglé');
        return owner;
      });
      if (decision.row) existing = decision.row;
      if (decision.reason)
        report.natural.push({
          entity: 'Post',
          legacyId: c.id,
          id: decision.row?.id ?? (candidates.map((x) => x.id).join(', ') || '—'),
          label: title,
          reason: decision.reason,
        });
    }
    if (!existing) {
      const created = dry ? { id: fakeId(`post-${c.id}`) } : await prisma.post.create({ data });
      remember('posts', c.id, created.id);
      report.bump('Post', 'created');
    } else {
      remember('posts', c.id, existing.id);
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.post.update({ where: { id: existing.id }, data: patch });
      report.bump('Post', patch ? 'updated' : 'unchanged');
    }
    if (c.kind === 'stream') {
      const videoId = youtubeIdFrom(c.embed_url);
      const seasonId = seasonIdBySource.get(c.season_id);
      if (videoId && seasonId) {
        const mappedVideo = previous.streamVideos[String(c.id)];
        const existingVideo =
          (mappedVideo ? await prisma.streamSeasonVideo.findUnique({ where: { id: mappedVideo } }) : null) ??
          (await prisma.streamSeasonVideo.findFirst({ where: { seasonId, videoId } }));
        const videoData = { seasonId, videoId, title, date: (c.event_date || '').trim() };
        if (!existingVideo) {
          const created = dry
            ? { id: fakeId(`video-${c.id}`) }
            : await prisma.streamSeasonVideo.create({ data: videoData });
          remember('streamVideos', c.id, created.id);
          report.bump('StreamSeasonVideo', 'created');
        } else {
          registry.streamVideos[String(c.id)] = existingVideo.id;
          const patch = diff(existingVideo, videoData);
          if (patch && !dry)
            await prisma.streamSeasonVideo.update({ where: { id: existingVideo.id }, data: patch });
          report.bump('StreamSeasonVideo', patch ? 'updated' : 'unchanged');
        }
      } else {
        report.skip('communications (stream)', 1, 'identifiant YouTube ou saison introuvable dans l’embed_url');
      }
    }
  }

  await saveRegistry();

  // ---- Season archives: podium, bracket and historical rosters -----------
  for (const s of seasons) {
    const seasonId = seasonIdBySource.get(s.sourceId);
    if (!seasonId) continue;
    const bracket = playoffsSrc.filter((p) => p.season_id === s.sourceId);
    const podium = podiumFromBracket(bracket, (src) => teamIdBySource.get(src) ?? null);
    const roster = rosterBySeason.get(s.sourceId) ?? [];
    const archive = {
      // Extra key of the season JSON: read-only history, ignored by the
      // existing readers (they only look at `summary` / `podiums`).
      rosters: roster.map((r) => ({ teamId: r.teamId, userId: r.userId, role: r.role })),
      bracket: bracket.map((b) => ({
        round: b.round,
        order: b.match_order,
        teamAId: teamIdBySource.get(b.team1_id) ?? null,
        teamBId: teamIdBySource.get(b.team2_id) ?? null,
        winnerTeamId: b.winner_id ? teamIdBySource.get(b.winner_id) ?? null : null,
      })),
    };
    const existing = await prisma.esportSeason.findUnique({ where: { id: seasonId } });
    const podiums = JSON.stringify({ regular: null, playoffs: podium.length ? podium : null });
    let current: Record<string, unknown> = {};
    try {
      current = existing?.summary ? JSON.parse(existing.summary) : {};
    } catch {
      current = {};
    }
    const summary = JSON.stringify({ ...current, legacy: archive });
    const patch = diff(existing, { podiums, summary });
    if (patch && !dry) await prisma.esportSeason.update({ where: { id: seasonId }, data: patch });
    report.bump('EsportSeason (archives)', patch ? 'updated' : 'unchanged');
  }
  report.skip('playoffs_matches', playoffsSrc.length, 'archivés dans EsportSeason.podiums / summary.legacy');

  // ---- Explicitly skipped tables -----------------------------------------
  report.skip('site_settings', siteSettingsSrc.length, 'fonds de page : aucun équivalent dans notre design (décision 1)');
  report.skip('admin_users', adminUsersSrc.length, 'comptes Gmail de leurs administrateurs : non importés');
  report.skip('hero_meta', heroMetaSrc.length, 'instantané picks/bans/win-rate propre à leur site : aucun champ équivalent');
  report.skip('heroes', heroesSrc.length, 'utilisés uniquement pour résoudre les picks vers notre catalogue');
  report.skip(
    'communication_likes / communication_comments / communication_comment_likes',
    0,
    'likes et commentaires anonymes (colonne `actor` libre) : aucun compte à rattacher',
  );
  const spellings = new Set(playersSrc.map((p) => p.name.trim()));
  report.note(
    `${playersSrc.length} lignes \`players\` (une par joueur et par saison), ${spellings.size} orthographes ` +
      `distinctes, ${people.length} personnes après normalisation. Le brief annonçait 55 personnes : ` +
      'la règle « une personne par pseudo normalisé » en donne 51, car 9 groupes de variantes sont fusionnés.',
  );
  report.note(
    'Pseudos que la normalisation ne fusionne pas alors qu’il s’agit peut-être des mêmes personnes, ' +
      'à arbitrer à la main : `Gabrielle` / `Gabrielle~555` / `Gabriellle~555`, `Moon` / `MOON@4215`, ' +
      '`Cresus` / `It is Cresus`, `Atomic Weight` / `TheAtomicWeight`, `PIERRO SMK` / `Pierrosmoke`.',
  );
  report.note('`matches.mvp_player_id` et `matches.bans` sont nuls/vides sur toutes les lignes en amont.');
  const nullHeroPicks = gamePlayersSrc.filter((gp) => !gp.hero_id).length;
  if (nullHeroPicks)
    report.note(
      `${nullHeroPicks} pick(s) sans héros en amont : ils sont importés avec \`heroId\` et \`hero\` à null.`,
    );
  report.note(
    'Les identifiants des matchs importés sont conservés dans le registre `' +
      LEGACY_REGISTRY_KEY +
      '` : les crochets de gamification (XP de match, succès, cadres, notifications) les ignorent, pour ' +
      'qu’un enregistrement ultérieur par un administrateur ne distribue pas rétroactivement les ' +
      'récompenses aux profils importés. Le champ `notes` du match, visible par tous et modifiable par ' +
      'l’administration, n’est jamais écrit par l’import.',
  );
  report.note(
    'Relancer l’import écrase les champs qu’il gère : titre, contenu et images des posts, nom, logo, lien, ' +
      'description et ordre des sponsors, podiums et archives de saison, score, format et games des matchs, ' +
      'nom et logo des équipes. Les retouches faites par un administrateur sur ces champs sont donc perdues ' +
      'à la relance. Ne sont jamais écrasés : les profils déjà adoptés, la visibilité (`isActive`) et le ' +
      'palier (`tier`) des sponsors, le champ `notes` des matchs, et les saisons que le nettoyage conserve.',
  );
  report.note(
    'Adoption d’un profil importé : aucune route de l’API ne modifie `email` (voir `UsersService.update`), ' +
      'il faut donc écrire l’adresse Gmail réelle directement en base. La première connexion Google adopte ' +
      'ensuite le profil (`AuthService.googleLogin` cherche par `googleId` puis par `email`).',
  );
  report.note(
    'Les lanes (Exp/Gold/Jungle/Mid/Roam) sont posées sur `User.role`, `EsportTeamMember.role` et `EsportMatchPlayer.role`.',
  );
  report.note(
    'Aucun KDA en amont : les lignes `EsportMatchPlayer` ont kills/deaths/assists à 0 et `isMvp` à false.',
  );

  // ---- Recompute the denormalized player counters ------------------------
  if (!dry) {
    const ids = Array.from(userIdByPerson.values());
    const { PlayerStatsService } = await import('../src/stats/player-stats.service');
    await new PlayerStatsService(prisma as any).recomputeUsers(ids);
    report.note(`Compteurs (victoires, défaites, série, badges) recalculés pour ${ids.length} profils.`);
  }

  // ---- Registry ----------------------------------------------------------
  // Already saved after each entity; this is the final flush.
  registryDirty = true;
  await saveRegistry();
  if (!dry && !registryRow?.value) {
    // First run: seed the backup so the registry can be restored if it is ever
    // deleted, which is the one loss the import cannot recover from.
    const value = serializeRegistry(registry);
    await prisma.appSetting.upsert({
      where: { key: LEGACY_REGISTRY_BACKUP_KEY },
      create: { key: LEGACY_REGISTRY_BACKUP_KEY, value },
      update: { value },
    });
  }
  report.note(
    `Registre d’import ${dry ? 'qui serait écrit' : 'écrit'} dans \`AppSetting\` (clé \`${LEGACY_REGISTRY_KEY}\`, ` +
      `sauvegarde de la version précédente sous \`${LEGACY_REGISTRY_BACKUP_KEY}\`) : ` +
      `${registrySize(registry)} correspondances « identifiant historique → identifiant interne ». C’est la seule ` +
      'clé que rien dans l’application ne peut réécrire : elle permet de relancer l’import après une adoption ' +
      'Google, une liaison de compte de jeu, un renommage ou une note retapée.',
  );

  // ---- Report ------------------------------------------------------------
  const md = report.render(opts);
  log('\n' + md);
  // A dry run only writes a file when one is asked for, so the release manager
  // can diff the simulation against the report of the real run.
  const target = opts.report ?? (dry ? null : path.join(opts.dump, '..', 'IMPORT_REPORT.md'));
  if (target) {
    fs.writeFileSync(target, md, 'utf8');
    log(`\n📝 Rapport écrit dans ${target}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
