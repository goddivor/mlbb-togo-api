import { Logger } from '@nestjs/common';
import {
  ACT_BASE,
  MoontonClient,
  SG_BASE,
  actHeaders,
  classifyMoonton,
  jwtExpiry,
  sgHeaders,
} from './moonton.client';
import { samples } from './__fixtures__/battlereport.samples';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTAwMDAwMDB9.c2lnbmF0dXJl';

describe('Moonton headers', () => {
  it('authenticates actgateway with x-token only (no authorization header)', () => {
    const h = actHeaders(JWT);
    expect(h['x-token']).toBe(JWT);
    expect(h['x-lang']).toBe('en');
    expect(h.Origin).toBe('https://www.mobilelegends.com');
    expect(h.Referer).toBe('https://www.mobilelegends.com/');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('strips a Bearer prefix from the stored session', () => {
    expect(actHeaders(`Bearer ${JWT}`)['x-token']).toBe(JWT);
  });

  it('sends authorization + x-token to sg-api, plus app ids for getBaseInfo', () => {
    const h = sgHeaders({ jwt: JWT, forInfo: true });
    expect(h.authorization).toBe(JWT);
    expect(h['x-token']).toBe(JWT);
    expect(h['x-actid']).toBe('2728785');
    expect(h['x-appid']).toBe('2713644');
    expect(h['Content-Type']).toContain('application/x-www-form-urlencoded');
  });

  it('sends no session header to sg-api without a token (sendVc/login)', () => {
    const h = sgHeaders();
    expect(h.authorization).toBeUndefined();
    expect(h['x-token']).toBeUndefined();
  });
});

describe('classifyMoonton', () => {
  it('accepts code 0 only, whatever the HTTP status', () => {
    const r = classifyMoonton(200, samples.stats);
    expect(r).toMatchObject({ ok: true, outcome: 'ok', code: 0 });
    expect(r.data.wc).toBe(188);
  });

  it('detects a refused session (1002 "auth is empty", HTTP 200)', () => {
    expect(classifyMoonton(200, samples.invalidToken)).toMatchObject({
      ok: false,
      outcome: 'token_expired',
      code: 1002,
      message: 'auth is empty',
      data: null,
    });
  });

  it('detects sg-api session refusals (-20020 and HTTP 401)', () => {
    expect(classifyMoonton(200, { code: -20020, msg: 'token不合法' }).outcome).toBe('token_expired');
    expect(classifyMoonton(401, { code: 401, message: 'Unauthorized' }).outcome).toBe('token_expired');
    expect(classifyMoonton(401, null).outcome).toBe('token_expired');
  });

  it('maps 10407 to a decommissioned route, not to an expired session', () => {
    expect(classifyMoonton(200, samples.offline)).toMatchObject({
      ok: false,
      outcome: 'offline',
      code: 10407,
      message: '接口下线',
    });
  });

  it('keeps other codes as generic errors with their message', () => {
    expect(classifyMoonton(200, { code: -20010, msg: 'vc error' })).toMatchObject({
      outcome: 'error',
      code: -20010,
      message: 'vc error',
    });
  });

  it('treats a missing or non-JSON body as unreachable', () => {
    expect(classifyMoonton(502, null).outcome).toBe('unreachable');
    expect(classifyMoonton(200, 'oops').outcome).toBe('unreachable');
  });
});

describe('jwtExpiry', () => {
  it('reads the exp claim', () => {
    expect(jwtExpiry(JWT)?.getTime()).toBe(1790000000 * 1000);
  });
  it('returns null for non-JWT values', () => {
    expect(jwtExpiry('opaque-token')).toBeNull();
    expect(jwtExpiry(null)).toBeNull();
    expect(jwtExpiry('a.bm90LWpzb24.c')).toBeNull();
  });
});

describe('MoontonClient', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());
  afterAll(() => warn.mockRestore());

  const reply = (status: number, body: any) =>
    jest.fn().mockResolvedValue({ status, json: () => Promise.resolve(body) });

  it('GETs actgateway with query params and x-token only', async () => {
    const fetchFn = reply(200, samples.matches);
    const client = new MoontonClient(fetchFn);
    const r = await client.actGet('battlereport/matches/recent', { sid: 40, limit: 10, last_cursor: null }, JWT);

    expect(r.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${ACT_BASE}/battlereport/matches/recent?sid=40&limit=10`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-token']).toBe(JWT);
    expect(init.headers.authorization).toBeUndefined();
  });

  it('logs code and message of a failure without leaking the token', async () => {
    const client = new MoontonClient(reply(200, samples.offline));
    const r = await client.actGet('battlereport/stats', {}, JWT);

    expect(r.outcome).toBe('offline');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('code=10407');
    expect(line).toContain('接口下线');
    expect(line).not.toContain(JWT);
  });

  it('never throws on network errors', async () => {
    const client = new MoontonClient(jest.fn().mockRejectedValue(new Error("fetch failed")));
    const r = await client.sgPost('/base/getBaseInfo', {}, { jwt: JWT, forInfo: true });
    expect(r).toMatchObject({ ok: false, outcome: 'unreachable', data: null });
  });

  it('POSTs sg-api as a form', async () => {
    const fetchFn = reply(200, samples.info);
    const client = new MoontonClient(fetchFn);
    const r = await client.sgPost('/base/getBaseInfo', { roleId: 1, zoneId: 2 }, { jwt: JWT, forInfo: true });
    expect(r.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${SG_BASE}/base/getBaseInfo`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('roleId=1&zoneId=2');
  });
});
