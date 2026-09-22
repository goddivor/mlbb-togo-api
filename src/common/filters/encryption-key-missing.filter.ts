import { ArgumentsHost, Catch, ExceptionFilter, ServiceUnavailableException } from '@nestjs/common';
import { EncryptionKeyMissingError } from '../utils/crypto.util';

export const ENCRYPTION_KEY_MISSING_MESSAGE =
  'ENCRYPTION_KEY absente ou trop courte (32 caractères minimum) : les secrets chiffrés (jetons YouTube, clé de stream, intégrations) sont indisponibles.';

/**
 * A missing ENCRYPTION_KEY is a server configuration problem, not a bug of
 * the request: answer 503 with an explicit message instead of a generic 500,
 * wherever the error is thrown (YouTube tokens, stream key, integrations...).
 */
@Catch(EncryptionKeyMissingError)
export class EncryptionKeyMissingFilter implements ExceptionFilter {
  catch(_error: EncryptionKeyMissingError, host: ArgumentsHost) {
    const exception = new ServiceUnavailableException(ENCRYPTION_KEY_MISSING_MESSAGE);
    // GraphQL (and other non-HTTP contexts) format the returned exception themselves.
    if (host.getType() !== 'http') return exception;
    const res = host.switchToHttp().getResponse();
    res.status(exception.getStatus()).json(exception.getResponse());
  }
}
