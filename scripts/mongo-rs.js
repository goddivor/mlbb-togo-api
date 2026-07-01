
try {
  rs.status();
} catch (e) {
  try {
    rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] });
  } catch (e2) {

    print('NOT_REPLSET: ' + (e2 && e2.message ? e2.message : e2));
    quit(2);
  }
}
for (let i = 0; i < 30; i++) {
  try {
    if (db.hello().isWritablePrimary) {
      quit(0);
    }
  } catch (e) {

  }
  sleep(500);
}
quit(1);
