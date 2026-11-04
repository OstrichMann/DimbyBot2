# Fluxer Music Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert this checkout into an independent Fluxer Bot with working music commands and Dashboard controls, preserving boundaries for later feature migrations.

**Architecture:** Native Fluxer REST/Gateway integration and LiveKit audio feed a Bot-owned music service used by both commands and HTTP/WebSocket handlers. Keep Lavalink initially as a metadata search service through its HTTP API, not as the queue or voice owner. Preserve the nested Dashboard and existing database-backed playlist behavior.

**Tech Stack:** TypeScript ESM, Node 24+, Yarn 1.22.22, Next.js, React, Express, PostgreSQL/Prisma, Better Auth 1.6.22 generic OAuth, `ws`, `@livekit/rtc-node`, FFmpeg, existing companion and Lavalink search services.

**Spec:** [Approved design](../specs/2026-11-04-fluxer-music-design.md)

## Global Constraints

- Preserve the two applications and compile graphs: Bot entry `src/server.ts`, nested Next.js Dashboard in `src/web/`, and HTTP/WebSocket communication between them. Bot code never imports the Dashboard. Keep isomorphic contracts in `src/shared/`.
- Retain TypeScript ESM, Node 24+, Yarn, PostgreSQL/Prisma, and existing repository placement and testing rules.
- Do not build a multi-platform framework or retain a Discord runtime mode.
- Use configurable `BOT_COMMAND_PREFIX`, default `!`.
- `seek` accepts seconds or `mm:ss`; `volume` accepts 0–100; `loop` accepts `off`, `track`, or `queue`.
- Default to a fresh database, separate application credentials, separate session secret, separate storage/volumes, and distinct service/image names for this Fluxer deployment.
- No automatic linking of Fluxer identities to Discord accounts by email or numeric ID.
- Restore paused until an authorized user resumes.
- Do not provision a remote repository, push images, publish, or deploy as part of this local conversion.
- Deferred: autoplay, genre discovery, round-robin queueing, downloads, countdowns, Upload Alerts, log forwarding, and developer/admin tools.
- Tests use `node:test`, `node:assert/strict`, and `tsx`; place them under `tests/`, with Dashboard tests in `tests/web/`.

## Review Focus

- A resumed Gateway may replay a play command: one message must enqueue only once (Task 2).
- Two concurrent searches may finish out of order, or complete after stop/leave: preserve accepted order and prevent abandoned work from restarting audio (Task 6).
- A Fluxer user can have multiple voice connections: authorize against the Bot's actual channel without choosing an arbitrary connection (Task 3).
- A playlist can contain duplicate tracks with identical source IDs: UI keys and mutations must identify entries, not sources (Tasks 4 and 9).
- Refresh-token rotation can race across Bot and Dashboard processes: concurrent requests must not overwrite the winning credentials or spuriously invalidate the session (Task 8).

---

## Execution and file map

This is one integrated migration, not independent products. Execute Tasks 1–10 in order; stop after Task 5 if the real voice feasibility gate fails. Initial commits may add tested modules alongside the old runtime; Task 10 performs the final cutover and archives retired code. Do not claim the conversion complete before that cutover and the live acceptance pass.

New implementation locations:

