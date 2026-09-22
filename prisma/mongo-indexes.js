
db.User.createIndex(
  { googleId: 1 },
  { unique: true, name: 'User_googleId_partial', partialFilterExpression: { googleId: { $type: 'string' } } },
);
db.User.createIndex(
  { mlbbRoleId: 1 },
  { unique: true, name: 'User_mlbbRoleId_partial', partialFilterExpression: { mlbbRoleId: { $type: 'number' } } },
);
print('Index partiels User (googleId, mlbbRoleId) en place.');
db.EsportSeason.createIndex(
  { slug: 1 },
  { unique: true, name: 'EsportSeason_slug_partial', partialFilterExpression: { slug: { $type: 'string' } } },
);
print('Index partiel EsportSeason (slug) en place.');
db.SeasonAward.createIndex(
  { seasonId: 1, category: 1 },
  {
    unique: true,
    name: 'SeasonAward_season_category_partial',
    partialFilterExpression: { category: { $in: ['mvp', 'best_gold', 'best_mid', 'best_jungle', 'best_roam', 'best_exp'] } },
  },
);
print('Index partiel SeasonAward (seasonId, category) en place.');
db.UserFrame.createIndex(
  { userId: 1, frameId: 1, variant: 1 },
  { unique: true, name: 'UserFrame_userId_frameId_variant_key' },
);
db.RewardElection.createIndex(
  { kind: 1, period: 1 },
  { unique: true, name: 'RewardElection_kind_period_key' },
);
print('Index uniques UserFrame (userId, frameId, variant) et RewardElection (kind, period) en place.');
for (const coll of ['Item', 'Emblem', 'BattleSpell']) {
  db.getCollection(coll).createIndex(
    { gameId: 1 },
    { unique: true, name: `${coll}_gameId_partial`, partialFilterExpression: { gameId: { $type: 'number' } } },
  );
}
print('Partial indexes Item/Emblem/BattleSpell (gameId) in place.');
db.EmblemTalent.createIndex(
  { gameId: 1 },
  { unique: true, name: 'EmblemTalent_gameId_partial', partialFilterExpression: { gameId: { $type: 'number' } } },
);
print('Partial index EmblemTalent (gameId) in place.');
