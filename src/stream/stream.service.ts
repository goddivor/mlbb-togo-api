import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { parseJson, toJson } from '../common/utils/json.util';
import { UpdateStreamConfigDto } from './dto/update-stream-config.dto';

export interface StreamVideo {
  id: string;
  title: string;
  day?: string;
  duration?: string;
  date?: string;
}

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
      liveTitle: config.liveTitle || '',
      liveDesc: config.liveDesc || '',
      s1MainVideoId: config.s1MainVideoId || '',
      videos: parseJson<StreamVideo[]>(config.videos, []),
      updatedAt: config.updatedAt,
    };
  }

  async getConfig() {
    return this.serialize(await this.getOrCreate());
  }

  async updateConfig(dto: UpdateStreamConfigDto) {
    const current = await this.getOrCreate();
    const data: any = {};

    if (dto.youtubeChannel !== undefined) {
      // Accept a full URL, an @handle or a bare handle; store the bare handle.
      data.youtubeChannel = this.normalizeChannel(dto.youtubeChannel);
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
        }))
        .filter((v) => v.id);
      data.videos = toJson(cleaned);
    }

    const updated = await this.prisma.streamConfig.update({
      where: { id: current.id },
      data,
    });
    return this.serialize(updated);
  }

  // Strip a channel URL / @ prefix down to the bare handle or channel id.
  private normalizeChannel(input: string): string {
    let v = (input || '').trim();
    const match = v.match(/youtube\.com\/(?:@)?([^/?#]+)/i);
    if (match) v = match[1];
    return v.replace(/^@/, '').trim();
  }

  // Accept a watch URL, an embed URL or a bare 11-char id; store the bare id.
  private normalizeVideoId(input: string): string {
    let v = (input || '').trim();
    const byV = v.match(/[?&]v=([^&#]+)/);
    if (byV) return byV[1];
    const byPath = v.match(/(?:youtu\.be|\/embed)\/([^/?#]+)/);
    if (byPath) return byPath[1];
    return v;
  }
}
