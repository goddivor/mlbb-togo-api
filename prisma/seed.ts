
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import heroes from './heroes.json';

const prisma = new PrismaClient();

const toJson = (value: any) => JSON.stringify(value ?? null);

// Official MLBB role SVG icons (reused for the lanes).
const LANE_ICON = {
  marksman: 'https://akmweb.youngjoygame.com/web/gms/image/91f817c656908a83c2e24eecb3b70986.svg',
  fighter: 'https://akmweb.youngjoygame.com/web/gms/image/6a246099f7eb83a8856306d8b4c84fc2.svg',
  assassin: 'https://akmweb.youngjoygame.com/web/gms/image/de611167c7310681135f0b4198137bfa.svg',
  mage: 'https://akmweb.youngjoygame.com/web/gms/image/facab1eacb218d767b5acb80304bfafd.svg',
  tank: 'https://akmweb.youngjoygame.com/web/gms/image/a3dbb075b4d8186c29f02f7d47da236a.svg',
};

// The 6 hero classes/roles with their official Moonton SVG/PNG icons.
const HERO_ROLES = [
  { key: 'tank', name: 'Tank', icon: 'https://akmweb.youngjoygame.com/web/gms/image/60638c59536d9505c9c731af13f7fdfd.png', sort: 0 },
  { key: 'fighter', name: 'Fighter', icon: 'https://akmweb.youngjoygame.com/web/gms/image/629e282165d4b63deceaf350426ea440.png', sort: 1 },
  { key: 'assassin', name: 'Assassin', icon: 'https://akmweb.youngjoygame.com/web/gms/image/d0b8b65a47fc43dc7bb2bac447072fd2.png', sort: 2 },
  { key: 'mage', name: 'Mage', icon: 'https://akmweb.youngjoygame.com/web/gms/image/1c6985dd0caec2028ccb6d1b8ca95e0f.png', sort: 3 },
  { key: 'marksman', name: 'Marksman', icon: 'https://akmweb.youngjoygame.com/web/gms/image/025c69a764924f4bac526a2662f1a0b9.png', sort: 4 },
  { key: 'support', name: 'Support', icon: 'https://akmweb.youngjoygame.com/web/gms/image/1e4609b25a4cd63ee5a13015d4058159.png', sort: 5 },
];

// The 5 lanes. `compatibleClasses` = classes that can hold the lane
// (without contradiction: jungle = assassin/fighter, roam = tank/support...).
const LANES = [
  {
    key: 'gold', name: 'Gold Lane', shortName: 'Gold', icon: LANE_ICON.marksman,
    color: '#f5b642', compatibleClasses: ['marksman'], sort: 1,
    description: "La voie inférieure, réservée aux tireurs (marksman). Le gold laner farme l'or et devient le principal dégât à distance en fin de partie.",
  },
  {
    key: 'roam', name: 'Roam', shortName: 'Roam', icon: LANE_ICON.tank,
    color: '#22c55e', compatibleClasses: ['tank', 'support'], sort: 2,
    description: "Le soutien mobile qui parcourt la carte. Tenue par un tank (initiation, contrôle) ou un support (soins, protection) : il ne farme pas et protège l'équipe.",
  },
  {
    key: 'mid', name: 'Mid Lane', shortName: 'Mid', icon: LANE_ICON.mage,
    color: '#a855f7', compatibleClasses: ['mage'], sort: 3,
    description: 'La voie centrale des mages. Position clé pour les dégâts magiques de zone et le contrôle, avec un accès rapide aux deux moitiés de la carte.',
  },
  {
    key: 'jungle', name: 'Jungle', shortName: 'Jungle', icon: LANE_ICON.assassin,
    color: '#ec4899', compatibleClasses: ['assassin', 'fighter'], sort: 4,
    description: "La jungle et ses monstres neutres. Tenue par un assassin (pics de dégâts, ganks) ou un fighter (présence physique). Le jungler contrôle le rythme et les objectifs.",
  },
  {
    key: 'exp', name: 'EXP Lane', shortName: 'EXP', icon: LANE_ICON.fighter,
    color: '#00d4ff', compatibleClasses: ['fighter', 'tank'], sort: 5,
    description: "La voie supérieure, en un contre un. Tenue par un fighter (duel, split-push) ou un tank (résistance, front-line). Le exp laner encaisse et pèse dans les combats.",
  },
];

// Class -> recommended lanes (derived from the compatibilities above).
const CLASS_TO_LANES: Record<string, string[]> = {
  marksman: ['gold'],
  mage: ['mid'],
  assassin: ['jungle'],
  fighter: ['exp', 'jungle'],
  tank: ['roam', 'exp'],
  support: ['roam'],
};

