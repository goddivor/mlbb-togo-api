// Démarre MongoDB (replica set mono-nœud rs0, requis par Prisma) si pas déjà actif.
// Cross-platform (Linux / macOS / Windows) : pas de `--fork` ni de socket Unix sous Windows.
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const PORT = 27017;
const isWin = process.platform === 'win32';
const MONGO_HOME = process.env.MLBB_MONGO_HOME || path.join(os.homedir(), '.mlbb-mongo');
const DATA = process.env.MLBB_MONGO_DATA || path.join(MONGO_HOME, 'data');
const LOG = path.join(MONGO_HOME, 'mongod.log');
const RS_SCRIPT = path.join(__dirname, 'mongo-rs.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => done(true));
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => done(false));
  });
}

function have(cmd) {
  const r = spawnSync(`${isWin ? 'where' : 'which'} ${cmd}`, { shell: true, stdio: 'ignore' });
  return r.status === 0;
}

async function ensureMongo() {
  if (await portOpen()) {
    console.log(`✓ MongoDB déjà actif sur ${PORT}`);
    return;
  }
  if (!have('mongod')) {
    console.error('✗ mongod introuvable. Installe MongoDB : https://www.mongodb.com/try/download/community');
    process.exit(1);
  }

  console.log('▶ Démarrage de MongoDB (replica set rs0)…');
  fs.mkdirSync(MONGO_HOME, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });

  const args = ['--dbpath', DATA, '--replSet', 'rs0', '--bind_ip', '127.0.0.1', '--port', String(PORT)];
  if (!isWin) args.push('--unixSocketPrefix', MONGO_HOME); // socket Unix : POSIX uniquement

  const out = fs.openSync(LOG, 'a');
  const child = spawn(isWin ? 'mongod.exe' : 'mongod', args, {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.on('error', (e) => {
    console.error('✗ Échec du démarrage de mongod :', e.message);
    process.exit(1);
  });
  child.unref();

  for (let i = 0; i < 60 && !(await portOpen()); i++) await sleep(500);
  if (!(await portOpen())) {
    console.error(`✗ MongoDB n'a pas démarré (voir ${LOG})`);
    process.exit(1);
  }

  // Initialise le replica set + attend le primary (script mongosh, idempotent).
  if (have('mongosh')) {
    spawnSync(`mongosh --quiet --port ${PORT} "${RS_SCRIPT}"`, { shell: true, stdio: 'ignore' });
  }
  console.log('✓ MongoDB prêt');
}

module.exports = { ensureMongo };

if (require.main === module) {
  ensureMongo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
