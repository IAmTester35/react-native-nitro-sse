import { Platform } from 'react-native';
import { NitroSseClient } from './NitroSseClient';
import { FetchSseDriver } from './FetchSseDriver';
import { NitroSseModuleNotFoundError } from './NitroSseError';
import { createNitroSse as createNativeNitroSse } from './createNitroSse.native';
import type { SseClient } from './SseInterface';

/**
 * Creates a high-performance SSE client that supports typed event listeners (`addEventListener`) and legacy batching.
 *
 * @returns An SseClient instance wrapping the native NitroSse implementation, or FetchSseDriver on Web.
 * @throws {NitroSseModuleNotFoundError} If the native NitroSse module cannot be found on iOS/Android.
 */
export function createNitroSse(): SseClient {
  try {
    return createNativeNitroSse();
  } catch (error) {
    if (Platform.OS === 'web' && error instanceof NitroSseModuleNotFoundError) {
      return new NitroSseClient(new FetchSseDriver());
    }
    throw error;
  }
}
