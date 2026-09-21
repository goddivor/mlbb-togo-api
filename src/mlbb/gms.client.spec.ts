import { GmsClient, GmsError } from './gms.client';

const json = (body: any, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function client(responses: Array<Response | Error>) {
  const c = new GmsClient();
  const calls: Array<{ url: string; init: any }> = [];
  c.fetchFn = jest.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next!;
  }) as any;
  return { c, calls };
}

describe('GmsClient', () => {
  it('posts to the given app/source with a signed body and returns data', async () => {
    const { c, calls } = client([
      json({ data: { server: { enigma: 'secret' } } }),
      json({ code: 0, data: { records: [{ id: 1 }], total: 1 } }),
    ]);
    const data = await c.callSource('2713644', '2777391', { pageSize: 1 }, 'fr');
    expect(data).toEqual({ records: [{ id: 1 }], total: 1 });
    const post = calls[1];
    expect(post.url).toBe('https://api.gms.moontontech.com/api/gms/source/2713644/2777391');
    expect(post.init.method).toBe('POST');
    expect(post.init.body).toBe('{"pageSize":1}');
    expect(post.init.headers['x-lang']).toBe('fr');
    expect(post.init.headers['user-agent']).toMatch(/Mozilla/);
    expect(post.init.headers.authorization).toBe(
      GmsClient.sign('POST', '/api/gms/source/2713644/2777391', '', '{"pageSize":1}', 'secret'),
    );
    expect(post.init.signal).toBeDefined();
  });

  it('still calls unsigned when the signing key is unavailable', async () => {
    const { c, calls } = client([new Error('enigma down'), json({ code: 0, data: { records: [] } })]);
    await expect(c.callSource('2669606', '2756567', {})).resolves.toEqual({ records: [], total: 0 });
    expect(calls[1].init.headers.authorization).toBeUndefined();
  });

  it('throws a GmsError when code !== 0', async () => {
    const { c } = client([json({ data: { server: { enigma: 's' } } }), json({ code: 10407, message: 'offline' })]);
    await expect(c.callSource('2669606', '1', {})).rejects.toMatchObject({ name: 'GmsError', code: 10407 });
  });

  it('throws a GmsError on HTTP errors and network failures', async () => {
    const { c } = client([
      json({ data: { server: { enigma: 's' } } }),
      json({}, 502),
      new Error('timeout'),
    ]);
    await expect(c.callSource('2669606', '1', {})).rejects.toBeInstanceOf(GmsError);
    await expect(c.callSource('2669606', '1', {})).rejects.toThrow('timeout');
  });

  it('signs like www.mobilelegends.com (HMAC-SHA1, base64)', () => {
    expect(GmsClient.sign('post', '/p', '', '', 'k')).toBe(GmsClient.sign('POST', '/p', '', '{}', 'k'));
    expect(GmsClient.sign('POST', '/p', '', '{}', 'k')).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});
