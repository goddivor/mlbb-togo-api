import { clearChannelFeed, importedVideoIds, sameChannel } from './stream-feed.util';

function fakePrisma(registryValue: string | null) {
  return {
    appSetting: { findUnique: jest.fn(async () => (registryValue ? { value: registryValue } : null)) },
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

  it('reads ids from a broken registry without throwing', () => {
    expect(importedVideoIds('not json')).toEqual([]);
    expect(importedVideoIds(undefined)).toEqual([]);
  });

  it('compares channel handles case-insensitively', () => {
    expect(sameChannel('EternumEsports', '@eternumesports ')).toBe(true);
    expect(sameChannel('', 'eternum')).toBe(false);
  });
});
