/*
 * Creates (or updates) a dedicated admin account that logs in with a
 * username + password (NOT Google). Credentials are read from env vars so
 * they never end up in the repo or the shell history file.
 *
 * Usage:
 *   ADMIN_USERNAME=monadmin ADMIN_PASSWORD='motdepasseSolide' node prisma/create-admin.js
 *
 * Optional:
 *   ADMIN_EMAIL=...    (defaults to <username>@mlbbtogo.local)
 *   ADMIN_ROLE=admin   (admin | moderator, defaults to admin)
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const email = process.env.ADMIN_EMAIL || `${username}@mlbbtogo.local`;
  const roleUser = process.env.ADMIN_ROLE === 'moderator' ? 'moderator' : 'admin';

  if (!username || !password) {
    console.error(
      'Missing credentials. Run:\n  ADMIN_USERNAME=... ADMIN_PASSWORD=... node prisma/create-admin.js',
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const hashed = await bcrypt.hash(password, 10);
  const existing = await prisma.user.findUnique({ where: { username } });

  if (existing) {
    await prisma.user.update({
      where: { username },
      data: { password: hashed, roleUser, provider: 'local' },
    });
    console.log(`Updated admin account "${username}" (role=${roleUser}).`);
  } else {
    await prisma.user.create({
      data: {
        username,
        email,
        password: hashed,
        roleUser,
        provider: 'local',
        profileSource: 'game',
        country: 'Togo',
      },
    });
    console.log(`Created admin account "${username}" (role=${roleUser}, email=${email}).`);
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
