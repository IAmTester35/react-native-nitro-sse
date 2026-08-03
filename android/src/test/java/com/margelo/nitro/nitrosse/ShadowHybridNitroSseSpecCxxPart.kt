package com.margelo.nitro.nitrosse

import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

/**
 * Robolectric shadow stubbing native C++ initialization for `HybridNitroSseSpec.CxxPart`.
 *
 * Prevents JVM unit tests from failing on unsatisfied C++ link errors when native shared libraries
 * are not compiled into test binaries.
 */
@Implements(className = "com.margelo.nitro.nitrosse.HybridNitroSseSpec\$CxxPart")
class ShadowHybridNitroSseSpecCxxPart {
    @Implementation
    fun initHybrid(): Any? {
        return null
    }
}
