/**
 * Pure helpers for group chat rooms (team / tournament / draft team).
 * Kept free of Prisma so they can be unit-tested in isolation.
 */

export const ROOM_KINDS = ['team', 'tournament', 'draft_team'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const isRoomKind = (v: unknown): v is RoomKind =>
  typeof v === 'string' && (ROOM_KINDS as readonly string[]).includes(v);

/** Socket.io room name used for a thread. */
export const threadRoom = (threadId: string) => `thread:${threadId}`;

/**
 * Extracts the distinct `@username` handles of a message body, in order of
 * first appearance. Handles are matched against `members` case-insensitively
 * and only known members are returned (as their canonical ids), so a stray
 * "@everyone" or an email address never triggers a notification.
 */
export function parseMentions(
  body: string,
  members: { id: string; username: string }[],
): string[] {
  if (!body) return [];
  const byName = new Map<string, string>();
  for (const m of members)
    if (m.username) byName.set(m.username.toLowerCase(), m.id);
  const found: string[] = [];
  // A handle starts at the beginning of the text or after whitespace or
  // punctuation (so "mail@host" is not a mention) and stops at the first
  // character that is not part of a username.
  const re = /(^|[^\w@.])@([\w.-]{2,32})/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const handle = match[2].replace(/[.-]+$/, '').toLowerCase();
    const id = byName.get(handle);
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/** Number of messages a user has not seen yet, given their read cursor. */
export function countUnread(
  messages: { senderId: string; createdAt: Date }[],
  userId: string,
  lastReadAt: Date | null | undefined,
): number {
  const cursor = lastReadAt ? lastReadAt.getTime() : 0;
  let n = 0;
  for (const m of messages)
    if (m.senderId !== userId && m.createdAt.getTime() > cursor) n += 1;
  return n;
}

/** Tiny TTL cache used to memoise membership lookups between requests. */
export class TtlCache<V> {
  private store = new Map<string, { value: V; expires: number }>();
  constructor(private readonly ttlMs: number) {}

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()) {
    this.store.set(key, { value, expires: now + this.ttlMs });
  }

  delete(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}
