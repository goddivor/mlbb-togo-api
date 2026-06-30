# MLBB Togo — Backend (NestJS)

API REST de la plateforme MLBB Togo, construite avec NestJS 10, Prisma et **MongoDB**.

## Prérequis

- Node.js 20+
- **MongoDB** installé (`mongod` + `mongosh`). Prisma exige un **replica set** (même mono-nœud) ; les scripts s'en chargent automatiquement.

## Démarrage (après un clone)

```bash
npm install
cp .env.example .env        # puis renseigne JWT_SECRET et, si besoin, les clés Google
npm run db:setup            # démarre MongoDB + schéma + index + données de référence
npm run dev                 # démarre MongoDB (si besoin) + NestJS en watch → http://localhost:3006/api
```

`npm run db:setup` rend la base **identique** pour tout le monde : il pousse le schéma, crée les index uniques partiels, puis injecte les **données de référence versionnées** (133 héros, l'organisation e-sport et ses équipes, la MTL, les sponsors). Ces données vivent dans `prisma/heroes.json` et `prisma/seed.ts` — donc un clone du repo + `npm run db:setup` reproduit exactement la même base de référence. Les comptes utilisateurs ne sont pas versionnés (chacun crée le sien à la connexion).

Variables d'environnement (`.env`, voir `.env.example`) : `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `GOOGLE_CLIENT_ID/SECRET`, `PORT`, `FRONTEND_URL`.

## Scripts

- `npm run dev` : démarre MongoDB (si besoin) puis NestJS en watch
- `npm run db:setup` : prépare la base à l'identique (schéma + index + seed)
- `npm run seed` : (re)injecte les données de référence (`SEED_DEMO=1` pour des comptes de démo)
- `npm run build` puis `npm run start:prod` : build et exécution de production

## Modèle de données

Schéma Prisma : `prisma/schema.prisma` (provider **mongodb**). MongoDB n'utilise pas de migrations SQL : on synchronise le schéma avec `prisma db push`. Les identifiants optionnels uniques (`googleId`, `mlbbRoleId`) sont protégés par des **index uniques partiels** créés via `prisma/mongo-indexes.js` (un index unique simple refuserait plusieurs comptes sans ces champs). Les listes et objets (héros favoris, badges, stats de jeu, brackets, etc.) sont stockés en chaînes JSON et désérialisés dans les réponses de l'API.

## Endpoints principaux (préfixe `/api`)

| Méthode | Route | Accès |
|---|---|---|
| POST | `/auth/register`, `/auth/login` | public |
| GET | `/auth/me` | JWT |
| GET | `/users`, `/users/leaderboard`, `/users/:id` | public |
| PATCH/DELETE | `/users/:id`, `/users/:id/ban`, `/users/:id/role` | JWT (admin) |
| GET | `/teams`, `/teams/:id` | public |
| POST/PATCH/DELETE | `/teams`, `/teams/:id` | JWT |
| GET | `/posts`, `/posts/:id` | public |
| POST | `/posts`, `/posts/:id/comments` | JWT |
| POST | `/posts/:id/like` | public |
| GET | `/tournaments`, `/tournaments/:id` | public |
| POST/PATCH/DELETE | `/tournaments...` | JWT (admin) |
| GET | `/events`, `/events/:id` | public |
| POST/DELETE | `/events...` | JWT |
| GET | `/matches`, `/matches/:id` | public |
| POST | `/matches` | JWT |
| GET | `/heroes`, `/heroes/:id` | public |
| GET | `/admin/stats`, `/admin/logs`, `/admin/forms` | public |
| POST/PATCH/DELETE | `/admin/...` | JWT (admin / moderator) |
| POST | `/admin/forms/:id/responses` | public |

Règle générale : les lectures (GET) sont publiques, les écritures sont protégées par JWT, et les actions sensibles exigent le rôle `admin` (ou `moderator`).

## Note sur les moteurs Prisma hors-ligne

Le client est épinglé sur Prisma 6.19.2 afin de réutiliser les moteurs déjà présents dans le cache local (`~/.cache/prisma`), ce qui permet de générer le client et migrer sans accès au CDN de Prisma.
