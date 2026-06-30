// Prépare la base MongoDB à l'identique pour quiconque clone le projet :
//   1) démarre MongoDB (replica set)   2) schéma + index   3) données de référence.
// Cross-platform (Linux / macOS / Windows).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensureMongo } = require('./ensure-mongo');

function databaseUrl() {
  try {
    const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const m = env.match(/^DATABASE_URL=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    /* .env absent : on retombe sur la valeur par défaut */
  }
  return 'mongodb://127.0.0.1:27017/mlbb_togo?replicaSet=rs0';
}

function run(cmd, label) {
  console.log(`▶ ${label}`);
  const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`✗ Échec : ${label}`);
    process.exit(r.status || 1);
  }
}

(async () => {
  await ensureMongo();
  const indexes = path.join(__dirname, '..', 'prisma', 'mongo-indexes.js');
  run('npx prisma db push', 'Synchronisation du schéma (prisma db push)');
  run(`mongosh "${databaseUrl()}" "${indexes}"`, 'Création des index uniques partiels');
  run('npm run seed', 'Injection des données de référence (seed)');
  console.log('✓ Base prête. Astuce : SEED_DEMO=1 npm run seed pour des comptes de démonstration.');
})();
