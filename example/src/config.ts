import { Platform } from 'react-native';
import { version } from '../../package.json';

export const DEV_SERVER_PORT = 33333;
export const BENCHMARK_SERVER_PORT = 3100;
export const CURRENT_LIBRARY_VERSION = version;

/**
 * Resolves the server host based on platform.
 * - Android Emulator uses 10.0.2.2 to access host loopback.
 * - iOS Simulator and Desktop use localhost.
 */
export function resolveHost(port: number): string {
  const host = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
  return `http://${host}:${port}`;
}

export function getDevServerUrl(): string {
  return `${resolveHost(DEV_SERVER_PORT)}/events`;
}

export function getBenchmarkServerUrl(): string {
  return resolveHost(BENCHMARK_SERVER_PORT);
}