| Location                                                                                                                                          | Responsibility                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/fluxer/{config,discovery,rest,gateway,entities,access,voice}.ts`                                                                         | Native platform integration, authoritative entity state, grants                         |
| `src/lib/music/{types,sourceResolver,lavalinkSearch,companionSource,decoder,livekitTransport,musicService,sessionPersistence,playlistService}.ts` | Sources, PCM transport, queue lifecycle, persistent music behavior                      |
| `src/shared/music-contract.ts`                                                                                                                    | Serializable track/player/action DTOs                                                   |
| `src/shared/{fluxer-oauth,fluxer-user-id}.ts`                                                                                                     | Isomorphic OAuth configuration/profile mapping and ID validation                        |
| `src/commands/{context,parseCommand,dispatchCommand,musicCommands}.ts`                                                                            | Prefix grammar, native command context, first-release commands                          |
| `src/botApi/musicHttp.ts`                                                                                                                         | Translation between existing music HTTP contracts and the service                       |
| `src/web/server/{music,playlists}.actions.ts`                                                                                                     | Migrated Dashboard server actions                                                       |
| `scripts/fluxer-voice-smoke.ts`                                                                                                                   | Explicit credentialed voice feasibility probe                                           |
| `docs/fluxer-music-smoke.md`                                                                                                                      | Manual acceptance evidence and instructions                                             |
| `legacy/discord/`                                                                                                                                 | Retired source/tests needed for later migrations; never imported by active applications |

Do not relocate `src/web/` or broadly reorganize unrelated helpers. Each file listed below is created unless explicitly marked as existing. Keep the original design approval unchanged in meaning; record implementation findings separately.

### Task 1: Establish a reproducible baseline and native HTTP boundary

**Files:** `src/lib/fluxer/config.ts`, `discovery.ts`, `rest.ts`; tests mirroring each under `tests/lib/fluxer/`; existing `package.json`, `yarn.lock`, `.env.example`.

**Interfaces:**

- `readFluxerConfig(env: NodeJS.ProcessEnv): FluxerConfig` returns `{ instanceOrigin, token, clientId, commandPrefix }` from `FLUXER_INSTANCE_ORIGIN`, `FLUXER_BOT_TOKEN`, `FLUXER_CLIENT_ID`, `BOT_COMMAND_PREFIX`; hosted default origin is `https://fluxer.com`.
- `discoverFluxer(origin: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<FluxerEndpoints>` returns validated `{ api, gateway, cdn, media }` from the instance discovery document. Confirm exact discovery path/fields from current official docs before coding.
- `FluxerRest.request<T>(method: string, path: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<T>` uses bot auth, response validation at callers, per-bucket/global request scheduling, and typed status errors.

- [ ] Verify Node is >=24. Enable/install the repository's pinned Yarn using the available package-manager mechanism without changing global tools unnecessarily. Run `yarn install` and `yarn web:install`; record baseline typecheck, lint, formatting, tests, and builds. Identify existing failures separately before changes. Never print `.env` or tokens.
- [ ] Write tests: `configDefaults` asserts prefix `!`; `discoveryUsesReturnedEndpoints` asserts calls target returned API/Gateway URLs; `restRetries429WithinBudget` asserts `retry_after` is respected, max 3 attempts; `restAbortsAndRedacts` asserts cancellation stops retry and errors omit tokens; `restDoesNotRetryMessagePostAfterAmbiguousFailure` asserts no duplicate POST on network uncertainty. Test malformed discovery data and authentication denial.
- [ ] Run `node --experimental-test-module-mocks --import tsx --test tests/lib/fluxer/config.test.ts tests/lib/fluxer/discovery.test.ts tests/lib/fluxer/rest.test.ts`; expect new tests to fail before implementation.
- [ ] Implement config/discovery and REST request scheduling with injected fetch/clock. Permit configured trusted endpoints from discovery, require HTTP(S)/WS(S) as appropriate, timeout at 10 seconds by default, and avoid automatic retry of non-idempotent ambiguous requests. Document HTTP only for explicitly configured local instances. Keep body/token errors sanitized.
- [ ] Run the targeted tests, then required checks below; commit only when green: `feat: add native fluxer http integration`.

### Task 2: Gateway sessions and native entities

**Files:** `src/lib/fluxer/gateway.ts`, `entities.ts`; `tests/lib/fluxer/{gateway,entities}.test.ts`; `tests/test-support/fluxerFakes.ts`.

**Interfaces:**

- `FluxerGateway.start(): Promise<void>`, `send(op: number, data: unknown): void`, `stop(): Promise<void>`; constructor takes endpoints, token, injected socket/clock, and an awaited dispatch callback.
- `FluxerEntities.apply(event: FluxerDispatch): void`, `getGuild(id: string): FluxerGuild | undefined`, `voiceChannelsFor(guildId: string, userId: string): ReadonlySet<string>`. Define minimal validated native types, not Discord client shapes.
- Dispatch callback normalizes message events to `{ id, guildId, channelId, authorId, content, bot, webhook }` and role/member/channel/voice events to cache updates.

