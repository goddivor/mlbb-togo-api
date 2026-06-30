#!/usr/bin/env bash
# Prépare la base MongoDB à l'identique pour quiconque clone le projet :
#   1) démarre MongoDB (replica set)   2) crée le schéma et les index
#   3) injecte les données de référence (héros, e-sport, MTL, sponsors).
set -e
cd "$(dirname "$0")/.."

bash scripts/ensure-mongo.sh

# Récupère DATABASE_URL depuis .env (pour mongosh ; prisma le lit déjà tout seul).
DBURL=$(grep -E '^DATABASE_URL=' .env | head -1 | sed -E 's/^DATABASE_URL=//; s/^"//; s/"$//')

echo "▶ Synchronisation du schéma (prisma db push)…"
npx prisma db push

echo "▶ Création des index uniques partiels…"
mongosh "$DBURL" prisma/mongo-indexes.js

echo "▶ Injection des données de référence (seed)…"
npm run seed

echo "✓ Base prête. Astuce : SEED_DEMO=1 npm run seed pour ajouter des comptes de démonstration."
