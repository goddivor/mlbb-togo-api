/**
 * Import of the legacy MLBB Togo site (issue goddivor/mlbb-togo#153).
 *
 *   npm run import:legacy -- --dump ../tools/mlbb-import/dump [--report r.md] [--dry-run]
 *
 * The dump is a read-only JSON export of their Supabase tables; this script
 * never calls their API. Every mapping decision lives in
 * `src/esport/legacy-import.logic.ts` (pure, unit tested) — here we only read
 * the files, talk to Prisma and print the report.
 *
 * The import is idempotent: a re-run resolves what it wrote through the
 * registry alone, whatever a member or an admin has done to those rows since
 * (rename, Google adoption, game-account link, retyped note).
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
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
import { resetLegacyCache } from '../src/esport/legacy-import.guard';
import {
  LEGACY_LOCK_KEY,
  LEGACY_REGISTRY_BACKUP_KEY,
  LEGACY_REGISTRY_KEY,
  LOCK_TTL_MS,
  LegacyRegistry,
  RegistryMap,
  emptyRegistry,
  mergeRegistry,
  foreignMappings,
  REGISTRY_MAPS,
  parseRegistry,
  registrySize,
  serializeRegistry,
} from '../src/esport/legacy-import.registry';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------



type Options = {
  dump: string;
  dryRun: boolean;
  report: string | null;
  allowMissingRegistry: boolean;
  forceUnlock: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dump: path.resolve(__dirname, '../../tools/mlbb-import/dump'),
    dryRun: false,
    report: null,
    allowMissingRegistry: false,
    forceUnlock: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dump') opts.dump = path.resolve(argv[++i] ?? '');
    else if (arg === '--report') opts.report = path.resolve(argv[++i] ?? '');
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-missing-registry') opts.allowMissingRegistry = true;
    else if (arg === '--force-unlock') opts.forceUnlock = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run import:legacy -- [--dump <dir>] [--report <file.md>] [--dry-run]\n' +
          '                               [--allow-missing-registry] [--force-unlock]',
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

/** Table-cell safe text. */
const cell = (v: string | null | undefined): string =>
  String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim() || '(sans libellé)';

