#!/usr/bin/env bash

set -e

echo "=================================================="
echo "⚡ Running Nitrogen Codegen for react-native-nitro-sse"
echo "=================================================="

# Move to workspace root
cd "$(dirname "$0")/../../.."

echo "Generating C++, Swift, and Kotlin bindings from src/*.nitro.ts..."
yarn nitrogen

echo "✅ Nitrogen Codegen completed successfully!"
