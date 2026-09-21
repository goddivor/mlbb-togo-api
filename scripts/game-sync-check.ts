/* eslint-disable no-console */
/**
 * Dev-only check of every Moonton player route through our own client
 * (src/game/moonton.client.ts), with YOUR game session. Prints, per route, the
 * outcome, Moonton `code`/`message` and a short summary of the fields (never
 * the token, never the full payload).
 *
 * MLBB Academy closed on 30/06/2026: every actgateway `battlereport/*` route
 * answers `10407` and no replacement web API exists, so only getBaseInfo still
 * serves player data (api-research/MOONTON_PLAYER.md). The script still probes
 * the battlereport routes and ends with a verdict, so a comeback is noticed.
 *
 * Get a session: link your game account on the site, or call sg-api
 * base/sendVc + base/login yourself (see api-research/mlbb-upstream.sh) and
 * copy `data.jwt`.
 *
 *   cd backend
 *   MLBB_JWT=<data.jwt> npx ts-node scripts/game-sync-check.ts
 *   MLBB_JWT=<data.jwt> MLBB_SID=40 MLBB_HERO=17 npx ts-node scripts/game-sync-check.ts
 */
import { MoontonClient, MoontonResult, jwtExpiry } from '../src/game/moonton.client';
import {
  mapCareerStats,
  mapFrequentHeroes,
  mapHeroMatches,
  mapMatchDetail,
  mapRecentMatches,
  mapSeasons,
} from '../src/game/game.mappers';
import { mapBaseInfo } from '../src/game/game-sync.service';
import { BATTLEREPORT_AVAILABLE } from '../src/game/game-data.source';

const jwt = (process.env.MLBB_JWT || '').replace(/^Bearer\s+/i, '').trim();
if (!jwt) {
  console.error('Set MLBB_JWT=<data.jwt returned by sg-api base/login>.');
  process.exit(1);
}

const client = new MoontonClient();

function summary(value: any): string {
  if (value === null || value === undefined) return '-';
  if (Array.isArray(value)) return `array(${value.length})${value.length ? ` of {${Object.keys(value[0] ?? {}).join(',')}}` : ''}`;
  if (typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return String(value);
}

const battlereport: Array<{ route: string; outcome: string }> = [];

function report(route: string, r: MoontonResult, mapped?: any) {
  if (route.startsWith('act ')) battlereport.push({ route, outcome: r.outcome });
  console.log(`\n=== ${route}`);
  console.log(`outcome=${r.outcome} http=${r.httpStatus} code=${r.code} message=${r.message ?? '-'}`);
  if (r.ok) {
    console.log(`raw data: ${summary(r.data)}`);
    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
      for (const [k, v] of Object.entries(r.data)) console.log(`  ${k}: ${summary(v)}`);
    }
    if (mapped !== undefined) console.log(`mapped: ${JSON.stringify(mapped, null, 0).slice(0, 600)}`);
  }
}

async function main() {
  const exp = jwtExpiry(jwt);
  console.log(`JWT exp: ${exp ? exp.toISOString() : 'unknown'}${exp && exp < new Date() ? ' (EXPIRED)' : ''}`);

  const info = await client.sgPost('/base/getBaseInfo', {}, { jwt, forInfo: true });
  report('sg-api POST /base/getBaseInfo', info, info.ok ? mapBaseInfo(info.data) : undefined);

  const stats = await client.actGet('battlereport/stats', {}, jwt);
  report('act GET battlereport/stats', stats, stats.ok ? mapCareerStats(stats.data) : undefined);

  const seasonsR = await client.actGet('battlereport/season/list', {}, jwt);
  const seasons = seasonsR.ok ? mapSeasons(seasonsR.data) : [];
  report('act GET battlereport/season/list', seasonsR, seasons);

  const sid = Number(process.env.MLBB_SID) || seasons[0] || 40;
  console.log(`\n(using sid=${sid})`);

  const freq = await client.actGet('battlereport/heros/frequent', { sid, limit: 5 }, jwt);
  report('act GET battlereport/heros/frequent', freq, freq.ok ? mapFrequentHeroes(freq.data) : undefined);

  const recent = await client.actGet('battlereport/matches/recent', { sid, limit: 5 }, jwt);
  const page = recent.ok ? mapRecentMatches(recent.data, sid) : null;
  report('act GET battlereport/matches/recent', recent, page ?? undefined);

  const bid = process.env.MLBB_BID || page?.items[0]?.bid;
  if (bid) {
    const detail = await client.actGet(`battlereport/matches/${bid}`, { sid }, jwt);
    report(`act GET battlereport/matches/${bid}`, detail, detail.ok ? mapMatchDetail(detail.data) : undefined);
  } else {
    console.log('\n=== act GET battlereport/matches/{bid}: skipped (no match id; set MLBB_BID)');
  }

  const hero = Number(process.env.MLBB_HERO) || page?.items[0]?.heroId || 17;
  const heroM = await client.actGet('battlereport/hero/matches', { hid: hero, sid, limit: 5 }, jwt);
  report(`act GET battlereport/hero/matches (hid=${hero})`, heroM, heroM.ok ? mapHeroMatches(heroM.data, sid) : undefined);

  report('act GET battlereport/friends', await client.actGet('battlereport/friends', { sid }, jwt));
  report('act GET battlereport/privacy/settings', await client.actGet('battlereport/privacy/settings', {}, jwt));

  console.log('\n=== Verdict');
  console.log(`getBaseInfo (profile, rank, level): ${info.outcome}`);
  const alive = battlereport.filter((r) => r.outcome === 'ok');
  const offline = battlereport.filter((r) => r.outcome === 'offline');
  if (!alive.length && offline.length) {
    console.log(
      `battlereport/*: ${offline.length}/${battlereport.length} routes offline (10407). MLBB Academy was shut down ` +
        'on 30/06/2026 and Moonton offers no replacement web API: career stats, heroes and match history are ' +
        `not available. The sync uses getBaseInfo only (BATTLEREPORT_AVAILABLE=${BATTLEREPORT_AVAILABLE}).`,
    );
  } else if (alive.length) {
    console.log(
      `battlereport/*: ${alive.length} route(s) answered again (${alive.map((r) => r.route).join(', ')}). ` +
        'Check the payloads, then consider BATTLEREPORT_AVAILABLE=true in src/game/game-data.source.ts and ' +
        'GAME_STATS_ENABLED=true on the frontend.',
    );
  } else {
    console.log(
      'battlereport/*: no route answered (session refused or Moonton unreachable). A Moonton JWT lives about 7 days: ' +
        'rerun with a fresh one. Expected with a valid session: 10407 everywhere (MLBB Academy closed on 30/06/2026).',
    );
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
