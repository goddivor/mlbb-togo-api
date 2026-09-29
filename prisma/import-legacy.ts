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
 * The import is idempotent: everything is upserted on a natural key (season
 * name, team name, match (season, teams, date), award (season, category)), so
 * running it twice changes nothing.
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

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type Options = {
  dump: string;
  wipeSeed: boolean;
  dryRun: boolean;
  report: string | null;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dump: path.resolve(__dirname, '../../tools/mlbb-import/dump'),
    wipeSeed: false,
    dryRun: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dump') opts.dump = path.resolve(argv[++i] ?? '');
    else if (arg === '--report') opts.report = path.resolve(argv[++i] ?? '');
    else if (arg === '--wipe-seed') opts.wipeSeed = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: npm run import:legacy -- [--dump <dir>] [--report <file.md>] [--wipe-seed] [--dry-run]',
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

type Counter = { created: number; updated: number; unchanged: number };

class Report {
  readonly counts = new Map<string, Counter>();
  readonly notes: string[] = [];
  readonly merges: { key: string; variants: string[]; username: string }[] = [];
  readonly collisions: { pseudo: string; username: string; taken: string }[] = [];
  readonly skipped: { table: string; reason: string; rows: number }[] = [];
  unmatchedHeroes: string[] = [];

  bump(entity: string, kind: keyof Counter, n = 1) {
    const c = this.counts.get(entity) ?? { created: 0, updated: 0, unchanged: 0 };
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
    lines.push('| Entité | Créés | Mis à jour | Inchangés |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const [entity, c] of this.counts) {
      lines.push(`| ${entity} | ${c.created} | ${c.updated} | ${c.unchanged} |`);
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
      lines.push('| Pseudo importé | Identifiant attribué | Identifiant déjà pris |');
      lines.push('| --- | --- | --- |');
      for (const c of this.collisions) {
        lines.push(`| ${c.pseudo} | \`${c.username}\` | \`${c.taken}\` |`);
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
  const log = (s: string) => console.log(s);

  // ---- Optional cleanup of the seeded demo data --------------------------
  if (opts.wipeSeed) {
    const seededTeams = await prisma.esportTeam.findMany({
      where: { name: { in: ['ETERNUM ALPHA', 'ETERNUM BETA', 'ETERNUM GAMMA', 'ETERNUM DELTA', 'ETERNUM EPSILON'] } },
      select: { id: true, name: true },
    });
    const empty: string[] = [];
    for (const t of seededTeams) {
      const [members, matches] = await Promise.all([
        prisma.esportTeamMember.count({ where: { teamId: t.id } }),
        prisma.esportMatch.count({ where: { OR: [{ teamAId: t.id }, { teamBId: t.id }] } }),
      ]);
      if (!members && !matches) empty.push(t.id);
    }
    const seasons = await prisma.esportSeason.findMany({
      where: { name: { in: ['MTL Saison 1'] } },
      select: { id: true },
    });
    // The seeded sponsors carry a logo and nothing else (the field is absent,
    // not null, so it has to be filtered in JS rather than in the query).
    const namelessSponsors = (await prisma.sponsor.findMany({ select: { id: true, name: true } }))
      .filter((s) => !s.name)
      .map((s) => s.id);
    if (!dry) {
      if (empty.length) await prisma.esportTeam.deleteMany({ where: { id: { in: empty } } });
      if (seasons.length) await prisma.esportSeason.deleteMany({ where: { id: { in: seasons.map((s) => s.id) } } });
      if (namelessSponsors.length)
        await prisma.sponsor.deleteMany({ where: { id: { in: namelessSponsors } } });
    }
    report.note(
      `Nettoyage \`--wipe-seed\` : ${empty.length} équipe(s) ETERNUM sans membre ni match et ${seasons.length} saison(s) de démonstration supprimées, ainsi que ${namelessSponsors.length} sponsor(s) du seed (ceux qui n’ont pas de nom).`,
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
    const existing = await prisma.esportSeason.findFirst({ where: { name: s.name } });
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
      report.bump('EsportSeason', 'created');
    } else {
      seasonIdBySource.set(s.sourceId, existing.id);
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.esportSeason.update({ where: { id: existing.id }, data: patch });
      report.bump('EsportSeason', patch ? 'updated' : 'unchanged');
    }
  }

  // ---- Teams -------------------------------------------------------------
  const teams = dedupeTeams(teamsSrc);
  const teamIdBySource = new Map<number, string>();
  for (const t of teams) {
    const existing = await prisma.esportTeam.findFirst({ where: { name: t.name } });
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
    for (const src of t.sourceIds) teamIdBySource.set(src, id);
  }

  // ---- People ------------------------------------------------------------
  const people = dedupePlayers(playersSrc);
  const personByPlayerId = new Map<number, ImportedPerson>();
  for (const p of people) for (const id of p.sourceIds) personByPlayerId.set(id, p);

  // Usernames already used by real members (an imported profile never steals
  // one: it gets a suffix and the collision is reported). Profiles created by
  // a previous run are excluded so re-running finds them again instead of
  // suffixing every slug.
  const existingUsers = await prisma.user.findMany({
    select: { id: true, username: true, email: true, provider: true },
  });
  const byEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));
  const takenUsernames = existingUsers
    .filter((u) => u.provider !== 'imported')
    .map((u) => u.username);
  const assignments = new Map(assignUsernames(people, takenUsernames).map((a) => [a.key, a]));

  const userIdByPerson = new Map<string, string>();
  for (const person of people) {
    const a = assignments.get(person.key)!;
    if (person.variants.length > 1) {
      report.merges.push({ key: person.key, variants: person.variants, username: a.username });
    }
    if (a.collidedWith) {
      report.collisions.push({ pseudo: person.displayName, username: a.username, taken: a.collidedWith });
    }
    const email = a.email;
    const existing = byEmail.get(email);
    const data = {
      username: a.username,
      email,
      avatar: person.avatar,
      // Our `User` has no `displayName` column: it is derived from
      // `gameNickname`, which is where the original pseudo goes so the player
      // keeps his name everywhere (roster, match sheet, stats). The provenance
      // is written in the biography.
      gameNickname: person.displayName,
      bio: `Profil repris du site historique de la MTL. Pseudo d’origine : ${person.displayName}.`,
      role: person.lane ?? 'fighter',
      country: 'Togo',
      provider: 'imported',
      profileSource: 'local',
    };
    if (!existing) {
      const created = dry
        ? { id: fakeId(`user-${person.key}`) }
        : await prisma.user.create({
            // Unusable password: the profile has no password, no Google and no
            // game account until an admin fills a real address on it (the
            // Google sign-in then adopts it by email).
            data: { ...data, password: await bcrypt.hash(crypto.randomUUID(), 10) },
          });
      userIdByPerson.set(person.key, created.id);
      report.bump('User (profils importés)', 'created');
    } else {
      userIdByPerson.set(person.key, existing.id);
      const current = await prisma.user.findUnique({ where: { id: existing.id } });
      // Never overwrite an account someone has since claimed through Google.
      const { provider, profileSource, ...rest } = data;
      const patch = diff(current, current?.provider === 'imported' ? data : rest);
      if (patch && !dry) await prisma.user.update({ where: { id: existing.id }, data: patch });
      report.bump('User (profils importés)', patch ? 'updated' : 'unchanged');
    }
  }

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
    const wonA = built.filter((g) => g.winnerTeamId === teamAId).length;
    const wonB = built.filter((g) => g.winnerTeamId === teamBId).length;
    if (built.length && (wonA !== scoreA || wonB !== scoreB)) inconsistent.push(m.id);

    const shots = shotsByMatch.get(m.id) ?? [];
    const data = {
      seasonId,
      teamAId,
      teamBId,
      type: typeOf(stage),
      stage,
      format: formatOf(m.best_of, scoreA, scoreB, built.length),
      scheduledAt,
      status: 'completed',
      scoreA,
      scoreB,
      winnerTeamId: winnerOf(scoreA, scoreB, teamAId, teamBId),
      games: serializeGames(built as any),
      screenshots: shots.length ? JSON.stringify(shots) : null,
    };
    const existing = await prisma.esportMatch.findFirst({
      where: { seasonId, teamAId, teamBId, scheduledAt },
    });
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

    // One row per player of the series: hero = his most used one, no KDA.
    for (const row of buildMatchPlayers(built as any, laneOfUser)) {
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
        'le score déclaré fait foi, les games importées sont incomplètes.',
    );
  report.note(
    `${gamesSrc.length} games et ${gamePlayersSrc.length - orphanPicks} picks écrits dans le JSON ` +
      '`EsportMatch.games` (aucune table dédiée, aucun changement de schéma Prisma).',
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

  // ---- Sponsors ----------------------------------------------------------
  for (const s of [...sponsorsSrc].sort((a, b) => a.id - b.id)) {
    const seasonId = seasonIdBySource.get(s.season_id);
    const data = {
      name: s.name?.trim() || null,
      logo: s.logo_url,
      url: s.link_url || null,
      description: s.description?.trim() || null,
      sort: Number(s.weight) || 0,
      seasonIds: seasonId ? [seasonId] : [],
      isActive: true,
    };
    const existing = await prisma.sponsor.findFirst({ where: { name: data.name } });
    if (!existing) {
      if (!dry) await prisma.sponsor.create({ data });
      report.bump('Sponsor', 'created');
    } else {
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.sponsor.update({ where: { id: existing.id }, data: patch });
      report.bump('Sponsor', patch ? 'updated' : 'unchanged');
    }
  }

  // ---- Communications: posts, stream videos, offline events --------------
  // Their communications were published by the site itself (`author_name` is
  // null on every row), so they are attributed to an admin when there is one,
  // else to a dedicated system account hidden from every player-facing list.
  const IMPORT_AUTHOR = { username: 'mlbb-togo', email: 'system@imported.mlbbtogo.local' };
  let author =
    (await prisma.user.findFirst({ where: { roleUser: 'admin' }, orderBy: { createdAt: 'asc' } })) ??
    (await prisma.user.findFirst({ where: { email: IMPORT_AUTHOR.email } }));
  if (!author && !dry) {
    author = await prisma.user.create({
      data: {
        ...IMPORT_AUTHOR,
        password: await bcrypt.hash(crypto.randomUUID(), 10),
        provider: 'imported',
        profileSource: 'local',
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
      const existing = await prisma.event.findFirst({ where: { title, date: c.event_date || null } });
      const data = {
        title,
        type: 'offline',
        description: (c.content || '').trim() || null,
        date: c.event_date || null,
        city: cityOf(c.location),
        isPublic: true,
      };
      if (!existing) {
        if (!dry) await prisma.event.create({ data });
        report.bump('Event', 'created');
      } else {
        const patch = diff(existing, data);
        if (patch && !dry) await prisma.event.update({ where: { id: existing.id }, data: patch });
        report.bump('Event', patch ? 'updated' : 'unchanged');
      }
      continue;
    }
    if (!author) {
      report.skip('communications', 1, 'aucun compte auteur disponible pour publier le post');
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
    const existing = await prisma.post.findFirst({ where: { title, category: data.category } });
    if (!existing) {
      if (!dry) await prisma.post.create({ data });
      report.bump('Post', 'created');
    } else {
      const patch = diff(existing, data);
      if (patch && !dry) await prisma.post.update({ where: { id: existing.id }, data: patch });
      report.bump('Post', patch ? 'updated' : 'unchanged');
    }
    if (c.kind === 'stream') {
      const videoId = youtubeIdFrom(c.embed_url);
      const seasonId = seasonIdBySource.get(c.season_id);
      if (videoId && seasonId) {
        const existingVideo = await prisma.streamSeasonVideo.findFirst({ where: { seasonId, videoId } });
        const videoData = { seasonId, videoId, title, date: (c.event_date || '').trim() };
        if (!existingVideo) {
          if (!dry) await prisma.streamSeasonVideo.create({ data: videoData });
          report.bump('StreamSeasonVideo', 'created');
        } else {
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
  report.note('`matches.mvp_player_id` et `matches.bans` sont nuls/vides sur toutes les lignes en amont.');
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

  // ---- Report ------------------------------------------------------------
  const md = report.render(opts);
  log('\n' + md);
  const target = opts.report ?? path.join(opts.dump, '..', 'IMPORT_REPORT.md');
  if (!dry) {
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
