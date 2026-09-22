import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MediaService } from './media.service';
import { CloudinaryClient, createCloudinaryClient } from './media.cloudinary';
import { CloudinaryResource, cloudinarySignature } from './media.logic';
import { TargetAdapter } from './media.targets';
import { PrismaService } from '../prisma/prisma.service';
import { IntegrationsService } from '../integrations/integrations.service';

const USER = '64b000000000000000000001';
const CAPTAIN = '64b000000000000000000002';
const ADMIN_ID = '64b000000000000000000003';
const TEAM = '64b0000000000000000000aa';
const ESPORT_TEAM = '64b0000000000000000000ab';
const SEASON = '64b0000000000000000000ac';
const CONFIG = { cloudName: 'demo', apiKey: '123', apiSecret: 'shh', folder: 'mlbb' };

const player = { id: USER, username: 'player', permissions: [] as string[] };
const captain = { id: CAPTAIN, username: 'cap', permissions: [] as string[] };
const admin = (...permissions: string[]) => ({ id: ADMIN_ID, username: 'admin', permissions });

/** In-memory single-field targets (id -> value). */
function memoryAdapter(values: Record<string, string | null>): TargetAdapter & { values: typeof values } {
  return {
    values,
    labels: async (ids) => new Map(ids.map((id) => [id, `label-${id}`])),
    exists: async (id) => id in values,
    read: async (id) => values[id] ?? null,
    readMany: async (ids) => new Map(ids.filter((id) => id in values).map((id) => [id, values[id] ?? null])),
    write: async (id, url) => {
      values[id] = url;
    },
    findByUrl: async (url) => Object.keys(values).find((k) => values[k] === url) ?? null,
    findByUrls: async (urls) =>
      new Map(Object.keys(values).filter((k) => urls.includes(values[k] as string)).map((k) => [values[k] as string, k])),
  };
}

function fakePrisma() {
  let seq = 0;
  const assets = new Map<string, any>();
  const logs: any[] = [];
  const match = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
      if (v && typeof v === 'object' && 'gt' in v) return row[k] > v.gt;
      if (v && typeof v === 'object' && 'lte' in v) return row[k] !== null && row[k] <= v.lte;
      return row[k] === v;
    });
  const prisma = {
    mediaAsset: {
      findUnique: jest.fn(async ({ where }) =>
        where.id ? (assets.get(where.id) ?? null) : ([...assets.values()].find((a) => a.publicId === where.publicId) ?? null),
      ),
      findFirst: jest.fn(async ({ where }) => [...assets.values()].reverse().find((a) => match(a, where)) ?? null),
      findMany: jest.fn(async ({ where, take } = {}) =>
        [...assets.values()]
          .filter((a) => match(a, where))
          .reverse()
          .slice(0, take ?? undefined),
      ),
      count: jest.fn(async ({ where } = {}) => [...assets.values()].filter((a) => match(a, where)).length),
      create: jest.fn(async ({ data }) => {
        const row = {
          id: `64b1${String(++seq).padStart(20, '0')}`,
          reviewedById: null,
          reviewedAt: null,
          rejectReason: null,
          destroyedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        assets.set(row.id, row);
        return row;
      }),
      update: jest.fn(async ({ where, data }) => {
        const row = { ...assets.get(where.id), ...data };
        assets.set(where.id, row);
        return row;
      }),
      delete: jest.fn(async ({ where }) => assets.delete(where.id)),
    },
    esportTeam: {
      findUnique: jest.fn(async ({ where }) => ({ type: where.id === ESPORT_TEAM ? 'esport' : 'community' })),
    },
    esportTeamMember: {
      findFirst: jest.fn(async ({ where }) => (where.userId === CAPTAIN ? { id: 'm1' } : null)),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: USER, username: 'player' },
        { id: CAPTAIN, username: 'cap' },
        { id: ADMIN_ID, username: 'admin' },
      ]),
    },
    adminLog: { create: jest.fn(async ({ data }) => logs.push(data)) },
  };
  return { prisma, assets, logs };
}

