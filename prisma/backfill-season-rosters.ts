/**
 * Backfill of the per-season rosters (issue goddivor/mlbb-togo#162).
 *
 *   npm run backfill:rosters -- [--dry-run] [--allow-remote-database]
 *
 * The legacy import (#153) wrote only the CURRENT roster as membership rows;
 * the roster of every season was archived inside
 * `EsportSeason.summary.legacy.rosters` (`{ teamId, userId, role }`). That is
 * why the five ETERNUM teams hold 19 matches each and show no member: their
 * players are listed in a season archive, not in `EsportTeamMember`.
 *
 * This script turns that archive into real memberships tagged with their
 * `seasonId`. It is idempotent: a row already existing for the same
 * (team, user, season) is left untouched, which is also what a re-run of the
 * import does, so the two paths converge. It never touches the live
 * (untagged) rows, so nothing an admin or a captain manages today changes.
 *
 * Databases where the import runs again do not need it: the import writes the
 * per-season rows itself from now on.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { seasonRosterTeams } from '../src/awards/awards.logic';

type Options = { dryRun: boolean; allowRemote: boolean };

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, allowRemote: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--allow-remote-database') opts.allowRemote = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: npm run backfill:rosters -- [--dry-run] [--allow-remote-database]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

/** Same guard as the import: production is only written to on purpose. */
function assertLocalDatabase(allowRemote: boolean) {
  const url = process.env.DATABASE_URL || '';
  const host = (url.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/:?,]+)/) || [])[1] || '';
  if (['localhost', '127.0.0.1', '::1', 'mongo', 'mongodb'].includes(host)) return;
  if (!allowRemote) {
    console.error(
      `Refusing to write into "${host || 'unknown host'}": this command only runs against a local ` +
        'database. Pass --allow-remote-database to run it on production deliberately.',
    );
    process.exit(1);
  }
  console.warn(`⚠ Remote database allowed on purpose: ${host || 'unknown host'}`);
}

/**
 * Roster lines of a season archive. `seasonRosterTeams` keeps one team per
 * player (what the awards need); here every line matters, including the role.
 */
export function parseArchivedRoster(
  summary: unknown,
): { teamId: string; userId: string; role: string | null }[] {
  let doc: any = summary;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  const rosters = doc?.legacy?.rosters;
  if (!Array.isArray(rosters)) return [];
  const out: { teamId: string; userId: string; role: string | null }[] = [];
  const seen = new Set<string>();
  for (const line of rosters) {
    if (!line || typeof line !== 'object') continue;
    const teamId = typeof line.teamId === 'string' ? line.teamId : null;
    const userId = typeof line.userId === 'string' ? line.userId : null;
    if (!teamId || !userId) continue;
    const key = `${teamId}:${userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ teamId, userId, role: typeof line.role === 'string' ? line.role : null });
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertLocalDatabase(opts.allowRemote);
  const prisma = new PrismaClient();
  try {
    const seasons = await prisma.esportSeason.findMany({
      select: { id: true, name: true, number: true, summary: true },
    });
    const teams = await prisma.esportTeam.findMany({ select: { id: true, name: true } });
    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const knownTeams = new Set(teams.map((t) => t.id));
    const users = await prisma.user.findMany({ select: { id: true } });
    const knownUsers = new Set(users.map((u) => u.id));

    let created = 0;
    let existing = 0;
    let skipped = 0;
    for (const season of seasons.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))) {
      const roster = parseArchivedRoster(season.summary);
      // `seasonRosterTeams` is the reader the awards already use: it must see
      // the same archive, so a season it reads nothing from is reported.
      if (!roster.length) {
        if (seasonRosterTeams(season.summary).size === 0)
          console.log(`- ${season.name}: no archived roster`);
        continue;
      }
      const perTeam = new Map<string, number>();
      for (const line of roster) {
        if (!knownTeams.has(line.teamId) || !knownUsers.has(line.userId)) {
          skipped += 1;
          continue;
        }
        const already = await prisma.esportTeamMember.findFirst({
          where: { teamId: line.teamId, userId: line.userId, seasonId: season.id },
          select: { id: true },
        });
        if (already) {
          existing += 1;
          perTeam.set(line.teamId, (perTeam.get(line.teamId) ?? 0) + 1);
          continue;
        }
        if (!opts.dryRun) {
          await prisma.esportTeamMember.create({
            data: {
              teamId: line.teamId,
              userId: line.userId,
              role: line.role,
              seasonId: season.id,
            },
          });
        }
        created += 1;
        perTeam.set(line.teamId, (perTeam.get(line.teamId) ?? 0) + 1);
      }
      const detail = [...perTeam.entries()]
        .map(([teamId, n]) => `${teamName.get(teamId) ?? teamId}: ${n}`)
        .sort()
        .join(', ');
      console.log(`- ${season.name}: ${roster.length} roster line(s) — ${detail}`);
    }
    console.log(
      `\n${opts.dryRun ? '[dry-run] ' : ''}${created} membership(s) created, ${existing} already ` +
        `there, ${skipped} line(s) skipped (team or player gone).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
