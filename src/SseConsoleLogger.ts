import type { SseEvent } from './SseInterface';

declare const __DEV__: boolean | undefined;

/**
 * Returns true when running in a React Native development environment (`__DEV__ === true`).
 */
export function isDevEnvironment(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

/**
 * Emits a warning to the DevTools console in development builds only.
 */
export function devWarn(message: string, ...args: unknown[]): void {
  if (!isDevEnvironment()) return;
  console.warn(message, ...args);
}

/**
 * Emits a debug message to the DevTools console in development builds only.
 */
export function devDebug(message: string, ...args: unknown[]): void {
  if (!isDevEnvironment()) return;
  console.debug(message, ...args);
}

/**
 * Emits an error to the DevTools console (used for user-code exceptions and invalid options).
 */
export function logError(message: string, ...args: unknown[]): void {
  console.error(message, ...args);
}

/**
 * Reports unhandled native/driver SSE `error` events in `__DEV__` via `console.warn`
 * (avoiding RedBox overlays for transient reconnects) while deduplicating consecutive
 * identical error signatures to prevent reconnect-loop console spam.
 */
export class UnhandledSseErrorReporter {
  private _lastSignature: string | null = null;

  report(scope: '[NitroSse]' | '[useNitroSse]', event: SseEvent): void {
    if (!isDevEnvironment()) return;

    const detail = event.message ?? 'Unknown SSE error';
    const statusPart =
      event.statusCode !== undefined ? ` (status: ${event.statusCode})` : '';
    const signature = `${event.statusCode ?? ''}|${detail}`;

    if (this._lastSignature === signature) {
      return;
    }
    this._lastSignature = signature;

    const hint =
      scope === '[useNitroSse]'
        ? 'Provide an `onError` callback to handle stream errors.'
        : "Attach an `addEventListener('error', ...)` listener to handle stream errors.";

    console.warn(
      `${scope} Unhandled SSE error: ${detail}${statusPart}. ${hint}`,
      event
    );
  }

  reset(): void {
    this._lastSignature = null;
  }
}