const mockPlayers: any[] = [
  {
    id: '1', username: 'TogoKing', email: 'togoking@mlbb.tg', avatar: null,
    rank: 'mythic', role: 'assassin', favoriteHeroes: ['Gusion', 'Ling', 'Fanny'],
    wins: 1250, losses: 380, winRate: 76.7, mvpCount: 89, streak: 7,
    country: 'Togo', city: 'Lomé', bio: 'Meilleur assassin du Togo 🇹🇬 | Mythic 800+',
    badges: ['mvp', 'streak-5', 'tournament-winner'], joinedAt: '2023-01-15',
    lastActive: '2024-03-28', isOnline: true, teamId: 't1', role_user: 'admin',
  },
  {
    id: '2', username: 'MLBBQueens_TG', email: 'queens@mlbb.tg', avatar: null,
    rank: 'mythical-glory', role: 'mage', favoriteHeroes: ['Kagura', 'Lunox', 'Pharsa'],
    wins: 980, losses: 290, winRate: 77.2, mvpCount: 112, streak: 12,
    country: 'Togo', city: 'Lomé', bio: 'Pro mage player | Kagura main 🏆',
    badges: ['mvp', 'tournament-winner', 'streak-10'], joinedAt: '2022-08-20',
    lastActive: '2024-03-29', isOnline: true, teamId: 't2', role_user: 'moderator',
  },
  {
    id: '3', username: 'ShadowBlade_TG', email: 'shadow@mlbb.tg', avatar: null,
    rank: 'legend', role: 'assassin', favoriteHeroes: ['Hayabusa', 'Lancelot', 'Benedetta'],
    wins: 670, losses: 310, winRate: 68.4, mvpCount: 45, streak: 3,
    country: 'Togo', city: 'Kara', bio: 'Hayabusa one-trick 🔥',
    badges: ['first-win', 'team-leader'], joinedAt: '2023-06-10',
    lastActive: '2024-03-27', isOnline: false, teamId: 't1', role_user: 'user',
  },
  {
    id: '4', username: 'TankMaster_TG', email: 'tank@mlbb.tg', avatar: null,
    rank: 'mythic', role: 'tank', favoriteHeroes: ['Khufra', 'Atlas', 'Tigreal'],
    wins: 890, losses: 420, winRate: 67.9, mvpCount: 34, streak: 4,
    country: 'Togo', city: 'Sokodé', bio: 'Main tank 🛡️',
    badges: ['first-win', 'veteran'], joinedAt: '2022-03-01',
    lastActive: '2024-03-29', isOnline: true, teamId: 't3', role_user: 'user',
  },
  {
    id: '5', username: 'GoldLane_King', email: 'goldlane@mlbb.tg', avatar: null,
    rank: 'epic', role: 'marksman', favoriteHeroes: ['Granger', 'Claude', 'Beatrix'],
    wins: 450, losses: 280, winRate: 61.6, mvpCount: 28, streak: 2,
    country: 'Togo', city: 'Lomé', bio: 'Marksman main 🏹',
    badges: ['first-win'], joinedAt: '2023-11-05',
    lastActive: '2024-03-26', isOnline: false, teamId: null, role_user: 'user',
  },
  {
    id: '6', username: 'SupportGod_TG', email: 'support@mlbb.tg', avatar: null,
    rank: 'mythical-glory', role: 'support', favoriteHeroes: ['Angela', 'Rafaela', 'Floryn'],
    wins: 1100, losses: 350, winRate: 75.9, mvpCount: 67, streak: 9,
    country: 'Togo', city: 'Lomé', bio: 'Support main 💚',
    badges: ['mvp', 'streak-5', 'veteran', 'social-butterfly'], joinedAt: '2022-01-10',
    lastActive: '2024-03-29', isOnline: true, teamId: 't2', role_user: 'user',
  },
  {
    id: '7', username: 'FighterBeast', email: 'fighter@mlbb.tg', avatar: null,
    rank: 'grandmaster', role: 'fighter', favoriteHeroes: ['Yu Zhong', 'Paquito', 'Thamuz'],
    wins: 320, losses: 210, winRate: 60.4, mvpCount: 15, streak: 1,
    country: 'Togo', city: 'Atakpamé', bio: 'Fighter main ⚔️',
    badges: ['first-win'], joinedAt: '2024-01-15',
    lastActive: '2024-03-25', isOnline: false, teamId: null, role_user: 'user',
  },
  {
    id: '8', username: 'MageProdige', email: 'mage@mlbb.tg', avatar: null,
    rank: 'legend', role: 'mage', favoriteHeroes: ['Xavier', 'Valentina', 'Yve'],
    wins: 580, losses: 290, winRate: 66.7, mvpCount: 52, streak: 5,
    country: 'Togo', city: 'Lomé', bio: 'Xavier & Valentina main 🔮',
    badges: ['mvp', 'streak-5'], joinedAt: '2023-04-20',
    lastActive: '2024-03-28', isOnline: true, teamId: 't3', role_user: 'user',
  },
];

