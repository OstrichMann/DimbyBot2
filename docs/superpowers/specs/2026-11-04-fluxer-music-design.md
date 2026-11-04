# Fluxer music-first conversion

Status: approved by the user on November 4, 2026. This document describes the target; implementation has not started.

## Intent and agreed scope

Convert this checkout into a Fluxer-specific Bot that evolves independently of the Discord version. The first release delivers music through both Fluxer messages and the existing Dashboard. Design the integration so downloads, countdowns, Upload Alerts, and other features can be incorporated later.

The user selected native Fluxer integration over a Discord compatibility layer and approved the initial music scope: play, pause/resume, skip, stop/leave, queue management, seek, volume, loop, shuffle, and playlists, together with Dashboard music controls and Fluxer sign-in.

## Constraints and current architecture

- Preserve the two applications and compile graphs: Bot entry `src/server.ts`, nested Next.js Dashboard in `src/web/`, and HTTP/WebSocket communication between them. Bot code never imports the Dashboard. Keep isomorphic contracts in `src/shared/`.
- Retain TypeScript ESM, Node 24+, Yarn, PostgreSQL/Prisma, and existing repository placement and testing rules.
- Today `BotClient` extends `discord.js.Client`; commands consume Discord interactions; voice uses Lavalink and `@discordjs/voice`. Authentication, membership, permissions, invite URLs, image URLs, and player snapshots also carry Discord assumptions.
- Fluxer bot slash commands and message components are not available today. Use prefix commands and ordinary messages/embeds. Dashboard buttons remain usable because they call the Bot API.
- Fluxer currently uses LiveKit voice. Changing API URLs cannot make the existing Discord audio transports work.

## Approaches

1. **Native Fluxer integration (selected):** implement Fluxer REST/Gateway and LiveKit voice boundaries, and refactor reusable music behavior out of Discord/Lavalink objects. More initial work, but provides an independent foundation for future features.
2. **Discord compatibility layer (rejected):** emulate Discord clients/interactions to reuse handlers. Fewer initial edits, but leaves permissions, command replies, caching, and playback coupled to Discord semantics.

Do not build a multi-platform framework or retain a Discord runtime mode. Small interfaces isolate responsibilities within the Fluxer Bot.

## Proposed first-release behavior

These details are implementation defaults proposed by the author, rather than additional decisions made by the user.

- Use configurable `BOT_COMMAND_PREFIX`, default `!`, with `!help` documenting syntax. Ignore bots, webhooks, DMs, and unrelated messages. The initial command set is `play`, `pause`, `resume`, `skip`, `stop`, `leave`, `queue`, `remove`, `move`, `clear`, `seek`, `volume`, `loop`, `shuffle`, `nowplaying`, and `playlist` subcommands.
- `play` consumes the remaining text as a search query or URL. Queue indexes are one-based at user boundaries. `seek` accepts seconds or `mm:ss`; `volume` accepts 0–100; `loop` accepts `off`, `track`, or `queue`. Playlist names with spaces use quoted arguments. Invalid arguments produce usage guidance without changing state.
- Playlist operations cover create, list, view, rename, delete, add, remove, reorder, and enqueue. Playlists belong to the authenticated Fluxer user; enforce ownership in every entry point.
- Use messages/embeds for feedback and now-playing information. No emulation of ephemeral replies, autocomplete, or message buttons. Do not put credentials or private account data in public replies.
- Keep the configured control-channel flow that accepts a plain search query. Add a permission-checked `control-channel` configuration command because this is necessary music setup. In that channel, dispatch recognized prefix commands before interpreting ordinary text as a query; unknown prefix commands return help rather than becoming searches.
- Preserve search/query resolution, YouTube companion playback, supported catalog-to-playback resolution, displayed duration rules, and user media URL protections where applicable. Catalog metadata alone is never treated as playable audio.
- `stop` clears the active queue and stops audio while leaving the connection available; `leave` also disconnects. Skip advances once, track loop repeats the current track, queue loop rotates completed tracks, and shuffle affects upcoming tracks only. An empty queue becomes idle. Leave an empty voice channel after a bounded configurable timeout.
- Autoplay, genre discovery, round-robin queueing, download creation/local download browsing, countdowns, Upload Alerts, log forwarding, and developer/admin tools are deferred. Do not advertise their existing Discord implementations as working Fluxer features.

