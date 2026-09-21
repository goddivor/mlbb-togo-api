/**
 * Permission catalogue (RBAC).
 *
 * Every admin area has one `admin.<area>` permission (it opens the matching
 * `/admin/<area>` page and its endpoints). Action capabilities (`forum.*`,
 * `posts.*`, `matches.*`, ...) grant a precise right outside of, or on top of,
 * an admin area. Roles store a list of these keys; a user's effective
 * permissions are the union of the permissions of all his roles.
 *
 * The catalogue lives in code (not in the database) so that adding a new area
 * is a code change reviewed with the endpoints it protects. Unknown keys found
 * in the database are ignored.
 */

export type PermissionGroup =
  | 'league'
  | 'esport'
  | 'catalog'
  | 'community'
  | 'partners'
  | 'system';

export interface PermissionDef {
  key: string;
  group: PermissionGroup;
  label: { fr: string; en: string };
  description?: { fr: string; en: string };
  /** Admin area route opened by this permission (admin.* only). */
  route?: string;
}

export const PERMISSION_GROUPS: { key: PermissionGroup; label: { fr: string; en: string } }[] = [
  { key: 'league', label: { fr: 'Ligue', en: 'League' } },
  { key: 'esport', label: { fr: 'Esport', en: 'Esport' } },
  { key: 'catalog', label: { fr: 'Catalogue', en: 'Catalog' } },
  { key: 'community', label: { fr: 'Communauté', en: 'Community' } },
  { key: 'partners', label: { fr: 'Partenaires', en: 'Partners' } },
  { key: 'system', label: { fr: 'Système', en: 'System' } },
];

export const PERMISSIONS: readonly PermissionDef[] = [
  // League
  {
    key: 'admin.league',
    group: 'league',
    route: '/admin/league',
    label: { fr: 'Salle de contrôle de la ligue', en: 'League control room' },
    description: {
      fr: 'Vue d’ensemble de la saison et annonces de ligue.',
      en: 'Season overview and league announcements.',
    },
  },
  {
    key: 'league.recompute',
    group: 'league',
    label: { fr: 'Recalculer les statistiques', en: 'Recompute statistics' },
    description: {
      fr: 'Relancer le calcul des classements et statistiques de la saison.',
      en: 'Rerun the standings and statistics computation of a season.',
    },
  },
  // Esport
  {
    key: 'admin.esport',
    group: 'esport',
    route: '/admin/esport',
    label: { fr: 'Équipes esport', en: 'Esport teams' },
    description: {
      fr: 'Créer et gérer les équipes, membres, capitaines et staff.',
      en: 'Create and manage teams, members, captains and staff.',
    },
  },
  {
    key: 'admin.seasons',
    group: 'esport',
    route: '/admin/seasons',
    label: { fr: 'Saisons', en: 'Seasons' },
  },
  {
    key: 'admin.matches',
    group: 'esport',
    route: '/admin/matches',
    label: { fr: 'Matchs', en: 'Matches' },
  },
  {
    key: 'matches.validate',
    group: 'esport',
    label: { fr: 'Valider les résultats de match', en: 'Validate match results' },
    description: {
      fr: 'Saisir ou corriger le résultat et la feuille de match des rencontres officielles.',
      en: 'Enter or fix the result and match sheet of official matches.',
    },
  },
  {
    key: 'admin.awards',
    group: 'esport',
    route: '/admin/awards',
    label: { fr: 'Récompenses', en: 'Awards' },
  },
  {
    key: 'admin.tournaments',
    group: 'esport',
    route: '/admin/tournaments',
    label: { fr: 'Tournois', en: 'Tournaments' },
  },
  {
    key: 'admin.draft',
    group: 'esport',
    route: '/admin/draft',
    label: { fr: 'Draft', en: 'Draft' },
  },
  {
    key: 'admin.stream',
    group: 'esport',
    route: '/admin/stream',
    label: { fr: 'Diffusion', en: 'Stream' },
  },
  // Catalog
  {
    key: 'admin.catalog',
    group: 'catalog',
    route: '/admin/catalog',
    label: { fr: 'Catalogue du jeu', en: 'Game catalog' },
    description: {
      fr: 'Héros, lignes, objets, emblèmes, sorts et builds.',
      en: 'Heroes, lanes, items, emblems, spells and builds.',
    },
  },
  // Community
  {
    key: 'admin.users',
    group: 'community',
    route: '/admin/users',
    label: { fr: 'Utilisateurs', en: 'Users' },
    description: {
      fr: 'Consulter, modifier et suspendre des comptes.',
      en: 'View, edit and suspend accounts.',
    },
  },
  {
    key: 'users.delete',
    group: 'community',
    label: { fr: 'Supprimer des comptes', en: 'Delete accounts' },
  },
  {
    key: 'admin.requests',
    group: 'community',
    route: '/admin/requests',
    label: { fr: 'Demandes d’équipe', en: 'Team requests' },
  },
  {
    key: 'admin.messages',
    group: 'community',
    route: '/admin/messages',
    label: { fr: 'Messagerie admin', en: 'Admin inbox' },
    description: {
      fr: 'Messagerie de l’administration et messages du formulaire de contact.',
      en: 'Admin inbox and contact form messages.',
    },
  },
  {
    key: 'forum.announce',
    group: 'community',
    label: { fr: 'Publier des annonces', en: 'Publish announcements' },
    description: {
      fr: 'Publier dans les catégories Annonces et Stream du forum.',
      en: 'Post in the Announcements and Stream forum categories.',
    },
  },
  {
    key: 'forum.moderate',
    group: 'community',
    label: { fr: 'Modérer le forum', en: 'Moderate the forum' },
    description: {
      fr: 'Épingler et supprimer les publications des autres membres.',
      en: 'Pin and delete other members’ posts.',
    },
  },
  // Partners
  {
    key: 'admin.sponsors',
    group: 'partners',
    route: '/admin/sponsors',
    label: { fr: 'Sponsors et demandes', en: 'Sponsors and requests' },
    description: {
      fr: 'Consulter les sponsors et traiter les demandes de partenariat.',
      en: 'View sponsors and handle partnership requests.',
    },
  },
  {
    key: 'sponsors.manage',
    group: 'partners',
    label: { fr: 'Gérer sponsors et offres', en: 'Manage sponsors and offers' },
    description: {
      fr: 'Créer, modifier et supprimer sponsors, offres et demandes.',
      en: 'Create, edit and delete sponsors, offers and requests.',
    },
  },
  {
    key: 'posts.sponsor',
    group: 'partners',
    label: { fr: 'Sponsoriser des publications', en: 'Sponsor posts' },
  },
  // System
  {
    key: 'admin.logs',
    group: 'system',
    route: '/admin/logs',
    label: { fr: 'Journal d’activité', en: 'Activity log' },
    description: {
      fr: 'Journal des actions et formulaires d’administration.',
      en: 'Admin action log and forms.',
    },
  },
  {
    key: 'admin.roles',
    group: 'system',
    route: '/admin/roles',
    label: { fr: 'Rôles et accès', en: 'Roles and access' },
    description: {
      fr: 'Créer des rôles et les attribuer aux utilisateurs.',
      en: 'Create roles and assign them to users.',
    },
  },
];

