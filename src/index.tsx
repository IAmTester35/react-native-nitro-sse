import { NitroModules } from 'react-native-nitro-modules';
import type { NitroSse } from './NitroSse.nitro';

export * from './SseInterface';
export * from './NitroSse.nitro';

export function createNitroSse(): NitroSse {
  let nativeSse: NitroSse | undefined;
  try {
    nativeSse = NitroModules.createHybridObject<NitroSse>('NitroSse');
  } catch {}

  if (!nativeSse) {
    console.debug(
      'Native NitroSse not found. This might be a test environment or web.'
    );
    throw new Error(
      'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.'
    );
  }
  return nativeSse;
}
