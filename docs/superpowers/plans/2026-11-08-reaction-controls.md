# Queue Reaction Controls Implementation Plan

> Execute inline with superpowers:executing-plans and test-driven-development.

**Goal:** Restore clickable music controls on the Fluxer queue message.
**Architecture:** ControlMessage seeds emoji and identifies its current message. A reaction handler validates events and delegates to MusicService. BotClient routes reaction events as bounded background work.
**Tech Stack:** TypeScript, native Fluxer REST/Gateway, node:test.
**Spec:** docs/superpowers/specs/2026-11-08-reaction-controls-design.md

## Constraints and review focus

No Discord imports or Dashboard changes. Preserve existing permissions. Check retained/recreated messages, malformed/custom emoji events, permission denial, concurrent toggles, and cleanup failures.

## Tasks

- [x] Add failing tests for reaction actions, routing filters, denial, cleanup and message seeding.
- [x] Implement src/lib/music/controlReactions.ts, extend controlMessage.ts and route in BotClient.ts. Use expectedRevision to reject concurrent stale decisions; retain the runtime background-task limit.
- [x] Update permission documentation and migration matrix.
- [x] Run focused tests, typecheck, lint, Prettier and both application test suites; review the diff.

## Verification

Focused reaction/control-message/runtime tests pass. Typecheck, lint and repository Prettier checks pass. The full Bot and Dashboard suites pass when run with localhost binding permitted; the sandboxed run was blocked by EPERM in the existing health/API listener test. No commit or deployment was requested.
