import Foundation

/// In-memory URLProtocol mock allowing unit tests to simulate HTTP responses,
/// streaming chunks, status codes, and network errors without real network sockets.
final class MockURLProtocol: URLProtocol {
    typealias ResponseProvider = (URLRequest) throws -> (HTTPURLResponse, [Data], TimeInterval)
    
    private static var handler: ResponseProvider?
    private static let lock = NSLock()
    
    static func setHandler(_ handler: @escaping ResponseProvider) {
        lock.lock()
        defer { lock.unlock() }
        self.handler = handler
    }
    
    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        self.handler = nil
    }
    
    override class func canInit(with request: URLRequest) -> Bool {
        return true
    }
    
    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        return request
    }
    
    override func startLoading() {
        MockURLProtocol.lock.lock()
        let currentHandler = MockURLProtocol.handler
        MockURLProtocol.lock.unlock()
        
        guard let handler = currentHandler else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: NSURLErrorDomain, code: NSURLErrorBadURL, userInfo: nil))
            return
        }
        
        do {
            let (response, chunks, chunkDelay) = try handler(self.request)
            if (300...399).contains(response.statusCode),
               let location = (response.allHeaderFields["Location"] as? String) ?? (response.value(forHTTPHeaderField: "Location")),
               let newUrl = URL(string: location, relativeTo: self.request.url) {
                var newRequest = self.request
                newRequest.url = newUrl
                self.client?.urlProtocol(self, wasRedirectedTo: newRequest, redirectResponse: response)
                return
            }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            
            for chunk in chunks {
                if chunkDelay > 0 {
                    Thread.sleep(forTimeInterval: chunkDelay)
                }
                self.client?.urlProtocol(self, didLoad: chunk)
            }
            self.client?.urlProtocolDidFinishLoading(self)
        } catch {
            self.client?.urlProtocol(self, didFailWithError: error)
        }
    }
    
    override func stopLoading() {
        // No-op for mock
    }
}
