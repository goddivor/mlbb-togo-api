import { Injectable, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GmsClient } from '../mlbb/gms.client';
import { APP_ACADEMY, SRC } from '../mlbb/gms.constants';
import {
  CatalogCandidate,
  CatalogCounts,
  ExistingCatalogRow,
  mapGmsBattleSpells,
  mapGmsEmblems,
  mapGmsTalents,
  mapGmsItems,
  planCatalogSync,
} from './catalog-sync.mappers';

/** Moonton Academy sources of the catalog (app 2713644). */
export const CATALOG_SOURCES = {
  items: SRC.equipment,
  itemDetails: '2713995',
  battleSpells: '2718122',
  emblems: '2740642',
  talents: SRC.talents,
} as const;

export interface CatalogSyncResult {
  items: CatalogCounts;
  emblems: CatalogCounts;
  battleSpells: CatalogCounts;
  /** Emblem talents; null when Moonton could not serve them (not fatal). */
  talents: CatalogCounts | null;
  syncedAt: string;
}

const PAGE = { pageSize: 300, pageIndex: 1, filters: [], sorts: [], object: [] };
const TIMEOUT_MS = 20_000;

type Delegate = {
  findMany(args: unknown): Promise<ExistingCatalogRow[]>;
  create(args: { data: any }): Promise<unknown>;
  update(args: { where: { id: string }; data: any }): Promise<unknown>;
};

/**
 * Imports the game catalog (items, emblem sets, battle spells) with icons and
 * descriptions from the official Moonton GMS API. Never deletes a row; see
 * planCatalogSync for the matching and overwrite rules.
 *
 * Emblem talents (source 2718121) are imported in their own collection
 * (`EmblemTalent`, with their tier) for the community builds (#129); they are
 * kept out of the Emblem collection so the emblem set picker stays clean.
 */
@Injectable()
export class CatalogSyncService {
  private readonly logger = new Logger('CatalogSyncService');
  private running: Promise<CatalogSyncResult> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gms: GmsClient,
  ) {}

  /** Runs the sync; concurrent calls share the same run. */
  sync(lang = 'en'): Promise<CatalogSyncResult> {
    if (!this.running) {
      this.running = this.run(lang).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async fetch(sourceId: string, lang: string): Promise<any[]> {
    const data = await this.gms.callSource(APP_ACADEMY, sourceId, PAGE, lang, { timeoutMs: TIMEOUT_MS });
    return data.records;
  }

  private async run(lang: string): Promise<CatalogSyncResult> {
    const [details, list, spells, emblems, talents] = await Promise.all([
      this.fetch(CATALOG_SOURCES.itemDetails, lang),
      // The light list only backfills icons: its failure is not fatal.
      this.fetch(CATALOG_SOURCES.items, lang).catch(() => [] as any[]),
      this.fetch(CATALOG_SOURCES.battleSpells, lang),
      this.fetch(CATALOG_SOURCES.emblems, lang),
      // Talents only feed the community builds: their failure is not fatal.
      this.fetch(CATALOG_SOURCES.talents, lang).catch(() => null),
    ]);
    const now = new Date();
    const db: PrismaClient = this.prisma;
    const result: CatalogSyncResult = {
      items: await this.apply(db.item as unknown as Delegate, mapGmsItems(details, list), now, true),
      emblems: await this.apply(db.emblem as unknown as Delegate, mapGmsEmblems(emblems), now, true),
      battleSpells: await this.apply(db.battleSpell as unknown as Delegate, mapGmsBattleSpells(spells), now, false),
      talents: talents ? await this.applyTalents(db, talents, now) : null,
      syncedAt: now.toISOString(),
    };
    this.logger.log(
      `catalog sync: items +${result.items.created}/~${result.items.updated}, ` +
        `emblems +${result.emblems.created}/~${result.emblems.updated}, ` +
        `spells +${result.battleSpells.created}/~${result.battleSpells.updated}, ` +
        `talents ${result.talents ? `+${result.talents.created}/~${result.talents.updated}` : 'unavailable'}`,
    );
    return result;
  }

  /** Talents only feed the community builds: any failure here is not fatal. */
  private async applyTalents(db: PrismaClient, records: any[], now: Date): Promise<CatalogCounts | null> {
    try {
      return await this.apply(db.emblemTalent as unknown as Delegate, mapGmsTalents(records), now, false);
    } catch (e) {
      this.logger.warn(`talents sync failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async apply(
    delegate: Delegate,
    candidates: CatalogCandidate[],
    now: Date,
    withType: boolean,
  ): Promise<CatalogCounts> {
    const extraSelect = Object.fromEntries(
      [...new Set(candidates.flatMap((c) => Object.keys(c.extra ?? {})))].map((k) => [k, true]),
    );
    const existing = await delegate.findMany({
      select: {
        id: true,
        name: true,
        gameId: true,
        icon: true,
        description: true,
        updatedAt: true,
        syncedAt: true,
        ...(withType ? { type: true } : {}),
        ...extraSelect,
      },
    });
    const counts: CatalogCounts = { total: candidates.length, created: 0, updated: 0, unchanged: 0, failed: 0 };
    for (const w of planCatalogSync(candidates, existing, now, { withType })) {
      try {
        if (w.kind === 'create') {
          await delegate.create({ data: { ...w.data, syncedAt: new Date() } });
          counts.created++;
        } else if (w.kind === 'update') {
          // Stamp at write time: `updatedAt` is set by the same query, so
          // untouchedSinceSync stays true however long the whole run takes.
          const data = w.data.syncedAt ? { ...w.data, syncedAt: new Date() } : w.data;
          await delegate.update({ where: { id: w.id }, data });
          counts.updated++;
        } else {
          counts.unchanged++;
        }
      } catch (e) {
        // Typically a unique-name/gameId clash with a row edited meanwhile.
        counts.failed++;
        this.logger.warn(`catalog sync write failed (${w.kind}): ${(e as Error).message}`);
      }
    }
    return counts;
  }
}