- [ ] Write `gatewayHeartbeatResume` asserting Identify after Hello, heartbeat ACK timeout closes the socket, Resume includes last accepted sequence, and invalid session rebuilds state. Write `replayedMessageRunsOnce` asserting two events with the same message ID yield one command dispatch. Test malformed events and fatal auth close versus transient reconnect.
- [ ] Write `entitiesTracksMultipleConnections` asserting connections to channels A and B survive independently and removing A leaves B. Test guild deletion and role/channel changes invalidating affected cache entries.
- [ ] Run the two new test files with the Task 1 Node command; expect failure before implementation.
- [ ] Implement protocol v1 JSON with compression disabled initially, one connection, bounded exponential reconnect backoff (1–30 seconds with jitter), resume when valid, and timers canceled on stop. Acknowledge only accepted work; deduplicate message IDs for 10 minutes with a 10,000-entry bound. Keep application-level failures from replaying accepted commands. Rebuild cache after fresh Identify. No sharding abstraction until needed.
- [ ] Run tests and required checks; commit `feat: add fluxer gateway sessions`.

### Task 3: Authoritative access and voice grants

**Files:** `src/lib/fluxer/access.ts`, `voice.ts`; `src/shared/fluxer-user-id.ts`; matching tests under `tests/lib/fluxer/` and `tests/shared/`.

**Interfaces:**

- `authorizeMusic(actor: { userId: string; guildId: string }, action: "view" | "queue" | "control" | "configure", channelId?: string): Promise<MusicAccess>` returns verified channel/actor access or throws a typed forbidden/unavailable error.
- `FluxerVoice.join(guildId: string, channelId: string, signal: AbortSignal): Promise<VoiceGrant>`; `leave(guildId: string): Promise<void>`; `VoiceGrant = { endpoint: string; token: string; connectionId: string; e2eeKey?: string }`.
- `isFluxerId(value: unknown): value is string` accepts validated unsigned decimal strings within platform ID bounds, with no Discord epoch/date constraint.

- [ ] Write `accessRequiresActualSharedChannel`: user connections A+B, Bot in B => allowed; user only in A => denied. Write tests for initial join requiring VIEW_CHANNEL/CONNECT/SPEAK, role denies, missing member, lookup failure, configure requiring Manage Guild, and guild owner policy. Preserve existing capability policy when mapped to Fluxer permission bits; use current official permission definitions.
- [ ] Write `voiceGrantMatchesPendingJoin`: unrelated grant does not resolve a join; timeout rejects within 15 seconds; canceled join ignores a late grant; leave sends the actual connection ID; moved/disconnected session invalidates access and transport state. Assert grants never appear in logs/snapshots.
- [ ] Run failing tests, then implement authoritative REST fallback for incomplete cache, permission-overwrite ordering, event invalidation, grant correlation, and fail-closed decisions. Existing Discord snowflake guards must not validate Fluxer identities.
- [ ] Run targeted tests and required checks; commit `feat: authorize fluxer music and voice joins`.

### Task 4: App-owned tracks and playable source resolution

**Files:** `src/shared/music-contract.ts`; `src/lib/music/{types,lavalinkSearch,companionSource,sourceResolver}.ts`; adapt existing `src/util/youtubeCompanionPlayback.ts`, `userMediaUrl.ts`, `playbackDuration.ts` only where extraction is needed; matching tests.

**Interfaces:**

- `MusicTrack = { entryId: string; source: string; sourceId: string; title: string; author: string; uri: string; durationMs: number; isStream: boolean; thumbnailUrl: string | null; requesterId: string }`. Each queue insertion gets a distinct `entryId`, even for duplicate sources.
- `SourceResolver.search(query: string, requesterId: string, signal: AbortSignal): Promise<MusicTrack[]>`.
- `SourceResolver.prepare(track: MusicTrack, signal: AbortSignal): Promise<PreparedSource>` where `PreparedSource = { input: AsyncIterable<Uint8Array>; durationMs: number | null; playbackUrl: string; seekable: boolean; close(): Promise<void> }`.
- Source resolver owns HTTP fetching, validated redirects, cancellation, and credentials; FFmpeg never receives an untrusted URL or network credentials.

