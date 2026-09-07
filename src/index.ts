import { NitroModules } from 'react-native-nitro-modules';
import { NitroSseClient } from './NitroSseClient';
import { NitroSseModuleNotFoundError } from './NitroSseError';
import type { NitroSse } from './NitroSse.nitro';
import type { SseClient } from './SseInterface';

export * from './SseInterface';
export * from './NitroSse.nitro';
export * from './useNitroSse';
export * from './NitroSseClient';
export * from './NitroSseError';

/**
 * Creates a high-performance SSE client that supports typed event listeners (`addEventListener`) and legacy batching.
 *
 * @returns An SseClient instance wrapping the native NitroSse implementation.
 * @throws {NitroSseModuleNotFoundError} If the native NitroSse module cannot be found. Ensure the library is linked and the app is built for iOS/Android.
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

  if (!nativeSse) {
    throw new NitroSseModuleNotFoundError(
      'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.'
    );
  }
  return new NitroSseClient(nativeSse);
}
