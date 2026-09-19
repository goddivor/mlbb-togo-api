import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EsportSeasonsService } from '../esport/esport-seasons.service';
import { CommunityService } from '../community/community.service';
import {
  Lang,
  SPONSOR_FAQ,
  SPONSOR_TIERS,
} from './sponsors.constants';
import {
  cleanBenefits,
  filterForSeason,
  groupByTier,
  serializeOffer,
  serializeSponsor,
  sortOffers,
} from './sponsors.logic';
import { CreateSponsorOfferDto, UpdateSponsorOfferDto } from './dto/sponsor-offer.dto';
import {
  CreateSponsorshipRequestDto,
  UpdateSponsorshipRequestDto,
} from './dto/sponsorship-request.dto';

const OBJECT_ID = /^[a-f\d]{24}$/i;

@Injectable()
export class SponsorsService {
  private readonly logger = new Logger('SponsorsService');

  constructor(
    private prisma: PrismaService,
    private seasons: EsportSeasonsService,
    private community: CommunityService,
  ) {}

  // ----- Public reads -----

  /**
   * Active sponsors of a season (id, slug or "current"), tiered. Without a
   * season every active sponsor is returned.
   */
  async listPublic(seasonKey?: string) {
    let season: { id: string; name: string; slug: string | null; status: string } | null = null;
    const key = (seasonKey ?? '').trim();
    if (key) {
      try {
        const s = key === 'current' ? await this.seasons.current() : await this.seasons.get(key);
        season = { id: s.id, name: s.name, slug: s.slug ?? null, status: s.status };
      } catch {
        // No season at all: fall back to the global list.
        season = null;
      }
    }
    const rows = await this.prisma.sponsor.findMany();
    const items = filterForSeason(rows, season?.id ?? null);
    return { season, tiers: SPONSOR_TIERS, items, byTier: groupByTier(items) };
  }

  /** Every sponsor (admin), enriched with the public shape. */
  async listAll() {
    const rows = await this.prisma.sponsor.findMany();
    return rows.map(serializeSponsor).sort((a, b) => a.sort - b.sort);
  }

  async listOffers(includeInactive = false) {
    const rows = await this.prisma.sponsorOffer.findMany();
    return sortOffers(rows.map(serializeOffer), includeInactive);
  }

  getFaq(langRaw?: string) {
    const lang: Lang = (langRaw ?? 'fr').toLowerCase() === 'en' ? 'en' : 'fr';
    return { lang, items: SPONSOR_FAQ[lang] };
  }

  // ----- Admin: offers -----

  async createOffer(dto: CreateSponsorOfferDto) {
    const row = await this.prisma.sponsorOffer.create({
      data: {
        name: dto.name.trim(),
        tier: dto.tier || null,
        priceLabel: dto.priceLabel?.trim() || null,
        benefits: JSON.stringify(cleanBenefits(dto.benefits)),
        highlight: dto.highlight ?? false,
        isActive: dto.isActive ?? true,
        sort: dto.sort ?? 0,
      },
    });
    return serializeOffer(row);
  }

  async updateOffer(id: string, dto: UpdateSponsorOfferDto) {
    await this.findOffer(id);
    const row = await this.prisma.sponsorOffer.update({
      where: { id },
      data: {
        name: dto.name === undefined ? undefined : dto.name.trim(),
        tier: dto.tier === undefined ? undefined : dto.tier || null,
        priceLabel: dto.priceLabel === undefined ? undefined : dto.priceLabel.trim() || null,
        benefits: dto.benefits === undefined ? undefined : JSON.stringify(cleanBenefits(dto.benefits)),
        highlight: dto.highlight,
        isActive: dto.isActive,
        sort: dto.sort,
      },
    });
    return serializeOffer(row);
  }

  async deleteOffer(id: string) {
    await this.findOffer(id);
    await this.prisma.sponsorOffer.delete({ where: { id } });
    return { ok: true };
  }

  private async findOffer(id: string) {
    const row = OBJECT_ID.test(id) ? await this.prisma.sponsorOffer.findUnique({ where: { id } }) : null;
    if (!row) throw new NotFoundException('Offre introuvable.');
    return row;
  }

  // ----- Partnership requests -----

  async createRequest(dto: CreateSponsorshipRequestDto) {
    if (dto.offerId) {
      const offer = await this.prisma.sponsorOffer.findUnique({ where: { id: dto.offerId } });
      if (!offer) throw new NotFoundException('Offre introuvable.');
    }
    const row = await this.prisma.sponsorshipRequest.create({
      data: {
        company: dto.company.trim(),
        contactName: dto.contactName.trim(),
        email: dto.email.trim().toLowerCase(),
        phone: dto.phone?.trim() || null,
        message: dto.message.trim(),
        offerId: dto.offerId ?? null,
        status: 'new',
      },
    });
    void this.notifyAdmins(row).catch((e) => this.logger.warn(`Admin notification failed: ${e?.message}`));
    return {
      success: true,
      id: row.id,
      message: 'Demande envoyée. Merci, nous reviendrons vers vous sous 48 heures.',
    };
  }

  private async notifyAdmins(row: { id: string; company: string; contactName: string }) {
    const admins = await this.prisma.user.findMany({
      where: { roleUser: { in: ['admin', 'moderator'] } },
      select: { id: true },
    });
    await Promise.all(
      admins.map((a) =>
        this.community.notifyUser(a.id, {
          type: 'sponsorship_request',
          title: 'Nouvelle demande de partenariat',
          message: `${row.company} (${row.contactName}) souhaite devenir sponsor.`,
          link: '/admin/sponsors?tab=requests',
          data: { requestId: row.id, company: row.company, contactName: row.contactName },
        }),
      ),
    );
  }

  async listRequests(status?: string) {
    const rows = await this.prisma.sponsorshipRequest.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
    });
    const offerIds = Array.from(new Set(rows.map((r) => r.offerId).filter(Boolean))) as string[];
    const offers = offerIds.length
      ? await this.prisma.sponsorOffer.findMany({ where: { id: { in: offerIds } } })
      : [];
    const byId = new Map(offers.map((o) => [o.id, serializeOffer(o)]));
    return rows.map((r) => ({ ...r, offer: r.offerId ? byId.get(r.offerId) ?? null : null }));
  }

  async updateRequest(id: string, dto: UpdateSponsorshipRequestDto) {
    const row = OBJECT_ID.test(id)
      ? await this.prisma.sponsorshipRequest.findUnique({ where: { id } })
      : null;
    if (!row) throw new NotFoundException('Demande introuvable.');
    return this.prisma.sponsorshipRequest.update({
      where: { id },
      data: {
        status: dto.status,
        adminNote: dto.adminNote === undefined ? undefined : dto.adminNote.trim() || null,
      },
    });
  }

  async deleteRequest(id: string) {
    const row = OBJECT_ID.test(id)
      ? await this.prisma.sponsorshipRequest.findUnique({ where: { id } })
      : null;
    if (!row) throw new NotFoundException('Demande introuvable.');
    await this.prisma.sponsorshipRequest.delete({ where: { id } });
    return { ok: true };
  }
}