/** Fake Cloudinary: resources "uploaded" by the test, destroy calls recorded. */
function fakeCloudinary() {
  const resources = new Map<string, CloudinaryResource>();
  const destroyed: string[] = [];
  const client: CloudinaryClient = {
    getResource: jest.fn(async (_c, publicId) => resources.get(publicId) ?? null),
    destroy: jest.fn(async (_c, publicId) => {
      destroyed.push(publicId);
      resources.delete(publicId);
      return true;
    }),
  };
  const upload = (publicId: string, over: Partial<CloudinaryResource> = {}) => {
    resources.set(publicId, {
      public_id: publicId,
      format: 'png',
      resource_type: 'image',
      type: 'upload',
      bytes: 50_000,
      width: 300,
      height: 300,
      version: 17,
      secure_url: `https://res.cloudinary.com/demo/image/upload/v17/${publicId}.png`,
      ...over,
    });
  };
  return { client, resources, destroyed, upload };
}

function make(config: typeof CONFIG | null = CONFIG) {
  const { prisma, assets, logs } = fakePrisma();
  const cloud = fakeCloudinary();
  const integrations = { getCloudinaryConfig: jest.fn(async () => config) };
  const users = memoryAdapter({ [USER]: null, [CAPTAIN]: null });
  const teams = memoryAdapter({ [TEAM]: 'https://res.cloudinary.com/seed/image/upload/v1/seed/team.png', [ESPORT_TEAM]: null });
  const seasons = memoryAdapter({ [SEASON]: 'https://akmweb.youngjoygame.com/banner.png' });
  const sponsors = memoryAdapter({});
  const service = new MediaService(
    prisma as unknown as PrismaService,
    integrations as unknown as IntegrationsService,
  ).withDeps({
    client: cloud.client,
    nowSeconds: () => 1_700_000_000,
    adapters: { user: users, esportTeam: teams, season: seasons, sponsor: sponsors },
  });
  /** Full browser flow: sign, "upload" to the fake Cloudinary, confirm. */
  const upload = async (actor: any, purpose: string, targetId: string | null, over: Partial<CloudinaryResource> = {}) => {
    const ticket = await service.sign(actor, purpose, targetId);
    cloud.upload(ticket.params.public_id, over);
    return service.confirm(actor, purpose, targetId, ticket.params.public_id);
  };
  return { service, prisma, assets, logs, cloud, users, teams, seasons, sponsors, upload };
}