## Internal boundaries

### Fluxer integration

Place Bot-only REST, Gateway, entity normalization, and voice-grant handling under `src/lib/fluxer/`. Provide typed operations for sending/editing messages, reading guild/channel/member state, resolving effective permissions, and joining/leaving voice. Command handlers in `src/commands/` receive a native command context with actor, guild, channel, parsed arguments, and reply operations; it must not imitate Discord interaction objects.

Gateway lifecycle must include heartbeats, acknowledgment tracking, reconnect/backoff, resume, fresh-session state rebuilding, and shutdown. Deduplicate replayed command messages within bounded storage. Retain sequence acknowledgments only after dispatch processing is safely accepted. REST requests respect route/global rate limits, bounded retries, and cancellation. Fetch authoritative membership/permissions when cached state is incomplete; fail closed if it cannot be established. Invalidate affected permission state on role, member, channel, and voice changes.

Use instance discovery for API, Gateway, and asset endpoints. Default to hosted Fluxer, with an operator-configured instance origin rather than user-supplied runtime endpoints. Treat IDs as opaque decimal strings and replace Discord-specific epoch/range checks and asset builders. Supporting self-hosted endpoint discovery does not promise every optional instance feature.

### Music service and voice transport

Place Bot-only queue/player orchestration under `src/lib/music/`. Expose music operations and serializable player snapshots shared by commands and Bot API handlers. Store no SDK objects in public contracts or persistent snapshots. Queue changes and player replacement use per-guild serialization and generation/cancellation guards so stale searches, disconnects, or track completions cannot affect a successor player.

Use LiveKit as the Fluxer audio transport. Resolve a playable source just before playback, decode with FFmpeg into bounded PCM frames, and publish via the LiveKit Node SDK. The transport owns connection/grant lifecycle, frame pacing/backpressure, decoder cleanup, pause/resume, gain, seek/restart, and track completion. It must support multiple guilds independently and avoid unbounded buffering. Do not assume `lavalink-client`, a standard Lavalink node, or `@discordjs/voice` can publish audio to Fluxer. If existing Lavalink-backed metadata search is retained temporarily, isolate it behind source resolution; it must not own the queue or voice connection.

Before broad handler migration, verify a bot can join, publish an audible test source, pause/resume, and leave using the actual Fluxer grant, including encryption-key handling if required. Investigate the chosen LiveKit SDK's support and native/container dependencies during planning. If required transport support is unavailable, report the concrete blocker before substituting an incompatible voice implementation. Automated fakes do not establish audible playback.

Keep source resolution and streaming behind interfaces so a future voice protocol change or a future local-file source does not rewrite commands. Reuse existing search and companion helpers after removing Discord/Lavalink coupling where necessary. Preserve SSRF protection at every untrusted media URL boundary, including redirects and subprocess inputs.

### Dashboard, identity, and authorization

Replace Discord OAuth with Fluxer authorization-code sign-in using Better Auth's generic OAuth support or an equivalent supported integration. Retain state/PKCE, encrypted token storage, refresh rotation, origin checks, and secure session cookies. No automatic linking of Fluxer identities to Discord accounts by email or numeric ID.

Keep existing Bot API route shapes and WebSocket envelopes where their semantics still apply; define app-owned DTOs in `src/shared/` instead of exposing Lavalink tracks or player instances. Migrate music actions, playlist actions, permission resolution, guild discovery, voice context, and player broadcasts together. New server actions belong in `src/web/server/*.actions.ts`; HTTP routes remain thin.

