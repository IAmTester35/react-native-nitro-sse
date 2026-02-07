#include <jni.h>
#include "nitrosseOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::nitrosse::initialize(vm);
}
