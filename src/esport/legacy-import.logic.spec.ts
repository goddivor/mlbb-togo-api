import {
  HERO_FIX_TABLE,
  assignUsernames,
  awardCategoryOf,
  buildGames,
  buildHeroIndex,
  buildMatchPlayers,
  dedupePlayers,
  dedupeTeams,
  formatOf,
  IMPORTED_EMAIL_DOMAIN,
  LEGACY_MATCH_MARKER,
  importedEmail,
  isLegacyMatch,
  laneOf,
  mapSeasons,
  normalizeKey,
  podiumFromBracket,
  postImages,
  resolveHero,
  resolveHeroTable,
  slugifyUsername,
  stageOf,
  typeOf,
  winnerOf,
  youtubeIdFrom,
} from './legacy-import.logic';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

const player = (id: number, name: string, extra: Partial<any> = {}) => ({
  id,
  name,
  role: null,
  team_id: null,
  avatar_url: null,
  custom_title: null,
  created_at: '2025-01-01T00:00:00Z',
  ...extra,
});

describe('name normalization and dedupe', () => {
  it('folds case, accents, spaces and punctuation into one key', () => {
    expect(normalizeKey('Éole_Stayler')).toBe('eolestayler');
    expect(normalizeKey('Eole Stayler')).toBe('eolestayler');
    expect(normalizeKey('AFK-228')).toBe('afk228');
    expect(normalizeKey('Gladiateur ')).toBe('gladiateur');
    expect(normalizeKey(null)).toBe('');
  });

  it('merges the spellings of one person across seasons', () => {
    const people = dedupePlayers([
      player(1, 'Kyle_Ghost', { role: 'Jungle' }),
      player(2, 'Milagross', { role: 'Mid' }),
      player(3, 'Kyle_ghost', { role: 'Roam', avatar_url: 'https://cdn/x.png' }),
    ] as any);
    expect(people).toHaveLength(2);
    const kyle = people.find((p) => p.key === 'kyleghost')!;
    // Latest row wins for the display fields, every spelling is remembered.
    expect(kyle.displayName).toBe('Kyle_ghost');
    expect(kyle.variants).toEqual(['Kyle_Ghost', 'Kyle_ghost']);
    expect(kyle.sourceIds).toEqual([1, 3]);
    expect(kyle.lane).toBe('roam');
    expect(kyle.avatar).toBe('https://cdn/x.png');
  });

  it('ignores rows without a usable name', () => {
    expect(dedupePlayers([player(1, '  '), player(2, '???')] as any)).toEqual([]);
  });

  it('maps their lanes onto ours and drops the unknown ones', () => {
    expect(laneOf('Exp')).toBe('exp');
    expect(laneOf('Jungle')).toBe('jungle');
    expect(laneOf('coach')).toBeNull();
  });
});

