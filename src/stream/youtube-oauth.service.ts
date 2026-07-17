import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from '../common/utils/crypto.util';

const CLIENT_ID = process.env.YOUTUBE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = process.env.YOUTUBE_OAUTH_REDIRECT_URI;

// readonly → read channel/videos ; force-ssl → create/manage live broadcasts.
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

export interface ChannelVideo {
  videoId: string;
  title: string;
  thumbnail?: string;
  privacyStatus: string;
  publishedAt?: string;
  viewCount?: number;
  duration?: string;
}

@Injectable()
export class YoutubeOAuthService {
  private readonly logger = new Logger(YoutubeOAuthService.name);

  constructor(private prisma: PrismaService) {}

  private newClient() {
    return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  }

  // Step 1: consent URL the admin is redirected to.
  getAuthUrl(): string {
    if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
      throw new BadRequestException('YouTube OAuth is not configured');
    }
    return this.newClient().generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      include_granted_scopes: true,
    });
  }

  // Step 2: exchange the returned code, fetch channel info, persist tokens.
  async handleCallback(code: string) {
    const client = this.newClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.access_token) {
      throw new BadRequestException('Failed to obtain access token');
    }
    client.setCredentials(tokens);

    const youtube = google.youtube({ version: 'v3', auth: client });
    const resp = await youtube.channels.list({
      part: ['snippet', 'brandingSettings'],
      mine: true,
    });
    const channel = resp.data.items?.[0];
    if (!channel?.id) {
      throw new BadRequestException('No YouTube channel found for this account');
    }
    const thumbs = channel.snippet?.thumbnails || {};
    const avatar =
      thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';
    const banner =
      channel.brandingSettings?.image?.bannerExternalUrl || '';

    const existing = await this.prisma.youtubeAccount.findUnique({
      where: { channelId: channel.id },
    });
    const refreshToken =
      tokens.refresh_token ||
      (existing ? decrypt(existing.refreshToken) : '');

    const data = {
      channelTitle: channel.snippet?.title || '',
      channelThumbnail: avatar,
      channelBanner: banner,
      accessToken: encrypt(tokens.access_token),
      refreshToken: encrypt(refreshToken),
      tokenExpiresAt: new Date(tokens.expiry_date || Date.now() + 3600_000),
      scope: (tokens.scope || SCOPES.join(' ')),
      isConnected: true,
      connectedAt: new Date(),
    };

    if (existing) {
      await this.prisma.youtubeAccount.update({
        where: { channelId: channel.id },
        data,
      });
    } else {
      await this.prisma.youtubeAccount.create({
        data: { channelId: channel.id, ...data },
      });
    }
    return { channelId: channel.id, channelTitle: data.channelTitle };
  }

  async getAccount() {
    return this.prisma.youtubeAccount.findFirst({ where: { isConnected: true } });
  }

  // Public-facing status (no secrets).
  async getStatus() {
    const acc = await this.getAccount();
    if (!acc) return { connected: false };
    return {
      connected: true,
      channelId: acc.channelId,
      channelTitle: acc.channelTitle,
      channelThumbnail: acc.channelThumbnail,
      channelBanner: acc.channelBanner,
      connectedAt: acc.connectedAt,
      liveStatus: acc.liveStatus || '',
      liveWatchUrl: acc.liveWatchUrl || '',
      liveBroadcastId: acc.liveBroadcastId || '',
    };
  }

  async disconnect() {
    const acc = await this.getAccount();
    if (!acc) return { connected: false };
    try {
      const client = this.newClient();
      client.setCredentials({ access_token: decrypt(acc.accessToken) });
      await client.revokeCredentials();
    } catch {
      /* best effort */
    }
    await this.prisma.youtubeAccount.delete({ where: { id: acc.id } });
    return { connected: false };
  }

  // Return an authed googleapis client, refreshing the access token if needed.
  private async authedClient(acc: any) {
    const client = this.newClient();
    if (new Date() >= acc.tokenExpiresAt) {
      client.setCredentials({ refresh_token: decrypt(acc.refreshToken) });
      const { credentials } = await client.refreshAccessToken();
      if (credentials.access_token) {
        await this.prisma.youtubeAccount.update({
          where: { id: acc.id },
          data: {
            accessToken: encrypt(credentials.access_token),
            tokenExpiresAt: new Date(credentials.expiry_date || Date.now() + 3600_000),
          },
        });
        client.setCredentials({ access_token: credentials.access_token });
      }
    } else {
      client.setCredentials({ access_token: decrypt(acc.accessToken) });
    }
    return client;
  }

  // List the connected channel's uploaded videos (for Season 1 selection).
  async listVideos(pageToken?: string, maxResults = 50) {
    const acc = await this.getAccount();
    if (!acc) throw new BadRequestException('No connected channel');
    const client = await this.authedClient(acc);
    const youtube = google.youtube({ version: 'v3', auth: client });

    const chan = await youtube.channels.list({
      part: ['contentDetails'],
      mine: true,
    });
    const uploads =
      chan.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return { videos: [], nextPageToken: null, total: 0 };

    const playlist = await youtube.playlistItems.list({
      part: ['contentDetails'],
      playlistId: uploads,
      maxResults,
      pageToken: pageToken || undefined,
    });
    const ids = (playlist.data.items || [])
      .map((i) => i.contentDetails?.videoId)
      .filter((v): v is string => !!v);
    if (ids.length === 0) {
      return {
        videos: [],
        nextPageToken: playlist.data.nextPageToken || null,
        total: playlist.data.pageInfo?.totalResults || 0,
      };
    }

    const details = await youtube.videos.list({
      part: ['snippet', 'status', 'statistics', 'contentDetails'],
      id: ids,
    });
    const videos: ChannelVideo[] = (details.data.items || []).map((v) => ({
      videoId: v.id as string,
      title: v.snippet?.title || 'Sans titre',
      thumbnail:
        v.snippet?.thumbnails?.medium?.url ||
        v.snippet?.thumbnails?.default?.url ||
        undefined,
      privacyStatus: (v.status?.privacyStatus || 'private').toUpperCase(),
      publishedAt: v.snippet?.publishedAt || undefined,
      viewCount: v.statistics?.viewCount
        ? parseInt(v.statistics.viewCount, 10)
        : undefined,
      duration: v.contentDetails?.duration || undefined,
    }));

    return {
      videos,
      nextPageToken: playlist.data.nextPageToken || null,
      total: playlist.data.pageInfo?.totalResults || videos.length,
    };
  }

  // View counts via the connected account's authed client (no API key needed).
  async fetchViews(idsCsv: string): Promise<Record<string, string>> {
    const acc = await this.getAccount();
    if (!acc) return {};
    const ids = (idsCsv || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return {};
    try {
      const client = await this.authedClient(acc);
      const youtube = google.youtube({ version: 'v3', auth: client });
      const resp = await youtube.videos.list({ part: ['statistics'], id: ids });
      const map: Record<string, string> = {};
      for (const it of resp.data.items || []) {
        if (it.id && it.statistics?.viewCount) map[it.id] = it.statistics.viewCount;
      }
      return map;
    } catch (e) {
      this.logger.warn(`fetchViews (oauth) failed: ${(e as Error).message}`);
      return {};
    }
  }

  // Live status via the connected account's authed client (no API key needed).
  async fetchLive(): Promise<{ live: boolean; videoId: string | null; title: string | null }> {
    const acc = await this.getAccount();
    if (!acc) return { live: false, videoId: null, title: null };
    try {
      const client = await this.authedClient(acc);
      const youtube = google.youtube({ version: 'v3', auth: client });
      const resp = await youtube.search.list({
        part: ['snippet'],
        channelId: acc.channelId,
        eventType: 'live',
        type: ['video'],
      });
      const item = (resp.data.items || [])[0];
      if (item?.id?.videoId) {
        return { live: true, videoId: item.id.videoId, title: item.snippet?.title || null };
      }
      return { live: false, videoId: null, title: null };
    } catch (e) {
      this.logger.warn(`fetchLive (oauth) failed: ${(e as Error).message}`);
      return { live: false, videoId: null, title: null };
    }
  }

  async hasAccount(): Promise<boolean> {
    return !!(await this.getAccount());
  }

  // Create a live broadcast + stream, bind them, return the OBS ingestion info.
  async startLive(title: string, description = '', privacy = 'public') {
    const acc = await this.getAccount();
    if (!acc) throw new BadRequestException('No connected channel');
    const client = await this.authedClient(acc);
    const youtube = google.youtube({ version: 'v3', auth: client });

    const startTime = new Date(Date.now() + 60_000).toISOString();

    const broadcast = await youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: { title: title || 'Live', description, scheduledStartTime: startTime },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
        contentDetails: { enableAutoStart: true, enableAutoStop: true },
      },
    });
    const broadcastId = broadcast.data.id as string;

    const stream = await youtube.liveStreams.insert({
      part: ['snippet', 'cdn', 'contentDetails'],
      requestBody: {
        snippet: { title: title || 'Live' },
        cdn: {
          frameRate: 'variable',
          ingestionType: 'rtmp',
          resolution: 'variable',
        },
        contentDetails: { isReusable: true },
      },
    });
    const streamId = stream.data.id as string;
    const ingestion = stream.data.cdn?.ingestionInfo;

    await youtube.liveBroadcasts.bind({
      id: broadcastId,
      part: ['id', 'contentDetails'],
      streamId,
    });

    const watchUrl = `https://www.youtube.com/watch?v=${broadcastId}`;
    await this.prisma.youtubeAccount.update({
      where: { id: acc.id },
      data: {
        liveBroadcastId: broadcastId,
        liveStreamId: streamId,
        liveRtmpUrl: ingestion?.ingestionAddress || '',
        liveStreamKey: encrypt(ingestion?.streamName || ''),
        liveStatus: 'ready',
        liveWatchUrl: watchUrl,
        liveTitle: title || 'Live',
      },
    });

    return {
      broadcastId,
      rtmpUrl: ingestion?.ingestionAddress || '',
      streamKey: ingestion?.streamName || '',
      watchUrl,
      status: 'ready',
    };
  }

  // Re-expose the ingestion info (e.g. admin reopens the page mid-live).
  async getLivePanel() {
    const acc = await this.getAccount();
    if (!acc || !acc.liveBroadcastId) return { active: false };
    return {
      active: true,
      broadcastId: acc.liveBroadcastId,
      rtmpUrl: acc.liveRtmpUrl,
      streamKey: acc.liveStreamKey ? decrypt(acc.liveStreamKey) : '',
      watchUrl: acc.liveWatchUrl,
      status: acc.liveStatus,
      title: acc.liveTitle,
    };
  }

  async stopLive() {
    const acc = await this.getAccount();
    if (!acc || !acc.liveBroadcastId) return { active: false };
    try {
      const client = await this.authedClient(acc);
      const youtube = google.youtube({ version: 'v3', auth: client });
      await youtube.liveBroadcasts.transition({
        broadcastStatus: 'complete',
        id: acc.liveBroadcastId,
        part: ['status'],
      });
    } catch (e) {
      this.logger.warn(`stopLive transition failed: ${(e as Error).message}`);
    }
    await this.prisma.youtubeAccount.update({
      where: { id: acc.id },
      data: {
        liveStatus: 'complete',
        liveBroadcastId: '',
        liveStreamId: '',
        liveRtmpUrl: '',
        liveStreamKey: '',
        liveWatchUrl: '',
      },
    });
    return { active: false };
  }
}
