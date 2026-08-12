# Development Workflows — react-native-nitro-sse

This document outlines environment setup, JSI code generation (Nitrogen Codegen), working with the example workspace app (`example/`), CI/CD pipelines, and package release procedures.

---

## 1. Development Environment Setup

- **Node.js**: Version specified in `.nvmrc` (v20+).
- **Package Manager**: **Yarn 4** (Yarn Workspaces). Do NOT use `npm` to prevent workspace symlink breakage.
- **Android**: Android Studio Jellyfish/Ladybug+, JDK 17+, Android SDK 34+.
- **iOS**: Xcode 15/16+, CocoaPods, macOS Sequoia/Sonoma.

```bash
# Install dependencies across monorepo packages
yarn
```

---

## 2. Nitrogen Codegen Workflow (`yarn nitrogen`)

Whenever you modify the JSI spec interface in `src/NitroSse.nitro.ts` or configuration in `nitro.json`, you **MUST** run Nitrogen to regenerate C++, Swift Spec, and Kotlin Spec binding code:

```bash
yarn nitrogen
```

Nitrogen updates files in `nitrogen/generated/`:
- `nitrogen/generated/shared/`: C++ JSI binding glue.
- `nitrogen/generated/ios/`: Swift specs (`HybridNitroSseSpec.swift`).
- `nitrogen/generated/android/`: Kotlin specs (`HybridNitroSseSpec.kt`).

> [!CAUTION]
> Never manually edit files in `nitrogen/generated/` because they are completely overwritten whenever `yarn nitrogen` runs.

---

## 3. Example App Development Workflow (`example/`)

The example application inside `example/` is configured to link directly against the root library source code:

### Step 1: Launch Local SSE Mock Server
The repository includes a Node.js HTTP SSE Server to test real socket streaming locally:

```bash
yarn server
# Server starts at http://localhost:3000/stream
```

### Step 2: Start Metro Bundler
```bash
yarn example start
```

### Step 3: Run App on Simulator / Emulator
- **Run Android**:
  ```bash
  yarn example android
  ```
- **Run iOS**:
  ```bash
  yarn example ios
  ```

### Editing Native Code in Specialized IDEs:
- **Xcode (iOS)**: Open `example/ios/NitroSseExample.xcworkspace` in Xcode. Find Swift/ObjC source files at `Pods > Development Pods > react-native-nitro-sse`.
- **Android Studio (Android)**: Open `example/android` directory in Android Studio. Find Kotlin source files under `react-native-nitro-sse`.

---

## 4. Commit Message Conventions

The repository follows **Conventional Commits** (enforced automatically via Lefthook + Commitlint pre-commit hooks):

- `feat:` New features (e.g., `feat: add network path monitoring for Android`).
- `fix:` Bug fixes (e.g., `fix: prevent memory leak on HandlerThread disposal`).
- `refactor:` Internal code refactoring without public API changes.
- `docs:` Documentation updates in README or skill context.
- `test:` Adding or updating tests.
- `chore:` Maintenance tasks, CI updates, or release scripts.

---

## 5. CI Checking & Release Workflow

### Run CI Checks Locally
```bash
yarn ci
```
*(Executes: `yarn lint` -> `yarn typecheck` -> `yarn test` -> `yarn prepare` -> `yarn test:native` -> `yarn turbo run build:android build:ios`).*

### Package Release Workflow
Uses `release-it` to automate local version bumping (SemVer), Git tag creation, and Changelog generation:

```bash
yarn release
```

*Note: Automated npm publishing and GitHub Release generation are authoritatively handled by GitHub Actions (`.github/workflows/publish.yml`) upon pushing the release commit and tag.*