export const ALL_PERMISSIONS: readonly string[] = PERMISSIONS.map((p) => p.key);

const KNOWN = new Set(ALL_PERMISSIONS);

/**
 * Pseudo-permission accepted by `@RequirePermissions`: satisfied by ANY
 * `admin.*` permission (admin dashboard stats, shared admin lookups...).
 */
export const ANY_ADMIN = 'admin.*';

export function isKnownPermission(key: string): boolean {
  return KNOWN.has(key);
}

export function isAdminAreaPermission(key: string): boolean {
  return key.startsWith('admin.') && KNOWN.has(key);
}

/** Keeps only known keys, deduplicated, in catalogue order. */
export function normalizePermissions(keys: unknown): string[] {
  if (!Array.isArray(keys)) return [];
  const wanted = new Set(keys.filter((k): k is string => typeof k === 'string'));
  return ALL_PERMISSIONS.filter((k) => wanted.has(k));
}

/** System role keys (stable identifiers, independent of the display name). */
export const SYSTEM_ROLE_ADMIN = 'admin';
export const SYSTEM_ROLE_MODERATOR = 'moderator';

export const ADMIN_ROLE_NAME = 'Administrateur';
export const MODERATOR_ROLE_NAME = 'Modérateur';

/**
 * Permissions the legacy `moderator` role effectively had: every area whose
 * endpoints were guarded by `@Roles('admin', 'moderator')` (league overview
 * and announcements, catalog CRUD, draft, stream, users list + ban, team
 * requests, contact messages, logs and forms, sponsor list + request status,
 * post pin/sponsor, staff-only forum categories and post moderation).
 * Admin-only endpoints (seasons, esport teams, matches, awards, tournaments,
 * recompute, account deletion, role changes, sponsor/offer CRUD) are left out.
 */
export const MODERATOR_PERMISSIONS: readonly string[] = [
  'admin.league',
  'admin.catalog',
  'admin.draft',
  'admin.stream',
  'admin.users',
  'admin.requests',
  'admin.messages',
  'admin.logs',
  'admin.sponsors',
  'forum.announce',
  'forum.moderate',
  'posts.sponsor',
];

/** Minimal shape of a user as seen by permission checks. */
export interface PermissionSubject {
  roleUser?: string | null;
  permissions?: readonly string[] | null;
}

/**
 * Effective permissions of a request user. Users resolved by the JWT strategy
 * always carry `permissions`; the legacy `roleUser` fallback only serves
 * callers building a user by hand (internal jobs, older unit tests).
 */
export function permissionsOf(user?: PermissionSubject | null): readonly string[] {
  if (!user) return [];
  if (Array.isArray(user.permissions)) return user.permissions;
  if (user.roleUser === 'admin') return ALL_PERMISSIONS;
  if (user.roleUser === 'moderator') return MODERATOR_PERMISSIONS;
  return [];
}

export function hasPermission(user: PermissionSubject | null | undefined, key: string): boolean {
  const perms = permissionsOf(user);
  if (key === ANY_ADMIN) return perms.some((p) => p.startsWith('admin.'));
  return perms.includes(key);
}

/** True when the user holds at least one of `keys` (empty list = allowed). */
export function hasAnyPermission(
  user: PermissionSubject | null | undefined,
  keys: readonly string[],
): boolean {
  if (!keys.length) return true;
  return keys.some((k) => hasPermission(user, k));
}

export function hasAdminAccess(user?: PermissionSubject | null): boolean {
  return hasPermission(user, ANY_ADMIN);
}