describe('MediaService', () => {
  describe('sign', () => {
    it('returns a signed ticket for an allowed slot, never the secret', async () => {
      const { service } = make();
      const ticket = await service.sign(player, 'avatar', USER);
      expect(ticket.params.public_id).toMatch(new RegExp(`^mlbb/avatar/${USER}/${USER}_[a-f0-9]{16}$`));
      const { signature, ...signed } = ticket.params;
      expect(signature).toBe(cloudinarySignature(signed, 'shh'));
      expect(ticket.apiKey).toBe('123');
      expect(JSON.stringify(ticket)).not.toContain('shh');
      expect(ticket.status).toBe('approved');
    });

    it('checks permissions and ownership before signing', async () => {
      const { service } = make();
      await expect(service.sign(player, 'avatar', CAPTAIN)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.sign(player, 'season', SEASON)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.sign(player, 'team', TEAM)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.sign(admin('admin.seasons'), 'season', '64b0000000000000000000ff')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.sign(player, 'nope', null)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.sign(player, 'avatar', 'not-an-id')).rejects.toBeInstanceOf(BadRequestException);
      expect((await service.sign(captain, 'team', TEAM)).status).toBe('pending');
      expect((await service.sign(captain, 'team', ESPORT_TEAM)).status).toBe('approved');
    });

    it('is unavailable while Cloudinary is not configured', async () => {
      const { service } = make(null);
      await expect(service.sign(player, 'avatar', USER)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(await service.publicConfig()).toMatchObject({ enabled: false });
    });
  });

  describe('confirm', () => {
    it('records the asset from Admin API metadata and attaches it with a delivery URL', async () => {
      const { upload, users, assets } = make();
      const res = await upload(player, 'avatar', USER);
      expect(res.status).toBe('approved');
      expect(res.applied).toBe(true);
      expect(res.url).toMatch(/\/image\/upload\/c_limit,w_400,h_400\/f_auto,q_auto\/v17\/mlbb\/avatar\//);
      expect(users.values[USER]).toBe(res.url);
      const row = [...assets.values()][0];
      expect(row).toMatchObject({ purpose: 'avatar', targetType: 'user', targetId: USER, uploadedById: USER, bytes: 50_000, width: 300, format: 'png' });
    });

    it('refuses a public id outside the actor slot without calling Cloudinary', async () => {
      const { service, cloud } = make();
      await expect(service.confirm(player, 'avatar', USER, `mlbb/avatar/${USER}/${CAPTAIN}_abc`)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service.confirm(player, 'avatar', USER, `mlbb/season/new/${USER}_abc`)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(cloud.client.getResource).not.toHaveBeenCalled();
      expect(cloud.destroyed).toEqual([]);
    });

    it('destroys and refuses an invalid upload (format, size, animation)', async () => {
      const { upload, cloud, assets, users } = make();
      await expect(upload(player, 'avatar', USER, { format: 'svg' })).rejects.toThrow(/Format/);
      await expect(upload(player, 'avatar', USER, { bytes: 20 * 1024 * 1024 })).rejects.toThrow(/lourde/);
      await expect(upload(player, 'avatar', USER, { format: 'gif', pages: 4 })).rejects.toThrow(/animées/);
      expect(cloud.destroyed).toHaveLength(3);
      expect(assets.size).toBe(0);
      expect(users.values[USER]).toBeNull();
    });

    it('refuses a missing resource and a double confirmation', async () => {
      const { service, upload } = make();
      const ticket = await service.sign(player, 'avatar', USER);
      await expect(service.confirm(player, 'avatar', USER, ticket.params.public_id)).rejects.toThrow(/introuvable/);
      const done = await upload(player, 'avatar', USER);
      await expect(service.confirm(player, 'avatar', USER, done.asset.publicId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('records a signed row at sign time and promotes it on confirmation', async () => {
      const { service, cloud, assets } = make();
      const ticket = await service.sign(player, 'avatar', USER);
      const signed = [...assets.values()][0];
      expect(signed).toMatchObject({
        publicId: ticket.params.public_id,
        status: 'signed',
        uploadedById: USER,
        targetId: USER,
        purpose: 'avatar',
      });
      expect(signed.expiresAt.getTime() - signed.createdAt.getTime()).toBe(24 * 3600 * 1000);
      expect((await service.list({})).total).toBe(0);

      cloud.upload(ticket.params.public_id);
      const res = await service.confirm(player, 'avatar', USER, ticket.params.public_id);
      expect(assets.size).toBe(1);
      expect(res.asset.id).toBe(signed.id);
      expect(assets.get(signed.id)).toMatchObject({ status: 'approved', expiresAt: null, bytes: 50_000 });
    });

    it('still confirms a ticket signed before sign-time rows existed', async () => {
      const { service, cloud, assets } = make();
      const ticket = await service.sign(player, 'avatar', USER);
      assets.clear();
      cloud.upload(ticket.params.public_id);
      const res = await service.confirm(player, 'avatar', USER, ticket.params.public_id);
      expect(res.status).toBe('approved');
      expect(assets.size).toBe(1);
    });

    it('caps the signed but unconfirmed uploads of one user', async () => {
      const { service } = make();
      for (let i = 0; i < 20; i++) await service.sign(player, 'avatar', USER);
      await expect(service.sign(player, 'avatar', USER)).rejects.toMatchObject({ status: 429 });
      // Other users are not affected.
      await expect(service.sign(captain, 'avatar', CAPTAIN)).resolves.toBeDefined();
    });

    it('re-checks permissions at confirmation', async () => {
      const { service, cloud } = make();
      const ticket = await service.sign(player, 'avatar', USER);
      cloud.upload(ticket.params.public_id);
      await expect(service.confirm(captain, 'avatar', USER, ticket.params.public_id)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('replacement and removal', () => {
    it('replacing destroys the previous tracked asset', async () => {
      const { upload, cloud, assets, users } = make();
      const first = await upload(player, 'avatar', USER);
      const second = await upload(player, 'avatar', USER);
      expect(users.values[USER]).toBe(second.url);
      expect(cloud.destroyed).toEqual([first.asset.publicId]);
      expect([...assets.values()].map((a) => a.publicId)).toEqual([second.asset.publicId]);
    });

    it("never destroys another record's asset copied into the field", async () => {
      const { service, upload, cloud, users, assets } = make();
      const theirs = await upload(captain, 'avatar', CAPTAIN);
      // The player points his avatar at the captain's upload (PATCH /users/:id).
      users.values[USER] = theirs.url;
      await service.removeFromTarget(player, 'avatar', USER);
      await upload(player, 'avatar', USER);
      expect(cloud.destroyed).toEqual([]);
      expect(users.values[CAPTAIN]).toBe(theirs.url);
      expect([...assets.values()].some((a) => a.id === theirs.asset.id)).toBe(true);
    });

    it('never destroys images we did not upload (seed Cloudinary URL, MLBB CDN)', async () => {
      const { upload, cloud, teams, seasons } = make();
      await upload(admin('admin.esport'), 'team', TEAM);
      await upload(admin('admin.seasons'), 'season', SEASON);
      expect(cloud.destroyed).toEqual([]);
      expect(teams.values[TEAM]).toMatch(/\/mlbb\/team\//);
      expect(seasons.values[SEASON]).toMatch(/\/mlbb\/season\//);
    });

    it('removing clears the field and destroys the asset; only when approved-level', async () => {
      const { service, upload, cloud, users, assets } = make();
      const res = await upload(player, 'avatar', USER);
      await expect(service.removeFromTarget(captain, 'avatar', USER)).rejects.toBeInstanceOf(ForbiddenException);
      await service.removeFromTarget(player, 'avatar', USER);
      expect(users.values[USER]).toBeNull();
      expect(cloud.destroyed).toEqual([res.asset.publicId]);
      expect(assets.size).toBe(0);
      await expect(service.removeFromTarget(admin('sponsors.manage'), 'sponsor', null)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('keeps the tracking row when Cloudinary cannot destroy (retry from the library)', async () => {
      const { upload, cloud, assets } = make();
      await upload(player, 'avatar', USER);
      (cloud.client.destroy as jest.Mock).mockRejectedValueOnce(new Error('down'));
      await upload(player, 'avatar', USER);
      expect(assets.size).toBe(2);
    });
  });

  describe('pending community team images', () => {
    it('keeps the public image until an admin approves', async () => {
      const { service, upload, teams, cloud } = make();
      const seed = teams.values[TEAM];
      const res = await upload(captain, 'team', TEAM);
      expect(res).toMatchObject({ status: 'pending', applied: false });
      expect(teams.values[TEAM]).toBe(seed);
      const state = await service.targetState(captain, 'team', TEAM);
      expect(state.pending?.id).toBe(res.asset.id);
      expect(state.canPasteUrl).toBe(false);
      await expect(service.removeFromTarget(captain, 'team', TEAM)).rejects.toBeInstanceOf(ForbiddenException);

      const approved = await service.approve(admin('admin.media'), res.asset.id);
      expect(approved.status).toBe('approved');
      expect(teams.values[TEAM]).toBe(res.url);
      // The seed image is not ours: never destroyed.
      expect(cloud.destroyed).toEqual([]);
    });

    it('a newer proposal supersedes the previous pending one', async () => {
      const { upload, cloud, assets } = make();
      const a = await upload(captain, 'team', TEAM);
      const b = await upload(captain, 'team', TEAM);
      expect(cloud.destroyed).toEqual([a.asset.publicId]);
      expect([...assets.values()].map((r) => r.id)).toEqual([b.asset.id]);
    });

    it('rejecting destroys the image and keeps the row for history', async () => {
      const { service, upload, teams, cloud, assets } = make();
      const seed = teams.values[TEAM];
      const res = await upload(captain, 'team', TEAM);
      const rejected = await service.reject(admin('admin.media'), res.asset.id, ' offensive ');
      expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'offensive', destroyed: true });
      expect(cloud.destroyed).toEqual([res.asset.publicId]);
      expect(teams.values[TEAM]).toBe(seed);
      expect(assets.size).toBe(1);
      await expect(service.approve(admin('admin.media'), res.asset.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('esport team captains publish directly', async () => {
      const { upload, teams } = make();
      const res = await upload(captain, 'team', ESPORT_TEAM);
      expect(res.status).toBe('approved');
      expect(teams.values[ESPORT_TEAM]).toBe(res.url);
    });
  });

  describe('deleteAsset and library', () => {
    it('an uploader deletes his own unused upload, not someone else\'s nor an image in use', async () => {
      const { service, upload, cloud } = make();
      const unattached = await upload(admin('admin.seasons'), 'season', null);
      const inUse = await upload(player, 'avatar', USER);
      await expect(service.deleteAsset(player, unattached.asset.id)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.deleteAsset(player, inUse.asset.id)).rejects.toThrow(/utilisée/);
      await service.deleteAsset(admin('admin.seasons'), unattached.asset.id);
      expect(cloud.destroyed).toEqual([unattached.asset.publicId]);
    });

    it('admin.media deletes an image in use and clears its target', async () => {
      const { service, upload, users, logs } = make();
      const res = await upload(player, 'avatar', USER);
      await service.deleteAsset(admin('admin.media'), res.asset.id);
      expect(users.values[USER]).toBeNull();
      expect(logs[0]).toMatchObject({ action: 'media.delete', target: `avatar:${USER}` });
    });

    it('lists with filters, usage, labels and counts, without writing', async () => {
      const { service, upload, seasons, prisma } = make();
      const created = await upload(admin('admin.seasons'), 'season', null);
      await upload(captain, 'team', TEAM);
      await upload(player, 'avatar', USER);
      await service.sign(player, 'avatar', USER); // never uploaded: not listed
      // The season form saved the uploaded URL on a new season.
      seasons.values['64b0000000000000000000ad'] = created.url;
      prisma.mediaAsset.update.mockClear();
      prisma.mediaAsset.create.mockClear();

      const all = await service.list({});
      expect(all.total).toBe(3);
      expect(all.counts).toEqual({ pending: 1, approved: 2, rejected: 0 });
      const season = all.items.find((i) => i.purpose === 'season')!;
      // In use (matched by URL) but linked only by the daily maintenance.
      expect(season).toMatchObject({ inUse: true, targetId: null, uploader: 'admin' });
      expect(prisma.mediaAsset.update).not.toHaveBeenCalled();
      expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
      const pending = await service.list({ status: 'pending' });
      expect(pending.items).toHaveLength(1);
      expect(pending.items[0]).toMatchObject({ purpose: 'team', uploader: 'cap', targetLabel: `label-${TEAM}`, inUse: false });
    });

    it('computes usage with one batched read per target type', async () => {
      const { service, upload, users } = make();
      users.values['64b000000000000000000004'] = null;
      await upload(player, 'avatar', USER);
      await upload(captain, 'avatar', CAPTAIN);
      const readMany = jest.spyOn(users, 'readMany');
      const read = jest.spyOn(users, 'read');
      const page = await service.list({});
      expect(page.items.map((i) => (i as { inUse?: boolean }).inUse)).toEqual([true, true]);
      expect(readMany).toHaveBeenCalledTimes(1);
      expect(readMany.mock.calls[0][0].sort()).toEqual([USER, CAPTAIN].sort());
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('daily maintenance', () => {
    const DAY = 24 * 3600 * 1000;
    const signedAt = new Date(1_700_000_000 * 1000);

    it('destroys and forgets the uploads signed but never confirmed once expired', async () => {
      const { service, upload, cloud, assets } = make();
      const abandoned = await service.sign(player, 'avatar', USER);
      cloud.upload(abandoned.params.public_id); // uploaded, never confirmed
      const neverSent = await service.sign(captain, 'avatar', CAPTAIN);
      const kept = await upload(player, 'avatar', USER);

      // Not expired yet: nothing happens.
      expect((await service.runMaintenance(new Date(signedAt.getTime() + DAY - 1000))).abandoned).toMatchObject({
        found: 0,
        deleted: 0,
      });
      const report = await service.runMaintenance(new Date(signedAt.getTime() + DAY + 1000));
      expect(report.abandoned).toEqual({ found: 2, deleted: 2, failed: 0, skipped: 0 });
      expect(cloud.destroyed.sort()).toEqual([abandoned.params.public_id, neverSent.params.public_id].sort());
      expect(cloud.resources.has(abandoned.params.public_id)).toBe(false);
      expect([...assets.values()].map((a) => a.id)).toEqual([kept.asset.id]);
    });

    it('is bounded per run, keeps rows it could not destroy and waits for Cloudinary', async () => {
      const later = new Date(signedAt.getTime() + 2 * DAY);
      const { service, cloud, assets } = make();
      for (let i = 0; i < 5; i++) await service.sign(player, 'avatar', USER);
      expect((await service.runMaintenance(later, { limit: 2 })).abandoned.deleted).toBe(2);
      expect(assets.size).toBe(3);
      (cloud.client.destroy as jest.Mock).mockRejectedValueOnce(new Error('down'));
      expect((await service.runMaintenance(later, { limit: 2 })).abandoned).toMatchObject({ deleted: 1, failed: 1 });
      expect(assets.size).toBe(2);
      expect((await service.runMaintenance(later, { limit: 10, budgetMs: 0 })).abandoned).toMatchObject({
        deleted: 0,
        skipped: 2,
      });

      const again = make(null);
      await again.prisma.mediaAsset.create({
        data: { publicId: 'mlbb/avatar/x/y_z', status: 'signed', expiresAt: signedAt, purpose: 'avatar' },
      });
      expect(await again.service.sweepAbandoned(later)).toEqual({ found: 1, deleted: 0, failed: 0, skipped: 1 });
      expect(again.assets.size).toBe(1);
    });

    it('links assets uploaded before their target existed', async () => {
      const { service, upload, seasons, assets } = make();
      const created = await upload(admin('admin.seasons'), 'season', null);
      const orphan = await upload(admin('admin.seasons'), 'season', null);
      seasons.values['64b0000000000000000000ad'] = created.url;
      const report = await service.runMaintenance(signedAt);
      expect(report.linked).toEqual({ found: 2, linked: 1 });
      expect(assets.get(created.asset.id).targetId).toBe('64b0000000000000000000ad');
      expect(assets.get(orphan.asset.id).targetId).toBeNull();
    });
  });
});

describe('createCloudinaryClient', () => {
  it('reads resources with basic auth and destroys with a signed request', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/resources/')) return new Response(JSON.stringify({ public_id: 'a/b c' }), { status: 200 });
      return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    });
    const client = createCloudinaryClient('https://api.example.test/', fetchImpl, () => 1_700_000_000);
    await client.getResource(CONFIG, 'a/b c');
    expect(calls[0].url).toBe('https://api.example.test/v1_1/demo/resources/image/upload/a/b%20c?pages=true');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('123:shh').toString('base64')}`,
    );
    expect(await client.destroy(CONFIG, 'mlbb/x')).toBe(true);
    expect(calls[1].url).toBe('https://api.example.test/v1_1/demo/image/destroy');
    const body = new URLSearchParams(String(calls[1].init?.body));
    expect(body.get('public_id')).toBe('mlbb/x');
    expect(body.get('api_key')).toBe('123');
    expect(body.get('signature')).toBe(
      cloudinarySignature({ invalidate: 'true', public_id: 'mlbb/x', timestamp: 1_700_000_000 }, 'shh'),
    );
  });

  it('maps 404 to null and other failures to errors', async () => {
    const client = createCloudinaryClient('https://x', async () => new Response('', { status: 404 }));
    expect(await client.getResource(CONFIG, 'p')).toBeNull();
    const failing = createCloudinaryClient('https://x', async () => new Response('', { status: 500 }));
    await expect(failing.getResource(CONFIG, 'p')).rejects.toThrow(/HTTP 500/);
    await expect(failing.destroy(CONFIG, 'p')).rejects.toThrow(/HTTP 500/);
    const offline = createCloudinaryClient('https://x', async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(offline.getResource(CONFIG, 'p')).rejects.toThrow(/injoignable/);
  });
});
