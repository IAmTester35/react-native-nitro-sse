import { NitroSseClient } from './NitroSseClient';
import { FetchSseDriver } from './FetchSseDriver';
import type { SseClient } from './SseInterface';

/**
 * Creates an SSE client for Web platform using WHATWG fetch() and ReadableStream.
 *
 * @returns An SseClient instance backed by FetchSseDriver.
 */
export function createNitroSse(): SseClient {
  return new NitroSseClient(new FetchSseDriver());
}