- [ ] Write `searchPreservesCatalogIdentity`, `prepareResolvesCatalogToYoutube`, `duplicateSourcesHaveDifferentEntries`, `prepareRefreshesExpiredStream`, and `prepareUsesPlaybackDuration`. Assert metadata search results are not themselves passed to the audio transport.
- [ ] Write URL tests for localhost/private DNS answers, DNS rebinding/redirect to private addresses, unsupported protocol, and user input pretending to be a trusted companion URL. Assert source bytes are fetched only after validation and trusted companion responses are confined to its configured origin. Reuse the repository's existing deny-private policy and tests.
- [ ] Run failing targeted tests. Implement direct Lavalink `/v4/loadtracks` metadata calls using configured node credentials and no player/voice session. Extract companion metadata/stream URL resolution from `Player`/`Track` wrappers. Preserve supported YouTube, catalog, and public HTTP source behavior with just-in-time prepare. Fetch through a validated/pinned connection path so checks cannot be bypassed between DNS validation and connection; enforce redirect validation at every hop.
- [ ] Run targeted tests and required checks; commit `feat: resolve platform independent music sources`.

### Task 5: LiveKit audio transport and mandatory feasibility gate

**Files:** `src/lib/music/{decoder,livekitTransport}.ts`; `scripts/fluxer-voice-smoke.ts`; `tests/lib/music/{decoder,livekitTransport}.test.ts`; `docs/fluxer-music-smoke.md`; existing `package.json`, `yarn.lock`, `Dockerfile`, `Dockerfile.dev`.

**Interfaces:**

- `MusicTransport.connect(grant: VoiceGrant, signal: AbortSignal): Promise<void>`; `play(source: PreparedSource, offsetMs: number, signal: AbortSignal): Promise<void>` resolves on natural completion; `pause(): Promise<void>`; `resume(): Promise<void>`; `setVolume(percent: number): void`; `positionMs(): number`; `stop(): Promise<void>`; `disconnect(): Promise<void>`.
- `decodePcm(input: AsyncIterable<Uint8Array>, offsetMs: number, signal: AbortSignal): AsyncIterable<Int16Array>` uses FFmpeg stdin and outputs 48 kHz stereo PCM, 20 ms frames (960 samples per channel).

- [ ] Check current official `@livekit/rtc-node` APIs/native binaries and pin a stable version compatible with Node 24 and target Linux images. Confirm Fluxer's `e2ee_key` encoding and key-provider settings against platform source/docs, rather than assuming a plain LiveKit room is sufficient. Record findings in an ADR. Do not add private keys or grant examples to docs.
- [ ] Write tests asserting frame size/sample rate, bounded pending audio (<=200 ms), pause position stability, gain clamping, natural end once, abort killing FFmpeg, decoder failure rejection, grant encryption setup, and idempotent cleanup. Assert seek rejects non-seekable streams; implement seek through source re-prepare and decoder restart, not blind stream offsetting.
- [ ] Run failing tests; implement LiveKit `Room`/`AudioSource`/`AudioFrame` publishing with awaited frame submission, capped buffering, tracked presented position, and guaranteed process/track/room cleanup. Decode to PCM through pipes only; disable unnecessary FFmpeg network protocols. Volume is applied before PCM submission. Native SDK handles room transport only.
- [ ] Run passing targeted tests and build the Linux Bot image locally to verify native loading. Add an explicit smoke script taking target guild/channel IDs from env and a generated local tone, joining through Fluxer Gateway grants, publishing, pausing/resuming, and leaving. Never auto-run it during tests or startup.
- [ ] Run the probe with authorized bot credentials and confirm audio from a listener in the target Fluxer channel; record date, platform/SDK versions, encrypted/unencrypted behavior tested, and pass/fail without secrets. If credentials are unavailable or audio fails, stop dependent migration work and report exactly what is needed. A passing fake room does not pass this gate.
- [ ] Run required checks; commit `feat: publish music through fluxer livekit voice` only with a functioning implementation; keep live verification status explicit.

### Task 6: Shared music lifecycle, queues, and restart persistence

