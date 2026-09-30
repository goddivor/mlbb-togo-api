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
