import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';
import { YoutubeOAuthService } from './youtube-oauth.service';

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

// Default channel used to bootstrap the singleton config on first read.
// The admin connects the real channel afterwards; videos are attached to
// admin-created seasons (see StreamSeasonVideo), not seeded here.
const DEFAULT_CHANNEL = 'eternumesports';

@Injectable()
export class StreamService {
  private readonly logger = new Logger(StreamService.name);
  private readonly apiKey = process.env.YOUTUBE_API_KEY || '';

  // Short-lived cache for the "is the channel live?" check (search costs 100
  // quota units, so we avoid hitting it on every page load).
  private liveCache: { at: number; channelId: string; data: any } | null = null;
  private readonly LIVE_TTL = 60_000;

  constructor(
    private prisma: PrismaService,
    private youtube: YoutubeOAuthService,
  ) {}

  // The config is a singleton: at most one document. Create it lazily on first
  // read so the public Stream page always has something to render.
  private async getOrCreate() {
    const existing = await this.prisma.streamConfig.findFirst();
    if (existing) return existing;
    return this.prisma.streamConfig.create({
      data: { youtubeChannel: DEFAULT_CHANNEL },
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
    if (!channelId) return { live: false, videoId: null, title: null };

    const now = Date.now();
    if (
      this.liveCache &&
      this.liveCache.channelId === channelId &&
      now - this.liveCache.at < this.LIVE_TTL
    ) {
      return this.liveCache.data;
    }

    // Prefer the OAuth-connected channel (uses the connected project's quota,
    // no API key needed); fall back to the API key for the default channel.
    if (account) {
      const data = await this.youtube.fetchLive();
      this.liveCache = { at: now, channelId, data };
      return data;
    }

    if (!this.apiKey) return { live: false, videoId: null, title: null };

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
    if (ids.length === 0) return { views: {} };

    // Prefer the OAuth-connected channel (no API key needed).
    if (await this.youtube.hasAccount()) {
      return { views: await this.youtube.fetchViews(idsCsv) };
    }

    if (!this.apiKey) return { views: {} };
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

  /* ---------------- Seasons ↔ videos ---------------- */

  // Public: seasons (created by the admin in the esport module) that have at
  // least one attached video, each with its ordered video list.
  async listPublicSeasons() {
    const links = await this.prisma.streamSeasonVideo.findMany({
      orderBy: [{ seasonId: 'asc' }, { sort: 'asc' }],
    });
    if (links.length === 0) return [];
    const seasonIds = [...new Set(links.map((l) => l.seasonId))];
    const seasons = await this.prisma.esportSeason.findMany({
      where: { id: { in: seasonIds } },
    });
    const byId = new Map(seasons.map((s) => [s.id, s]));
    // Preserve the esport season order (most recent first).
    const ordered = seasons
      .sort((a, b) => (b.startDate?.getTime() || 0) - (a.startDate?.getTime() || 0))
      .map((s) => s.id);
    return ordered
      .filter((id) => byId.has(id))
      .map((id) => ({
        seasonId: id,
        name: byId.get(id)!.name,
        videos: links
          .filter((l) => l.seasonId === id)
          .map((l) => ({
            id: l.videoId,
            title: l.title,
            thumbnail: l.thumbnail || undefined,
            duration: l.duration || undefined,
            date: l.date || undefined,
          })),
      }));
  }

  // Admin: the videos currently attached to a given season.
  async getSeasonVideos(seasonId: string) {
    const links = await this.prisma.streamSeasonVideo.findMany({
      where: { seasonId },
      orderBy: { sort: 'asc' },
    });
    return links.map((l) => ({
      id: l.videoId,
      title: l.title,
      thumbnail: l.thumbnail || undefined,
      duration: l.duration || undefined,
      date: l.date || undefined,
    }));
  }

  // Admin: replace a season's video selection with the provided list.
  async setSeasonVideos(seasonId: string, videos: Partial<StreamVideo>[]) {
    // Guard: the season must exist (created via the esport admin).
    const season = await this.prisma.esportSeason.findUnique({
      where: { id: seasonId },
    });
    if (!season) throw new NotFoundException('Saison introuvable.');

    const cleaned = (videos || [])
      .map((v, i) => ({
        seasonId,
        videoId: this.normalizeVideoId(v.id || ''),
        title: (v.title || '').trim(),
        thumbnail: (v.thumbnail || '').trim(),
        duration: (v.duration || '').trim(),
        date: (v.date || '').trim(),
        sort: i,
      }))
      .filter((v) => v.videoId);

    await this.prisma.streamSeasonVideo.deleteMany({ where: { seasonId } });
    if (cleaned.length > 0) {
      await this.prisma.streamSeasonVideo.createMany({ data: cleaned });
    }
    return this.getSeasonVideos(seasonId);
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
