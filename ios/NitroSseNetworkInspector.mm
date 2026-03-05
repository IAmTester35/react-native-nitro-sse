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
    [RCTInspectorNetworkReporter reportRequestStart:requestId request:request encodedDataLength:(int)encodedDataLength];
    [RCTInspectorNetworkReporter reportConnectionTiming:requestId request:request];
    return requestId;
#else
    return nil;
#endif
}

+ (void)reportResponseStart:(nullable NSString *)requestId
                   response:(nullable NSURLResponse *)response
                 statusCode:(NSInteger)statusCode
                    headers:(NSDictionary<NSString *, NSString *> *)headers {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        NSURLResponse *finalResponse = response;
        if (finalResponse == nil) {
            // Provide a dummy response to avoid crash in internal RN C++ layer
            finalResponse = [[NSURLResponse alloc] initWithURL:[NSURL URLWithString:@""]
                                                      MIMEType:@"text/event-stream"
                                         expectedContentLength:-1
                                              textEncodingName:nil];
        }
        [RCTInspectorNetworkReporter reportResponseStart:requestId response:finalResponse statusCode:(int)statusCode headers:headers];
    }
#endif
}

+ (void)reportDataReceived:(nullable NSString *)requestId
                      data:(NSData *)data {
#ifdef HAS_NETWORK_REPORTER
    if (requestId && data) {
        [RCTInspectorNetworkReporter reportDataReceived:requestId data:data];
        NSString *dataString = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (dataString) {
            [RCTInspectorNetworkReporter maybeStoreResponseBodyIncremental:requestId data:dataString];
        }
    }
#endif
}

+ (void)reportResponseEnd:(nullable NSString *)requestId
        encodedDataLength:(NSInteger)encodedDataLength {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        [RCTInspectorNetworkReporter reportResponseEnd:requestId encodedDataLength:(int)encodedDataLength];
    }
#endif
}

+ (void)reportRequestFailed:(nullable NSString *)requestId
                  cancelled:(BOOL)cancelled {
#ifdef HAS_NETWORK_REPORTER
    if (requestId) {
        [RCTInspectorNetworkReporter reportRequestFailed:requestId cancelled:cancelled];
    }
#endif
}

@end
