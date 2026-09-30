// Pure helpers for listing a YouTube channel's uploads through the public
// Data API (API-key path, used when no OAuth account is connected).

export interface ChannelVideoItem {
  videoId: string;
  title: string;
  thumbnail?: string;
  privacyStatus: string;
  publishedAt?: string;
  viewCount?: number;
  duration?: string;
}

// Every channel id "UCxxxx" has an "uploads" playlist whose id is "UUxxxx".
export function uploadsPlaylistId(channelId: string): string | null {
  return /^UC[\w-]{20,}$/.test(channelId) ? `UU${channelId.slice(2)}` : null;
}

// Map one `videos.list` item (snippet,status,statistics,contentDetails).
export function mapVideoItem(item: any): ChannelVideoItem | null {
  if (!item?.id) return null;
  const thumbs = item.snippet?.thumbnails || {};
  return {
    videoId: item.id,
    title: item.snippet?.title || 'Sans titre',
    thumbnail: thumbs.medium?.url || thumbs.default?.url || undefined,
    privacyStatus: String(item.status?.privacyStatus || 'public').toUpperCase(),
    publishedAt: item.snippet?.publishedAt || undefined,
    viewCount: item.statistics?.viewCount
      ? parseInt(item.statistics.viewCount, 10)
      : undefined,
    duration: item.contentDetails?.duration || undefined,
  };
}

// The API key only sees public videos: keep them and preserve playlist order.
export function orderPublicVideos(ids: string[], items: any[]): ChannelVideoItem[] {
  const byId = new Map<string, ChannelVideoItem>();
  for (const item of items || []) {
    const mapped = mapVideoItem(item);
    if (mapped && mapped.privacyStatus === 'PUBLIC') byId.set(mapped.videoId, mapped);
  }
  return ids.map((id) => byId.get(id)).filter((v): v is ChannelVideoItem => !!v);
}
