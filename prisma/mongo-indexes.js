// Index uniques PARTIELS pour les identités optionnelles du modèle User.
//
// Pourquoi : un index @unique simple (géré par Prisma) refuserait plusieurs
// comptes SANS googleId / mlbbRoleId, car MongoDB considère les champs absents
// comme `null` et interdit les doublons de null. Un index PARTIEL n'indexe que
// les documents où le champ existe → l'unicité ne s'applique qu'aux comptes liés.
//
// À exécuter après `prisma db push` :
//   mongosh "$DATABASE_URL" prisma/mongo-indexes.js
// (idempotent : ré-exécutable sans erreur).

db.User.createIndex(
  { googleId: 1 },
  { unique: true, name: 'User_googleId_partial', partialFilterExpression: { googleId: { $type: 'string' } } },
);
db.User.createIndex(
  { mlbbRoleId: 1 },
  { unique: true, name: 'User_mlbbRoleId_partial', partialFilterExpression: { mlbbRoleId: { $type: 'number' } } },
);
print('Index partiels User (googleId, mlbbRoleId) en place.');
