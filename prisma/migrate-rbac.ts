/*
 * RBAC production migration (idempotent, safe to re-run).
 *
 *   npx prisma db push          # additive: Role model, User.roleIds, User.isSystemAccount
 *   npm run rbac:migrate        # this script
 *
 * It backfills the new User fields, flags the bootstrap `admin` account as a
 * system account, seeds the Administrateur (+ Modérateur when needed) roles and
 * maps legacy `roleUser` admin/moderator accounts onto them. The same steps run
 * automatically at API boot (disable with RBAC_BOOT_MIGRATION=0).
 */
import { PrismaClient } from '@prisma/client';
import { AccessService } from '../src/access/access.service';

async function main() {
  const prisma = new PrismaClient();
  try {
    const access = new AccessService(prisma as any);
    const res = await access.runMigration();
    console.log(
      `RBAC migration done: ${res.migrated} staff migrated, ` +
        `${res.systemAccounts} system account(s) flagged, ${res.backfilled} user(s) backfilled.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