const norm = (v: string | null | undefined): string =>
  String(v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

class Report {
  readonly duplicates: {
    entity: string;
    created: { label: string; id: string };
    existing: { label: string; id: string };
    reason: string;
  }[] = [];
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
  readonly created: { entity: string; legacyId: string | number; id: string; label: string }[] = [];
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
    lines.push(
      '- Portée : l’import ne crée que des lignes neuves et ne modifie (ou ne supprime) que celles dont ' +
        'il a lui-même l’identifiant dans son registre. Aucune ligne créée par l’équipe n’est touchée.',
    );
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
    lines.push('## Lignes créées');
    lines.push('');
    lines.push(
      'L’import ne reconnaît une ligne qu’à travers son registre : il ne rapproche jamais par nom, logo, ' +
        'titre ni adresse, et il ne modifie que les lignes qu’il a lui-même créées. Une ligne historique ' +
        'absente du registre produit donc une NOUVELLE ligne, listée ici. À la première exécution, tout y figure.',
    );
    lines.push('');
    if (!this.created.length) lines.push('Aucune : tout a été résolu par le registre.');
    else {
      const byEntity = new Map<string, number>();
      for (const c of this.created) byEntity.set(c.entity, (byEntity.get(c.entity) ?? 0) + 1);
      lines.push('| Entité | Lignes créées |');
      lines.push('| --- | ---: |');
      for (const [entity, n] of byEntity) lines.push(`| ${entity} | ${n} |`);
      lines.push('');
      lines.push('Liste complète, pour pouvoir fusionner les doublons à la main :');
      lines.push('');
      lines.push('| Entité | Libellé | Id historique | Id interne |');
      lines.push('| --- | --- | --- | --- |');
      for (const c of this.created)
        lines.push(`| ${c.entity} | ${cell(c.label)} | ${c.legacyId} | \`${c.id}\` |`);
    }
    lines.push('');
    lines.push('## Doublons probables');
    lines.push('');
    lines.push(
      'Lignes créées par l’import qui ressemblent (même nom ou même logo) à une ligne qui existait déjà et que ' +
        'l’import n’a pas créée. Il ne les rapproche jamais tout seul : à fusionner ou supprimer à la main.',
    );
    lines.push('');
    if (!this.duplicates.length) lines.push('Aucun.');
    else {
      lines.push('| Entité | Ligne créée | Id | Ligne existante | Id | Critère |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const d of this.duplicates)
        lines.push(
          `| ${d.entity} | ${cell(d.created.label)} | \`${d.created.id}\` | ${cell(d.existing.label)} | \`${d.existing.id}\` | ${d.reason} |`,
        );
    }
    lines.push('');
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
  const runStartedAt = Date.now();
  /** Readable names of the rows the run touches, for the report labels. */
  const names = new Map<string, string>();
  const log = (s: string) => console.log(s);

  // ---- Registry (legacy id -> our id) ------------------------------------
  const registryRow = await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
  const previous: LegacyRegistry = parseRegistry(registryRow?.value);
  const foreign = foreignMappings(previous);
  if (foreign.length) {
    console.error(
      [
        `✗ Le registre \`${LEGACY_REGISTRY_KEY}\` pointe sur ${foreign.length} ligne(s) plus anciennes que l’import lui-même :`,
        ...foreign.slice(0, 10).map((f) => `    ${f}`),
        '  Ce ne sont pas des lignes créées par l’import (registre édité à la main ou copié d’une autre base).',
        '  Rien n’a été écrit. Corrigez ou supprimez ces entrées du registre avant de relancer.',
      ].join('\n'),
    );
    process.exit(1);
  }
  const importedUsers = await prisma.user.findMany({
    where: { provider: 'imported', isSystemAccount: false },
    select: { id: true, email: true, googleId: true, username: true },
  });
  const importedProfiles = importedUsers.length;
  const registeredPlayerIds = new Set(Object.values(previous.players));
  const mappedProfiles = registeredPlayerIds.size;
  const claimedByOwner = (u: { email: string; googleId?: string | null }) =>
    !!u.googleId || !u.email.toLowerCase().endsWith(IMPORTED_EMAIL_DOMAIN);

  /**
   * Two kinds of imported profile are missing from the registry:
   *  - one nobody has claimed yet (placeholder mailbox, no Google): the import
   *    created it and was killed before writing the mapping. It is recovered on
   *    the next run by its placeholder mailbox, which is derived from the slug
   *    and cannot be rewritten while the profile is unclaimed;
   *  - one an owner has adopted (Gmail address or Google id, possibly renamed):
   *    nothing identifies it any more. Continuing would create a duplicate of
   *    it and leave the member's history on the old account, so the run stops
   *    unless the operator forces it.
   */
  const unregistered = importedUsers.filter((u) => !registeredPlayerIds.has(u.id));
  const unrecoverable = unregistered.filter((u) => claimedByOwner(u));
  const recoverable = unregistered.length - unrecoverable.length;
  // An empty registry next to imported profiles is a lost registry, not an
  // interrupted run: seasons and teams are registered before the first profile
  // is created, so a killed run always leaves a registry behind.
  const registryLost = registrySize(previous) === 0 && importedProfiles > 0;
  if ((unrecoverable.length || registryLost) && !opts.allowMissingRegistry) {
    console.error(
      [
        registryLost
          ? `✗ ${importedProfiles} profil(s) importé(s) en base mais le registre \`${LEGACY_REGISTRY_KEY}\` est vide (absent ou illisible).`
          : `✗ ${unrecoverable.length} profil(s) importé(s) déjà adopté(s) ne figurent pas dans le registre \`${LEGACY_REGISTRY_KEY}\` (tronqué) : ${unrecoverable
              .map((u) => u.username)
              .join(', ')}.`,
        '  Continuer créerait des doublons (équipes, matchs, sponsors…) et laisserait l’historique sur les anciens comptes.',
        '',
        `  • Restaurez le registre depuis \`${LEGACY_REGISTRY_BACKUP_KEY}\` s’il existe,`,
        '  • ou relancez avec --allow-missing-registry : les profils non réclamés (adresse',
        '    @imported.mlbbtogo.local) sont retrouvés par leur adresse ; tout le reste (profils adoptés,',
        '    équipes, matchs, sponsors, publications) sera recréé en doublon.',
        '',
        '  Un import simplement interrompu (kill, coupure) ne déclenche pas ce message : les profils créés',
        '  mais pas encore inscrits au registre sont retrouvés tout seuls.',
      ].join('\n'),
    );
    process.exit(1);
  }
  if (unrecoverable.length) {
    report.note(
      `⚠️ ${unrecoverable.length} profil(s) importé(s) adopté(s) absents du registre : exécution forcée par ` +
        '`--allow-missing-registry`, des doublons sont possibles.',
    );
  }
  if (recoverable) {
    report.note(
      `${recoverable} profil(s) importé(s) non réclamés absents du registre (import interrompu ou registre perdu) : ` +
        'retrouvés par leur adresse de substitution et réinscrits dans le registre, sans doublon.',
    );
  }

  // A second run started while the first is still writing would fight over the
  // same registry. One lock row, released at the end, stale after 15 minutes.
  if (!dry) {
    // Taken atomically: `create` on the unique `key` is the only operation two
    // processes cannot both win. A lock older than 15 minutes is stale (the
    // holder died) and is cleared first; `--force-unlock` clears it whatever
    // its age.
    const existingLock = await prisma.appSetting.findUnique({ where: { key: LEGACY_LOCK_KEY } });
    if (existingLock) {
      // The value is `<epoch ms>:<host>:<pid>`. On the same host, a holder whose
      // process no longer exists was killed: its lock is stale at once instead
      // of blocking every run for 15 minutes.
      const [sinceRaw, holderHost, holderPidRaw] = existingLock.value.split(':');
      const heldSince = Number(sinceRaw);
      const holderPid = Number(holderPidRaw);
      let holderDead = false;
      if (holderHost === os.hostname() && Number.isInteger(holderPid) && holderPid > 0) {
        try {
          process.kill(holderPid, 0);
        } catch (e: any) {
          holderDead = e?.code === 'ESRCH';
        }
      }
      const stale = holderDead || !Number.isFinite(heldSince) || Date.now() - heldSince >= LOCK_TTL_MS;
      if (!stale && !opts.forceUnlock) {
        console.error(
          `✗ Un import est déjà en cours depuis ${new Date(heldSince).toISOString()} ` +
            `(verrou \`${LEGACY_LOCK_KEY}\`). Réessayez plus tard, ou relancez avec --force-unlock si le processus est mort.`,
        );
        process.exit(1);
      }
      await prisma.appSetting.deleteMany({ where: { key: LEGACY_LOCK_KEY } });
    }
    try {
      await prisma.appSetting.create({
        data: { key: LEGACY_LOCK_KEY, value: `${Date.now()}:${os.hostname()}:${process.pid}` },
      });
    } catch {
      console.error(
        `✗ Un autre import vient de prendre le verrou \`${LEGACY_LOCK_KEY}\`. Réessayez plus tard.`,
      );
      process.exit(1);
    }
  }

  // The new registry starts from the previous one: a run that stops halfway
  // must never make the mappings it had already recorded disappear.
  const registry: LegacyRegistry = mergeRegistry(emptyRegistry(), previous);
  /**
   * Persist the registry. Called after every single row the import creates:
   * 51 profiles and 74 matches are nothing to write. A process killed between
   * a row's creation and its mapping still leaves that one row unregistered:
   * profiles are recovered on the next run by their placeholder mailbox, and
   * the other entities by the checks of their own section.
   */
  const saveRegistry = async () => {
    if (dry) return;
    // Fingerprint: stamped once, before the first row of the first run exists.
    registry.firstRunAt = registry.firstRunAt ?? runStartedAt;
    const value = serializeRegistry(registry);
    await prisma.appSetting.upsert({
      where: { key: LEGACY_REGISTRY_KEY },
      create: { key: LEGACY_REGISTRY_KEY, value },
      update: { value },
    });
  };
  const remember = async (map: RegistryMap, legacyId: string | number, id: string) => {
    if (registry[map][String(legacyId)] === id) return;
    registry[map][String(legacyId)] = id;
    await saveRegistry();
  };
  // Copy the version we start from under a backup key, but only when it parses:
  // a corrupt value must never overwrite a good backup.
  const registryLooksComplete = unregistered.length === 0;
  if (!dry && registryRow?.value && registrySize(previous) > 0 && registryLooksComplete) {
    await prisma.appSetting.upsert({
      where: { key: LEGACY_REGISTRY_BACKUP_KEY },
      create: { key: LEGACY_REGISTRY_BACKUP_KEY, value: registryRow.value },
      update: { value: registryRow.value },
    });
  }
  report.note(
    registrySize(previous)
      ? `Registre d’import précédent : ${registrySize(previous)} correspondances, écrit le ${previous.updatedAt ?? 'inconnu'}, sauvegardé sous \`${LEGACY_REGISTRY_BACKUP_KEY}\` avant d’être complété.`
      : 'Aucun registre d’import précédent : première exécution, toutes les lignes sont créées.',
  );

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
  // `slug` is unique (partial index): a season the team already created may
  // hold the one we would use. We suffix ours rather than touch theirs.
  const takenSlugs = new Set(
    (await prisma.esportSeason.findMany({ select: { id: true, slug: true } }))
      .filter((r) => r.slug)
      .map((r) => r.slug as string),
  );
  for (const s of seasons) {
    const mapped = previous.seasons[String(s.sourceId)];
    const existing = mapped ? await prisma.esportSeason.findUnique({ where: { id: mapped } }) : null;
    let slug = s.slug;
    if (!existing) {
      let i = 2;
      while (takenSlugs.has(slug)) slug = `${s.slug}-${i++}`;
      takenSlugs.add(slug);
      if (slug !== s.slug)
        report.note(
          `Slug « ${s.slug} » déjà pris par une saison existante : la saison importée « ${s.name} » reçoit « ${slug} ».`,
        );
    } else {
      slug = existing.slug ?? s.slug;
    }
    const data = {
      name: s.name,
      slug,
      number: s.number,
      // Always imported closed and inactive, whatever the source said. Two live
      // seasons would lock the admin out: `POST /esport/seasons`,
      // `/seasons/:id/playoffs` and `/seasons/:id/activate` all refuse a second
      // one, and `current()` would become order-dependent. The owner activates
      // the season he wants from the admin.
      status: 'closed',
      isActive: false,
    };
    if (!existing) {
      const created = dry ? { id: fakeId(`season-${s.sourceId}`) } : await prisma.esportSeason.create({ data });
      seasonIdBySource.set(s.sourceId, created.id);
      names.set(created.id, s.name);
      report.created.push({ entity: 'EsportSeason', legacyId: s.sourceId, id: created.id, label: s.name });
      await remember('seasons', s.sourceId, created.id);
      report.bump('EsportSeason', 'created');
    } else {
      seasonIdBySource.set(s.sourceId, existing.id);
      await remember('seasons', s.sourceId, existing.id);
      // Status and activity are written at creation only: the owner may have
      // activated this season since, and a re-run must not close it again.
      const { status: _status, isActive: _isActive, ...managed } = data;
      const patch = diff(existing, managed);
      if (patch && !dry) await prisma.esportSeason.update({ where: { id: existing.id }, data: patch });
      report.bump('EsportSeason', patch ? 'updated' : 'unchanged');
    }
  }

  // ---- Teams -------------------------------------------------------------
  const teams = dedupeTeams(teamsSrc);
  const teamIdBySource = new Map<number, string>();
  for (const t of teams) {
    const mapped = t.sourceIds.map((id) => previous.teams[String(id)]).find(Boolean);
    const existing = mapped ? await prisma.esportTeam.findUnique({ where: { id: mapped } }) : null;
    const data = { name: t.name, image: t.image, type: 'esport', esportId: esport?.id ?? null };
    let id: string;
    if (!existing) {
      const created = dry ? { id: fakeId(`team-${t.key}`) } : await prisma.esportTeam.create({ data });
      id = created.id;
      names.set(id, t.name);
      report.created.push({ entity: 'EsportTeam', legacyId: t.sourceIds.join('/'), id, label: t.name });
      report.bump('EsportTeam', 'created');
    } else {
      id = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportTeam.update({ where: { id }, data: patch });
      report.bump('EsportTeam', patch ? 'updated' : 'unchanged');
    }
    for (const src of t.sourceIds) {
      teamIdBySource.set(src, id);
      await remember('teams', src, id);
    }
  }

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
   * The profile of a legacy player: the registry, and nothing else. No lookup
   * by mailbox, pseudo or username: every one of them is rewritten by a normal
   * flow (Google adoption, game-account link, rename), and matching on them is
   * exactly how a member's history ended up on somebody else's account.
   */
  const findProfile = (person: ImportedPerson) => {
    for (const legacyId of person.sourceIds) {
      const mapped = previous.players[String(legacyId)];
      const user = mapped ? byId.get(mapped) : undefined;
      if (user) return { user };
    }
    return null;
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

  const recoveredIds = new Set<string>();
  const userIdByPerson = new Map<string, string>();
  const adopted: string[] = [];
  for (const person of people) {
    const a = assignments.get(person.key)!;
    if (person.variants.length > 1) {
      report.merges.push({ key: person.key, variants: person.variants, username: a.username });
    }
    let found = findProfile(person);
    if (!found) {
      // A profile the import created before being killed, never registered.
      const orphan = existingUsers.find(
        (u) =>
          u.provider === 'imported' &&
          !isAdopted(u) &&
          !registeredPlayerIds.has(u.id) &&
          !recoveredIds.has(u.id) &&
          u.email.toLowerCase() === a.email.toLowerCase(),
      );
      if (orphan) {
        recoveredIds.add(orphan.id);
        found = { user: orphan };
      }
    }
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
      names.set(created.id, a.username);
      report.created.push({
        entity: 'User',
        legacyId: person.sourceIds.join('/'),
        id: created.id,
        label: `${a.username} (${person.displayName})`,
      });
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
      await remember('players', legacyId, userIdByPerson.get(person.key)!);
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

  // ---- Current rosters (season 3) + archived rosters ---------------------
  const lastSeason = seasons[seasons.length - 1];
  const rosterBySeason = new Map<
    number,
    { teamId: string; userId: string; role: string | null; sourceTeamId: number; sourcePlayerId: number }[]
  >();
  for (const row of playersSrc) {
    if (!row.team_id) continue;
    const team = teamsSrc.find((t) => t.id === row.team_id);
    const teamId = teamIdBySource.get(row.team_id);
    const userId = userIdOf(row.id);
    if (!team || !teamId || !userId) continue;
    const list = rosterBySeason.get(team.season_id) ?? [];
    if (!list.some((m) => m.teamId === teamId && m.userId === userId)) {
      list.push({ teamId, userId, role: laneOf(row.role), sourceTeamId: row.team_id, sourcePlayerId: row.id });
    }
    rosterBySeason.set(team.season_id, list);
  }
  for (const m of rosterBySeason.get(lastSeason.sourceId) ?? []) {
    // Keyed on the registry, like everything else: a roster line an admin
    // added by hand is never rewritten, and the unique (teamId, userId) index
    // is respected by looking the pair up before creating.
    const key = `${m.sourceTeamId}:${m.sourcePlayerId}`;
    const mappedMember = previous.teamMembers[key];
    const own = mappedMember
      ? await prisma.esportTeamMember.findUnique({ where: { id: mappedMember } })
      : null;
    if (own) {
      await remember('teamMembers', key, own.id);
      const patch = diff(own, { role: m.role });
      if (patch && !dry) await prisma.esportTeamMember.update({ where: { id: own.id }, data: patch });
      report.bump('EsportTeamMember', patch ? 'updated' : 'unchanged');
      continue;
    }
    const other = await prisma.esportTeamMember.findFirst({
      where: { teamId: m.teamId, userId: m.userId },
      select: { id: true },
    });
    if (other) {
      // Somebody already put this player in this team: left untouched.
      report.bump('EsportTeamMember', 'unchanged');
      continue;
    }
    const created = dry
      ? { id: fakeId(`member-${key}`) }
      : await prisma.esportTeamMember.create({ data: { teamId: m.teamId, userId: m.userId, role: m.role } });
    await remember('teamMembers', key, created.id);
    report.created.push({
      entity: 'EsportTeamMember',
      legacyId: key,
      id: created.id,
      label: `${names.get(m.userId) ?? m.userId} dans ${names.get(m.teamId) ?? m.teamId}`,
    });
    report.bump('EsportTeamMember', 'created');
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
    const existing = mapped ? await prisma.esportMatch.findUnique({ where: { id: mapped } }) : null;
    let matchId: string;
    if (!existing) {
      const created = dry ? { id: fakeId(`match-${m.id}`) } : await prisma.esportMatch.create({ data });
      matchId = created.id;
      names.set(matchId, `${names.get(teamAId) ?? teamAId} vs ${names.get(teamBId) ?? teamBId}`);
      report.created.push({
        entity: 'EsportMatch',
        legacyId: m.id,
        id: matchId,
        label: `${names.get(matchId)} (${scheduledAt ? scheduledAt.toISOString().slice(0, 10) : 'sans date'})`,
      });
      report.bump('EsportMatch', 'created');
    } else {
      matchId = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportMatch.update({ where: { id: matchId }, data: patch });
      report.bump('EsportMatch', patch ? 'updated' : 'unchanged');
    }
    matchIdBySource.set(m.id, matchId);
    await remember('matches', m.id, matchId);

    // One row per player of the series: hero = his most used one, no KDA.
    const rows = buildMatchPlayers(games as any, laneOfUser);
    const playerKey = (legacyPlayerId: number | string) => `${m.id}:${legacyPlayerId}`;
    const legacyPlayerOf = new Map<string, number>();
    for (const [legacyId, person] of personByPlayerId) {
      const uid = userIdByPerson.get(person.key);
      if (uid && !legacyPlayerOf.has(uid)) legacyPlayerOf.set(uid, legacyId);
    }
    for (const row of rows) {
      const key = playerKey(legacyPlayerOf.get(row.userId) ?? row.userId);
      const mappedRow = previous.matchPlayers[key];
      const own = mappedRow
        ? await prisma.esportMatchPlayer.findUnique({ where: { id: mappedRow } })
        : null;
      const common = {
        hero: row.hero,
        heroId: row.heroId,
        role: row.role,
        teamId: row.teamId,
      };
      if (own) {
        await remember('matchPlayers', key, own.id);
        // `isMvp` is deliberately absent: an admin may have named an MVP on an
        // imported sheet and the import must not undo it.
        const patch = diff(own, common);
        if (patch && !dry) await prisma.esportMatchPlayer.update({ where: { id: own.id }, data: patch });
        report.bump('EsportMatchPlayer', patch ? 'updated' : 'unchanged');
        continue;
      }
      const other = await prisma.esportMatchPlayer.findFirst({
        where: { matchId, userId: row.userId },
        select: { id: true },
      });
      if (other) {
        // The unique (matchId, userId) row already exists and is not ours.
        report.bump('EsportMatchPlayer', 'unchanged');
        continue;
      }
      const created = dry
        ? { id: fakeId(`matchplayer-${key}`) }
        : await prisma.esportMatchPlayer.create({
            data: { matchId, userId: row.userId, ...common, isMvp: false },
          });
      await remember('matchPlayers', key, created.id);
      report.created.push({
        entity: 'EsportMatchPlayer',
        legacyId: key,
        id: created.id,
        label: `${names.get(row.userId) ?? row.userId} (${row.hero ?? 'sans héros'}) dans ${names.get(matchId) ?? matchId}`,
      });
      report.bump('EsportMatchPlayer', 'created');
    }
    // Rows this import created for a game that has since been dropped upstream
    // are the ONLY ones it may remove: never a player an admin added.
    const keep = new Set(rows.map((row) => playerKey(legacyPlayerOf.get(row.userId) ?? row.userId)));
    const ours = Object.entries(registry.matchPlayers).filter(([k]) => k.startsWith(`${m.id}:`));
    const stale = ours.filter(([k]) => !keep.has(k));
    if (stale.length) {
      if (!dry)
        await prisma.esportMatchPlayer.deleteMany({ where: { id: { in: stale.map(([, id]) => id) } } });
      for (const [k] of stale) delete registry.matchPlayers[k];
      await saveRegistry();
      report.bump('EsportMatchPlayer', 'deleted', stale.length);
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

  // ---- Awards ------------------------------------------------------------
  for (const a of [...awardsSrc].sort((x, y) => x.id - y.id)) {
    const seasonId = seasonIdBySource.get(a.season_id);
    if (!seasonId) continue;
    const category = awardCategoryOf(a.title);
    const title = category === 'custom' ? (a.custom_label || a.title || '').trim() || null : null;
    const userId = a.player_id ? userIdOf(a.player_id) : null;
    const teamId = a.team_id ? teamIdBySource.get(a.team_id) ?? null : null;
    const data = { seasonId, category, title, userId, teamId, description: a.description?.trim() || null };
    const mappedAward = previous.awards[String(a.id)];
    const existing = mappedAward
      ? await prisma.seasonAward.findUnique({ where: { id: mappedAward } })
      : null;
    if (!existing) {
      const created = dry ? { id: fakeId(`award-${a.id}`) } : await prisma.seasonAward.create({ data });
      await remember('awards', a.id, created.id);
      report.created.push({
        entity: 'SeasonAward',
        legacyId: a.id,
        id: created.id,
        label: `${title ?? category}${userId ? ` : ${names.get(userId) ?? userId}` : ''}`,
      });
      report.bump('SeasonAward', 'created');
    } else {
      await remember('awards', a.id, existing.id);
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.seasonAward.update({ where: { id: existing.id }, data: patch });
      report.bump('SeasonAward', patch ? 'updated' : 'unchanged');
    }
  }

  // ---- Sponsors ----------------------------------------------------------
  // Resolved through the registry only. A sponsor the team already created,
  // even with the same logo, is a different row and is left alone; the report
  // lists the duplicate so it can be merged by hand. `isActive` and `tier` are
  // only written at creation: hiding a partner or giving him a tier is the
  // team's decision and survives every re-run.
  const allSponsors = await prisma.sponsor.findMany();
  for (const s of [...sponsorsSrc].sort((a, b) => a.id - b.id)) {
    const seasonId = seasonIdBySource.get(s.season_id);
    const logo = String(s.logo_url ?? '').trim();
    const name = s.name?.trim() || null;
    const mapped = previous.sponsors[String(s.id)];
    const existing = mapped ? allSponsors.find((row) => row.id === mapped) : undefined;
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
      report.created.push({ entity: 'Sponsor', legacyId: s.id, id: sponsorId, label: name ?? logo });
      report.bump('Sponsor', 'created');
    } else {
      sponsorId = existing.id;
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.sponsor.update({ where: { id: sponsorId }, data: patch });
      report.bump('Sponsor', patch ? 'updated' : 'unchanged');
    }
    await remember('sponsors', s.id, sponsorId);
  }
  report.note(
    'Champs de `Sponsor` que l’import écrit à chaque exécution : `name`, `logo`, `url`, `description`, ' +
      '`sort` et `seasonIds` (nos saisons ajoutées aux existantes). Il ne touche jamais `isActive` ni ' +
      '`tier` : masquer un partenaire ou lui donner un palier reste une décision de l’équipe.',
  );

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
      const existing = mappedEvent ? await prisma.event.findUnique({ where: { id: mappedEvent } }) : null;
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
        await remember('events', c.id, created.id);
        report.created.push({ entity: 'Event', legacyId: c.id, id: created.id, label: title });
        report.bump('Event', 'created');
      } else {
        await remember('events', c.id, existing.id);
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
    const existing = mappedPost ? await prisma.post.findUnique({ where: { id: mappedPost } }) : null;
    if (!existing) {
      const created = dry ? { id: fakeId(`post-${c.id}`) } : await prisma.post.create({ data });
      await remember('posts', c.id, created.id);
      report.created.push({ entity: 'Post', legacyId: c.id, id: created.id, label: title });
      report.bump('Post', 'created');
    } else {
      await remember('posts', c.id, existing.id);
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.post.update({ where: { id: existing.id }, data: patch });
      report.bump('Post', patch ? 'updated' : 'unchanged');
    }
    if (c.kind === 'stream') {
      const videoId = youtubeIdFrom(c.embed_url);
      const seasonId = seasonIdBySource.get(c.season_id);
      if (videoId && seasonId) {
        const mappedVideo = previous.streamVideos[String(c.id)];
        const existingVideo = mappedVideo
          ? await prisma.streamSeasonVideo.findUnique({ where: { id: mappedVideo } })
          : null;
        const videoData = { seasonId, videoId, title, date: (c.event_date || '').trim() };
        if (!existingVideo) {
          let createdId: string | null = null;
          try {
            createdId = dry
              ? fakeId(`video-${c.id}`)
              : (await prisma.streamSeasonVideo.create({ data: videoData })).id;
          } catch (e: any) {
            // `@@unique([seasonId, videoId])`: somebody already listed this
            // video in this season. It is not ours and stays untouched.
            if (e?.code !== 'P2002') throw e;
          }
          if (createdId) {
            await remember('streamVideos', c.id, createdId);
            report.created.push({ entity: 'StreamSeasonVideo', legacyId: c.id, id: createdId, label: `${title} (${videoId})` });
            report.bump('StreamSeasonVideo', 'created');
          } else {
            report.skip(
              'communications (stream)',
              1,
              `la vidéo ${videoId} est déjà listée sur cette saison (ajoutée à la main ou en double dans le dump)`,
            );
          }
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
  report.note(
    'Portée du script : il n’insère que des lignes neuves et ne modifie ou ne supprime que celles dont il ' +
      'a l’identifiant dans son registre (la seule suppression possible est une ligne `EsportMatchPlayer` qu’il a ' +
      'lui-même créée pour une game disparue en amont). Le ménage des données de démonstration (les cinq équipes ETERNUM ' +
      'du seed, une éventuelle saison de test) est à faire à la main par le release manager, en regardant ' +
      'les données : certaines portent déjà des campagnes de recrutement, des membres ou des matchs.',
  );
  report.note(
    'Les saisons sont importées **fermées et inactives**, quelle que soit leur valeur en amont : deux saisons ' +
      'actives bloqueraient l’administration (création, passage en playoffs et activation refusent une seconde ' +
      'saison en cours). L’équipe active ensuite la saison de son choix depuis l’administration.',
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
  const recomputed = Array.from(userIdByPerson.values());
  if (!dry) {
    const { PlayerStatsService } = await import('../src/stats/player-stats.service');
    await new PlayerStatsService(prisma as any).recomputeUsers(recomputed);
  }
  report.note(
    `Compteurs (victoires, défaites, série, badges) ${dry ? 'à recalculer' : 'recalculés'} pour ${recomputed.length} profils.`,
  );

  // ---- Registry ----------------------------------------------------------
  // Already saved after every created row; this is the final flush.
  await saveRegistry();
  const existingBackup = dry
    ? null
    : await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_BACKUP_KEY } });
  if (!dry && !registrySize(previous) && !existingBackup) {
    // First run: seed the backup so the registry can be restored if it is ever
    // deleted, which is the one loss the import cannot recover from. Never
    // replaces a backup that already exists (a forced run after the registry
    // was lost must not overwrite the good copy).
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

  // ---- Probable duplicates (report only, nothing is written) --------------
  {
    const ours = new Set<string>();
    for (const map of REGISTRY_MAPS) for (const id of Object.values(registry[map])) ours.add(id);
    type Row = { id: string; label: string; keys: Record<string, string> };
    const sources: Record<string, Row[]> = {
      EsportSeason: (await prisma.esportSeason.findMany({ select: { id: true, name: true, slug: true } })).map(
        (r) => ({ id: r.id, label: r.name, keys: { nom: norm(r.name), slug: norm(r.slug) } }),
      ),
      EsportTeam: (await prisma.esportTeam.findMany({ select: { id: true, name: true, image: true } })).map(
        (r) => ({ id: r.id, label: r.name, keys: { nom: norm(r.name), logo: r.image ?? '' } }),
      ),
      Sponsor: (await prisma.sponsor.findMany({ select: { id: true, name: true, logo: true } })).map((r) => ({
        id: r.id,
        label: r.name ?? r.logo,
        keys: { nom: norm(r.name), logo: r.logo ?? '' },
      })),
      Event: (await prisma.event.findMany({ select: { id: true, title: true } })).map((r) => ({
        id: r.id,
        label: r.title,
        keys: { titre: norm(r.title) },
      })),
      Post: (await prisma.post.findMany({ select: { id: true, title: true } })).map((r) => ({
        id: r.id,
        label: r.title,
        keys: { titre: norm(r.title) },
      })),
      User: (await prisma.user.findMany({ select: { id: true, username: true, gameNickname: true } })).map(
        (r) => ({
          id: r.id,
          label: `${r.username}${r.gameNickname ? ` (${r.gameNickname})` : ''}`,
          keys: { pseudo: norm(r.gameNickname), 'nom d’utilisateur': norm(r.username) },
        }),
      ),
    };
    // Every row the registry owns, not only those created by this very run: a
    // resumed run must still report what the interrupted one created.
    const registryOf: Record<string, Record<string, string>> = {
      EsportSeason: registry.seasons,
      EsportTeam: registry.teams,
      Sponsor: registry.sponsors,
      Event: registry.events,
      Post: registry.posts,
      User: registry.players,
    };
    const candidates: { entity: string; id: string; label: string }[] = [];
    for (const [entity, map] of Object.entries(registryOf)) {
      const rows = sources[entity];
      for (const id of new Set(Object.values(map))) {
        const row = rows.find((r) => r.id === id);
        if (row) candidates.push({ entity, id, label: row.label });
      }
    }
    // A dry run has no row yet: only the report knows them.
    for (const c of report.created) {
      if (sources[c.entity] && !candidates.some((k) => k.id === c.id)) {
        candidates.push({ entity: c.entity, id: c.id, label: c.label });
      }
    }
    for (const c of candidates) {
      const rows = sources[c.entity];
      const mine: Row = rows.find((r) => r.id === c.id) ?? {
        id: c.id,
        label: c.label,
        keys: Object.fromEntries(
          Object.keys(rows[0]?.keys ?? {})
            .filter((k) => k !== 'logo' && k !== 'slug')
            .map((k) => [k, norm(c.label)]),
        ),
      };
      for (const other of rows) {
        if (other.id === c.id || ours.has(other.id)) continue;
        const hit = Object.keys(mine.keys).find((k) => mine.keys[k] && mine.keys[k] === other.keys[k]);
        if (hit)
          report.duplicates.push({
            entity: c.entity,
            created: { label: mine.label, id: c.id },
            existing: { label: other.label, id: other.id },
            reason: hit,
          });
      }
    }
  }

  // ---- Release the lock --------------------------------------------------
  if (!dry) await prisma.appSetting.deleteMany({ where: { key: LEGACY_LOCK_KEY } });

  // ---- Report ------------------------------------------------------------
  const md = report.render(opts);
  log('\n' + md);
  // Only ever written where the operator asked for it: a test run must not
  // silently overwrite the report the owner is reviewing.
  if (opts.report) {
    fs.writeFileSync(opts.report, md, 'utf8');
    log(`\n📝 Rapport écrit dans ${opts.report}`);
  } else {
    log('\nℹ️  Aucun fichier écrit : passez --report <fichier.md> pour enregistrer ce rapport.');
  }
}

main()
  .catch(async (e) => {
    console.error(e);
    // Never leave the lock behind on a crash.
    await prisma.appSetting.deleteMany({ where: { key: LEGACY_LOCK_KEY } }).catch(() => null);
    process.exit(1);
  })
  .finally(() => {
    // The guard caches the registry per process; forget it so nothing in this
    // process (and any test importing the script) serves a pre-import answer.
    resetLegacyCache();
    return prisma.$disconnect();
  });
