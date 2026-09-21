import {
  BANS_PER_TEAM,
  DRAFT_ORDERS,
  DraftOrderError,
  DraftState,
  applyAction,
  emptyTeam,
  isComplete,
  stepAt,
  totalSteps,
  undoAction,
  usedHeroIds,
} from './pickban-order';

function fresh(mode: DraftState['mode'] = 'ranked'): DraftState {
  return { mode, currentStep: 0, blueTeam: emptyTeam(), redTeam: emptyTeam() };
}

// Plays the whole draft with distinct hero ids following the expected order.
function playAll(mode: DraftState['mode']): DraftState {
  let state = fresh(mode);
  for (let i = 0; i < totalSteps(mode); i++) {
    const step = stepAt(mode, i)!;
    state = applyAction(state, {
      action: step.action,
      team: step.team,
      heroId: `h${i}`,
      heroName: `Hero ${i}`,
      lane: step.action === 'pick' ? 'mid' : undefined,
    });
  }
  return state;
}

describe('pickban draft order', () => {
  it('has 16 steps in ranked (3 bans/team) and 20 in tournament (5 bans/team)', () => {
    expect(totalSteps('ranked')).toBe(16);
    expect(totalSteps('tournament')).toBe(20);
    expect(DRAFT_ORDERS.ranked.filter((s) => s.action === 'ban')).toHaveLength(
      BANS_PER_TEAM.ranked * 2,
    );
    expect(DRAFT_ORDERS.tournament.filter((s) => s.action === 'ban')).toHaveLength(
      BANS_PER_TEAM.tournament * 2,
    );
  });

  it('alternates bans starting with blue, then snake-picks B R R B B R R B B R', () => {
    const ranked = DRAFT_ORDERS.ranked;
    expect(ranked.slice(0, 6).map((s) => s.team)).toEqual([
      'blue', 'red', 'blue', 'red', 'blue', 'red',
    ]);
    expect(ranked.slice(6).map((s) => s.team)).toEqual([
      'blue', 'red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red',
    ]);
    expect(ranked.slice(6).every((s) => s.action === 'pick')).toBe(true);
  });

  it('gives each team 5 picks and the right number of bans once complete', () => {
    for (const mode of ['ranked', 'tournament'] as const) {
      const done = playAll(mode);
      expect(isComplete(done)).toBe(true);
      expect(done.blueTeam.picks).toHaveLength(5);
      expect(done.redTeam.picks).toHaveLength(5);
      expect(done.blueTeam.bans).toHaveLength(BANS_PER_TEAM[mode]);
      expect(done.redTeam.bans).toHaveLength(BANS_PER_TEAM[mode]);
      expect(usedHeroIds(done).size).toBe(totalSteps(mode));
    }
  });

  it('rejects an action that does not match the expected step', () => {
    const state = fresh();
    expect(() =>
      applyAction(state, { action: 'pick', team: 'blue', heroId: 'a', heroName: 'A' }),
    ).toThrow(DraftOrderError);
    expect(() =>
      applyAction(state, { action: 'ban', team: 'red', heroId: 'a', heroName: 'A' }),
    ).toThrow(/blue team/);
  });

  it('rejects a hero already picked or banned by either team', () => {
    let state = fresh();
    state = applyAction(state, { action: 'ban', team: 'blue', heroId: 'ling', heroName: 'Ling' });
    expect(() =>
      applyAction(state, { action: 'ban', team: 'red', heroId: 'ling', heroName: 'Ling' }),
    ).toThrow(/already/);
  });

  it('rejects an unknown lane on a pick', () => {
    let state = fresh();
    for (let i = 0; i < 6; i++) {
      state = applyAction(state, {
        action: 'ban',
        team: i % 2 === 0 ? 'blue' : 'red',
        heroId: `b${i}`,
        heroName: `B${i}`,
      });
    }
    expect(() =>
      applyAction(state, { action: 'pick', team: 'blue', heroId: 'x', heroName: 'X', lane: 'top' }),
    ).toThrow(/lane/);
  });

  it('refuses actions once the draft is complete', () => {
    const done = playAll('ranked');
    expect(() =>
      applyAction(done, { action: 'pick', team: 'red', heroId: 'z', heroName: 'Z' }),
    ).toThrow(/complete/);
  });

  it('undo reverts the last step and frees the hero', () => {
    let state = fresh();
    state = applyAction(state, { action: 'ban', team: 'blue', heroId: 'a', heroName: 'A' });
    state = applyAction(state, { action: 'ban', team: 'red', heroId: 'b', heroName: 'B' });
    const undone = undoAction(state);
    expect(undone.currentStep).toBe(1);
    expect(undone.redTeam.bans).toEqual([]);
    expect(undone.blueTeam.bans).toHaveLength(1);
    expect(usedHeroIds(undone).has('b')).toBe(false);
    // Undo is a no-op on a fresh draft.
    expect(undoAction(fresh())).toEqual(fresh());
  });

  it('does not mutate the input state', () => {
    const state = fresh();
    applyAction(state, { action: 'ban', team: 'blue', heroId: 'a', heroName: 'A' });
    expect(state.currentStep).toBe(0);
    expect(state.blueTeam.bans).toEqual([]);
  });
});
