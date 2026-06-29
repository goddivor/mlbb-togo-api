-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "avatar" TEXT,
    "rank" TEXT NOT NULL DEFAULT 'warrior',
    "role" TEXT NOT NULL DEFAULT 'fighter',
    "favoriteHeroes" TEXT NOT NULL DEFAULT '[]',
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "mvpCount" INTEGER NOT NULL DEFAULT 0,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "country" TEXT NOT NULL DEFAULT 'Togo',
    "city" TEXT,
    "bio" TEXT,
    "badges" TEXT NOT NULL DEFAULT '[]',
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActive" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "roleUser" TEXT NOT NULL DEFAULT 'user',
    "provider" TEXT NOT NULL DEFAULT 'local',
    "mlbbRoleId" INTEGER,
    "mlbbZoneId" INTEGER,
    "mlbbToken" TEXT,
    "teamId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("avatar", "badges", "bio", "city", "country", "createdAt", "email", "favoriteHeroes", "id", "isBanned", "isOnline", "joinedAt", "lastActive", "losses", "mvpCount", "password", "rank", "role", "roleUser", "streak", "teamId", "updatedAt", "username", "wins") SELECT "avatar", "badges", "bio", "city", "country", "createdAt", "email", "favoriteHeroes", "id", "isBanned", "isOnline", "joinedAt", "lastActive", "losses", "mvpCount", "password", "rank", "role", "roleUser", "streak", "teamId", "updatedAt", "username", "wins" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_mlbbRoleId_key" ON "User"("mlbbRoleId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
