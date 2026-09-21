// Anthropic Messages API calls with structured output (forced tool use with a
// strict JSON schema). The client is injected so tests can mock
// `messages.create`.

import Anthropic from '@anthropic-ai/sdk';
import { AiLang, CatalogHero, HeroMeta, PlayerContext } from './ai.types';
import { winRateOf } from './ai-heuristics';

export const ANTHROPIC_CLIENT = 'ANTHROPIC_CLIENT';

/** Minimal surface of the SDK we depend on (keeps mocks trivial). */
export type AnthropicLike = Pick<Anthropic, 'messages'>;

export const DEFAULT_AI_MODEL = 'claude-opus-5';

const LANG_NAME: Record<AiLang, string> = { fr: 'French', en: 'English' };

const heroPickSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Exact hero name from the catalog' },
    reason: { type: 'string', description: 'One or two sentences, in the requested language' },
    confidence: { type: 'number', description: 'Between 0 and 1' },
  },
  required: ['name', 'reason', 'confidence'],
  additionalProperties: false,
} as const;

const pointSchema = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    description: { type: 'string' },
    impact: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['category', 'description', 'impact'],
  additionalProperties: false,
} as const;

export const TOOLS = {
  coach: {
    name: 'submit_coaching',
    description: 'Submit personalised coaching for the player.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Two or three sentences summarising the player situation' },
        tips: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['title', 'detail', 'priority'],
            additionalProperties: false,
          },
        },
        heroes: { type: 'array', items: heroPickSchema, description: 'Up to 3 heroes to focus on' },
      },
      required: ['summary', 'tips', 'heroes'],
      additionalProperties: false,
    },
  },
  recommend: {
    name: 'submit_hero_recommendations',
    description: 'Submit exactly 5 hero recommendations.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { heroes: { type: 'array', items: heroPickSchema } },
      required: ['heroes'],
      additionalProperties: false,
    },
  },
  build: {
    name: 'submit_build',
    description: 'Submit an item build for the hero.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Short note on the data used or missing' },
        boots: {
          type: 'object',
          properties: { name: { type: 'string' }, reason: { type: 'string' } },
          required: ['name', 'reason'],
          additionalProperties: false,
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Real Mobile Legends item name' },
              reason: { type: 'string' },
              priority: { type: 'string', enum: ['core', 'situational'] },
            },
            required: ['name', 'reason', 'priority'],
            additionalProperties: false,
          },
        },
        emblem: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'One of: Tank Emblem, Fighter Emblem, Assassin Emblem, Mage Emblem, Marksman Emblem, Support Emblem' },
            talents: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
          },
          required: ['name', 'talents', 'reason'],
          additionalProperties: false,
        },
        spell: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Battle spell name, e.g. Flicker, Execute, Retribution, Inspire, Sprint, Revitalize, Aegis, Petrify, Purify, Flameshot, Arrival, Vengeance' },
            reason: { type: 'string' },
          },
          required: ['name', 'reason'],
          additionalProperties: false,
        },
      },
      required: ['note', 'boots', 'items', 'emblem', 'spell'],
      additionalProperties: false,
    },
  },
  counter: {
    name: 'submit_counter_picks',
    description: 'Submit up to 5 counter picks against the enemy heroes.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        counters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exact hero name from the catalog' },
              reason: { type: 'string' },
              effectiveness: { type: 'number', description: 'Between 0 and 1' },
              against: { type: 'array', items: { type: 'string' }, description: 'Enemy names this pick answers' },
            },
            required: ['name', 'reason', 'effectiveness', 'against'],
            additionalProperties: false,
          },
        },
      },
      required: ['counters'],
      additionalProperties: false,
    },
  },
  analysis: {
    name: 'submit_player_analysis',
    description: 'Submit the player strengths, weaknesses and recommendations.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        strengths: { type: 'array', items: pointSchema },
        weaknesses: { type: 'array', items: pointSchema },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
      required: ['strengths', 'weaknesses', 'recommendations'],
      additionalProperties: false,
    },
  },
} as const;

