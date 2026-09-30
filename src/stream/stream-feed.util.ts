import type { PrismaService } from '../prisma/prisma.service';

// Wipe everything a YouTube channel fed into the platform: the videos an admin
// attached to seasons, the featured video and the cached channel metadata.
// The admin-typed channel handle (`youtubeChannel`) is left untouched.
export async function clearChannelFeed(prisma: PrismaService): Promise<void> {
  await prisma.streamSeasonVideo.deleteMany({});
  await prisma.streamConfig.updateMany({
    data: {
      channelId: '',
      channelTitle: '',
      channelAvatar: '',
      channelBanner: '',
      liveTitle: '',
      liveDesc: '',
      s1MainVideoId: '',
      videos: '[]',
    },
  });
}