describe('usernames of imported profiles', () => {
  it('slugifies the pseudo and builds the placeholder mailbox', () => {
    expect(slugifyUsername('WOD.Darksider0006 :Exp')).toBe('wod-darksider0006-exp');
    expect(slugifyUsername('M A L I K')).toBe('m-a-l-i-k');
    expect(slugifyUsername('???')).toBe('joueur');
    expect(importedEmail('maroel')).toBe('maroel@imported.mlbbtogo.local');
    expect(importedEmail('maroel').endsWith(IMPORTED_EMAIL_DOMAIN)).toBe(true);
  });

  it('suffixes and reports a collision with an existing member', () => {
    const people = dedupePlayers([player(1, 'Maroel'), player(2, 'Joker')] as any);
    const assigned = assignUsernames(people, ['Maroel']);
    expect(assigned.find((a) => a.key === 'maroel')).toEqual({
      key: 'maroel',
      username: 'maroel-2',
      email: 'maroel-2@imported.mlbbtogo.local',
      collidedWith: 'maroel',
    });
    expect(assigned.find((a) => a.key === 'joker')?.collidedWith).toBeNull();
  });

  it('never gives the same username to two imported people', () => {
    const people = dedupePlayers([player(1, 'Moon!'), player(2, 'Moon?')] as any);
    const names = assignUsernames(people, []).map((a) => a.username);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('hero resolution', () => {
  const index = buildHeroIndex([
    { id: 'h1', name: 'Cecilion' },
    { id: 'h2', name: 'Terizla' },
    { id: 'h3', name: 'Minsitthar' },
    { id: 'h4', name: 'Popol and Kupa' },
    { id: 'h5', name: 'Yi Sun-shin' },
  ]);

  it('applies the fix table to their misspellings', () => {
    expect(Object.keys(HERO_FIX_TABLE)).toHaveLength(4);
    expect(resolveHero('Cecillion', index)?.id).toBe('h1');
    expect(resolveHero('Terrizla', index)?.id).toBe('h2');
    expect(resolveHero('Minsithar ', index)?.id).toBe('h3');
    expect(resolveHero('Maikoh et Kupa', index)?.id).toBe('h4');
  });

  it('matches on the normalized name', () => {
    expect(resolveHero('yi sun shin', index)?.name).toBe('Yi Sun-shin');
    expect(resolveHero('Unknown Hero', index)).toBeNull();
    expect(resolveHero('', index)).toBeNull();
  });

  it('separates the unresolved heroes that were actually played', () => {
    const table = [
      { id: 's1', name: 'Cecillion', slug: null },
      { id: 's2', name: 'Ghost Hero', slug: null },
      { id: 's3', name: 'Never Picked', slug: null },
    ];
    const res = resolveHeroTable(table, index, new Set(['s1', 's2']));
    expect(res.resolved.get('s1')?.id).toBe('h1');
    expect(res.unmatched).toEqual(['Ghost Hero', 'Never Picked']);
    // Only a hero someone picked may abort the import.
    expect(res.unmatchedPlayed).toEqual(['Ghost Hero']);
  });
});

describe('season mapping', () => {
  it('numbers the seasons by creation date and keeps one active', () => {
    const seasons = mapSeasons([
      { id: 4, name: 'Saison 3 : au delà des limites', is_active: true, created_at: '2026-07-01T00:00:00Z' },
      { id: 1, name: "Saison 1 : L'éveil du phénix", is_active: false, created_at: '2025-09-17T00:00:00Z' },
      { id: 3, name: 'Saison 2 : Plus Ultra', is_active: false, created_at: '2026-02-23T00:00:00Z' },
    ]);
    expect(seasons.map((s) => [s.sourceId, s.number, s.status])).toEqual([
      [1, 1, 'closed'],
      [3, 2, 'closed'],
      [4, 3, 'active'],
    ]);
    expect(seasons[0].slug).toBe('saison-1-l-eveil-du-phenix');
    expect(seasons.map((s) => s.isActive)).toEqual([false, false, true]);
  });
});

describe('team mapping', () => {
  const team = (id: number, name: string, season: number, logo: string | null = null) => ({
    id,
    name,
    short_name: null,
    logo_url: logo,
    season_id: season,
    created_at: '2025-01-01T00:00:00Z',
  });

  it('keeps one team per name and remembers every source id', () => {
    const teams = dedupeTeams([
      team(2, 'ETERNUM ALPHA', 1, 'https://cdn/old.png'),
      team(6, 'ETERNUM ALPHA', 3, 'https://cdn/new.png'),
      team(11, 'IMMORTALS', 4),
    ] as any);
    expect(teams).toHaveLength(2);
    expect(teams[0].sourceIds).toEqual([2, 6]);
    // Latest logo wins.
    expect(teams[0].image).toBe('https://cdn/new.png');
  });
});

describe('match mapping', () => {
  it('maps their type onto our stage and back onto the legacy type', () => {
    expect(stageOf('league')).toBe('league');
    expect(stageOf('playoff')).toBe('playoff');
    expect(stageOf('scrim')).toBe('scrim');
    expect(stageOf(null)).toBe('scrim');
    expect(typeOf('scrim')).toBe('friendly');
    expect(typeOf('league')).toBe('official');
  });

  it('rounds an even or impossible best_of up to a valid format', () => {
    expect(formatOf(3, 2, 0, 2)).toBe('bo3');
    // Their "BO2" is really a BO3.
    expect(formatOf(2, 2, 0, 2)).toBe('bo3');
    expect(formatOf(2, 1, 0, 1)).toBe('bo3');
    // A "BO1" that ended 2-0 needs a wider format.
    expect(formatOf(1, 2, 0, 0)).toBe('bo3');
    expect(formatOf(1, 1, 0, 1)).toBe('bo1');
    expect(formatOf(5, 3, 1, 4)).toBe('bo5');
    expect(formatOf(null, 0, 0, 0)).toBe('bo1');
  });

  it('derives the winner from the score', () => {
    expect(winnerOf(2, 0, A, B)).toBe(A);
    expect(winnerOf(0, 2, A, B)).toBe(B);
    expect(winnerOf(1, 1, A, B)).toBeNull();
  });

});

describe('games and picks', () => {
  const input = [
    {
      gameId: 'g2',
      gameNumber: 2,
      winnerTeamId: B,
      players: [
        { userId: 'u1', teamId: A, hero: { id: 'h1', name: 'Fredrinn' }, isSub: false },
        { userId: 'u2', teamId: B, hero: { id: 'h2', name: 'Lancelot' }, isSub: true },
      ],
    },
    {
      gameId: 'g1',
      gameNumber: 1,
      winnerTeamId: A,
      players: [
        { userId: 'u1', teamId: A, hero: { id: 'h1', name: 'Fredrinn' }, isSub: false },
        { userId: 'u2', teamId: B, hero: { id: 'h3', name: 'Chou' }, isSub: false },
      ],
    },
  ];

  it('renumbers the games and carries the picks', () => {
    const games = buildGames(input);
    expect(games.map((g) => g.number)).toEqual([1, 2]);
    expect(games[0].winnerTeamId).toBe(A);
    expect(games[0].duration).toBeNull();
    expect(games[0].mvpUserId).toBeNull();
    expect(games[0].picks).toEqual([
      { userId: 'u1', teamId: A, heroId: 'h1', hero: 'Fredrinn', isSub: false },
      { userId: 'u2', teamId: B, heroId: 'h3', hero: 'Chou', isSub: false },
    ]);
    expect(games[1].picks?.[1].isSub).toBe(true);
  });

  it('omits the picks of a game nobody was recorded in', () => {
    const [game] = buildGames([{ gameId: 'g', gameNumber: 1, winnerTeamId: null, players: [] }]);
    expect(game.picks).toBeUndefined();
  });

  it('gives each player his most used hero of the series', () => {
    const rows = buildMatchPlayers(buildGames(input), (id) => (id === 'u1' ? 'exp' : null));
    expect(rows).toHaveLength(2);
    const u1 = rows.find((r) => r.userId === 'u1')!;
    expect(u1).toEqual({ userId: 'u1', teamId: A, hero: 'Fredrinn', heroId: 'h1', role: 'exp' });
    // u2 played two different heroes once each: the first one wins the tie.
    const u2 = rows.find((r) => r.userId === 'u2')!;
    expect(u2.hero).toBe('Chou');
    expect(u2.role).toBeNull();
  });

  it('leaves the hero empty when no pick was recorded', () => {
    const games = buildGames([
      {
        gameId: 'g',
        gameNumber: 1,
        winnerTeamId: A,
        players: [{ userId: 'u9', teamId: A, hero: null, isSub: false }],
      },
    ]);
    expect(buildMatchPlayers(games)).toEqual([
      { userId: 'u9', teamId: A, hero: null, heroId: null, role: null },
    ]);
  });
});

describe('legacy match marker', () => {
  it('recognizes an imported match, even with an admin note after the marker', () => {
    expect(isLegacyMatch(LEGACY_MATCH_MARKER)).toBe(true);
    expect(isLegacyMatch(`${LEGACY_MATCH_MARKER} score revu le 12/01`)).toBe(true);
    expect(isLegacyMatch('note libre')).toBe(false);
    expect(isLegacyMatch(null)).toBe(false);
    expect(isLegacyMatch(undefined)).toBe(false);
  });
});

describe('awards', () => {
  it('maps their free-text titles onto our categories', () => {
    expect(awardCategoryOf('MVP')).toBe('mvp');
    expect(awardCategoryOf('Best Jungler')).toBe('best_jungle');
    expect(awardCategoryOf('Best Roamer')).toBe('best_roam');
    expect(awardCategoryOf('Best Exp laner')).toBe('best_exp');
    expect(awardCategoryOf('Best Mid/Mage')).toBe('best_mid');
    expect(awardCategoryOf('Best Gold Laner')).toBe('best_gold');
    expect(awardCategoryOf('Shōri no Hasha')).toBe('custom');
  });

});

describe('playoffs bracket', () => {
  const rows = [
    { season_id: 1, round: 1, match_order: 1, team1_id: 2, team2_id: 5, winner_id: 2 },
    { season_id: 1, round: 1, match_order: 2, team1_id: 3, team2_id: 4, winner_id: 3 },
    { season_id: 1, round: 2, match_order: 1, team1_id: 2, team2_id: 3, winner_id: 2 },
    { season_id: 1, round: 2, match_order: 2, team1_id: 5, team2_id: 4, winner_id: 4 },
  ];
  const teamIdOf = (n: number) => `team-${n}`;

  it('derives the podium from the last round', () => {
    expect(podiumFromBracket(rows, teamIdOf)).toEqual([
      { placement: 1, teamId: 'team-2' },
      { placement: 2, teamId: 'team-3' },
      { placement: 3, teamId: 'team-4' },
    ]);
  });

  it('returns nothing without a bracket or without a winner', () => {
    expect(podiumFromBracket([], teamIdOf)).toEqual([]);
    expect(
      podiumFromBracket(
        [{ season_id: 1, round: 1, match_order: 1, team1_id: 2, team2_id: 3, winner_id: null }],
        teamIdOf,
      ),
    ).toEqual([]);
  });
});

describe('communications', () => {
  it('parses a YouTube id from every form of their embed url', () => {
    expect(youtubeIdFrom('https://www.youtube.com/watch?v=a3ugOyaVVyI')).toBe('a3ugOyaVVyI');
    expect(youtubeIdFrom('https://m.youtube.com/watch?v=8OUo_aNyKBg')).toBe('8OUo_aNyKBg');
    expect(youtubeIdFrom('https://youtu.be/8OUo_aNyKBg')).toBe('8OUo_aNyKBg');
    expect(youtubeIdFrom('https://www.youtube.com/embed/8OUo_aNyKBg')).toBe('8OUo_aNyKBg');
    expect(youtubeIdFrom('')).toBeNull();
    expect(youtubeIdFrom('https://twitch.tv/mlbbtogo')).toBeNull();
  });

  it('merges the gallery and the cover without duplicates', () => {
    expect(postImages('https://a/1.png', 'https://a/1.png')).toEqual(['https://a/1.png']);
    expect(postImages('https://a/1.png,https://a/2.png', 'https://a/3.png')).toEqual([
      'https://a/1.png',
      'https://a/2.png',
      'https://a/3.png',
    ]);
    expect(postImages(null, null)).toEqual([]);
    expect(postImages('not a url', 'https://a/1.png')).toEqual(['https://a/1.png']);
  });
});

describe('idempotence of the mapping', () => {
  const rows = [
    player(1, 'Kyle_Ghost', { role: 'Jungle', team_id: 2 }),
    player(2, 'Kyle_ghost', { role: 'Jungle', team_id: 6 }),
    player(3, 'Milagross', { role: 'Mid', team_id: 2 }),
  ] as any;

  it('produces the same people, usernames and emails on every run', () => {
    const first = dedupePlayers(rows);
    const second = dedupePlayers(rows);
    expect(second).toEqual(first);
    expect(assignUsernames(second, [])).toEqual(assignUsernames(first, []));
    // Re-running must not re-suffix: the profiles of the previous run are not
    // part of the `taken` set, so the same slug and mailbox come back.
    const run1 = assignUsernames(first, ['someRealMember']);
    const run2 = assignUsernames(first, ['someRealMember']);
    expect(run2.map((a) => a.email)).toEqual(run1.map((a) => a.email));
    expect(run1.map((a) => a.email)).toEqual(
      first.map((p) => importedEmail(slugifyUsername(p.displayName))),
    );
  });

  it('re-maps seasons, teams and games to identical rows', () => {
    const seasons = [
      { id: 1, name: 'Saison 1', is_active: false, created_at: '2025-09-17T00:00:00Z' },
      { id: 4, name: 'Saison 2', is_active: true, created_at: '2026-07-01T00:00:00Z' },
    ];
    expect(mapSeasons(seasons)).toEqual(mapSeasons(seasons));
    const teams = [
      { id: 2, name: 'ETERNUM ALPHA', short_name: 'ETMA', logo_url: null, season_id: 1, created_at: '' },
    ] as any;
    expect(dedupeTeams(teams)).toEqual(dedupeTeams(teams));
    const games = [
      {
        gameId: 'g1',
        gameNumber: 1,
        winnerTeamId: A,
        players: [{ userId: 'u1', teamId: A, hero: { id: 'h1', name: 'Chou' }, isSub: false }],
      },
    ];
    expect(buildGames(games)).toEqual(buildGames(games));
    expect(buildMatchPlayers(buildGames(games))).toEqual(buildMatchPlayers(buildGames(games)));
  });
});
