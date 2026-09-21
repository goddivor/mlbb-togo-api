/**
 * Shared vocabulary of the recruitment module: availability levels and the
 * application life cycle. Kept in one place so the DTOs, the service and the
 * specs cannot drift apart.
 */

/**
 * How much a player can commit. Deliberately coarse (three buckets) rather
 * than a schedule: a free-text availability is unusable as a filter.
 */
export const RECRUITMENT_AVAILABILITY = [
  'casual', // a few games a week, no fixed schedule
  'regular', // regular scrims, available most evenings
  'competitive', // full competitive schedule, tournaments included
] as const;

export type RecruitmentAvailability = (typeof RECRUITMENT_AVAILABILITY)[number];

/**
 * Highest in-game rank level currently reachable (see decodeRank in
 * users.service: Mythic Immortal starts above 235). The bound is generous so a
 * future season inflating the ladder does not reject legitimate queries.
 */
export const MAX_RANK_LEVEL = 500;

/** Application life cycle. */
export const APPLICATION_STATUSES = [
  'pending',
  'shortlisted',
  'accepted',
  'rejected',
  'withdrawn',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Allowed transitions. `accepted`, `rejected` and `withdrawn` are terminal: a
 * closed application is re-opened by applying again, not by flipping a status
 * back, which keeps the audit trail (decidedAt / decidedById) meaningful.
 */
export const APPLICATION_TRANSITIONS: Record<
  ApplicationStatus,
  readonly ApplicationStatus[]
> = {
  pending: ['shortlisted', 'accepted', 'rejected', 'withdrawn'],
  shortlisted: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
};

/** Statuses the team owner (captain) or the staff may set. */
export const MANAGER_STATUSES: readonly ApplicationStatus[] = [
  'shortlisted',
  'accepted',
  'rejected',
];

/** Statuses the candidate may set on their own application. */
export const CANDIDATE_STATUSES: readonly ApplicationStatus[] = ['withdrawn'];

/** Statuses that still need an answer from the recruiter. */
export const ACTIVE_STATUSES: readonly ApplicationStatus[] = [
  'pending',
  'shortlisted',
];

export function isAvailability(value: unknown): value is RecruitmentAvailability {
  return (
    typeof value === 'string' &&
    (RECRUITMENT_AVAILABILITY as readonly string[]).includes(value)
  );
}