const mockTeams: any[] = [
  {
    id: 't1', name: 'Thunder Titans TG', tag: 'TTT', logo: null,
    description: 'Équipe compétitive togolaise', captainId: '1', members: ['1', '3'],
    maxMembers: 7, wins: 45, losses: 12, winRate: 78.9, rank: 1,
    foundedAt: '2023-02-01', region: 'Togo',
    achievements: ['Champion Togo 2024 Q1', 'Top 8 West Africa Cup'],
    isRecruiting: true, lookingFor: ['tank', 'support'],
  },
  {
    id: 't2', name: 'Phoenix Rising TG', tag: 'PRT', logo: null,
    description: 'Rising from the ashes', captainId: '2', members: ['2', '6'],
    maxMembers: 7, wins: 52, losses: 8, winRate: 86.7, rank: 2,
    foundedAt: '2022-09-15', region: 'Togo',
    achievements: ['Vice-Champion Togo 2024'],
    isRecruiting: false, lookingFor: [],
  },
  {
    id: 't3', name: 'Dragon Warriors', tag: 'DW', logo: null,
    description: 'Force et honneur', captainId: '4', members: ['4', '8'],
    maxMembers: 7, wins: 28, losses: 15, winRate: 65.1, rank: 5,
    foundedAt: '2023-08-01', region: 'Togo',
    achievements: ['Top 16 National Championship'],
    isRecruiting: true, lookingFor: ['marksman', 'assassin'],
  },
];

const mockPosts: any[] = [
  {
    id: 'p1', authorId: '1', authorName: 'TogoKing', authorRank: 'mythic',
    category: 'strategies', title: 'Guide: Comment counter les assassins en ranked',
    content: 'Les assassins dominent le meta actuel. Voici mes conseils...',
    likes: 45, views: 234, isPinned: true, createdAt: '2024-03-27T08:00:00Z',
    comments: [
      { id: 'c1', authorId: '3', authorName: 'ShadowBlade_TG', content: 'Super guide!', createdAt: '2024-03-27T10:30:00Z' },
      { id: 'c2', authorId: '4', authorName: 'TankMaster_TG', content: 'Le placement est crucial.', createdAt: '2024-03-27T11:15:00Z' },
    ],
  },
  {
    id: 'p2', authorId: '2', authorName: 'MLBBQueens_TG', authorRank: 'mythical-glory',
    category: 'recruitment', title: '📢 Phoenix Rising recrute un tank!',
    content: 'Recherche tank Mythic+ pour notre roster.',
    likes: 23, views: 156, isPinned: false, createdAt: '2024-03-26T14:00:00Z',
    comments: [
      { id: 'c3', authorId: '4', authorName: 'TankMaster_TG', content: 'Intéressé!', createdAt: '2024-03-26T15:00:00Z' },
    ],
  },
  {
    id: 'p3', authorId: '6', authorName: 'SupportGod_TG', authorRank: 'mythical-glory',
    category: 'guides', title: '📖 Guide Angela: Positionnement',
    content: "Angela est l'un des supports les plus forts du meta...",
    likes: 67, views: 312, isPinned: false, createdAt: '2024-03-25T09:00:00Z',
    comments: [],
  },
  {
    id: 'p4', authorId: '8', authorName: 'MageProdige', authorRank: 'legend',
    category: 'tournaments', title: '🏆 Lomé Championship - Inscriptions ouvertes!',
    content: 'Le plus grand tournoi MLBB du Togo! 500 000 FCFA de prize pool.',
    likes: 89, views: 567, isPinned: true, createdAt: '2024-03-24T12:00:00Z',
    comments: [
      { id: 'c4', authorId: '1', authorName: 'TogoKing', content: 'Thunder Titans sera là!', createdAt: '2024-03-24T16:00:00Z' },
    ],
  },
];

