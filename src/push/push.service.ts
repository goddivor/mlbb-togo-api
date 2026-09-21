import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PushService {
  private readonly logger = new Logger('PushService');
  private enabled = false;

  constructor(private prisma: PrismaService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@mlbbtogo.com';
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.enabled = true;
    } else {
      this.logger.warn('VAPID keys missing — push notifications disabled.');
    }
  }

  getPublicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY ?? null;
  }

  async subscribe(userId: string, sub: any) {
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (!endpoint || !p256dh || !auth) return { ok: false };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { userId, endpoint, p256dh, auth },
      update: { userId, p256dh, auth },
    });
    return { ok: true };
  }

  async unsubscribe(endpoint: string) {
    if (endpoint)
      await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
    return { ok: true };
  }

  /** Best-effort push to every device of a user; prunes dead subscriptions. */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; link?: string },
  ) {
    if (!this.enabled) return;
    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subs.length === 0) return;
    const data = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            data,
          );
        } catch (e: any) {
          // 404/410 = subscription expired → remove it.
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await this.prisma.pushSubscription
              .deleteMany({ where: { endpoint: s.endpoint } })
              .catch(() => {});
          }
        }
      }),
    );
  }
}
