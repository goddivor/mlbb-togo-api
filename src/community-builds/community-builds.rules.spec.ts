import {
  assertLikeable,
  assertOwner,
  assertPickable,
  assertPublishable,
  assertReportable,
  assertTalentTiers,
  BuildRuleError,
  canView,
  cleanText,
  LIMITS,
  normalizeItemIds,
  normalizeLane,
  normalizeNotes,
  normalizePage,
  normalizeReportReason,
  normalizeSort,
  normalizeTitle,
  quotaError,
  quotaKey,
} from './community-builds.rules';

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof BuildRuleError ? err.code : 'other';
  }
};

const id = (n: number) => n.toString(16).padStart(24, '0');

describe('community builds rules: content', () => {
  it('normalizes the title and enforces its length', () => {
    expect(normalizeTitle('  Burst   Ling \u0007 ')).toBe('Burst Ling');
    expect(codeOf(() => normalizeTitle('ab'))).toBe('title_length');
    expect(codeOf(() => normalizeTitle('x'.repeat(LIMITS.titleMax + 1)))).toBe('title_length');
    expect(codeOf(() => normalizeTitle(undefined))).toBe('title_length');
  });

  it('keeps line breaks in notes, caps their length and maps blank to null', () => {
    expect(normalizeNotes('line 1\r\n\n\n\nline 2')).toBe('line 1\n\nline 2');
    expect(normalizeNotes('   ')).toBeNull();
    expect(codeOf(() => normalizeNotes('x'.repeat(LIMITS.notesMax + 1)))).toBe('notes_length');
    expect(cleanText(42)).toBe('');
  });

  it('accepts known lanes only', () => {
    expect(normalizeLane('jungle')).toBe('jungle');
    expect(normalizeLane('')).toBeNull();
    expect(normalizeLane(null)).toBeNull();
    expect(codeOf(() => normalizeLane('top'))).toBe('lane');
  });

  it('allows at most 6 distinct items', () => {
    expect(normalizeItemIds([id(1), id(2)])).toEqual([id(1), id(2)]);
    expect(normalizeItemIds(undefined)).toEqual([]);
    expect(codeOf(() => normalizeItemIds([1, 2, 3, 4, 5, 6, 7].map(id)))).toBe('items_count');
    expect(codeOf(() => normalizeItemIds([id(1), id(1)]))).toBe('items_duplicate');
  });

  it('requires enabled catalog entries, except ones the build already had', () => {
    const rows = [
      { id: id(1), enabled: true },
      { id: id(2), enabled: null },
      { id: id(3), enabled: false },
    ];
    expect(codeOf(() => assertPickable([id(1), id(2)], rows, 'item'))).toBeNull();
    expect(codeOf(() => assertPickable([id(3)], rows, 'item'))).toBe('item_disabled');
    expect(codeOf(() => assertPickable([id(3)], rows, 'item', [id(3)]))).toBeNull();
    expect(codeOf(() => assertPickable([id(9)], rows, 'item'))).toBe('item_unknown');
  });

  it('allows one talent per tier, three at most', () => {
    expect(codeOf(() => assertTalentTiers([{ id: 'a', tier: 1 }, { id: 'b', tier: 2 }, { id: 'c', tier: 3 }]))).toBeNull();
    expect(codeOf(() => assertTalentTiers([{ id: 'a', tier: 1 }, { id: 'b', tier: 1 }]))).toBe('talents_tier_duplicate');
    expect(codeOf(() => assertTalentTiers([{ id: 'a', tier: null }]))).toBe('talents_tier');
    expect(
      codeOf(() => assertTalentTiers([1, 2, 3, 1].map((tier, i) => ({ id: String(i), tier })))),
    ).toBe('talents_count');
  });

  it('needs a title and at least one item to publish', () => {
    expect(codeOf(() => assertPublishable({ title: 'Good build', itemIds: [id(1)] }))).toBeNull();
    expect(codeOf(() => assertPublishable({ title: 'Good build', itemIds: [] }))).toBe('publish_no_items');
    expect(codeOf(() => assertPublishable({ title: '', itemIds: [id(1)] }))).toBe('title_length');
  });
});