**Files:** `src/lib/music/{musicService,sessionPersistence}.ts`; existing `src/repositories/playerSessionRepository.ts`; add V2 snapshot types to `src/shared/music-contract.ts`; matching tests under `tests/lib/music/` and `tests/repositories/`.

**Interfaces:**

- `MusicService.execute(actor: { userId: string; guildId: string; textChannelId: string }, action: MusicAction): Promise<MusicSnapshot>` performs access checks itself before mutations.
- `MusicAction` is a discriminated union for play/query, enqueue/tracks, pause, resume, skip, stop, leave, remove/entryId, move/entryId/toIndex, clear, seek/positionMs, volume/percent, loop/mode, shuffle. Internal indexes are zero-based; adapters translate one-based user indexes.
- `MusicService.snapshot(guildId: string): MusicSnapshot`; `subscribe(listener: (snapshot: MusicSnapshot) => void): () => void`; `shutdown(): Promise<void>`.
- `MusicSnapshot` contains revision, guild/channel IDs, status, current/upcoming `MusicTrack` entries, positionMs, durationMs, volume, and repeatMode. V2 persisted snapshots exclude source bytes, grants, tokens, and ephemeral URLs.
- `SessionPersistence.restore(): Promise<void>`, `flush(): Promise<void>` uses the existing repository and versioned parsing; inject resolver, access, transport factory, clock, and repository into the service for tests.

- [ ] Write tests for every action's state/reply decision, one completion advancing once, track/queue loop, upcoming-only shuffle, invalid/negative/non-finite seek and volume, and independent guild playback. Test not-found/removed entry IDs rather than silently targeting a new index.
- [ ] Write `acceptedSearchOrderSurvivesOutOfOrderResolution`, `stopCancelsPendingSearchAndJoin`, `staleEndDoesNotSkipSuccessor`, and concurrent command/API mutation tests. Reserve order before awaits; stop/leave cancel a generation immediately, without waiting behind slow resolution. Never hold an uninterruptible mutation lock across a network wait.
- [ ] Write persistence tests asserting queue/order/position/settings round-trip, restore paused, re-prepare on resume, permission denial prevents reconnect, unknown/V1 snapshots remain untouched, and shutdown flushes pending changes. Test member/role loss during playback and empty-channel timeout (default 120 seconds, `MUSIC_EMPTY_VOICE_TIMEOUT_MS`, canceled on rejoin).
- [ ] Run failing tests. Implement per-guild lifecycle and revision/generation guards using existing lock helpers where suitable, while removing their dependence on Lavalink player identity. Publish snapshots after committed state changes. Debounce writes at 500 ms, checkpoint active position every 5 seconds, and flush on shutdown. Stop invalid sources with clear errors and advance a failed queued track at most once; bounded retry only for refreshable sources.
- [ ] Run tests and required checks; commit `feat: add fluxer music sessions and queues`.

### Task 7: Native commands and owner-scoped playlists

**Files:** `src/commands/{context,parseCommand,dispatchCommand,musicCommands}.ts`; `src/lib/music/playlistService.ts`; existing `src/repositories/playlistRepository.ts`, `src/util/saveControlChannel.ts`, `src/repositories/guildSettingsRepository.ts`; tests under `tests/commands/`, `tests/lib/music/`, `tests/repositories/`.

**Interfaces:**

- `parseCommand(content: string, prefix: string): ParsedCommand | null`; `ParsedCommand = { name: string; args: string[]; remainder: string }` supports quoted names, rejects unterminated quotes, and preserves the play query text.
- `dispatchCommand(message: FluxerMessage, deps: CommandDependencies): Promise<void>` calls `MusicService.execute`, playlist service, and REST replies through `CommandContext`.
- `PlaylistService.execute(userId: string, action: PlaylistAction): Promise<PlaylistResult>` supports create/list/view/rename/delete/add/remove/move/enqueue, checks ownership before every read/mutation, and returns app-owned DTOs. Use existing repository transactions and add an owner-filtered rename operation.

