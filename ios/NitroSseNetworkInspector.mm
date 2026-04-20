#import "NitroSseNetworkInspector.h"

#if __has_include(<React/RCTInspectorNetworkReporter.h>)
#import <React/RCTInspectorNetworkReporter.h>
#define HAS_NETWORK_REPORTER 1
#endif

@implementation NitroSseNetworkInspector

+ (nullable NSString *)reportRequestStart:(NSURLRequest *)request
                        encodedDataLength:(NSInteger)encodedDataLength {
#ifdef HAS_NETWORK_REPORTER
    NSString *requestId = [[NSUUID UUID] UUIDString];
    [RCTInspectorNetworkReporter reportRequestStart:(id)requestId request:request encodedDataLength:(int)encodedDataLength];
    [RCTInspectorNetworkReporter reportConnectionTiming:(id)requestId request:request];
    return requestId;
#else
    return nil;
#endif
}

+ (void)reportResponseStart:(nullable NSString *)requestId
                        url:(nullable NSString *)url
                   response:(nullable NSURLResponse *)response
                 statusCode:(NSInteger)statusCode
                    headers:(NSDictionary<NSString *, NSString *> *)headers {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        NSURLResponse *finalResponse = response;
        if (finalResponse == nil) {
            // Reconstruct a dummy response using standard SSE headers if none provided
            NSMutableDictionary *mergedHeaders = [headers mutableCopy] ?: [NSMutableDictionary new];
            if (!mergedHeaders[@"Content-Type"]) mergedHeaders[@"Content-Type"] = @"text/event-stream";
            if (!mergedHeaders[@"Cache-Control"]) mergedHeaders[@"Cache-Control"] = @"no-cache";
            if (!mergedHeaders[@"Connection"]) mergedHeaders[@"Connection"] = @"keep-alive";
            
            finalResponse = [[NSHTTPURLResponse alloc] initWithURL:[NSURL URLWithString:url ?: @"http://sse-stream/"]
                                                        statusCode:statusCode
                                                       HTTPVersion:@"HTTP/1.1"
                                                      headerFields:mergedHeaders];
            // Pass the merged headers to the reporter as well
            [RCTInspectorNetworkReporter reportResponseStart:(id)requestId response:finalResponse statusCode:(int)statusCode headers:mergedHeaders];
        } else {
            [RCTInspectorNetworkReporter reportResponseStart:(id)requestId response:finalResponse statusCode:(int)statusCode headers:headers ?: @{}];
        }
    }
#endif
}

+ (void)reportResponseEnd:(nullable NSString *)requestId
        encodedDataLength:(NSInteger)encodedDataLength {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        [RCTInspectorNetworkReporter reportResponseEnd:(id)requestId encodedDataLength:(int)encodedDataLength];
    }
#endif
}

+ (void)reportRequestFailed:(nullable NSString *)requestId
                  cancelled:(BOOL)cancelled {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        [RCTInspectorNetworkReporter reportRequestFailed:(id)requestId cancelled:cancelled];
    }
#endif
}

@end
