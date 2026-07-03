import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { serializeUserCard } from '../users/users.service';
import { CommunityService } from '../community/community.service';

@Injectable()
export class FriendsService {
  constructor(
    private prisma: PrismaService,
    private community: CommunityService,
  ) {}

  private findBetween(a: string, b: string) {
    return this.prisma.friendship.findFirst({
      where: {
        OR: [
          { requesterId: a, addresseeId: b },
          { requesterId: b, addresseeId: a },
        ],
      },
    });
  }

  private async cards(ids: string[]) {
    const users = await this.prisma.user.findMany({
      where: { id: { in: Array.from(new Set(ids)) } },
    });
    return new Map(users.map((u) => [u.id, serializeUserCard(u)]));
  }

  async sendRequest(me: string, otherId: string) {
    if (!otherId || otherId === me)
      throw new BadRequestException('Destinataire invalide.');
    const other = await this.prisma.user.findUnique({ where: { id: otherId } });
    if (!other) throw new NotFoundException('Utilisateur introuvable.');
    const existing = await this.findBetween(me, otherId);
    if (existing) {
      if (existing.status === 'accepted')
        throw new ConflictException('Vous êtes déjà amis.');
      throw new ConflictException('Une demande existe déjà.');
    }
    await this.prisma.friendship.create({
      data: { requesterId: me, addresseeId: otherId, status: 'pending' },
    });
    const meUser = await this.prisma.user.findUnique({ where: { id: me } });
    const who = meUser ? serializeUserCard(meUser).displayName || meUser.username : 'Un joueur';
    await this.community.notifyUser(otherId, {
      type: 'friend_request',
      title: "Nouvelle demande d'ami",
      message: `${who} veut vous ajouter en ami.`,
      link: '/friends',
    });
    return { ok: true, status: 'pending_out' };
  }

  async accept(me: string, otherId: string) {
    const fr = await this.prisma.friendship.findFirst({
      where: { requesterId: otherId, addresseeId: me, status: 'pending' },
    });
    if (!fr) throw new NotFoundException('Demande introuvable.');
    await this.prisma.friendship.update({
      where: { id: fr.id },
      data: { status: 'accepted' },
    });
    const meUser = await this.prisma.user.findUnique({ where: { id: me } });
    const who = meUser ? serializeUserCard(meUser).displayName || meUser.username : 'Un joueur';
    await this.community.notifyUser(otherId, {
      type: 'friend_accept',
      title: 'Demande acceptée',
      message: `${who} a accepté votre demande d'ami.`,
      link: `/players/${me}`,
    });
    return { ok: true, status: 'friends' };
  }

  async remove(me: string, otherId: string) {
    const fr = await this.findBetween(me, otherId);
    if (fr) await this.prisma.friendship.delete({ where: { id: fr.id } });
    return { ok: true, status: 'none' };
  }

  async listFriends(me: string) {
    const rels = await this.prisma.friendship.findMany({
      where: {
        status: 'accepted',
        OR: [{ requesterId: me }, { addresseeId: me }],
      },
      orderBy: { updatedAt: 'desc' },
    });
    const otherIds = rels.map((r) => (r.requesterId === me ? r.addresseeId : r.requesterId));
    const map = await this.cards(otherIds);
    return rels
      .map((r) => map.get(r.requesterId === me ? r.addresseeId : r.requesterId))
      .filter(Boolean);
  }

  async listRequests(me: string) {
    const rels = await this.prisma.friendship.findMany({
      where: { addresseeId: me, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    const map = await this.cards(rels.map((r) => r.requesterId));
    return rels
      .map((r) => map.get(r.requesterId))
      .filter(Boolean);
  }

  async statusWith(me: string, otherId: string) {
    if (otherId === me) return { status: 'self' };
    const fr = await this.findBetween(me, otherId);
    if (!fr) return { status: 'none' };
    if (fr.status === 'accepted') return { status: 'friends' };
    return { status: fr.requesterId === me ? 'pending_out' : 'pending_in' };
  }
}
