import { Injectable, Logger } from '@nestjs/common';

/**
 * Domain events of the community builds, for other modules to hook into
 * (e.g. XP / achievements) without this module knowing about them.
 *
 * - `published`: a build became public for the FIRST time (republishing
 *   after an unpublish emits nothing, so XP cannot be farmed that way);
 * - `unpublished`: the author moved a published build back to drafts;
 * - `liked` / `unliked`: a like was actually added / removed (idempotent
 *   calls that change nothing emit nothing);
 * - `hidden` / `unhidden` / `deleted`: moderation or author deletion.
 */
export type CommunityBuildEventType =
  | 'published'
  | 'unpublished'
  | 'liked'
  | 'unliked'
  | 'hidden'
  | 'unhidden'
  | 'deleted';

export interface CommunityBuildEvent {
  type: CommunityBuildEventType;
  buildId: string;
  heroId: string;
  /** Author of the build (receiver of likes). */
  authorId: string;
  /** User who triggered the event (liker, moderator, author). */
  actorId: string;
  /** Likes count after the event. */
  likesCount: number;
  at: Date;
}

export type CommunityBuildListener = (event: CommunityBuildEvent) => void | Promise<void>;

/**
 * Minimal in-process event bus. Listeners run after the write succeeded and
 * never break the request: errors are logged and swallowed.
 *
 * Usage from another module (import CommunityBuildsModule):
 *   constructor(events: CommunityBuildsEvents) {
 *     events.subscribe((e) => e.type === 'liked' && grantXp(e.authorId, e.buildId));
 *   }
 */
@Injectable()
export class CommunityBuildsEvents {
  private readonly logger = new Logger('CommunityBuildsEvents');
  private readonly listeners = new Set<CommunityBuildListener>();

  /** Registers a listener; returns the unsubscribe function. */
  subscribe(listener: CommunityBuildListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit(event: Omit<CommunityBuildEvent, 'at'>): Promise<void> {
    const full: CommunityBuildEvent = { ...event, at: new Date() };
    for (const listener of this.listeners) {
      try {
        await listener(full);
      } catch (err) {
        this.logger.warn(`listener failed on ${event.type} ${event.buildId}: ${(err as Error)?.message}`);
      }
    }
  }
}
