// Read/write access to the image field of each upload target. The media
// service only talks to targets through this table, so adding a purpose is a
// matter of adding one adapter.

import { PrismaService } from '../prisma/prisma.service';
import { TargetType } from './media.logic';

export interface TargetAdapter {
  /** Human label shown in the media library (name, title...), null when gone. */
  labels(ids: string[]): Promise<Map<string, string>>;
  exists(id: string): Promise<boolean>;
  /**
   * `single`: current field value. `list`: every image URL of the target
   * joined in one string (used for "is this asset still in use").
   */
  read(id: string): Promise<string | null>;
  /** `single` only: sets (or clears with null) the image field. */
  write?(id: string, url: string | null): Promise<void>;
  /** `list` only: removes an image URL from the target. */
  detach?(id: string, url: string): Promise<void>;
  /** `single` only: id of the target whose field is exactly `url`. */
  findByUrl?(url: string): Promise<string | null>;
}

const toMap = <T extends { id: string }>(rows: T[], label: (r: T) => string | null | undefined) =>
  new Map(rows.map((r) => [r.id, label(r) || r.id]));

/** Adapter of a model holding one image in a plain string field. */
function singleField(
  delegate: any,
  field: string,
  labelField: string,
  nullValue: string | null = null,
): TargetAdapter {
  return {
    async labels(ids) {
      if (!ids.length) return new Map();
      const rows = await delegate.findMany({ where: { id: { in: ids } }, select: { id: true, [labelField]: true } });
      return toMap(rows, (r: any) => r[labelField]);
    },
    async exists(id) {
      return !!(await delegate.findUnique({ where: { id }, select: { id: true } }));
    },
    async read(id) {
      const row = await delegate.findUnique({ where: { id }, select: { [field]: true } });
      return (row?.[field] as string | null | undefined) || null;
    },
    async write(id, url) {
      await delegate.update({ where: { id }, data: { [field]: url ?? nullValue } });
    },
    async findByUrl(url) {
      const row = await delegate.findFirst({ where: { [field]: url }, select: { id: true } });
      return row?.id ?? null;
    },
  };
}

export function createTargetAdapters(prisma: PrismaService): Record<TargetType, TargetAdapter> {
  const p = prisma as any;
  return {
    user: singleField(p.user, 'avatar', 'username'),
    esportTeam: singleField(p.esportTeam, 'image', 'name'),
    esportTeamStaff: singleField(p.esportTeamStaff, 'avatar', 'name'),
    // Sponsor.logo is required: never cleared (the purpose is not removable).
    sponsor: singleField(p.sponsor, 'logo', 'name', ''),
    tournament: singleField(p.tournament, 'banner', 'name'),
    season: singleField(p.esportSeason, 'banner', 'name'),
    award: singleField(p.seasonAward, 'imageUrl', 'title'),
    match: {
      async labels(ids) {
        if (!ids.length) return new Map();
        const rows: { id: string; teamAId: string; teamBId: string }[] = await p.esportMatch.findMany({
          where: { id: { in: ids } },
          select: { id: true, teamAId: true, teamBId: true },
        });
        const teamIds = [...new Set(rows.flatMap((r) => [r.teamAId, r.teamBId]))];
        const teams: { id: string; name: string }[] = teamIds.length
          ? await p.esportTeam.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true } })
          : [];
        const names = new Map(teams.map((t) => [t.id, t.name]));
        return toMap(rows, (r) => `${names.get(r.teamAId) ?? '?'} vs ${names.get(r.teamBId) ?? '?'}`);
      },
      async exists(id) {
        return !!(await p.esportMatch.findUnique({ where: { id }, select: { id: true } }));
      },
      async read(id) {
        const row = await p.esportMatch.findUnique({ where: { id }, select: { screenshots: true, games: true } });
        return row ? `${row.screenshots ?? ''}\n${row.games ?? ''}` : null;
      },
      async detach(id, url) {
        const row = await p.esportMatch.findUnique({ where: { id }, select: { screenshots: true, games: true } });
        if (!row) return;
        const parse = (raw: string | null) => {
          try {
            const v = JSON.parse(raw ?? '');
            return Array.isArray(v) ? v : null;
          } catch {
            return null;
          }
        };
        const data: Record<string, string | null> = {};
        const shots = parse(row.screenshots);
        if (shots?.includes(url)) {
          const next = shots.filter((s) => s !== url);
          data.screenshots = next.length ? JSON.stringify(next) : null;
        }
        const games = parse(row.games);
        if (games?.some((g) => g && g.screenshot === url)) {
          data.games = JSON.stringify(games.map((g) => (g && g.screenshot === url ? { ...g, screenshot: null } : g)));
        }
        if (Object.keys(data).length) await p.esportMatch.update({ where: { id }, data });
      },
    },
  };
}
