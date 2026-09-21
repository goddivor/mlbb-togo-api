import * as crypto from 'crypto';
import {
  CloudinaryResource,
  MAX_UPLOAD_BYTES,
  buildPublicId,
  buildUploadTicket,
  canPasteUrl,
  cloudinarySignature,
  decideUpload,
  deliveryUrl,
  folderPrefix,
  publicIdFromUrl,
  slotPrefix,
  validateResource,
} from './media.logic';

const USER = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const TEAM = '64b0000000000000000000aa';
const player = { id: USER, permissions: [] as string[] };
const admin = (...permissions: string[]) => ({ id: OTHER, permissions });

describe('decideUpload (permissions and ownership)', () => {
  it('lets a user upload his own avatar only', () => {
    expect(decideUpload('avatar', player, USER)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload('avatar', player, OTHER)).toMatchObject({ allowed: false });
    expect(decideUpload('avatar', player, null)).toEqual({ allowed: false, reason: 'target_required' });
    expect(decideUpload('avatar', admin('admin.users'), USER)).toEqual({ allowed: true, status: 'approved' });
  });

  it('team logo: admins direct, esport captain direct, community captain pending', () => {
    expect(decideUpload('team', admin('admin.esport'), TEAM)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload('team', player, TEAM, { isCaptain: true, teamType: 'esport' })).toEqual({
      allowed: true,
      status: 'approved',
    });
    expect(decideUpload('team', player, TEAM, { isCaptain: true, teamType: 'community' })).toEqual({
      allowed: true,
      status: 'pending',
    });
    expect(decideUpload('team', player, TEAM, { isCaptain: false, teamType: 'community' })).toMatchObject({
      allowed: false,
    });
    // A captain cannot upload for a team that does not exist yet.
    expect(decideUpload('team', player, null, { isCaptain: true })).toMatchObject({ allowed: false });
  });

  it('admin.requests uploads a logo for a team being created, not for an existing one', () => {
    expect(decideUpload('team', admin('admin.requests'), null)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload('team', admin('admin.requests'), TEAM)).toMatchObject({ allowed: false });
  });

  it.each([
    ['sponsor', 'sponsors.manage'],
    ['tournament', 'admin.tournaments'],
    ['season', 'admin.seasons'],
    ['award', 'admin.awards'],
    ['team-staff', 'admin.esport'],
  ] as const)('%s needs %s', (purpose, permission) => {
    expect(decideUpload(purpose, admin(permission), null)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload(purpose, admin('admin.logs'), null)).toMatchObject({ allowed: false });
    expect(decideUpload(purpose, player, null)).toMatchObject({ allowed: false });
  });

  it('match screenshots need a match and admin.matches or matches.validate', () => {
    expect(decideUpload('match', admin('matches.validate'), TEAM)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload('match', admin('admin.matches'), TEAM)).toEqual({ allowed: true, status: 'approved' });
    expect(decideUpload('match', admin('admin.matches'), null)).toMatchObject({ reason: 'target_required' });
    expect(decideUpload('match', player, TEAM)).toMatchObject({ allowed: false });
  });

  it('only admins of a purpose get the paste-a-URL fallback', () => {
    expect(canPasteUrl('season', admin('admin.seasons'))).toBe(true);
    expect(canPasteUrl('avatar', player)).toBe(false);
    expect(canPasteUrl('team', player)).toBe(false);
  });

  it('honours the legacy roleUser fallback (admin = every permission)', () => {
    expect(decideUpload('sponsor', { id: OTHER, roleUser: 'admin' }, null)).toMatchObject({ allowed: true });
  });
});

describe('public ids', () => {
  it('normalises the folder', () => {
    expect(folderPrefix(null)).toBe('');
    expect(folderPrefix('  ')).toBe('');
    expect(folderPrefix('/mlbb-togo//prod/')).toBe('mlbb-togo/prod/');
  });

  it('builds ids inside the purpose / target / uploader slot', () => {
    const id = buildPublicId('mlbb', 'team', TEAM, USER, 'abc123');
    expect(id).toBe(`mlbb/team/${TEAM}/${USER}_abc123`);
    expect(id.startsWith(slotPrefix('mlbb', 'team', TEAM, USER))).toBe(true);
    expect(buildPublicId(null, 'sponsor', null, USER, 'x')).toBe(`sponsor/new/${USER}_x`);
    expect(buildPublicId('f', 'avatar', USER, USER)).toMatch(new RegExp(`^f/avatar/${USER}/${USER}_[a-f0-9]{16}$`));
  });

  it('extracts the public id of Cloudinary URLs only', () => {
    expect(
      publicIdFromUrl('https://res.cloudinary.com/demo/image/upload/c_limit,w_400,h_400/f_auto,q_auto/v1712/mlbb/avatar/a/b_c.png'),
    ).toBe('mlbb/avatar/a/b_c');
    expect(publicIdFromUrl('https://res.cloudinary.com/demo/image/upload/v1/sample.jpg')).toBe('sample');
    expect(publicIdFromUrl('https://akmweb.youngjoygame.com/web/svnres/img/mlbb/homepage/100_ceb.png')).toBeNull();
    expect(publicIdFromUrl('')).toBeNull();
    expect(publicIdFromUrl(null)).toBeNull();
  });
});

