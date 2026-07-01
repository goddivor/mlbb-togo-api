
db.User.createIndex(
  { googleId: 1 },
  { unique: true, name: 'User_googleId_partial', partialFilterExpression: { googleId: { $type: 'string' } } },
);
db.User.createIndex(
  { mlbbRoleId: 1 },
  { unique: true, name: 'User_mlbbRoleId_partial', partialFilterExpression: { mlbbRoleId: { $type: 'number' } } },
);
print('Index partiels User (googleId, mlbbRoleId) en place.');
