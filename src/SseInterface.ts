export type HttpMethod = 'get' | 'post';

export type SseEventType = 'open' | 'message' | 'error' | 'close' | 'heartbeat';

export interface SseConfig {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  backgroundExecution?: boolean;
  batchingIntervalMs?: number;
  maxBufferSize?: number;
}

export interface SseEvent {
  type: SseEventType;
  data?: string;
  id?: string;
  event?: string;
  message?: string;
}

export interface SseStats {
  totalBytesReceived: number;
  reconnectCount: number;
  lastErrorTime?: number;
  lastErrorCode?: string;
}
