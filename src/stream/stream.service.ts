import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';

export interface StreamVideo {
  id: string;
  title: string;
  day?: string;
  duration?: string;
  date?: string;
  thumbnail?: string;
}

interface ChannelMeta {
  channelId: string;
  channelTitle: string;
  channelAvatar: string;
  channelBanner: string;
}

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

// Default channel/videos used to bootstrap the singleton config on first read.
// The admin can change all of this from the dashboard afterwards.
const DEFAULT_CHANNEL = 'eternumesports';
const DEFAULT_VIDEOS: StreamVideo[] = [
  { id: 'gmQZwF1e440', title: 'Game 1', day: 'Game 1', duration: '12:34', date: '2025-01-15' },
  { id: 'ig4rgd_XpsI', title: 'Game 1 (bis)', day: 'Game 1', duration: '10:45', date: '2025-01-16' },
  { id: 'RrlV4gdaT-c', title: 'Game 2', day: 'Game 2', duration: '14:20', date: '2025-01-18' },
  { id: 'XUxJ5RDPn50', title: 'Day 7', day: 'Day 7', duration: '18:05', date: '2025-01-22' },
  { id: '0fHem_8aV-c', title: 'Day 9', day: 'Day 9', duration: '15:30', date: '2025-01-24' },
  { id: 'rk1x2zOxN5c', title: 'Day 10', day: 'Day 10', duration: '16:45', date: '2025-01-25' },
  { id: 'CpMvI_7n83I', title: 'Day 12', day: 'Day 12', duration: '20:10', date: '2025-01-27' },
  { id: '5SjS6tOz0Ck', title: 'Third game', day: 'Game 3', duration: '13:55', date: '2025-01-29' },
  { id: 'yEZqiM5uYoM', title: 'Final', day: 'Final', duration: '25:30', date: '2025-02-01' },
];

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);
  private readonly apiKey = process.env.YOUTUBE_API_KEY || '';

  // Short-lived cache for the "is the channel live?" check (search costs 100
  // quota units, so we avoid hitting it on every page load).
  private liveCache: { at: number; channelId: string; data: any } | null = null;
  private readonly LIVE_TTL = 60_000;

  constructor(private prisma: PrismaService) {}

  // The config is a singleton: at most one document. Create it lazily on first
  // read so the public Stream page always has something to render.
  private async getOrCreate() {
    const existing = await this.prisma.streamConfig.findFirst();
    if (existing) return existing;
    return this.prisma.streamConfig.create({
      data: {
        youtubeChannel: DEFAULT_CHANNEL,
        s1MainVideoId: DEFAULT_VIDEOS[0].id,
        videos: toJson(DEFAULT_VIDEOS),
      },
    });
  }

  private serialize(config: any) {
    return {
      id: config.id,
      youtubeChannel: config.youtubeChannel,
      channelId: config.channelId || '',
      channelTitle: config.channelTitle || '',
      channelAvatar: config.channelAvatar || '',
      channelBanner: config.channelBanner || '',
      liveTitle: config.liveTitle || '',
      liveDesc: config.liveDesc || '',
      s1MainVideoId: config.s1MainVideoId || '',
      videos: parseJson<StreamVideo[]>(config.videos, []),
      connected: false,
      updatedAt: config.updatedAt,
    };
  }

  async getConfig() {
    const config = this.serialize(await this.getOrCreate());
    // When a YouTube channel is connected via OAuth, its live metadata takes
    // precedence over the manually stored values.
    const account = await this.prisma.youtubeAccount.findFirst({
      where: { isConnected: true },
    });
    if (account) {
      config.connected = true;
      config.channelId = account.channelId;
      config.channelTitle = account.channelTitle || config.channelTitle;
      config.channelAvatar = account.channelThumbnail || config.channelAvatar;
      config.channelBanner = account.channelBanner || config.channelBanner;
    } else {
      config.connected = false;
    }
    return config;
  }

  async updateConfig(dto: UpdateStreamConfigDto) {
    const current = await this.getOrCreate();
    const data: any = {};
    let channelChanged = false;

    if (dto.youtubeChannel !== undefined) {
      const normalized = this.normalizeChannel(dto.youtubeChannel);
      data.youtubeChannel = normalized;
      channelChanged = normalized !== current.youtubeChannel;
    }
    if (dto.liveTitle !== undefined) data.liveTitle = dto.liveTitle.trim();
    if (dto.liveDesc !== undefined) data.liveDesc = dto.liveDesc.trim();
    if (dto.s1MainVideoId !== undefined) {
      data.s1MainVideoId = this.normalizeVideoId(dto.s1MainVideoId);
    }
    if (dto.videos !== undefined) {
      const cleaned = (dto.videos || [])
        .map((v) => ({
          id: this.normalizeVideoId(v.id || ''),
          title: (v.title || '').trim(),
          day: (v.day || '').trim() || undefined,
          duration: (v.duration || '').trim() || undefined,
          date: (v.date || '').trim() || undefined,
          thumbnail: (v.thumbnail || '').trim() || undefined,
        }))
        .filter((v) => v.id);
      data.videos = toJson(cleaned);
    }

    // When the channel changes (or has no metadata yet), fetch banner/avatar.
    const handle = data.youtubeChannel ?? current.youtubeChannel;
    if (channelChanged || !current.channelId) {
      const meta = await this.fetchChannelMeta(handle);
      if (meta) {
        data.channelId = meta.channelId;
        data.channelTitle = meta.channelTitle;
        data.channelAvatar = meta.channelAvatar;
        data.channelBanner = meta.channelBanner;
        this.liveCache = null; // channel changed → invalidate live cache
      }
    }

    const updated = await this.prisma.streamConfig.update({
      where: { id: current.id },
      data,
    });
    return this.serialize(updated);
  }

  // Re-fetch the channel banner/avatar/title from YouTube on demand.
  async refreshChannel() {
    const current = await this.getOrCreate();
    const meta = await this.fetchChannelMeta(current.youtubeChannel);
    if (!meta) return this.serialize(current);
    const updated = await this.prisma.streamConfig.update({
      where: { id: current.id },
      data: {
        channelId: meta.channelId,
        channelTitle: meta.channelTitle,
        channelAvatar: meta.channelAvatar,
        channelBanner: meta.channelBanner,
      },
    });
    this.liveCache = null;
    return this.serialize(updated);
  }

  // Is the channel currently streaming live? Cached for LIVE_TTL.
  async getLive() {
    const account = await this.prisma.youtubeAccount.findFirst({
      where: { isConnected: true },
    });
    const config = await this.getOrCreate();
    const channelId = account?.channelId || config.channelId;
    if (!channelId || !this.apiKey) return { live: false, videoId: null, title: null };

    const now = Date.now();
    if (
      this.liveCache &&
      this.liveCache.channelId === channelId &&
      now - this.liveCache.at < this.LIVE_TTL
    ) {
      return this.liveCache.data;
    }

    let result = { live: false, videoId: null as string | null, title: null as string | null };
    try {
      const url = new URL(`${YT_BASE}/search`);
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('channelId', channelId);
      url.searchParams.set('eventType', 'live');
      url.searchParams.set('type', 'video');
      url.searchParams.set('key', this.apiKey);
      const res = await fetch(url.toString());
      if (res.ok) {
        const json: any = await res.json();
        const item = (json.items || [])[0];
        if (item?.id?.videoId) {
          result = {
            live: true,
            videoId: item.id.videoId,
            title: item.snippet?.title || null,
          };
        }
      }
    } catch (e) {
      this.logger.warn(`Live check failed: ${(e as Error).message}`);
    }

    this.liveCache = { at: now, channelId, data: result };
    return result;
  }

  // Return a { videoId: viewCount } map for the requested ids.
  async getViews(idsCsv: string) {
    const ids = (idsCsv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0 || !this.apiKey) return { views: {} };
    try {
      const url = new URL(`${YT_BASE}/videos`);
      url.searchParams.set('part', 'statistics');
      url.searchParams.set('id', ids.join(','));
      url.searchParams.set('key', this.apiKey);
      const res = await fetch(url.toString());
      if (!res.ok) return { views: {} };
      const json: any = await res.json();
      const views: Record<string, string> = {};
      for (const item of json.items || []) {
        if (item.id && item.statistics?.viewCount) {
          views[item.id] = item.statistics.viewCount;
        }
      }
      return { views };
    } catch (e) {
      this.logger.warn(`Views fetch failed: ${(e as Error).message}`);
      return { views: {} };
    }
  }

  // Resolve a handle (or channel id) to its metadata via the YouTube API.
  private async fetchChannelMeta(handleOrId: string): Promise<ChannelMeta | null> {
    if (!this.apiKey || !handleOrId) return null;
    try {
      const url = new URL(`${YT_BASE}/channels`);
      url.searchParams.set('part', 'snippet,brandingSettings');
      if (/^UC[\w-]{20,}$/.test(handleOrId)) {
        url.searchParams.set('id', handleOrId);
      } else {
        url.searchParams.set('forHandle', handleOrId);
      }
      url.searchParams.set('key', this.apiKey);
      const res = await fetch(url.toString());
      if (!res.ok) {
        this.logger.warn(`Channel meta fetch HTTP ${res.status}`);
        return null;
      }
      const json: any = await res.json();
      const item = (json.items || [])[0];
      if (!item) return null;
      const thumbs = item.snippet?.thumbnails || {};
      const avatar = (thumbs.high || thumbs.medium || thumbs.default || {}).url || '';
      const banner = item.brandingSettings?.image?.bannerExternalUrl || '';
      return {
        channelId: item.id || '',
        channelTitle: item.snippet?.title || '',
        channelAvatar: avatar,
        channelBanner: banner,
      };
    } catch (e) {
      this.logger.warn(`Channel meta fetch failed: ${(e as Error).message}`);
      return null;
    }
  }

  // Strip a channel URL / @ prefix down to the bare handle or channel id.
  private normalizeChannel(input: string): string {
    let v = (input || '').trim();
    const match = v.match(/youtube\.com\/(?:@)?([^/?#]+)/i);
    if (match) v = match[1];
    return v.replace(/^@/, '').trim();
  }

  // Accept a watch URL, an embed URL or a bare id; store the bare id.
  private normalizeVideoId(input: string): string {
    const v = (input || '').trim();
    const byV = v.match(/[?&]v=([^&#]+)/);
    if (byV) return byV[1];
    const byPath = v.match(/(?:youtu\.be|\/embed)\/([^/?#]+)/);
    if (byPath) return byPath[1];
    return v;
  }
}
