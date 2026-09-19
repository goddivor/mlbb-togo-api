import { countUnread, isRoomKind, parseMentions, threadRoom, TtlCache } from './rooms.util';

const members = [
  { id: 'u1', username: 'Alpha' },
  { id: 'u2', username: 'beta.gamma' },
  { id: 'u3', username: 'delta' },
];

describe('rooms.util', () => {
  describe('parseMentions', () => {
    it('returns the ids of mentioned members, case-insensitively', () => {
      expect(parseMentions('yo @alpha et @DELTA gg', members)).toEqual(['u1', 'u3']);
    });

    it('ignores unknown handles and email addresses', () => {
      expect(parseMentions('mail me at foo@alpha.com or @nobody', members)).toEqual([]);
    });

    it('accepts handles at the start of the text and after punctuation', () => {
      expect(parseMentions('@alpha, (@delta)', members)).toEqual(['u1', 'u3']);
    });

    it('drops trailing punctuation and dedupes', () => {
      expect(parseMentions('@beta.gamma. @beta.gamma!', members)).toEqual(['u2']);
    });

    it('handles empty input', () => {
      expect(parseMentions('', members)).toEqual([]);
      expect(parseMentions('hello', [])).toEqual([]);
    });
  });

  describe('countUnread', () => {
    const at = (s: number) => new Date(1000 * s);
    const messages = [
      { senderId: 'me', createdAt: at(1) },
      { senderId: 'other', createdAt: at(2) },
      { senderId: 'other', createdAt: at(3) },
      { senderId: 'other', createdAt: at(4) },
    ];

    it('counts every foreign message when there is no cursor', () => {
      expect(countUnread(messages, 'me', null)).toBe(3);
    });

    it('only counts messages newer than the cursor', () => {
      expect(countUnread(messages, 'me', at(3))).toBe(1);
      expect(countUnread(messages, 'me', at(4))).toBe(0);
    });

    it('never counts my own messages', () => {
      expect(countUnread(messages, 'other', null)).toBe(1);
    });
  });

  describe('TtlCache', () => {
    it('expires entries after the ttl', () => {
      const cache = new TtlCache<number>(100);
      cache.set('a', 1, 0);
      expect(cache.get('a', 50)).toBe(1);
      expect(cache.get('a', 100)).toBeUndefined();
    });

    it('distinguishes a cached null from a miss', () => {
      const cache = new TtlCache<number | null>(100);
      cache.set('a', null, 0);
      expect(cache.get('a', 10)).toBeNull();
      expect(cache.get('b', 10)).toBeUndefined();
    });
  });

  it('exposes room kinds and room names', () => {
    expect(isRoomKind('team')).toBe(true);
    expect(isRoomKind('direct')).toBe(false);
    expect(threadRoom('t1')).toBe('thread:t1');
  });
});
