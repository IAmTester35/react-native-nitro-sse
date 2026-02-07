# Changelog

## 0.1.0-beta.2 (2026-02-07)

### ⚠️ Breaking Changes

*   **Factory Pattern**: The library now exports a factory function `createNitroSse()` instead of a singleton instance. This allows multiple concurrent SSE connections.
    *   **Old usage**:
        ```typescript
        import { NitroSseModule } from 'react-native-nitro-sse';
        NitroSseModule.setup({ url: '...' }, callback);
        ```
    *   **New usage**:
        ```typescript
        import { createNitroSse } from 'react-native-nitro-sse';
        const sse = createNitroSse();
        sse.setup({ url: '...' }, callback);
        sse.start();
        ```

### Features

*   **Multiple Concurrent Connections**: You can now create as many independent SSE connections as needed.
*   **Manual Flush**: Added `.flush()` method to forcefully send buffered events to JS immediately.
*   **Restart**: Added `.restart()` method to force a reconnection from the client side.
*   **Connection Status**: Added `.isConnected()` method to check the active state of the connection synchronously.

### Improvements

*   **Stability**: Enhanced native implementation (kotlin/swift) for robust connection handling.
*   **Tests**: Comprehensive unit tests covering the new factory pattern and methods.
*   **Cleanup**: Removed unused coverage artifacts and optimized build configuration.