export type ToolKey = keyof typeof TOOLS;

export function playerBlock(p: PlayerContext): string {
  const { games, winRate } = winRateOf(p);
  const frequent = (p.gameFrequentHeroes ?? [])
    .slice(0, 8)
    .map((h) => `${h.name}${h.matches ? ` (${h.matches} games${h.winRate != null ? `, ${h.winRate}% WR` : ''})` : ''}`)
    .join(', ');
  return [
    `Username: ${p.username}`,
    `Rank: ${p.rank}`,
    `Main role: ${p.role}`,
    `Record: ${p.wins} wins / ${p.losses} losses (${games} games, ${winRate}% win rate)`,
    `MVP count: ${p.mvpCount}`,
    `Current streak: ${p.streak}`,
    `Favourite heroes: ${p.favoriteHeroes?.length ? p.favoriteHeroes.join(', ') : 'none set'}`,
    `Most played heroes (linked game account): ${frequent || 'not linked'}`,
    p.gameRoles?.length ? `Roles from game account: ${p.gameRoles.map((r) => r.role).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function catalogBlock(catalog: CatalogHero[]): string {
  return catalog
    .map((h) => `${h.name} [${(h.roles?.length ? h.roles : [h.role]).join('/')}; lanes: ${(h.laneKeys ?? []).join('/') || '?'}]`)
    .join('\n');
}

export function metaBlock(name: string, meta: HeroMeta | null): string {
  if (!meta || (!meta.available && !meta.counters?.weak?.length)) {
    return `${name}: meta statistics unavailable`;
  }
  const list = (refs: { name: string | null; increaseWinRate: number }[]) =>
    refs
      .filter((r) => r.name)
      .slice(0, 8)
      .map((r) => `${r.name} (${r.increaseWinRate >= 0 ? '+' : ''}${r.increaseWinRate}%)`)
      .join(', ') || 'n/a';
  return [
    `${name}: win rate ${meta.winRate}%, pick rate ${meta.pickRate}%, ban rate ${meta.banRate}%`,
    `  strong against: ${list(meta.counters.strong)}`,
    `  weak against (heroes that beat ${name}): ${list(meta.counters.weak)}`,
    `  best teammates: ${list(meta.synergy.best)}`,
    ...(meta.matrix?.counters?.length
      ? [
          `  hardest matchups (full matrix, ${name}'s win rate change): ${list(
            [...meta.matrix.counters].sort((a, b) => a.increaseWinRate - b.increaseWinRate),
          )}`,
        ]
      : []),
  ].join('\n');
}

export function systemPrompt(lang: AiLang, catalog: CatalogHero[]): string {
  return [
    'You are an expert Mobile Legends: Bang Bang coach for the MLBB Togo community.',
    `Write every user-facing text (summary, reasons, tips, descriptions) in ${LANG_NAME[lang]}.`,
    'Ground every statement in the data provided below. Do not invent statistics.',
    'Only use hero names that appear in the catalog, spelled exactly as listed. Never mention a hero that is not in the catalog.',
    'Always answer by calling the provided tool exactly once.',
    '',
    'HERO CATALOG (name [classes; lanes]):',
    catalogBlock(catalog),
  ].join('\n');
}

/**
 * Calls the model with a single forced tool and returns the tool input, or
 * null when the response carries no tool call.
 */
export async function callStructured(
  client: AnthropicLike,
  model: string,
  tool: ToolKey,
  system: string,
  user: string,
): Promise<Record<string, unknown> | null> {
  const def = TOOLS[tool];
  const res = await client.messages.create({
    model,
    max_tokens: 8192,
    system,
    messages: [{ role: 'user', content: user }],
    tools: [def as unknown as Anthropic.Messages.Tool],
    tool_choice: { type: 'tool', name: def.name },
  });
  if (res.stop_reason === 'refusal') return null;
  const block = res.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use' && b.name === def.name,
  );
  if (!block || typeof block.input !== 'object' || block.input === null) return null;
  return block.input as Record<string, unknown>;
}