describe('signatures', () => {
  it('follows the Cloudinary algorithm (sorted params + secret, SHA-1)', () => {
    // Example of the Cloudinary documentation.
    const sig = cloudinarySignature(
      { eager: 'w_400,h_300,c_pad|w_260,h_200,c_crop', public_id: 'sample_image', timestamp: 1315060510 },
      'abcd',
    );
    expect(sig).toBe(
      crypto
        .createHash('sha1')
        .update('eager=w_400,h_300,c_pad|w_260,h_200,c_crop&public_id=sample_image&timestamp=1315060510abcd')
        .digest('hex'),
    );
  });

  it('ignores api_key, file, cloud_name, resource_type and empty values', () => {
    const base = cloudinarySignature({ public_id: 'x', timestamp: 1 }, 's');
    expect(
      cloudinarySignature({ public_id: 'x', timestamp: 1, api_key: 'k', file: 'f', cloud_name: 'c', resource_type: 'image', folder: '' }, 's'),
    ).toBe(base);
  });

  it('signs the upload ticket fields the browser sends', () => {
    const ticket = buildUploadTicket({
      apiBase: 'https://api.cloudinary.com/',
      cloudName: 'demo',
      apiKey: '123',
      apiSecret: 'secret',
      publicId: 'mlbb/season/new/u_1',
      nowSeconds: 1_700_000_000,
    });
    expect(ticket.uploadUrl).toBe('https://api.cloudinary.com/v1_1/demo/image/upload');
    expect(ticket.params).toMatchObject({
      public_id: 'mlbb/season/new/u_1',
      timestamp: 1_700_000_000,
      allowed_formats: 'jpg,png,webp,gif',
    });
    const { signature, ...signed } = ticket.params;
    expect(signature).toBe(cloudinarySignature(signed, 'secret'));
    expect(JSON.stringify(ticket)).not.toContain('secret');
    expect(ticket.expiresAt).toBe(new Date((1_700_000_000 + 3600) * 1000).toISOString());
  });
});

describe('validateResource', () => {
  const prefix = `mlbb/team/${TEAM}/${USER}_`;
  const ok: CloudinaryResource = {
    public_id: `${prefix}abc`,
    format: 'png',
    resource_type: 'image',
    type: 'upload',
    bytes: 120_000,
    width: 512,
    height: 512,
    secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/x.png',
  };

  it('accepts a valid image', () => {
    expect(validateResource(ok, prefix)).toBeNull();
    expect(validateResource({ ...ok, format: 'gif', pages: 1 }, prefix)).toBeNull();
  });

  it('rejects wrong slot, type, format, size, dimensions and animations', () => {
    expect(validateResource({ ...ok, public_id: `mlbb/team/${TEAM}/${OTHER}_abc` }, prefix)).toBe('wrong_slot');
    expect(validateResource({ ...ok, resource_type: 'raw' }, prefix)).toBe('not_image');
    expect(validateResource({ ...ok, type: 'private' }, prefix)).toBe('not_image');
    expect(validateResource({ ...ok, format: 'svg' }, prefix)).toBe('format');
    expect(validateResource({ ...ok, format: 'pdf' }, prefix)).toBe('format');
    expect(validateResource({ ...ok, bytes: MAX_UPLOAD_BYTES + 1 }, prefix)).toBe('too_large');
    expect(validateResource({ ...ok, width: 8, height: 8 }, prefix)).toBe('dimensions');
    expect(validateResource({ ...ok, width: 7000 }, prefix)).toBe('dimensions');
    expect(validateResource({ ...ok, format: 'gif', pages: 12 }, prefix)).toBe('animated');
  });
});

describe('deliveryUrl', () => {
  it('limits the size and lets Cloudinary pick format and quality', () => {
    expect(deliveryUrl('https://res.cloudinary.com/demo/image/upload/v17/mlbb/a.png', 400)).toBe(
      'https://res.cloudinary.com/demo/image/upload/c_limit,w_400,h_400/f_auto,q_auto/v17/mlbb/a.png',
    );
  });
});