- [ ] Write command tests with one assertion per reply/security decision: `!play free text`, custom prefix, quoted playlist names, invalid seek/volume/loop/index, unknown prefix command in control channel, ignored bot/webhook/DM, forbidden configure, and reply sanitization. Assert ordinary control-channel text queues but explicit unknown commands never become searches.
- [ ] Write playlist tests for the complete operation matrix, cross-user denial, duplicate names, duplicate tracks, invalid reorder, ownership changed/not-found races, and atomic multi-track addition. Persist an owner filter at mutation time, not only a prior check.
- [ ] Run failing tests. Implement the command names and behavior from the spec, plus `!help` and `!control-channel <channel-id|off>`. Replies are ordinary messages with mentions disabled by default and service errors mapped to safe text. Post/edit a now-playing embed through the native REST boundary; throttle updates to respect limits and retain the configured control message ID.
- [ ] Run tests and required checks; commit `feat: expose fluxer music commands and playlists`.

### Task 8: Fluxer OAuth and authenticated Bot API music contracts

**Files:** `src/shared/{fluxer-oauth,auth-base-config,api-auth,permissions,player-state}.ts`; existing `src/shared/websocket/{ConnectionManager,PlayerBroadcaster,wsUpgradeAuth,wsCanViewPlayer}.ts`, `src/types/web.ts`, `src/botApi/createBotApiApp.ts`, `src/botApi/handlers/` music/guild/playlist handlers; new `src/botApi/musicHttp.ts`; `src/web/auth.ts`, `auth-client.ts`; tests mirroring changed helpers/handlers and `tests/web/lib/fluxer-oauth.test.ts`.

**Interfaces:**

- `fluxerOAuthProvider(config: FluxerOAuthConfig)` produces Better Auth 1.6.22 generic OAuth provider `fluxer`, `pkce: true`, scopes `identify email guilds`, and discovered/configured endpoints. `FLUXER_CLIENT_SECRET` is server-only.
- `requireFluxerActor(headers: Headers): Promise<{ userId: string; sessionId: string }>` extracts the provider account ID from a validated session; never substitutes a browser header/query ID.
- `handleMusicRequest(actor: AuthenticatedActor, request: MusicHttpRequest): Promise<{ status: number; body: unknown }>` maps existing routes to Tasks 6/7 and current shared error envelopes. Serialize snapshots to existing player/queue DTOs with explicit `entryId`; retire `encoded` as an identity. Deferred feature fields may be false during transition, never actionable.

- [ ] Write OAuth tests for state/PKCE errors, provider mismatch, encrypted tokens, profile mapping, refresh rotation, and token redaction. Request real email scope; if profile email is absent, map to a deterministic instance+user-specific reserved `.invalid` address with `emailVerified: false`; disable automatic account linking by email. Existing Discord identities must never silently become Fluxer accounts.
- [ ] Write a concurrent-refresh test exercising two auth consumers of one database account: only one refresh exchange for an expiring token, both callers observe the winning rotated pair. Use a database-backed per-account lock/compare-and-swap spanning Bot and Dashboard; in-process mutexes alone do not satisfy this test. Keep network retries bounded while locked.
- [ ] Write handler tests for unauthenticated 401, forbidden 403, malformed input 400, missing entries/playlists 404, unavailable authority 503, successful state mutations, and stale revision conflicts. Assert HTTP and command actions invoke the same service behavior; test every modified handler decision.
- [ ] Write WebSocket tests for authenticated upgrade, expiry, authorized guild subscription, role/member/voice invalidation, and per-viewer fields. Never broadcast another user's permission flags as shared state.
- [ ] Run failing Bot tests and `yarn test:web`. Implement generic OAuth against installed 1.6.22 APIs (not beta docs), shared auth configuration in both processes, session/provider identity mapping, authoritative access, source search/queue routes, playlist routes, and sanitized errors. Remove OAuth fallback paths that could bypass an authoritative deny. Preserve API path/envelope shapes where semantically valid; update consumers of renamed identity fields together in Task 9.
- [ ] Run required checks; commit `feat: migrate dashboard auth and bot api to fluxer`.

### Task 9: Dashboard music experience

