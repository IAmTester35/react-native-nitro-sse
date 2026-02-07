import { NitroModules } from 'react-native-nitro-modules';
import type { NitroSse } from './NitroSse.nitro';

const NitroSseHybridObject =
  NitroModules.createHybridObject<NitroSse>('NitroSse');

export function multiply(a: number, b: number): number {
  return NitroSseHybridObject.multiply(a, b);
}
