import { Platform } from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import { NitroSseClient } from './NitroSseClient';
import { FetchSseDriver } from './FetchSseDriver';
import { NitroSseModuleNotFoundError } from './NitroSseError';
import type { NitroSse } from './NitroSse.nitro';
import type { SseClient } from './SseInterface';

/**
 * Creates a high-performance SSE client that supports typed event listeners (`addEventListener`) and legacy batching.
 *
 * @returns An SseClient instance wrapping the native NitroSse implementation, or FetchSseDriver on Web.
 * @throws {NitroSseModuleNotFoundError} If the native NitroSse module cannot be found on iOS/Android.
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

  // Graceful fallback for Web
  if (Platform.OS === 'web') {
    return new NitroSseClient(new FetchSseDriver());
  }

  throw new NitroSseModuleNotFoundError(
    'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.'
  );
}
