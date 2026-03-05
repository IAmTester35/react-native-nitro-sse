#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface NitroSseNetworkInspector : NSObject

+ (nullable NSString *)reportRequestStart:(NSURLRequest *)request
                        encodedDataLength:(NSInteger)encodedDataLength;

+ (void)reportResponseStart:(nullable NSString *)requestId
                   response:(nullable NSURLResponse *)response
                 statusCode:(NSInteger)statusCode
                    headers:(NSDictionary<NSString *, NSString *> *)headers;

+ (void)reportDataReceived:(nullable NSString *)requestId
                      data:(NSData *)data;

+ (void)reportResponseEnd:(nullable NSString *)requestId
        encodedDataLength:(NSInteger)encodedDataLength;

+ (void)reportRequestFailed:(nullable NSString *)requestId
                  cancelled:(BOOL)cancelled;

@end

NS_ASSUME_NONNULL_END