const mockTournaments: any[] = [
  {
    id: 'tour1', name: 'Lomé Championship 2024',
    description: 'Le plus grand tournoi MLBB du Togo avec 500 000 FCFA',
    organizer: 'MLBB Togo Community', status: 'upcoming',
    startDate: '2024-04-15', endDate: '2024-04-20',
    prizePool: '500 000 FCFA', maxTeams: 16,
    registeredTeams: ['t1', 't2', 't3'], format: 'Double Elimination',
    rules: 'Standard MLBB tournament rules', banner: null, brackets: [],
    streamUrl: 'https://twitch.tv/mlbbtogo',
  },
  {
    id: 'tour2', name: 'Weekly Scrim Cup',
    description: 'Scrimmage hebdomadaire',
    organizer: 'Thunder Titans', status: 'ongoing',
    startDate: '2024-03-25', endDate: '2024-03-31',
    prizePool: '50 000 FCFA', maxTeams: 8,
    registeredTeams: ['t1', 't3'], format: 'Round Robin',
    rules: 'Bo3 format', banner: null, brackets: [], streamUrl: null,
  },
  {
    id: 'tour3', name: 'West Africa MLBB Cup',
    description: 'Tournoi régional ouest-africain',
    organizer: 'Moonton Africa', status: 'upcoming',
    startDate: '2024-05-01', endDate: '2024-05-10',
    prizePool: '2 000 000 FCFA', maxTeams: 32,
    registeredTeams: ['t1', 't2'], format: 'Group Stage + Knockout',
    rules: 'International rules', banner: null, brackets: [],
    streamUrl: 'https://youtube.com/mlbbafrica',
  },
];

const mockEvents: any[] = [
  {
    id: 'e1', title: 'Scrim: Thunder Titans vs Phoenix Rising', type: 'scrim',
    description: "Match d'entraînement", date: '2024-03-30', time: '20:00',
    duration: '2h', participants: ['t1', 't2'], organizer: 'MLBB Togo', isPublic: true,
  },
  {
    id: 'e2', title: 'Session de coaching', type: 'coaching',
    description: 'Session gratuite avec Mythical Glory', date: '2024-04-02', time: '18:00',
    duration: '1h30', participants: [], organizer: 'SupportGod_TG', isPublic: true,
  },
  {
    id: 'e3', title: 'Lomé Championship - Groupes', type: 'tournament',
    description: 'Phase de groupes', date: '2024-04-15', time: '14:00',
    duration: '6h', participants: [], organizer: 'MLBB Togo Community', isPublic: true,
  },
];

const mockMatches: any[] = [
  {
    id: 'm1', team1: { id: 't1', name: 'Thunder Titans TG', score: 2 },
    team2: { id: 't3', name: 'Dragon Warriors', score: 1 },
    tournament: 'Weekly Scrim Cup', date: '2024-03-28', status: 'completed',
    mvp: 'TogoKing', duration: '22:15', format: 'Bo3',
    games: [
      { number: 1, winner: 't1', duration: '18:30', mvp: 'TogoKing' },
      { number: 2, winner: 't3', duration: '21:45', mvp: 'MageProdige' },
      { number: 3, winner: 't1', duration: '19:20', mvp: 'ShadowBlade_TG' },
    ],
  },
  {
    id: 'm2', team1: { id: 't2', name: 'Phoenix Rising TG', score: 2 },
    team2: { id: 't1', name: 'Thunder Titans TG', score: 0 },
    tournament: 'Weekly Scrim Cup', date: '2024-03-27', status: 'completed',
    mvp: 'MLBBQueens_TG', duration: '35:00', format: 'Bo3',
    games: [
      { number: 1, winner: 't2', duration: '16:45', mvp: 'MLBBQueens_TG' },
      { number: 2, winner: 't2', duration: '18:15', mvp: 'SupportGod_TG' },
    ],
  },
  {
    id: 'm3', team1: { id: 't2', name: 'Phoenix Rising TG', score: 0 },
    team2: { id: 't3', name: 'Dragon Warriors', score: 0 },
    tournament: 'Lomé Championship 2024', date: '2024-04-15', status: 'upcoming',
    mvp: null, duration: null, format: 'Bo3', games: [],
  },
];

const mockNotifications: any[] = [
  { id: 'n1', type: 'match', title: 'Match à venir', message: 'Votre match commence dans 30 min!', read: false, createdAt: '2024-03-30T19:30:00Z', link: '/matches' },
  { id: 'n2', type: 'team', title: "Invitation d'équipe", message: 'Dragon Warriors vous invite!', read: false, createdAt: '2024-03-29T14:00:00Z', link: '/teams' },
  { id: 'n3', type: 'forum', title: 'Nouveau commentaire', message: 'TankMaster a commenté votre post', read: true, createdAt: '2024-03-27T11:15:00Z', link: '/forum' },
  { id: 'n4', type: 'tournament', title: 'Inscription confirmée', message: 'Inscription au Lomé Championship confirmée!', read: true, createdAt: '2024-03-25T10:00:00Z', link: '/tournaments' },
];

