import { ArgumentsHost, ServiceUnavailableException } from '@nestjs/common';
import { EncryptionKeyMissingFilter, ENCRYPTION_KEY_MISSING_MESSAGE } from './encryption-key-missing.filter';
import { EncryptionKeyMissingError, decrypt } from '../utils/crypto.util';

const httpHost = () => {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const host = { getType: () => 'http', switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
  return { host, res };
};

describe('EncryptionKeyMissingFilter', () => {
  const filter = new EncryptionKeyMissingFilter();

  it('answers 503 with an explicit message over HTTP', () => {
    const { host, res } = httpHost();
    filter.catch(new EncryptionKeyMissingError(), host);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 503,
      message: ENCRYPTION_KEY_MISSING_MESSAGE,
      error: 'Service Unavailable',
    });
  });

  it('returns a 503 exception in non-HTTP contexts (GraphQL)', () => {
    const host = { getType: () => 'graphql' } as unknown as ArgumentsHost;
    const out = filter.catch(new EncryptionKeyMissingError(), host);
    expect(out).toBeInstanceOf(ServiceUnavailableException);
  });

  it('catches what the crypto helpers throw without a key', () => {
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      expect(() => decrypt('v2:aa:bb:cc')).toThrow(EncryptionKeyMissingError);
    } finally {
      if (previous !== undefined) process.env.ENCRYPTION_KEY = previous;
    }
  });
});
