import { StreamService } from './stream.service';

function make(currentHandle: string) {
  const prisma: any = {
    streamConfig: {
      findFirst: jest.fn(async () => ({ id: 'c1', youtubeChannel: currentHandle, channelId: 'UCx' })),
      update: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    appSetting: { findUnique: jest.fn(async () => null) },
    streamSeasonVideo: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  };
  return { service: new StreamService(prisma, {} as any), prisma };
}

describe('StreamService.updateConfig channel changes', () => {
  it('does not wipe anything on the first configuration', async () => {
    const { service, prisma } = make('');
    await service.updateConfig({ youtubeChannel: '@eternumesports' });
    expect(prisma.streamSeasonVideo.deleteMany).not.toHaveBeenCalled();
  });

  it('does not wipe when only the case of the handle changes', async () => {
    const { service, prisma } = make('eternumesports');
    await service.updateConfig({ youtubeChannel: 'EternumEsports' });
    expect(prisma.streamSeasonVideo.deleteMany).not.toHaveBeenCalled();
  });

  it('wipes the feed when switching to another channel', async () => {
    const { service, prisma } = make('eternumesports');
    await service.updateConfig({ youtubeChannel: 'other' });
    expect(prisma.streamSeasonVideo.deleteMany).toHaveBeenCalled();
  });
});

describe('StreamService.setSeasonVideos', () => {
  it('keeps the id of rows that stay selected (legacy registry relies on it)', async () => {
    const prisma: any = {
      esportSeason: { findUnique: jest.fn(async () => ({ id: 's1' })) },
      streamSeasonVideo: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { id: 'r1', videoId: 'aaaaaaaaaaa', seasonId: 's1' },
            { id: 'r2', videoId: 'bbbbbbbbbbb', seasonId: 's1' },
          ])
          .mockResolvedValue([]),
        update: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 1 })),
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const service = new StreamService(prisma, {} as any);
    await service.setSeasonVideos('s1', [{ id: 'aaaaaaaaaaa', title: 'A' }, { id: 'ccccccccccc', title: 'C' }]);
    expect(prisma.streamSeasonVideo.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' } }));
    expect(prisma.streamSeasonVideo.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r2'] } } });
    expect(prisma.streamSeasonVideo.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ videoId: 'ccccccccccc' })] });
  });
});