const mockAdminLogs: any[] = [
  { id: 'log_1', action: 'user_ban', admin: 'TogoKing', target: 'FighterBeast', details: 'Compte suspendu pour comportement toxique', timestamp: '2024-03-29T10:00:00Z' },
  { id: 'log_2', action: 'tournament_create', admin: 'TogoKing', target: 'Lomé Championship 2024', details: 'Création du tournoi', timestamp: '2024-03-28T14:30:00Z' },
  { id: 'log_3', action: 'post_delete', admin: 'MLBBQueens_TG', target: 'Post #p5', details: 'Suppression pour spam', timestamp: '2024-03-27T09:15:00Z' },
  { id: 'log_4', action: 'user_promote', admin: 'TogoKing', target: 'MLBBQueens_TG', details: 'Promu modérateur', timestamp: '2024-03-26T16:00:00Z' },
  { id: 'log_5', action: 'team_edit', admin: 'TogoKing', target: 'Thunder Titans TG', details: 'Mise à jour des informations', timestamp: '2024-03-25T11:00:00Z' },
];

const mockFormTemplates: any[] = [
  {
    id: 'form_1', name: 'Inscription Tournoi Lomé', description: "Formulaire d'inscription pour le Lomé Championship",
    fields: [
      { id: 'f1', type: 'text', label: "Nom de l'équipe", required: true, placeholder: 'Ex: Thunder Titans' },
      { id: 'f2', type: 'text', label: 'Nom du capitaine', required: true, placeholder: 'Nom complet' },
      { id: 'f3', type: 'email', label: 'Email du capitaine', required: true, placeholder: 'email@example.com' },
      { id: 'f4', type: 'number', label: 'Nombre de joueurs', required: true, placeholder: '5-7' },
      { id: 'f5', type: 'select', label: "Rang moyen de l'équipe", required: true, options: ['Epic', 'Legend', 'Mythic', 'Mythical Glory', 'Mythical Immortal'] },
      { id: 'f6', type: 'textarea', label: "Message pour l'organisateur", required: false, placeholder: 'Optionnel' },
    ],
    createdAt: '2024-03-20T10:00:00Z', status: 'active', responses: 12,
  },
  {
    id: 'form_2', name: 'Recrutement Équipe', description: 'Formulaire pour rejoindre une équipe',
    fields: [
      { id: 'f1', type: 'text', label: 'Pseudo MLBB', required: true, placeholder: 'Votre pseudo' },
      { id: 'f2', type: 'text', label: 'ID MLBB', required: true, placeholder: 'Ex: 123456789' },
      { id: 'f3', type: 'select', label: 'Rang actuel', required: true, options: ['Epic', 'Legend', 'Mythic', 'Mythical Glory'] },
      { id: 'f4', type: 'select', label: 'Rôle principal', required: true, options: ['Tank', 'Fighter', 'Assassin', 'Mage', 'Marksman', 'Support'] },
      { id: 'f5', type: 'checkbox', label: 'Disponible pour les scrims', required: false },
      { id: 'f6', type: 'file', label: 'Screenshot profil MLBB', required: false },
    ],
    createdAt: '2024-03-18T14:00:00Z', status: 'active', responses: 8,
  },
];

const mockFormResponses: any[] = [
  { id: 'resp_1', formId: 'form_1', data: { "Nom de l'équipe": 'Dragon Warriors', 'Nom du capitaine': 'TankMaster', 'Email du capitaine': 'tank@mlbb.tg', 'Nombre de joueurs': 6, "Rang moyen de l'équipe": 'Mythic' }, submittedAt: '2024-03-25T10:00:00Z' },
  { id: 'resp_2', formId: 'form_1', data: { "Nom de l'équipe": 'Storm Breakers', 'Nom du capitaine': 'StormPlayer', 'Email du capitaine': 'storm@mlbb.tg', 'Nombre de joueurs': 5, "Rang moyen de l'équipe": 'Legend' }, submittedAt: '2024-03-24T14:30:00Z' },
  { id: 'resp_3', formId: 'form_2', data: { 'Pseudo MLBB': 'NewPlayer123', 'ID MLBB': '987654321', 'Rang actuel': 'Epic', 'Rôle principal': 'Mage' }, submittedAt: '2024-03-23T09:00:00Z' },
];

