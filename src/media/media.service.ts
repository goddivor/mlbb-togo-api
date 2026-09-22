import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { CloudinaryConfig } from '../integrations/integrations.logic';
import { hasPermission } from '../access/permissions';
import {
  ABANDONED_UPLOAD_MS,
  ALLOWED_FORMATS,
  MAX_OPEN_SIGNATURES,
  MAX_UPLOAD_BYTES,
  MEDIA_STATUSES,
  MediaPurpose,
  MediaStatus,
  PURPOSES,
  SIGNATURE_TTL_SECONDS,
  SIGNED_STATUS,
  TargetFacts,
  UploadActor,
  VALIDATION_MESSAGES,
  buildPublicId,
  buildUploadTicket,
  canPasteUrl,
  decideUpload,
  deliveryUrl,
  isMediaPurpose,
  isMediaStatus,
  publicIdFromUrl,
  slotPrefix,
  validateResource,
} from './media.logic';
import { CloudinaryClient, DEFAULT_CLOUDINARY_API_BASE, createCloudinaryClient } from './media.cloudinary';
import { TargetAdapter, createTargetAdapters } from './media.targets';

export interface MediaActor extends UploadActor {
  username?: string | null;
}

export interface MediaDeps {
  client?: CloudinaryClient;
  apiBase?: string;
  nowSeconds?: () => number;
  adapters?: Record<string, TargetAdapter>;
}

export interface MaintenanceOptions {
  /** Rows handled per task and per run. */
  limit?: number;
  /** Wall-clock budget of the sweep (ms): the remaining rows wait for the next run. */
  budgetMs?: number;
}

type Usage = { used: boolean; targetId: string | null };

export interface ListFilters {
  purpose?: string;
  status?: string;
  uploader?: string;
  page?: number;
  limit?: number;
}

