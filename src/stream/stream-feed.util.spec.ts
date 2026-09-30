import { clearChannelFeed, importedVideoIds, sameChannel } from './stream-feed.util';

function fakePrisma(registryValue: string | null, backupValue: string | null = registryValue) {
  return {
    appSetting: {
      findUnique: jest.fn(async ({ where }: any) => {
        const value = where.key === 'legacy.import' ? registryValue : backupValue;
        return value ? { value } : null;
      }),
    },
    streamSeasonVideo: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    streamConfig: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };
}

describe('stream feed cleanup', () => {
  it('keeps the videos created by the legacy import', async () => {
    const p = fakePrisma(JSON.stringify({ version: 1, streamVideos: { '22': 'aaaaaaaaaaaaaaaaaaaaaaa1', '23': 'aaaaaaaaaaaaaaaaaaaaaaa2' } }));
    await clearChannelFeed(p as any);
    expect(p.streamSeasonVideo.deleteMany).toHaveBeenCalledWith({ where: { id: { notIn: ['aaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaa2'] } } });
    expect(p.streamConfig.updateMany).toHaveBeenCalled();
  });

  it('deletes every video when nothing was imported', async () => {
    const p = fakePrisma(null);
    await clearChannelFeed(p as any);
    expect(p.streamSeasonVideo.deleteMany).toHaveBeenCalledWith({ where: {} });
  });

  it('keeps every video when the registry is unreadable and has no readable backup', async () => {
    const p = fakePrisma('{garbage');
    await clearChannelFeed(p as any);
    expect(p.streamSeasonVideo.deleteMany).not.toHaveBeenCalled();
    expect(p.streamConfig.updateMany).toHaveBeenCalled();
  });

  it('falls back to the registry backup when the live registry is unreadable', async () => {
    const p = fakePrisma('{garbage', JSON.stringify({ version: 1, streamVideos: { '22': 'aaaaaaaaaaaaaaaaaaaaaaa1' } }));
    await clearChannelFeed(p as any);
    expect(p.streamSeasonVideo.deleteMany).toHaveBeenCalledWith({ where: { id: { notIn: ['aaaaaaaaaaaaaaaaaaaaaaa1'] } } });
  });

  it('reads ids from a broken registry without throwing', () => {
    expect(importedVideoIds('not json')).toEqual([]);
    expect(importedVideoIds(undefined)).toEqual([]);
  });

  it('compares channel handles case-insensitively', () => {
    expect(sameChannel('EternumEsports', '@eternumesports ')).toBe(true);
    expect(sameChannel('', 'eternum')).toBe(false);
  });
});
