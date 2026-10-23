import { NitroModules } from 'react-native-nitro-modules';
import { NitroSseClient } from './NitroSseClient';
import { NitroSseModuleNotFoundError } from './NitroSseError';
import type { NitroSse } from './NitroSse.nitro';
import type { SseClient } from './SseInterface';

/**
 * Creates an SSE client for iOS and Android using Nitro Modules (JSI).
 *
 * @returns An SseClient instance backed by native NitroSse.
 * @throws {NitroSseModuleNotFoundError} If the native NitroSse module cannot be found.
 */
export function createNitroSse(): SseClient {
  let nativeSse: NitroSse | undefined;
  try {
    nativeSse = NitroModules.createHybridObject<NitroSse>('NitroSse');
  } catch {
    console.debug(
      'Native NitroSse not found. This might be a test environment or web.'
    );
  }

  if (nativeSse) {
    return new NitroSseClient(nativeSse);
  }

  throw new NitroSseModuleNotFoundError(
    'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.'
  );
}
