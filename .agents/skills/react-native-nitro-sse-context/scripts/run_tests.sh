#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

echo "=================================================="
echo "🧪 Running react-native-nitro-sse Test Suite"
echo "=================================================="

# Move to workspace root
cd "$(dirname "$0")/../../../.."

echo -e "\n1. Checking TypeScript Types..."
yarn typecheck

echo -e "\n2. Checking ESLint..."
yarn lint

echo -e "\n3. Running JavaScript Unit Tests (Jest)..."
yarn test

echo -e "\n4. Running Android Native Unit Tests..."
yarn test:android

echo -e "\n5. Running iOS Native Unit Tests..."
yarn test:ios

echo -e "\n✅ All tests passed successfully!"
