package com.margelo.nitro.core

import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements

@Implements(HybridObject::class)
class ShadowHybridObject {
    @Implementation
    protected fun initHybrid(): Any? {
        return null
    }
}
