import { mapVideoItem, orderPublicVideos, uploadsPlaylistId } from './stream-videos.logic';

describe('stream-videos.logic', () => {
  it('derives the uploads playlist from a channel id', () => {
    expect(uploadsPlaylistId('UCabcdefghijklmnopqrstuv')).toBe('UUabcdefghijklmnopqrstuv');
    expect(uploadsPlaylistId('eternumesports')).toBeNull();
    expect(uploadsPlaylistId('')).toBeNull();
  });

  it('maps a video item and tolerates missing fields', () => {
    expect(mapVideoItem(null)).toBeNull();
    const v = mapVideoItem({
      id: 'abc',
      snippet: { title: 'Final', thumbnails: { medium: { url: 'm.jpg' } }, publishedAt: '2026-01-02T00:00:00Z' },
      status: { privacyStatus: 'public' },
      statistics: { viewCount: '42' },
      contentDetails: { duration: 'PT1H2M3S' },
    });
    expect(v).toMatchObject({ videoId: 'abc', title: 'Final', thumbnail: 'm.jpg', viewCount: 42, privacyStatus: 'PUBLIC' });
    expect(mapVideoItem({ id: 'x' })?.title).toBe('Sans titre');
  });

  it('keeps public videos only and preserves playlist order', () => {
    const items = [
      { id: 'b', snippet: { title: 'B' }, status: { privacyStatus: 'public' } },
      { id: 'a', snippet: { title: 'A' }, status: { privacyStatus: 'public' } },
      { id: 'p', snippet: { title: 'P' }, status: { privacyStatus: 'private' } },
    ];
    expect(orderPublicVideos(['a', 'p', 'b', 'gone'], items).map((v) => v.videoId)).toEqual(['a', 'b']);
  });
});