The Bot API remains authoritative: verify the authenticated Fluxer user, current guild membership, channel permissions, and applicable same-voice-channel rule for every mutation. Do not trust browser-supplied actor IDs or voice claims. Preserve the current permission policy while translating it to Fluxer; explicitly test decisions affected by different permission semantics and multiple voice connections. A user controlling playback must occupy the Bot's active channel. A new session joins an authorized channel occupied by that user. Permission or membership lookup failure grants nothing.

The Dashboard retains guild selection, music search, player controls, queue editing, playlists, and live updates. Hide deferred controls and pages or return a clear unavailable response for their routes; no reachable route should invoke Discord-only runtime behavior. Update visible names, sign-in explanations, invites, and asset URLs to Fluxer.

## Persistence and independent deployment

Default to a fresh database, separate application credentials, separate session secret, separate storage/volumes, and distinct service/image names for this Fluxer deployment. Never reuse the Discord production database or infer mappings between platform IDs. Existing Discord data transfer is outside this first release; do not delete existing files or database rows to enforce separation.

Retain reusable playlist and settings models. Version new player snapshots around source identity, queue order, requester, position, volume, repeat mode, and paused state; never persist grants or expiring stream URLs. Flush snapshots at shutdown and debounce saves during playback. Restore queue and preferences after restart, re-resolve sources, and validate guild/channel/member access before reconnecting. Restore paused until an authorized user resumes. Unreadable/older snapshots must be identified and skipped safely without wiping them.

Non-music schemas and source can remain for future migration, but their jobs, commands, routes, and imports must not activate Discord integrations at startup. Remove unused Discord runtime dependencies once the active compile graphs no longer require them. Retained source must still typecheck or be explicitly archived outside active compile graphs; do not weaken compiler checks to hide errors.

Update README, glossary, configuration examples, Docker/Compose, and CI/deployment references for the independent Fluxer version. Do not provision a remote repository, push images, publish, or deploy as part of this local conversion. Preserve history and the current checkout; the user can host the resulting version separately.

## Validation and acceptance

- Unit tests under `tests/` and `tests/web/` cover each distinct reply, status, ownership, and permission decision touched by the migration.
- Gateway/REST tests cover authentication failures, rate limits, duplicate replay, reconnect/resume, and stale cache recovery. Voice tests cover grant timeout, disconnect, decoder error, cancellation during join/search, stale completion, and independent guild sessions.
- Music tests cover all listed operations, playlist ownership/order, restart snapshots, source re-resolution, and command/Dashboard races. Dashboard tests cover Fluxer OAuth/session helpers, permission failures, and music actions.
- Run `yarn typecheck`, `yarn lint`, `yarn prettier --check .`, `yarn test`, and production builds for both applications after substantive implementation. Do not commit with a failing suite or bypass the hook.
- Credentialed smoke validation must demonstrate sign-in and guild selection, audible Fluxer playback, every first-release control, queue/playlist changes through both entry points, live Dashboard updates, reconnect, and restart recovery. If credentials or a target guild are unavailable, explicitly report live verification as outstanding rather than claim a working deployment.

## Left to implementation planning

Choose concrete SDK versions, endpoint DTOs, command argument parsing implementation, source-resolver extraction, snapshot migration details, resource limits/timeouts, and incremental file moves after checking current official documentation and existing tests. Implement in small verified slices, beginning with the Fluxer connection/voice feasibility gate, then shared music behavior, commands, and the Dashboard. New architectural decisions should be recorded under `docs/adr/`.

## References checked on November 4, 2026

- [Fluxer bot commands and components](https://fluxer.com/help/slash-commands)
- [Fluxer voice and grants](https://docs.fluxer.com/voice/)
- [Fluxer Gateway lifecycle](https://docs.fluxer.com/gateway/overview/)
- [Fluxer OAuth2](https://docs.fluxer.com/http-api/oauth2/)
- [Fluxer instance discovery](https://docs.fluxer.com/http-api/instance/)
- [Fluxer snowflakes](https://docs.fluxer.com/snowflakes/)
- Repository ADR 0007: retain the nested Dashboard and two compile graphs.
