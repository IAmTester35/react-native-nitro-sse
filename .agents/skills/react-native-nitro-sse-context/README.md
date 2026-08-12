# Skill Context: react-native-nitro-sse

This directory contains a Custom Skill designed according to the 3-layer Progressive Disclosure standard for the **react-native-nitro-sse** library.

## Skill Folder Structure

- `SKILL.md`: Main entry point containing YAML metadata and multi-language library overview (TS, Kotlin, Swift).
- `references/`: Deep-dive resource documentation (read on-demand when tasks require it):
  - `architecture.md`: Details on JSI Nitro Modules architecture, Threading Serialization, Backpressure Buffer, Lifecycle & DevTools Inspector.
  - `conventions.md`: Code conventions across TypeScript, Kotlin, and Swift, thread safety rules, error status handling & attempt versioning.
  - `native-implementations.md`: Implementation details on iOS (LDSwiftEventSource / GCD) and Android (OkHttp SSE / HandlerThread).
  - `testing-guide.md`: 3-tier unit testing workflow (Jest JS, Android JUnit/Robolectric, iOS XCTest).
  - `workflows.md`: Nitrogen codegen workflow, running the example app, local SSE mock server, lint/typecheck, and release process.
  - `troubleshooting.md`: Common errors (Nitrogen out-of-sync, JS Dispatcher destroyed, background task limit) and resolution steps.
- `scripts/`:
  - `run_tests.sh`: Helper script to run typecheck, lint, JS unit tests, and native test suites.
  - `codegen.sh`: Helper script to run Nitrogen codegen.

## How to Activate & Install

This Skill is automatically saved in the project repository at `.agents/skills/react-native-nitro-sse-context/`.
When working in this project using Claude Code / Antigravity IDE, the agent will automatically discover and load the skill whenever relevant project questions or tasks arise.