type AssetRow = {
  id: string;
  publicId: string;
  url: string;
  secureUrl: string;
  purpose: string;
  targetType: string;
  targetId: string | null;
  uploadedById: string;
  status: string;
  bytes: number;
  width: number;
  height: number;
  format: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  rejectReason: string | null;
  destroyedAt: Date | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * Signed direct uploads to Cloudinary (the file never transits through the
 * API), validation of what was uploaded, attachment to the target field and
 * cleanup of replaced images. Only assets tracked in `MediaAsset` are ever
 * destroyed on Cloudinary.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger('MediaService');
  private client: CloudinaryClient;
  private apiBase: string;
  private nowSeconds: () => number = () => Math.floor(Date.now() / 1000);
  private adapters: Record<string, TargetAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationsService,
  ) {
    // Overridable to point the whole flow at a local fake (see scripts/fake-cloudinary.js).
    this.apiBase = process.env.CLOUDINARY_API_BASE || DEFAULT_CLOUDINARY_API_BASE;
    this.client = createCloudinaryClient(this.apiBase);
    this.adapters = createTargetAdapters(prisma);
  }

  /** Test seam: fake Cloudinary client, clock and target adapters. */
  withDeps(deps: MediaDeps): this {
    if (deps.apiBase) this.apiBase = deps.apiBase;
    if (deps.client) this.client = deps.client;
    if (deps.nowSeconds) this.nowSeconds = deps.nowSeconds;
    if (deps.adapters) this.adapters = deps.adapters;
    return this;
  }

  private get db(): any {
    return this.prisma as any;
  }

  // ----- helpers ---------------------------------------------------------------

  private purposeOf(value: unknown): MediaPurpose {
    if (!isMediaPurpose(value)) throw new BadRequestException('Type d’image inconnu.');
    return value;
  }

  private targetIdOf(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new BadRequestException('Cible invalide.');
    return value;
  }

  private adapterOf(purpose: MediaPurpose): TargetAdapter {
    return this.adapters[PURPOSES[purpose].targetType];
  }

  private async requireConfig(): Promise<CloudinaryConfig> {
    const config = await this.integrations.getCloudinaryConfig();
    if (!config) {
      throw new ServiceUnavailableException('Cloudinary n’est pas configuré : l’envoi d’images est indisponible.');
    }
    return config;
  }

  /** Target existence + the facts the permission rule needs. */
  private async factsOf(purpose: MediaPurpose, targetId: string | null, actor: MediaActor): Promise<TargetFacts> {
    if (!targetId) return {};
    if (!(await this.adapterOf(purpose).exists(targetId))) throw new NotFoundException('Cible introuvable.');
    if (purpose !== 'team') return {};
    const [team, captain] = await Promise.all([
      this.db.esportTeam.findUnique({ where: { id: targetId }, select: { type: true } }),
      this.db.esportTeamMember.findFirst({
        where: { teamId: targetId, userId: actor.id, isCaptain: true },
        select: { id: true },
      }),
    ]);
    return { isCaptain: !!captain, teamType: team?.type ?? 'community' };
  }

  private async authorize(purpose: MediaPurpose, targetId: string | null, actor: MediaActor) {
    const facts = await this.factsOf(purpose, targetId, actor);
    const decision = decideUpload(purpose, actor, targetId, facts);
    if (!decision.allowed) {
      if ('reason' in decision && decision.reason === 'target_required') throw new BadRequestException('Cible requise.');
      throw new ForbiddenException('Vous ne pouvez pas modifier cette image.');
    }
    return (decision as { status: 'approved' | 'pending' }).status;
  }

  private serialize(row: AssetRow, extra: Record<string, unknown> = {}) {
    return {
      id: row.id,
      publicId: row.publicId,
      url: row.url,
      purpose: row.purpose,
      targetType: row.targetType,
      targetId: row.targetId,
      uploadedById: row.uploadedById,
      status: row.status,
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      format: row.format,
      reviewedById: row.reviewedById,
      reviewedAt: row.reviewedAt,
      rejectReason: row.rejectReason,
      destroyed: !!row.destroyedAt,
      createdAt: row.createdAt,
      ...extra,
    };
  }

  /** Destroys the Cloudinary copy of a tracked asset (errors logged, not thrown). */
  private async destroyRemote(row: AssetRow, config?: CloudinaryConfig | null): Promise<boolean> {
    const cfg = config === undefined ? await this.integrations.getCloudinaryConfig() : config;
    if (!cfg) {
      this.logger.warn(`Cannot destroy ${row.publicId}: Cloudinary is not configured.`);
      return false;
    }
    try {
      return await this.client.destroy(cfg, row.publicId);
    } catch (err) {
      this.logger.warn(`Cloudinary destroy failed for ${row.publicId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Releases an image URL that is no longer used by a target: when it is one
   * of OUR tracked assets it is destroyed on Cloudinary and forgotten. Any
   * other URL (seed, MLBB CDN, pasted by an admin) is left untouched, and so
   * is an asset uploaded for another record: the field may hold a URL copied
   * from elsewhere (e.g. a player setting his profile avatar to someone
   * else's uploaded image through PATCH /users/:id).
   */
  async releaseUrl(
    url: string | null | undefined,
    owner: { purpose: MediaPurpose; targetId: string },
    exceptId?: string,
  ): Promise<void> {
    const publicId = publicIdFromUrl(url);
    if (!publicId) return;
    const row: AssetRow | null = await this.db.mediaAsset.findUnique({ where: { publicId } });
    if (!row || row.id === exceptId || row.status === SIGNED_STATUS) return;
    if (row.purpose !== owner.purpose || (row.targetId !== null && row.targetId !== owner.targetId)) return;
    if (await this.destroyRemote(row)) {
      await this.db.mediaAsset.delete({ where: { id: row.id } });
    }
  }

  /** Writes the image into the target field and releases the previous one. */
  private async applyToTarget(purpose: MediaPurpose, targetId: string, url: string, assetId: string) {
    const adapter = this.adapterOf(purpose);
    if (!adapter.write) return;
    const previous = await adapter.read(targetId);
    await adapter.write(targetId, url);
    if (previous && previous !== url) await this.releaseUrl(previous, { purpose, targetId }, assetId);
  }

  /**
   * Whether each asset is still displayed by its target, batched per target
   * type (one query per type, whatever the number of rows). Read-only: an
   * asset uploaded before its target existed (create forms) is matched by
   * URL here and linked for good by the daily maintenance.
   */
  private async usage(rows: AssetRow[]): Promise<Map<string, Usage>> {
    const result = new Map<string, Usage>(rows.map((r) => [r.id, { used: false, targetId: r.targetId }]));
    const candidates = rows.filter(
      (r) => r.status === 'approved' && !r.destroyedAt && isMediaPurpose(r.purpose) && this.adapters[r.targetType],
    );
    const groups = new Map<string, { ids: Set<string>; urls: Set<string> }>();
    for (const r of candidates) {
      const group = groups.get(r.targetType) ?? { ids: new Set<string>(), urls: new Set<string>() };
      if (r.targetId) group.ids.add(r.targetId);
      else if (PURPOSES[r.purpose as MediaPurpose].kind === 'single') group.urls.add(r.url);
      groups.set(r.targetType, group);
    }
    const values = new Map<string, Map<string, string | null>>();
    const owners = new Map<string, Map<string, string>>();
    await Promise.all(
      [...groups].map(async ([type, group]) => {
        const adapter = this.adapters[type];
        const [read, found] = await Promise.all([
          group.ids.size ? adapter.readMany([...group.ids]) : new Map<string, string | null>(),
          group.urls.size && adapter.findByUrls ? adapter.findByUrls([...group.urls]) : new Map<string, string>(),
        ]);
        values.set(type, read);
        owners.set(type, found);
      }),
    );
    for (const r of candidates) {
      if (!r.targetId) {
        const owner = owners.get(r.targetType)?.get(r.url) ?? null;
        result.set(r.id, { used: !!owner, targetId: owner });
        continue;
      }
      const current = values.get(r.targetType)?.get(r.targetId) ?? null;
      const single = PURPOSES[r.purpose as MediaPurpose].kind === 'single';
      const used = !!current && (single ? publicIdFromUrl(current) === r.publicId : current.includes(r.publicId));
      result.set(r.id, { used, targetId: r.targetId });
    }
    return result;
  }

  // ----- player/admin upload flow -------------------------------------------------

  /** Whether uploads are available (Cloudinary configured) and their limits. */
  async publicConfig() {
    const config = await this.integrations.getCloudinaryConfig();
    return { enabled: !!config, maxBytes: MAX_UPLOAD_BYTES, formats: ALLOWED_FORMATS };
  }

  /** Short-lived signature for ONE upload into a slot the actor may write. */
  async sign(actor: MediaActor, rawPurpose: unknown, rawTargetId: unknown) {
    const purpose = this.purposeOf(rawPurpose);
    const targetId = this.targetIdOf(rawTargetId);
    const status = await this.authorize(purpose, targetId, actor);
    const config = await this.requireConfig();
    const nowSeconds = this.nowSeconds();
    // Every ticket leaves a row behind until confirmed or swept: cap the open ones.
    const open: number = await this.db.mediaAsset.count({
      where: {
        uploadedById: actor.id,
        status: SIGNED_STATUS,
        createdAt: { gt: new Date((nowSeconds - SIGNATURE_TTL_SECONDS) * 1000) },
      },
    });
    if (open >= MAX_OPEN_SIGNATURES) {
      throw new HttpException('Trop d’envois en cours : réessayez dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
    const publicId = buildPublicId(config.folder, purpose, targetId, actor.id);
    const ticket = buildUploadTicket({
      apiBase: this.apiBase,
      cloudName: config.cloudName,
      apiKey: config.apiKey,
      apiSecret: config.apiSecret,
      publicId,
      nowSeconds,
    });
    // Recorded before the upload: a file never confirmed (abandoned, refused,
    // abuse) is still known, and destroyed by the daily sweep.
    await this.db.mediaAsset.create({
      data: {
        publicId,
        url: '',
        secureUrl: '',
        purpose,
        targetType: PURPOSES[purpose].targetType,
        targetId,
        uploadedById: actor.id,
        status: SIGNED_STATUS,
        bytes: 0,
        width: 0,
        height: 0,
        format: '',
        createdAt: new Date(nowSeconds * 1000),
        expiresAt: new Date(nowSeconds * 1000 + ABANDONED_UPLOAD_MS),
      },
    });
    return { ...ticket, status };
  }

  /**
   * Called by the browser once Cloudinary accepted the file. The metadata is
   * read back from the Cloudinary Admin API (never trusted from the client),
   * validated, then the asset is recorded and, for a single-image target,
   * attached right away (approved) or kept aside (pending).
   */
  async confirm(actor: MediaActor, rawPurpose: unknown, rawTargetId: unknown, rawPublicId: unknown) {
    const purpose = this.purposeOf(rawPurpose);
    const targetId = this.targetIdOf(rawTargetId);
    const status = await this.authorize(purpose, targetId, actor);
    const config = await this.requireConfig();
    const def = PURPOSES[purpose];

    const publicId = typeof rawPublicId === 'string' ? rawPublicId : '';
    const prefix = slotPrefix(config.folder, purpose, targetId, actor.id);
    // Not signed for this actor/slot: refuse without touching Cloudinary.
    if (!publicId.startsWith(prefix) || !/^[A-Za-z0-9_\-/]+$/.test(publicId)) {
      throw new BadRequestException(VALIDATION_MESSAGES.wrong_slot);
    }
    // Row recorded at sign time (absent for a ticket signed before it existed).
    const existing: AssetRow | null = await this.db.mediaAsset.findUnique({ where: { publicId } });
    if (existing && existing.status !== SIGNED_STATUS) throw new ConflictException('Image déjà enregistrée.');

    let resource;
    try {
      resource = await this.client.getResource(config, publicId);
    } catch (err) {
      throw new ServiceUnavailableException((err as Error).message);
    }
    if (!resource) throw new BadRequestException('Image introuvable sur Cloudinary.');
    const invalid = validateResource(resource, prefix);
    if (invalid) {
      // Uploaded with our signature into our slot: safe to destroy.
      const destroyed = await this.client.destroy(config, publicId).catch(() => false);
      if (destroyed && existing) await this.db.mediaAsset.delete({ where: { id: existing.id } });
      throw new BadRequestException(VALIDATION_MESSAGES[invalid]);
    }

    const url = deliveryUrl(resource.secure_url, def.maxDimension);
    const data = {
      publicId,
      url,
      secureUrl: resource.secure_url,
      purpose,
      targetType: def.targetType,
      targetId,
      uploadedById: actor.id,
      status,
      bytes: resource.bytes,
      width: resource.width,
      height: resource.height,
      format: String(resource.format).toLowerCase(),
      expiresAt: null,
    };
    // The signed row is promoted; a legacy ticket (no row) gets a new one.
    const row: AssetRow = existing
      ? await this.db.mediaAsset.update({ where: { id: existing.id }, data })
      : await this.db.mediaAsset.create({ data });

    let applied = false;
    if (status === 'approved' && targetId && def.kind === 'single') {
      await this.applyToTarget(purpose, targetId, url, row.id);
      applied = true;
    }
    if (status === 'pending' && targetId) {
      // A newer proposal replaces the previous pending one of the same target.
      const older: AssetRow[] = await this.db.mediaAsset.findMany({
        where: { purpose, targetId, status: 'pending', id: { not: row.id } },
      });
      for (const o of older) {
        await this.destroyRemote(o, config);
        await this.db.mediaAsset.delete({ where: { id: o.id } });
      }
    }
    return { asset: this.serialize(row), url, status, applied };
  }

  /** Image slot state for the upload component: current value + pending proposal. */
  async targetState(actor: MediaActor, rawPurpose: unknown, rawTargetId: unknown) {
    const purpose = this.purposeOf(rawPurpose);
    const targetId = this.targetIdOf(rawTargetId);
    if (!targetId) throw new BadRequestException('Cible requise.');
    const status = await this.authorize(purpose, targetId, actor);
    const adapter = this.adapterOf(purpose);
    const pending: AssetRow | null = await this.db.mediaAsset.findFirst({
      where: { purpose, targetId, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    return {
      purpose,
      targetId,
      current: PURPOSES[purpose].kind === 'single' ? await adapter.read(targetId) : null,
      pending: pending ? this.serialize(pending) : null,
      uploadStatus: status,
      canPasteUrl: canPasteUrl(purpose, actor),
    };
  }

  /** Clears a single-image target and destroys its tracked asset. */
  async removeFromTarget(actor: MediaActor, rawPurpose: unknown, rawTargetId: unknown) {
    const purpose = this.purposeOf(rawPurpose);
    const targetId = this.targetIdOf(rawTargetId);
    if (!targetId) throw new BadRequestException('Cible requise.');
    const def = PURPOSES[purpose];
    if (def.kind !== 'single' || !def.removable) throw new BadRequestException('Cette image ne peut pas être retirée.');
    const status = await this.authorize(purpose, targetId, actor);
    // A captain whose uploads need approval cannot remove the public image either.
    if (status !== 'approved') throw new ForbiddenException('Retrait soumis à validation : contactez un administrateur.');
    const adapter = this.adapterOf(purpose);
    const previous = await adapter.read(targetId);
    await adapter.write!(targetId, null);
    await this.releaseUrl(previous, { purpose, targetId });
    return { success: true };
  }

  /**
   * Deletes one asset. The uploader may delete his own pending or unused
   * upload (cancelled form); `admin.media` may delete any asset, which also
   * clears the target when the image is still displayed.
   */
  async deleteAsset(actor: MediaActor, id: string) {
    const row = await this.findRow(id);
    const isAdmin = hasPermission(actor, 'admin.media');
    const { used, targetId } = (await this.usage([row])).get(row.id)!;
    if (!isAdmin) {
      if (row.uploadedById !== actor.id) throw new ForbiddenException('Suppression non autorisée.');
      if (used) throw new ForbiddenException('Image utilisée : retirez-la depuis son formulaire.');
    }
    if (used && targetId && isMediaPurpose(row.purpose)) {
      const def = PURPOSES[row.purpose];
      const adapter = this.adapterOf(row.purpose);
      if (def.kind === 'list') await adapter.detach?.(targetId, row.url);
      else if (!def.removable) throw new ConflictException('Image obligatoire : remplacez-la avant de la supprimer.');
      else await adapter.write!(targetId, null);
    }
    if (!row.destroyedAt) await this.destroyRemote(row);
    await this.db.mediaAsset.delete({ where: { id: row.id } });
    if (isAdmin) await this.log('media.delete', actor, row, used ? 'in use: target cleared' : '');
    return { success: true };
  }

  // ----- admin library ---------------------------------------------------------------

  private async findRow(id: string): Promise<AssetRow> {
    if (!OBJECT_ID.test(id)) throw new NotFoundException('Image introuvable.');
    const row: AssetRow | null = await this.db.mediaAsset.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Image introuvable.');
    return row;
  }

  async list(filters: ListFilters) {
    const limit = Math.min(Math.max(Number(filters.limit) || 24, 1), 60);
    const page = Math.max(Number(filters.page) || 1, 1);
    // Rows still waiting for their upload (`signed`) are internal: never listed.
    const where: Record<string, unknown> = { status: { in: [...MEDIA_STATUSES] } };
    if (filters.purpose && isMediaPurpose(filters.purpose)) where.purpose = filters.purpose;
    if (filters.status && isMediaStatus(filters.status)) where.status = filters.status;
    if (filters.uploader?.trim()) {
      const users: { id: string }[] = await this.db.user.findMany({
        where: { username: { contains: filters.uploader.trim(), mode: 'insensitive' } },
        select: { id: true },
        take: 50,
      });
      where.uploadedById = { in: users.map((u) => u.id) };
    }
    const [rows, total, statusCounts] = await Promise.all([
      this.db.mediaAsset.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.db.mediaAsset.count({ where }),
      Promise.all(
        (['pending', 'approved', 'rejected'] as MediaStatus[]).map((s) =>
          this.db.mediaAsset.count({ where: { status: s } }),
        ),
      ),
    ]);

    const typed = rows as AssetRow[];
    const usage = await this.usage(typed);
    const userIds = [...new Set(typed.flatMap((r) => [r.uploadedById, r.reviewedById]).filter(Boolean))] as string[];
    const users: { id: string; username: string }[] = userIds.length
      ? await this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, username: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.username]));
    const byType = new Map<string, string[]>();
    for (const r of typed) {
      if (!r.targetId) continue;
      byType.set(r.targetType, [...(byType.get(r.targetType) ?? []), r.targetId]);
    }
    const labels = new Map<string, string>();
    for (const [type, ids] of byType) {
      const adapter = this.adapters[type];
      if (!adapter) continue;
      const map = await adapter.labels([...new Set(ids)]);
      for (const [id, label] of map) labels.set(`${type}:${id}`, label);
    }

    return {
      items: typed.map((r) =>
        this.serialize(r, {
          inUse: usage.get(r.id)?.used ?? false,
          uploader: names.get(r.uploadedById) ?? null,
          reviewer: r.reviewedById ? (names.get(r.reviewedById) ?? null) : null,
          targetLabel: r.targetId ? (labels.get(`${r.targetType}:${r.targetId}`) ?? null) : null,
        }),
      ),
      total,
      page,
      pages: Math.max(Math.ceil(total / limit), 1),
      limit,
      counts: { pending: statusCounts[0], approved: statusCounts[1], rejected: statusCounts[2] },
    };
  }

  /** Publishes a pending image: it replaces the target image (previous one released). */
  async approve(actor: MediaActor, id: string) {
    const row = await this.findRow(id);
    if (row.status !== 'pending') throw new ConflictException('Seules les images en attente peuvent être validées.');
    if (!isMediaPurpose(row.purpose)) throw new BadRequestException('Type d’image inconnu.');
    const updated: AssetRow = await this.db.mediaAsset.update({
      where: { id },
      data: { status: 'approved', reviewedById: actor.id, reviewedAt: new Date(), rejectReason: null },
    });
    if (row.targetId && PURPOSES[row.purpose].kind === 'single') {
      if (await this.adapterOf(row.purpose).exists(row.targetId)) {
        await this.applyToTarget(row.purpose, row.targetId, row.url, row.id);
      }
    }
    await this.log('media.approve', actor, row, '');
    return this.serialize(updated);
  }

  /** Refuses a pending image: the Cloudinary copy is destroyed, the row kept for history. */
  async reject(actor: MediaActor, id: string, reason?: string | null) {
    const row = await this.findRow(id);
    if (row.status !== 'pending') throw new ConflictException('Seules les images en attente peuvent être refusées.');
    const destroyed = await this.destroyRemote(row);
    const updated: AssetRow = await this.db.mediaAsset.update({
      where: { id },
      data: {
        status: 'rejected',
        reviewedById: actor.id,
        reviewedAt: new Date(),
        rejectReason: reason?.trim() ? reason.trim().slice(0, 300) : null,
        destroyedAt: destroyed ? new Date() : null,
      },
    });
    await this.log('media.reject', actor, row, reason ?? '');
    return this.serialize(updated);
  }

  // ----- daily maintenance ------------------------------------------------------------

  /**
   * Daily job (called by the rewards cron): destroys the uploads signed but
   * never confirmed, then links the assets uploaded before their target
   * existed. Bounded per run (row count and time budget); what is left waits
   * for the next run.
   */
  async runMaintenance(now = new Date(), opts: MaintenanceOptions = {}) {
    const limit = Math.max(opts.limit ?? 50, 1);
    const deadline = Date.now() + Math.max(opts.budgetMs ?? 10_000, 0);
    const abandoned = await this.sweepAbandoned(now, limit, deadline);
    const linked = await this.linkOrphans(limit);
    return { abandoned, linked };
  }

  /** Signed uploads never confirmed, past their expiry: destroyed on Cloudinary and forgotten. */
  async sweepAbandoned(now: Date, limit = 50, deadline = Number.POSITIVE_INFINITY) {
    const rows: AssetRow[] = await this.db.mediaAsset.findMany({
      where: { status: SIGNED_STATUS, expiresAt: { lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: limit,
    });
    const report = { found: rows.length, deleted: 0, failed: 0, skipped: 0 };
    if (!rows.length) return report;
    const config = await this.integrations.getCloudinaryConfig();
    if (!config) {
      // Nothing can be destroyed: the rows wait for a later run.
      report.skipped = rows.length;
      return report;
    }
    for (const row of rows) {
      if (Date.now() >= deadline) {
        report.skipped += 1;
        continue;
      }
      // `not found` (the file was never uploaded) counts as destroyed.
      if (await this.destroyRemote(row, config)) {
        await this.db.mediaAsset.delete({ where: { id: row.id } });
        report.deleted += 1;
      } else {
        report.failed += 1;
      }
    }
    return report;
  }

  /** Approved assets uploaded before their record existed: linked to it once found by URL. */
  async linkOrphans(limit = 50) {
    const singles = (Object.keys(PURPOSES) as MediaPurpose[]).filter((p) => PURPOSES[p].kind === 'single');
    const rows: AssetRow[] = await this.db.mediaAsset.findMany({
      // Only rejected rows are ever destroyed: no `destroyedAt` filter (unset fields do not match null on Mongo).
      where: { status: 'approved', targetId: null, purpose: { in: singles } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const usage = await this.usage(rows);
    let linked = 0;
    for (const row of rows) {
      const targetId = usage.get(row.id)?.targetId;
      if (!targetId) continue;
      await this.db.mediaAsset.update({ where: { id: row.id }, data: { targetId } });
      linked += 1;
    }
    return { found: rows.length, linked };
  }

  private async log(action: string, actor: MediaActor, row: AssetRow, details: string) {
    try {
      await this.db.adminLog.create({
        data: {
          action,
          admin: actor.username ?? actor.id,
          target: `${row.purpose}:${row.targetId ?? 'new'}`,
          details: `${row.publicId}${details ? ` (${details})` : ''}`.slice(0, 500),
        },
      });
    } catch (err) {
      this.logger.warn(`admin log failed: ${(err as Error).message}`);
    }
  }
}