describe('community builds rules: access', () => {
  const author = { id: 'u1' };
  const other = { id: 'u2' };
  const moderator = { id: 'm1', canModerate: true };
  const build = (status: string) => ({ authorId: 'u1', status });

  it('shows published builds to everyone', () => {
    expect(canView(build('published'), null)).toBe(true);
    expect(canView(build('published'), other)).toBe(true);
  });

  it('keeps drafts private to their author, even from moderators', () => {
    expect(canView(build('draft'), author)).toBe(true);
    expect(canView(build('draft'), other)).toBe(false);
    expect(canView(build('draft'), moderator)).toBe(false);
    expect(canView(build('draft'), null)).toBe(false);
  });

  it('shows hidden builds to their author and moderators only', () => {
    expect(canView(build('hidden'), author)).toBe(true);
    expect(canView(build('hidden'), moderator)).toBe(true);
    expect(canView(build('hidden'), other)).toBe(false);
    expect(canView(build('hidden'), null)).toBe(false);
  });

  it('reserves edits to the author', () => {
    expect(codeOf(() => assertOwner(build('draft'), author))).toBeNull();
    expect(codeOf(() => assertOwner(build('draft'), other))).toBe('not_owner');
    expect(codeOf(() => assertOwner(build('published'), moderator))).toBe('not_owner');
    expect(codeOf(() => assertOwner(build('draft'), null))).toBe('not_owner');
  });

  it('allows likes and reports on published builds of other players only', () => {
    expect(codeOf(() => assertLikeable(build('published'), other))).toBeNull();
    expect(codeOf(() => assertLikeable(build('published'), author))).toBe('like_own');
    expect(codeOf(() => assertLikeable(build('hidden'), moderator))).toBe('like_not_published');
    expect(codeOf(() => assertReportable(build('published'), other))).toBeNull();
    expect(codeOf(() => assertReportable(build('published'), author))).toBe('report_own');
    expect(codeOf(() => assertReportable(build('draft'), other))).toBe('report_not_published');
  });
});

describe('community builds rules: queries and quotas', () => {
  it('parses sort, page and limit defensively', () => {
    expect(normalizeSort('recent')).toBe('recent');
    expect(normalizeSort('whatever')).toBe('likes');
    expect(normalizePage(undefined, undefined)).toEqual({ page: 1, limit: LIMITS.pageSizeDefault, skip: 0 });
    expect(normalizePage('3', '10')).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(normalizePage('-2', '999').limit).toBe(LIMITS.pageSizeMax);
    expect(normalizePage('Infinity', '10').page).toBe(1);
    expect(normalizePage('1e20', '10').page).toBe(LIMITS.pageMax);
  });

  it('validates report reasons', () => {
    expect(normalizeReportReason('spam')).toBe('spam');
    expect(codeOf(() => normalizeReportReason('boring'))).toBe('report_reason');
  });

  it('keys daily quotas by UTC day and the builds counter by user', () => {
    const at = new Date('2026-09-21T23:30:00.000Z');
    expect(quotaKey('publish', 'u1', at)).toBe('publish:u1:2026-09-21');
    expect(quotaKey('report', 'u1', at)).toBe('report:u1:2026-09-21');
    expect(quotaKey('publish', 'u1', new Date('2026-09-22T00:00:01.000Z'))).toBe('publish:u1:2026-09-22');
    expect(quotaKey('builds', 'u1', at)).toBe('builds:u1');
    expect([quotaError('publish').code, quotaError('report').code, quotaError('builds').code]).toEqual([
      'quota_publish',
      'quota_reports',
      'quota_builds',
    ]);
  });
});
