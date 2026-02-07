import { NitroModules } from 'react-native-nitro-modules';
import type { NitroSse } from './NitroSse.nitro';

export * from './SseInterface';
export * from './NitroSse.nitro';

// Load the Hybrid Object from Native
let realNitroSse: NitroSse | undefined;
try {
  realNitroSse = NitroModules.createHybridObject<NitroSse>('NitroSse');
} catch {
  console.debug(
    'Native NitroSse not found. This might be a test environment or web.'
  );
}

/**
 * Public interface to use SSE.
 */
if (!realNitroSse || !(realNitroSse as any).setup) {
  throw new Error(
    'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.'
  );
}

export const NitroSseModule: NitroSse = realNitroSse;