async function main() {
  console.log('🌱 Démarrage du seed MLBB Togo...');

  await prisma.comment.deleteMany();
  await prisma.post.deleteMany();
  await prisma.formResponse.deleteMany();
  await prisma.formTemplate.deleteMany();
  await prisma.match.deleteMany();
  await prisma.event.deleteMany();
  await prisma.tournament.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.adminLog.deleteMany();
  // Heroes and lanes are NOT deleted: they are upserted (idempotent) to
  // preserve data refreshed from MLBB and admin edits.

  await prisma.user.updateMany({ data: { teamId: null } });
  await prisma.user.deleteMany();
  await prisma.team.deleteMany();
  await prisma.esportTeam.deleteMany();
  await prisma.esport.deleteMany();
  await prisma.sponsor.deleteMany();
  await prisma.mtlImage.deleteMany();
  await prisma.mtl.deleteMany();

  // Lanes: created only once. `update: {}` preserves admin edits
  // (description/icon) on re-seeds.
  for (const l of LANES) {
    await prisma.lane.upsert({ where: { key: l.key }, update: {}, create: l });
  }
  console.log(`   - Lanes          : ${LANES.length}`);

  // Hero roles: keep icons in sync on every re-seed.
  for (const r of HERO_ROLES) {
    await prisma.heroRole.upsert({
      where: { key: r.key },
      update: { name: r.name, icon: r.icon, sort: r.sort },
      create: r,
    });
  }
  console.log(`   - Rôles          : ${HERO_ROLES.length}`);

  // Heroes: upsert by name. We do not touch fields enriched by an admin
  // refresh (stats/art/thumb/source); only the base fields are resynced.
  for (const h of heroes as any[]) {
    const role = String(h.role || '').toLowerCase();
    const base = {
      role,
      image: h.image ?? undefined,
      roles: role ? [role] : [],
      laneKeys: CLASS_TO_LANES[role] ?? [],
    };
    await prisma.hero.upsert({
      where: { name: h.name },
      update: base,
      create: { name: h.name, ...base, source: 'seed' },
    });
  }
  console.log(`   - Héros          : ${(heroes as any[]).length}`);

  const eternum = await prisma.esport.create({
    data: {
      name: 'ETERNUM ESPORTS',
      logo: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/1758118659424_nh3e8x.png',
      color: '#E9B84B',
      description: 'Organisation e-sport togolaise sur Mobile Legends: Bang Bang.',
    },
  });
  const esportTeams = [
    { name: 'ETERNUM ALPHA', image: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1772778812/IMG-20260221-WA0018_msfsmp.jpg', sort: 1 },
    { name: 'ETERNUM GAMMA', image: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1772778812/IMG-20260221-WA0015_cqisit.jpg', sort: 2 },
    { name: 'ETERNUM BETA', image: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1772778812/IMG-20260221-WA0013_luw6lj.jpg', sort: 3 },
    { name: 'ETERNUM DELTA', image: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1772778812/IMG-20260221-WA0014_eahmue.jpg', sort: 4 },
    { name: 'ETERNUM EPSILON', image: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1772778812/IMG-20260221-WA0017_zngxww.jpg', sort: 5 },
  ];
  for (const t of esportTeams) {
    await prisma.esportTeam.create({
      data: { ...t, type: 'esport', esportId: eternum.id },
    });
  }
  const sponsors = [
    { logo: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/file_00000000337c61f4846cda7ce7698a3f_mcmh2e.png', sort: 1 },
    { logo: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/Logo_SJ_gaming_final_2_h9wlae.png', sort: 2 },
    { logo: 'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1761489110/cm3u7rlbo00110cmp00ux1yin_hvgm3z.png', sort: 3 },
  ];
  for (const s of sponsors) {
    await prisma.sponsor.create({ data: s });
  }
  console.log(
    `   - E-sport        : 1 org, ${esportTeams.length} équipes, ${sponsors.length} sponsors`,
  );

  const mtl = await prisma.mtl.create({
    data: {
      name: 'Mobile Legends Bang Bang Togo League',
      season: 'Saison 1',
      description:
        "La MTL est la ligue compétitive togolaise de Mobile Legends, opposant les équipes ETERNUM. La Saison 1 s'est déroulée du 17 octobre au 7 décembre 2025 (playoffs).",
      startDate: '2025-10-17',
      endDate: '2025-12-07',
    },
  });
  const mtlImages = [
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/MTL_SAISON_1_20251017_154732_0000_x5n4qo.png',
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/MTL_SAISON_1_20251018_093432_0000_iw2kdb.png',
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/MTL_SAISON_1_20251018_232351_0000_ozo1d9.png',
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1761489896/WhatsApp_Image_2025-10-23_%C3%A0_22.35.28_0edeafab_kr7yih.jpg',
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1761490096/WhatsApp_Image_2025-10-25_%C3%A0_09.07.23_cb02bc9d_womlfq.jpg',
    'https://res.cloudinary.com/dvh5ywcdi/image/upload/v1761492898/WhatsApp_Image_2025-10-26_%C3%A0_08.22.17_fc6ffe86_rvp9bi.jpg',
  ];
  for (let i = 0; i < mtlImages.length; i++) {
    await prisma.mtlImage.create({
      data: { image: mtlImages[i], sort: i + 1, mtlId: mtl.id },
    });
  }
  console.log(`   - MTL            : Saison 1, ${mtlImages.length} images`);

  const SEED_DEMO =
    process.env.SEED_DEMO === '1' || process.env.SEED_DEMO === 'true';
  if (!SEED_DEMO) {
    console.log('✅ Seed terminé (mode sans comptes : héros uniquement).');
    console.log('   Astuce : SEED_DEMO=1 npm run seed  pour des données de démo.');
    return;
  }

  const passwordHash = bcrypt.hashSync('password123', 10);

  for (const t of mockTeams) {
    await prisma.team.create({
      data: {
        id: t.id,
        name: t.name,
        tag: t.tag,
        logo: t.logo ?? undefined,
        description: t.description ?? undefined,
        captainId: t.captainId ?? undefined,
        maxMembers: t.maxMembers,
        wins: t.wins,
        losses: t.losses,
        rank: t.rank,
        foundedAt: new Date(t.foundedAt),
        region: t.region,
        achievements: toJson(t.achievements),
        isRecruiting: t.isRecruiting,
        lookingFor: toJson(t.lookingFor),
      },
    });
  }

  for (const p of mockPlayers) {
    await prisma.user.create({
      data: {
        id: p.id,
        username: p.username,
        email: p.email,
        password: passwordHash,
        avatar: p.avatar ?? undefined,
        rank: p.rank,
        role: p.role,
        favoriteHeroes: toJson(p.favoriteHeroes),
        wins: p.wins,
        losses: p.losses,
        mvpCount: p.mvpCount,
        streak: p.streak,
        country: p.country,
        city: p.city ?? undefined,
        bio: p.bio ?? undefined,
        badges: toJson(p.badges),
        joinedAt: new Date(p.joinedAt),
        lastActive: new Date(p.lastActive),
        isOnline: p.isOnline,
        roleUser: p.role_user,
        teamId: p.teamId ?? undefined,
      },
    });
  }

  for (const post of mockPosts) {
    await prisma.post.create({
      data: {
        id: post.id,
        authorId: post.authorId,
        authorName: post.authorName,
        authorRank: post.authorRank ?? undefined,
        category: post.category,
        title: post.title,
        content: post.content,
        likes: post.likes,
        views: post.views,
        isPinned: post.isPinned,
        createdAt: new Date(post.createdAt),
      },
    });
    for (const c of post.comments ?? []) {
      await prisma.comment.create({
        data: {
          id: c.id,
          postId: post.id,
          authorId: c.authorId,
          authorName: c.authorName,
          content: c.content,
          createdAt: new Date(c.createdAt),
        },
      });
    }
  }

  for (const t of mockTournaments) {
    await prisma.tournament.create({
      data: {
        id: t.id,
        name: t.name,
        description: t.description ?? undefined,
        organizer: t.organizer ?? undefined,
        status: t.status,
        startDate: t.startDate ?? undefined,
        endDate: t.endDate ?? undefined,
        prizePool: t.prizePool ?? undefined,
        maxTeams: t.maxTeams,
        registeredTeams: toJson(t.registeredTeams),
        format: t.format ?? undefined,
        rules: t.rules ?? undefined,
        banner: t.banner ?? undefined,
        brackets: toJson(t.brackets),
        streamUrl: t.streamUrl ?? undefined,
      },
    });
  }

  for (const e of mockEvents) {
    await prisma.event.create({
      data: {
        id: e.id,
        title: e.title,
        type: e.type,
        description: e.description ?? undefined,
        date: e.date ?? undefined,
        time: e.time ?? undefined,
        duration: e.duration ?? undefined,
        participants: toJson(e.participants),
        organizer: e.organizer ?? undefined,
        isPublic: e.isPublic,
      },
    });
  }

  for (const m of mockMatches) {
    await prisma.match.create({
      data: {
        id: m.id,
        team1: toJson(m.team1),
        team2: toJson(m.team2),
        tournament: m.tournament ?? undefined,
        date: m.date ?? undefined,
        status: m.status,
        mvp: m.mvp ?? undefined,
        duration: m.duration ?? undefined,
        format: m.format ?? undefined,
        games: toJson(m.games),
      },
    });
  }

  for (const log of mockAdminLogs) {
    await prisma.adminLog.create({
      data: {
        id: log.id,
        action: log.action,
        admin: log.admin,
        target: log.target ?? undefined,
        details: log.details ?? undefined,
        timestamp: new Date(log.timestamp),
      },
    });
  }

  for (const f of mockFormTemplates) {
    await prisma.formTemplate.create({
      data: {
        id: f.id,
        name: f.name,
        description: f.description ?? undefined,
        fields: toJson(f.fields),
        status: f.status ?? undefined,
        createdAt: new Date(f.createdAt),
      },
    });
  }
  for (const r of mockFormResponses) {
    await prisma.formResponse.create({
      data: {
        id: r.id,
        formId: r.formId,
        data: toJson(r.data),
        submittedAt: new Date(r.submittedAt),
      },
    });
  }

  for (const n of mockNotifications) {
    await prisma.notification.create({
      data: {
        id: n.id,
        userId: n.userId ?? undefined,
        type: n.type,
        title: n.title,
        message: n.message,
        read: n.read,
        link: n.link ?? undefined,
        createdAt: new Date(n.createdAt),
      },
    });
  }

  // Stream config: a single document holding the YouTube channel + Season 1
  // video list, editable by the admin. Created once, left untouched afterwards.
  const streamExists = await prisma.streamConfig.findFirst();
  if (!streamExists) {
    const s1Videos = [
      { id: 'gmQZwF1e440', title: 'Game 1', day: 'Game 1', duration: '12:34', date: '2025-01-15' },
      { id: 'ig4rgd_XpsI', title: 'Game 1 (bis)', day: 'Game 1', duration: '10:45', date: '2025-01-16' },
      { id: 'RrlV4gdaT-c', title: 'Game 2', day: 'Game 2', duration: '14:20', date: '2025-01-18' },
      { id: 'XUxJ5RDPn50', title: 'Day 7', day: 'Day 7', duration: '18:05', date: '2025-01-22' },
      { id: '0fHem_8aV-c', title: 'Day 9', day: 'Day 9', duration: '15:30', date: '2025-01-24' },
      { id: 'rk1x2zOxN5c', title: 'Day 10', day: 'Day 10', duration: '16:45', date: '2025-01-25' },
      { id: 'CpMvI_7n83I', title: 'Day 12', day: 'Day 12', duration: '20:10', date: '2025-01-27' },
      { id: '5SjS6tOz0Ck', title: 'Third game', day: 'Game 3', duration: '13:55', date: '2025-01-29' },
      { id: 'yEZqiM5uYoM', title: 'Final', day: 'Final', duration: '25:30', date: '2025-02-01' },
    ];
    await prisma.streamConfig.create({
      data: {
        youtubeChannel: 'eternumesports',
        s1MainVideoId: s1Videos[0].id,
        videos: JSON.stringify(s1Videos),
      },
    });
  }

  console.log('✅ Seed terminé. Résumé :');
  console.log(`   - Équipes        : ${mockTeams.length}`);
  console.log(`   - Utilisateurs   : ${mockPlayers.length}`);
  console.log(`   - Posts          : ${mockPosts.length}`);
  console.log(
    `   - Commentaires   : ${mockPosts.reduce((acc, p) => acc + (p.comments?.length ?? 0), 0)}`,
  );
  console.log(`   - Tournois       : ${mockTournaments.length}`);
  console.log(`   - Événements     : ${mockEvents.length}`);
  console.log(`   - Matchs         : ${mockMatches.length}`);
  console.log(`   - Héros          : ${(heroes as any[]).length}`);
  console.log(`   - Logs admin     : ${mockAdminLogs.length}`);
  console.log(`   - Formulaires    : ${mockFormTemplates.length}`);
  console.log(`   - Réponses       : ${mockFormResponses.length}`);
  console.log(`   - Notifications  : ${mockNotifications.length}`);
}

main()
  .catch((e) => {
    console.error('❌ Erreur durant le seed :', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
