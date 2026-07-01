
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

function standaloneError() {
  console.error(
    [
      '',
      `✗ MongoDB tourne sur le port ${PORT} mais n'est PAS un replica set — or Prisma l'exige.`,
      '  C\'est le cas typique d\'une installation de MongoDB en service (mode standalone).',
      '',
      '  Deux solutions :',
      '',
      '  • Rapide — arrête le service puis relance la commande :',
      '      Windows  : ouvre un terminal Administrateur → `net stop MongoDB` → relance `npm run db:setup`',
      '      Linux    : `sudo systemctl stop mongod` → relance',
      '      macOS    : `brew services stop mongodb-community` → relance',
      '    (le script démarrera alors sa propre instance en replica set, sans toucher à tes données de service.)',
      '',
      '  • Permanent — active la réplication sur ton service :',
      '      dans le fichier de conf MongoDB (mongod.cfg / mongod.conf) ajoute :',
      '          replication:',
      '            replSetName: rs0',
      '      redémarre le service, puis lance une fois : `mongosh --eval "rs.initiate()"`',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

async function ensureMongo() {
  const alreadyUp = await portOpen();

  if (!alreadyUp) {
    if (!have('mongod')) {
      console.error('✗ mongod introuvable. Installe MongoDB : https://www.mongodb.com/try/download/community');
      process.exit(1);
    }
    console.log('▶ Démarrage de MongoDB (replica set rs0)…');
    fs.mkdirSync(MONGO_HOME, { recursive: true });
    fs.mkdirSync(DATA, { recursive: true });

    const args = ['--dbpath', DATA, '--replSet', 'rs0', '--bind_ip', '127.0.0.1', '--port', String(PORT)];
    if (!isWin) args.push('--unixSocketPrefix', MONGO_HOME);

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
  } else {
    console.log(`✓ MongoDB détecté sur ${PORT}`);
  }

  if (!have('mongosh')) {
    console.warn('⚠ mongosh introuvable : impossible de vérifier/initialiser le replica set.');
    return;
  }
  const r = spawnSync(`mongosh --quiet --port ${PORT} "${RS_SCRIPT}"`, { shell: true, stdio: 'ignore' });
  if (r.status === 2) {

    standaloneError();
  }
  if (r.status !== 0) {
    console.error(`✗ Le replica set rs0 n'a pas de PRIMARY (voir ${LOG}).`);
    process.exit(1);
  }
  console.log('✓ MongoDB prêt (replica set rs0)');
}

module.exports = { ensureMongo };

if (require.main === module) {
  ensureMongo().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
