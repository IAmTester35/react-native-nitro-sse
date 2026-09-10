/**
 * Error codes identifying specific categories of NitroSse failures.
 */
export type NitroSseErrorCode =
  | 'NATIVE_MODULE_NOT_FOUND'
  | 'INVALID_CONFIG'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'CLIENT_DISPOSED';

/**
 * Base structured error class for all errors thrown by react-native-nitro-sse.
 * Carries a machine-readable `code` and optional `details` payload for defensive debugging.
 */
export class NitroSseError extends Error {
  readonly code: NitroSseErrorCode;
  readonly details?: unknown;

  constructor(message: string, code: NitroSseErrorCode, details?: unknown) {
    super(message);
    this.name = 'NitroSseError';
    this.code = code;
    this.details = details;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the native Nitro hybrid module cannot be resolved or linked.
 */
export class NitroSseModuleNotFoundError extends NitroSseError {
  constructor(message?: string, details?: unknown) {
    super(
      message ??
        'NitroSse: Native module not found. Ensure you have linked the library and built the app for iOS/Android.',
      'NATIVE_MODULE_NOT_FOUND',
      details
    );
    this.name = 'NitroSseModuleNotFoundError';
  }
}

/**
 * Thrown when configuration parameters, URLs, headers, or arguments fail defensive validation.
 */
export class NitroSseValidationError extends NitroSseError {
  constructor(
    message: string,
    code: 'INVALID_CONFIG' | 'INVALID_ARGUMENT' = 'INVALID_CONFIG',
    details?: unknown
  ) {
    super(message, code, details);
    this.name = 'NitroSseValidationError';
  }
}

/**
 * Thrown when an operation is attempted in an invalid state (e.g. calling operations on an unconfigured client).
 */
export class NitroSseStateError extends NitroSseError {
  constructor(message: string, details?: unknown) {
    super(message, 'INVALID_STATE', details);
    this.name = 'NitroSseStateError';
  }
}

/**
 * Thrown when any method is invoked on a client instance that has already been disposed.
 */
export class NitroSseDisposedError extends NitroSseError {
  constructor(message?: string, details?: unknown) {
    super(
      message ??
        '[NitroSse] Cannot perform operation on a disposed NitroSseClient instance.',
      'CLIENT_DISPOSED',
      details
    );
    this.name = 'NitroSseDisposedError';
  }
}
