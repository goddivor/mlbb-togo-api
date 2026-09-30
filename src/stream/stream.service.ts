import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';
import { YoutubeOAuthService } from './youtube-oauth.service';
import { clearChannelFeed, sameChannel } from './stream-feed.util';
import { orderPublicVideos, uploadsPlaylistId } from './stream-videos.logic';

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

// No channel is invented: the admin connects or configures the real one.
// Videos are attached to admin-created seasons (see StreamSeasonVideo).
const DEFAULT_CHANNEL = '';

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
      // First configuration (empty previous handle) feeds nothing, so nothing to wipe.
      channelChanged = !!current.youtubeChannel && !sameChannel(normalized, current.youtubeChannel);
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

    // Changing the channel wipes everything the previous one fed (selected
    // season videos, featured video, cached channel metadata).
    if (channelChanged) {
      await clearChannelFeed(this.prisma);
      delete data.s1MainVideoId;
      delete data.videos;
      this.liveCache = null;
    }

    // When the channel changes (or has no metadata yet), fetch banner/avatar.
    const handle = data.youtubeChannel ?? current.youtubeChannel;
    if (handle && (channelChanged || !current.channelId || !sameChannel(handle, current.youtubeChannel))) {
      const meta = await this.fetchChannelMeta(handle);
      if (meta) {
        data.channelId = meta.channelId;
        data.channelTitle = meta.channelTitle;
        data.channelAvatar = meta.channelAvatar;
        data.channelBanner = meta.channelBanner;
        this.liveCache = null;
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

  /* ---------------- Channel videos (admin picker) ---------------- */

  // Where the admin picker gets its videos from, and why it may be unavailable.
  async getSourceStatus() {
    const config = await this.getOrCreate();
    const account = await this.youtube.getAccount();
    return {
      oauthConnected: !!account,
      apiKeyConfigured: !!this.apiKey,
      configuredChannel: config.youtubeChannel || '',
      source: account ? 'oauth' : this.apiKey && config.youtubeChannel ? 'apikey' : null,
    };
  }

  // List the channel's uploads. Uses the OAuth connection when there is one
  // (private/unlisted included), else the API key on the configured channel
  // (public videos only). Errors are surfaced, never swallowed into an empty list.
  async listChannelVideos(pageToken?: string) {
    if (await this.youtube.hasAccount()) {
      try {
        return { source: 'oauth', ...(await this.youtube.listVideos(pageToken)) };
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        this.logger.warn(`OAuth video listing failed: ${(e as Error).message}`);
        throw new BadGatewayException(
          `YouTube a refusé la requête : ${(e as Error).message}. Reconnectez la chaîne si le problème persiste.`,
        );
      }
    }

    if (!this.apiKey) {
      throw new BadRequestException(
        'Aucune chaîne connectée et aucune clé YouTube (YOUTUBE_API_KEY) configurée.',
      );
    }
    const config = await this.getOrCreate();
    if (!config.youtubeChannel) {
      throw new BadRequestException('Aucune chaîne YouTube configurée : renseignez-la ou connectez-la.');
    }

    let channelId = config.channelId;
    if (!channelId) {
      const meta = await this.fetchChannelMeta(config.youtubeChannel);
      if (!meta?.channelId) {
        throw new BadRequestException(`Chaîne YouTube introuvable : @${config.youtubeChannel}.`);
      }
      channelId = meta.channelId;
      await this.prisma.streamConfig.update({
        where: { id: config.id },
        data: {
          channelId: meta.channelId,
          channelTitle: meta.channelTitle,
          channelAvatar: meta.channelAvatar,
          channelBanner: meta.channelBanner,
        },
      });
    }
    const uploads = uploadsPlaylistId(channelId);
    if (!uploads) throw new BadRequestException('Identifiant de chaîne YouTube invalide.');

    const playlist = await this.ytGet('playlistItems', {
      part: 'contentDetails',
      playlistId: uploads,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    const ids: string[] = (playlist.items || [])
      .map((i: any) => i.contentDetails?.videoId)
      .filter((v: unknown): v is string => !!v);
    const nextPageToken = playlist.nextPageToken || null;
    const total = playlist.pageInfo?.totalResults || 0;
    if (ids.length === 0) return { source: 'apikey', videos: [], nextPageToken, total };

    const details = await this.ytGet('videos', {
      part: 'snippet,status,statistics,contentDetails',
      id: ids.join(','),
    });
    return {
      source: 'apikey',
      videos: orderPublicVideos(ids, details.items || []),
      nextPageToken,
      total,
    };
  }

  // GET a YouTube Data API endpoint with the API key; failures become a 502
  // carrying YouTube's own reason (quota, invalid key, ...).
  private async ytGet(path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`${YT_BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('key', this.apiKey);
    let res: Response;
    try {
      res = await fetch(url.toString());
    } catch (e) {
      throw new BadGatewayException(`YouTube est injoignable : ${(e as Error).message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = json?.error?.message || `HTTP ${res.status}`;
      this.logger.warn(`YouTube ${path} failed: ${reason}`);
      throw new BadGatewayException(`YouTube a refusé la requête : ${reason}`);
    }
    return json;
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

    // Update rows in place (matched by YouTube id) instead of recreating them:
    // a row keeps its id, which is how the legacy registry recognises the
    // videos it imported. Only the rows that left the selection are deleted.
    const existing = await this.prisma.streamSeasonVideo.findMany({ where: { seasonId } });
    const pool = new Map<string, any[]>();
    for (const row of existing) pool.set(row.videoId, [...(pool.get(row.videoId) ?? []), row]);
    const kept = new Set<string>();
    const created: typeof cleaned = [];
    for (const v of cleaned) {
      const row = pool.get(v.videoId)?.shift();
      if (!row) {
        created.push(v);
        continue;
      }
      kept.add(row.id);
      await this.prisma.streamSeasonVideo.update({
        where: { id: row.id },
        data: { title: v.title, thumbnail: v.thumbnail, duration: v.duration, date: v.date, sort: v.sort },
      });
    }
    const removed = existing.filter((r) => !kept.has(r.id)).map((r) => r.id);
    if (removed.length > 0) {
      await this.prisma.streamSeasonVideo.deleteMany({ where: { id: { in: removed } } });
    }
    if (created.length > 0) {
      await this.prisma.streamSeasonVideo.createMany({ data: created });
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
