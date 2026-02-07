package com.margelo.nitro.nitrosse
  
import com.facebook.proguard.annotations.DoNotStrip

@DoNotStrip
class NitroSse : HybridNitroSseSpec() {
  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }
}