**Files:** `src/web/server/{music,playlists}.actions.ts`; existing `src/web/lib/actions/{player,playlist}.actions.ts` (migrate then retire), `src/web/server/{guild,dashboard-permissions}.actions.ts`, `src/web/lib/{api-auth,discord-bot-invite,discord-user-id}.ts`, `src/web/components/`, `src/web/hooks/`, `src/web/app/{page.tsx,dashboard/,playlists/,auth/error/page.tsx}`, related thin routes; matching helper/action tests in `tests/web/`.

**Interfaces:**

- Server actions preserve current caller signatures where possible and call authenticated Bot API routes with cookie forwarding. New files use `*.actions.ts` in `server/`.
- Player/queue hooks consume Task 8 DTOs, including stable `entryId`, revisions, and viewer-specific capabilities; no Lavalink types in browser code.
- Add `buildFluxerBotInvite(endpoints: FluxerEndpoints, clientId: string, permissions: bigint): string` in `src/web/lib/fluxer-bot-invite.ts` with native bot scope and tested permission encoding.

- [ ] Write helper/action tests for Fluxer invite/sign-in configuration, expired session, cookie forwarding, membership denial, complete music action payloads, queue duplicate entry keys, revision handling, and playlist ownership errors. Use the existing unit-test approach; no React Testing Library suite is needed.
- [ ] Run failing `yarn test:web`; migrate actions and their imports, guild selection, music search, pause/resume/skip/stop/leave/seek/volume/loop/shuffle, reorder/remove/clear, playlist UI, and WebSocket consumers. Disable controls when the caller lacks capabilities and show server failures clearly. Keep server authorization authoritative.
- [ ] Update visible Fluxer branding, sign-in copy, asset URLs, and invite URLs. Hide deferred settings/downloads/admin/autoplay/round-robin controls and return explicit unavailable responses for their reachable endpoints. Keep status/health limited to services actually in use. Search active code for Discord hosts and runtime SDK imports; document each remaining deliberate legacy reference.
- [ ] Run `yarn test:web`, required checks, and `yarn build:web`; inspect the running Dashboard at desktop/mobile widths using available browser controls. Verify duplicate source tracks remain separately selectable and keyboard/volume/seek interactions send the intended operation.
- [ ] Commit `feat: migrate dashboard music controls to fluxer` after required checks pass.

### Task 10: Runtime cutover, independent packaging, and acceptance

**Files:** existing `src/lib/{BotClient,botClientRegistry}.ts`, `src/server.ts`, `src/events/`, `src/util/{loadCommands,loadEvents}.ts`, `src/types/index.ts`, root/nested `package.json` and lockfiles, `.env.example`, `README.md`, `GLOSSARY.md`, Dockerfiles/entrypoints, all Compose files, `.github/workflows/`; `docs/adr/0010-fluxer-native-music.md`; `docs/fluxer-music-smoke.md`; archived source/tests under `legacy/discord/`; startup/contract tests under `tests/`.

**Interfaces:**

- `BotClient` becomes a native composition root exposing Fluxer entities/REST/Gateway and music/playlist services with `start(): Promise<void>` and `destroy(): Promise<void>`. No `extends discord.js.Client` or fake Discord client properties.
- Registry callers receive the native client; `src/server.ts` keeps health, Bot API, and authenticated WebSocket services and flushes music persistence before shutting transports/database down.

