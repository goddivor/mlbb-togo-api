
const { spawnSync } = require('child_process');
const { ensureMongo } = require('./ensure-mongo');

(async () => {
  await ensureMongo();
  const r = spawnSync('npx nest start --watch', { stdio: 'inherit', shell: true });
  process.exit(r.status == null ? 0 : r.status);
})();
