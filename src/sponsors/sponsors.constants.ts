/** Partnership tiers, from the most to the least visible. */
export const SPONSOR_TIERS = ['title', 'gold', 'silver', 'partner'] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

/** Tier used when a legacy sponsor has none. */
export const DEFAULT_TIER: SponsorTier = 'partner';

/** Lifecycle of a partnership request. */
export const REQUEST_STATUSES = ['new', 'contacted', 'accepted', 'declined'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Public form: max requests per IP inside the window. */
export const REQUEST_RATE_LIMIT = { max: 3, windowMs: 10 * 60 * 1000 };

export type Lang = 'fr' | 'en';

export interface SponsorFaqItem {
  q: string;
  a: string;
}

/** Static sponsoring FAQ (FR/EN), served by GET /sponsors/faq. */
export const SPONSOR_FAQ: Record<Lang, SponsorFaqItem[]> = {
  fr: [
    {
      q: 'Quels types de partenariats proposez-vous ?',
      a: 'Quatre niveaux : sponsor titre (naming de la saison), or, argent et partenaire. Chaque offre précise ses contreparties : logo sur le site et les overlays de stream, mentions à l’antenne, activations lors des finales en présentiel, contenus dédiés sur nos réseaux.',
    },
    {
      q: 'Un partenariat couvre-t-il une saison ou l’année entière ?',
      a: 'Les offres sont rattachées à une saison de ligue (environ trois mois). Un engagement sur plusieurs saisons bénéficie d’une remise et d’une visibilité continue sur le site entre deux saisons.',
    },
    {
      q: 'Quelle audience touchez-vous ?',
      a: 'Des joueurs de 15 à 30 ans, urbains, connectés tous les jours : matchs diffusés en direct sur YouTube, classements et forum consultés chaque semaine, événements en présentiel à Lomé. Les chiffres cibles de la saison sont affichés sur cette page.',
    },
    {
      q: 'Peut-on sponsoriser un seul événement ou un contenu ?',
      a: 'Oui. En dehors des offres saisonnières, nous proposons des activations ponctuelles : tournoi sponsorisé, annonce sponsorisée dans le fil de communication, finale en présentiel, ou dotation en lots.',
    },
    {
      q: 'Comment mesurez-vous les retombées ?',
      a: 'Chaque partenaire reçoit un bilan de fin de saison : vues cumulées des diffusions, portée des publications, participation aux événements et clics sur son lien depuis le site.',
    },
    {
      q: 'Quels sont les délais et le processus ?',
      a: 'Envoyez le formulaire ci-dessous : nous revenons vers vous sous 48 heures ouvrées avec une proposition détaillée. La signature intervient avant le début de la saison pour garantir la présence sur tous les supports.',
    },
  ],
  en: [
    {
      q: 'What kinds of partnerships do you offer?',
      a: 'Four tiers: title sponsor (season naming), gold, silver and partner. Each package lists its benefits: logo on the website and stream overlays, on-air mentions, activations at offline finals, dedicated content on our social channels.',
    },
    {
      q: 'Does a partnership cover one season or the whole year?',
      a: 'Packages are attached to a league season (about three months). A multi-season commitment comes with a discount and continuous visibility on the website between seasons.',
    },
    {
      q: 'Which audience do you reach?',
      a: 'Urban players aged 15 to 30 who connect every day: matches streamed live on YouTube, standings and forum checked weekly, offline events in Lomé. The target figures of the season are displayed on this page.',
    },
    {
      q: 'Can we sponsor a single event or piece of content?',
      a: 'Yes. Besides seasonal packages we offer one-off activations: a sponsored tournament, a sponsored announcement in the communication feed, an offline final, or prize contributions.',
    },
    {
      q: 'How do you measure results?',
      a: 'Every partner receives an end-of-season report: cumulated stream views, reach of the posts, event attendance and clicks on its link from the website.',
    },
    {
      q: 'What are the timeline and the process?',
      a: 'Send the form below: we get back to you within 48 business hours with a detailed proposal. Signing happens before the season starts so the partner appears on every medium.',
    },
  ],
};