- [ ] Write startup tests proving Fluxer initialization, music-only command registration, no countdown/Upload Alert/log-forward timers or Discord network requests, shutdown flush/cleanup, and readiness failure when required dependencies fail. Write contract tests proving the Dashboard cannot import Bot runtime or `lavalink-client`/LiveKit SDK objects through shared modules.
- [ ] Run failing tests; wire the native composition root and event dispatch. Snapshot restoration must not publish audio without resume authorization. Startup validates required credentials/endpoints but does not run a tone probe. Keep health distinct from music/readiness failures.
- [ ] Inventory retired imports/tests with `rg`, move Discord-specific implementations and their tests together to `legacy/discord/{src,tests}/`, and preserve a short archive README mapping future features to original files. No archive imports from active code. Keep reusable tested helpers active. Explicitly exclude archived TypeScript from lint/format tooling if necessary; root/Dashboard compilation must remain strict with current flag values. Remove `discord.js`, `@discordjs/voice`, DAVE/sodium/opus dependencies used only by retired transport, and `lavalink-client` when direct REST search has replaced its remaining imports. Remove slash deployment scripts from active package scripts and archive their source. Update both lockfiles through Yarn.
- [ ] Rename Compose project/services/images/volumes to Fluxer-specific defaults (project `dimbybot-fluxer`; avoid fixed shared container names), including companion/search/database service references, dev overrides, and Dashboard internal URL. Keep Lavalink configured for metadata search, with no voice session ownership. Set a fresh database name/user and distinct cookie name/secret defaults in examples; never overwrite populated `.env` or reuse production volumes. Update workflows so existing Discord GHCR tags/deployment targets are not reused; disable automatic remote deployment until explicitly configured for this independent version.
- [ ] Update README/glossary and the ADR with native prefix usage, music scope/deferred features, auth callback registration, LiveKit/FFmpeg requirements, independent database/storage, service startup, and troubleshooting. Preserve AGENTS.md layout/rules; update obsolete platform terminology there only where necessary to reflect the conversion.
- [ ] Run `yarn typecheck`, `yarn lint`, `yarn prettier --check .`, `yarn test`, `yarn build:bot`, and `yarn build:web`; all must pass. Build the production images locally and validate Compose configuration using a secret-free example environment. Search active source/manifests for Discord endpoints and retired SDK imports; only explicit historical/archive references may remain.
- [ ] Execute the documented credentialed acceptance matrix: Fluxer sign-in/guild selection; audible search/URL/catalog playback; every initial command and matching Dashboard control; playlist create/read/update/delete/ownership; independent guild sessions; live updates; voice/Gateway reconnect; restart restoring paused; failed/expired source recovery; permission changes while connected; shutdown without lingering FFmpeg/room/timers. Record tested results and outstanding cases without tokens. Do not claim completion with an unpassed voice gate.
- [ ] Commit `feat: complete independent fluxer music runtime` only after the required suite passes; honor the pre-commit hook. No push, new remote repository, image publication, or deployment.

## Required checks for implementation commits

After substantive code changes and before every implementation commit, run:

```bash
yarn typecheck
yarn lint
yarn prettier --check .
yarn test
```

Run targeted red/green tests before these broader checks. Builds are mandatory at Tasks 1, 5 (native image), 9 (Dashboard), and 10 (both applications/images). A baseline failure remains a blocker to a green-suite commit; fix it or report it rather than bypassing hooks. Do not install dependencies or edit product code while merely reviewing this plan.

## Self-review and execution notes

- Scope coverage: first-release controls (Tasks 6/7/9), playlists (7/8/9), native identity/access (1/2/3/8), LiveKit and sources (4/5), restart/cancellation (6), future features and packaging (10), all acceptance gates (5/10).
- Five review-focus cases are explicitly covered by tests in their owning tasks.
- Task interfaces intentionally use app-owned DTOs; adapters perform the only conversion to existing HTTP/UI envelopes.
- No unresolved product decisions are introduced. Concrete SDK/native compatibility and credentialed audible voice remain feasibility checks, not assumed successes.
- Current shell observation: Node is available at `/opt/homebrew/bin/node`; `yarn`, `corepack`, and local `node_modules/.bin/prettier` were absent when the design was drafted. Documentation changes have not been committed, and no baseline suite or formatting pass is claimed.

## Documentation used while planning

- [Fluxer Gateway](https://docs.fluxer.com/gateway/overview/), [voice grants](https://docs.fluxer.com/voice/), [OAuth2](https://docs.fluxer.com/http-api/oauth2/), [instance discovery](https://docs.fluxer.com/http-api/instance/), [current bot command limitations](https://fluxer.com/help/slash-commands).
- [LiveKit Node RTC SDK](https://docs.livekit.io/reference/client-sdk-node/modules.html).
- [Better Auth 1.6 generic OAuth](https://better-auth.com/docs/1.6/plugins/generic-oauth). Explicitly enable PKCE; its documented default in this version is false.
- Context7 was not available in the tool inventory; official documentation was used instead.
