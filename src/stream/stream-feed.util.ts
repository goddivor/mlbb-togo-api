import type { PrismaService } from '../prisma/prisma.service';
import { LEGACY_REGISTRY_KEY, parseRegistry } from '../esport/legacy-import.registry';

/** Ids of the stream videos the legacy import created (read from its registry). */
export function importedVideoIds(registryValue: string | null | undefined): string[] {
  return Object.values(parseRegistry(registryValue).streamVideos ?? {}).filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
}

/** Same handle regardless of case, `@` and surrounding spaces. */
export function sameChannel(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? '').trim().replace(/^@/, '').toLowerCase();
  return norm(a) === norm(b);
}

// Wipe what a YouTube channel fed into the platform: the videos an admin
// attached to seasons and the cached channel metadata. Videos created by the
// legacy import are real archive content, not fed by a channel: they stay.
// The admin-typed channel handle (`youtubeChannel`) is left untouched.
export async function clearChannelFeed(prisma: PrismaService): Promise<void> {
  const registry = await prisma.appSetting.findUnique({ where: { key: LEGACY_REGISTRY_KEY } });
  const keep = importedVideoIds(registry?.value);
  await prisma.streamSeasonVideo.deleteMany({ where: keep.length ? { id: { notIn: keep } } : {} });
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
