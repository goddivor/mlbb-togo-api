import { ServiceUnavailableException } from '@nestjs/common';
import { GmsError } from './gms.client';

/** Maps an upstream Moonton failure (no cached copy) to a 503 for controllers. */
export async function orUnavailable<T>(
  p: Promise<T>,
  message = 'Moonton hero statistics are temporarily unavailable.',
): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GmsError) {
      throw new ServiceUnavailableException(message);
    }
    throw e;
  }
}
