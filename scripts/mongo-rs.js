// Exécuté par mongosh : initialise le replica set rs0 si nécessaire,
// puis attend que le nœud devienne PRIMARY. Idempotent.
try {
  rs.status();
} catch (e) {
  rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] });
}
for (let i = 0; i < 30; i++) {
  try {
    if (db.hello().isWritablePrimary) {
      quit(0);
    }
  } catch (e) {
    /* en cours d'élection */
  }
  sleep(500);
}
quit(1);
