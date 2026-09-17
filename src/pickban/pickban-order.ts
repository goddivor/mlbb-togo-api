// Pure draft-order state machine for the MLBB pick & ban simulator.
// No framework dependency so it can be unit-tested and mirrored on the client.

export type PickBanMode = 'ranked' | 'tournament';
export type PickBanAction = 'pick' | 'ban';
export type PickBanTeam = 'blue' | 'red';

export interface DraftStep {
  step: number;
  action: PickBanAction;
  team: PickBanTeam;
}

export interface TeamPick {
  heroId: string;
  heroName: string;
  lane?: string;
}

export interface TeamBan {
  heroId: string;
  heroName: string;
}

export interface TeamState {
  picks: TeamPick[];
  bans: TeamBan[];
}

export interface DraftState {
  mode: PickBanMode;
  currentStep: number;
  blueTeam: TeamState;
  redTeam: TeamState;
}

export const LANES = ['gold', 'mid', 'jungle', 'exp', 'roam'] as const;

export const PICKS_PER_TEAM = 5;

export const BANS_PER_TEAM: Record<PickBanMode, number> = {
  ranked: 3,
  tournament: 5,
};

// MLBB ban phase: alternating blue/red for every ban slot. Pick phase:
// blue 1 - red 2 - blue 2 - red 2 - blue 2 - red 1 (snake order used in ranked
// and in most tournament formats).
const PICK_PATTERN: PickBanTeam[] = [
  'blue',
  'red',
  'red',
  'blue',
  'blue',
  'red',
  'red',
  'blue',
  'blue',
  'red',
];

function buildOrder(mode: PickBanMode): DraftStep[] {
  const order: DraftStep[] = [];
  const bans = BANS_PER_TEAM[mode];
  for (let i = 0; i < bans * 2; i++) {
    order.push({ step: order.length, action: 'ban', team: i % 2 === 0 ? 'blue' : 'red' });
  }
  for (const team of PICK_PATTERN) {
    order.push({ step: order.length, action: 'pick', team });
  }
  return order;
}

export const DRAFT_ORDERS: Record<PickBanMode, DraftStep[]> = {
  ranked: buildOrder('ranked'),
  tournament: buildOrder('tournament'),
};

export function isMode(value: unknown): value is PickBanMode {
  return value === 'ranked' || value === 'tournament';
}

export function totalSteps(mode: PickBanMode): number {
  return DRAFT_ORDERS[mode].length;
}

export function stepAt(mode: PickBanMode, step: number): DraftStep | null {
  return DRAFT_ORDERS[mode][step] ?? null;
}

export function emptyTeam(): TeamState {
  return { picks: [], bans: [] };
}

export function usedHeroIds(state: Pick<DraftState, 'blueTeam' | 'redTeam'>): Set<string> {
  return new Set([
    ...state.blueTeam.picks.map((p) => p.heroId),
    ...state.blueTeam.bans.map((b) => b.heroId),
    ...state.redTeam.picks.map((p) => p.heroId),
    ...state.redTeam.bans.map((b) => b.heroId),
  ]);
}

export class DraftOrderError extends Error {}

export interface ApplyInput {
  action: PickBanAction;
  team: PickBanTeam;
  heroId: string;
  heroName: string;
  lane?: string;
}

// Applies one pick/ban to the state and returns a new state. Throws
// DraftOrderError when the input does not match the expected step.
export function applyAction(state: DraftState, input: ApplyInput): DraftState {
  const expected = stepAt(state.mode, state.currentStep);
  if (!expected) throw new DraftOrderError('Draft already complete.');
  if (expected.action !== input.action) {
    throw new DraftOrderError(
      `Step ${state.currentStep + 1} expects a ${expected.action}, not a ${input.action}.`,
    );
  }
  if (expected.team !== input.team) {
    throw new DraftOrderError(
      `Step ${state.currentStep + 1} belongs to the ${expected.team} team.`,
    );
  }
  if (usedHeroIds(state).has(input.heroId)) {
    throw new DraftOrderError('Hero already picked or banned.');
  }
  if (input.action === 'pick' && input.lane && !(LANES as readonly string[]).includes(input.lane)) {
    throw new DraftOrderError('Unknown lane.');
  }

  const teamKey = input.team === 'blue' ? 'blueTeam' : 'redTeam';
  const team: TeamState = {
    picks: [...state[teamKey].picks],
    bans: [...state[teamKey].bans],
  };
  if (input.action === 'pick') {
    team.picks.push({ heroId: input.heroId, heroName: input.heroName, lane: input.lane });
  } else {
    team.bans.push({ heroId: input.heroId, heroName: input.heroName });
  }

  return { ...state, [teamKey]: team, currentStep: state.currentStep + 1 };
}

// Reverts the last applied step. Returns the same state when nothing to undo.
export function undoAction(state: DraftState): DraftState {
  if (state.currentStep === 0) return state;
  const last = stepAt(state.mode, state.currentStep - 1);
  if (!last) return state;
  const teamKey = last.team === 'blue' ? 'blueTeam' : 'redTeam';
  const team: TeamState = {
    picks: [...state[teamKey].picks],
    bans: [...state[teamKey].bans],
  };
  if (last.action === 'pick') team.picks.pop();
  else team.bans.pop();
  return { ...state, [teamKey]: team, currentStep: state.currentStep - 1 };
}

export function isComplete(state: DraftState): boolean {
  return state.currentStep >= totalSteps(state.mode);
}
