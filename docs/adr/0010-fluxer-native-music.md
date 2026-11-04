# Native Fluxer music and LiveKit voice

The Fluxer version is independent of the Discord version. Keep the Bot and nested Dashboard as separate applications with an HTTP/WebSocket contract (ADR 0007).

Replace Discord interactions with native prefix commands and use a Bot-owned music service. Lavalink initially remains a metadata search service accessed through `/v4/loadtracks`; it owns neither a player queue nor a Discord voice connection. Resolve YouTube companion streams just before playback, fetch bytes within the Bot, and decode through FFmpeg pipes. Public media requests validate every DNS answer, pin the chosen address at connection time, and revalidate each redirect. Arbitrary user URLs never enter Lavalink or FFmpeg network clients.

Use `@livekit/rtc-node` 1.2.1 (FFI bindings 0.13.1). Its published Linux binaries target GNU/glibc for x64 and arm64, not Alpine/musl. The Bot production/development images therefore use Node 24 on Debian Bookworm. The Dashboard does not need the native voice SDK. Preserve the entrypoints' `su-exec` invocation using a `gosu` compatibility symlink on Debian.

Fluxer's client passes the `e2ee_key` string directly to `ExternalE2EEKeyProvider.setKey`, then enables encrypted media before connecting. A string selects PBKDF2 key derivation from UTF-8 bytes, not base64 decoding. Use the Node SDK's PBKDF2 mode (`0`), AES-GCM (`1`), salt `LKFrameEncryptionKey`, shared key at index 0, key-ring size 16, ratchet window 0, and failure tolerance -1 to match the client. The server-issued room key does not establish end-to-end encryption between users. Never persist or log it.

The SDK owns WebRTC publishing. Queue at most 200 ms in its audio source, await frame submissions, drain on pause, and close the FFmpeg process, input source, audio track, room, and Gateway voice membership on teardown. Import the native SDK only when opening an actual room, and dispose its global runtime at Bot shutdown after all guild transports close.

The configured instance supplies an HTTPS LiveKit base in its grant. Normalize HTTP(S) to WS(S) while preserving TLS, host, port, path, and query; continue rejecting non-network schemes and credentialed endpoint URLs. An absent or explicitly null room key denotes unencrypted media.

An interrupted join remains quarantined until a late grant is disconnected or a new Gateway session replaces it. Grants have no caller-supplied nonce, so allowing an immediate same-channel retry would risk adopting the previous join's grant.

The local tone probe is an explicit operator command and never runs at startup or in tests. Automated transport tests and successful SDK calls do not prove that other Fluxer users hear audio. Broad command/Dashboard migration remains gated on a real audible probe with listener confirmation.

References inspected November 4, 2026:

- [Fluxer voice protocol](https://docs.fluxer.com/voice/).
- [Fluxer client connection adapter](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/src/features/voice/engine/v2/VoiceEngineV2AppConnectionHostAdapter.ts), [external key provider](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/pkgs/livekit-client/src/e2ee/KeyProvider.ts), and [key derivation](https://github.com/fluxerapp/fluxer/blob/main/fluxer_app/pkgs/livekit-client/src/e2ee/utils.ts). Protocol behavior was inspected; platform implementation code was not copied.
- [LiveKit Node SDK](https://docs.livekit.io/reference/client-sdk-node/), with installed 1.2.1 source/types used to verify current exports, native dependencies, and queue-duration units (milliseconds).

## Independent runtime and deployment

The active composition root is native Fluxer and registers only music behavior. Retired Discord source and matching tests are archived under `legacy/discord/`, outside compile graphs and the production image context. Reusable pure helpers keep their current tests. The active packages no longer depend on Discord's SDK, its voice/DAVE/Opus stack, or `lavalink-client`.

The native entrypoint and Prisma configuration load `.env.fluxer`, not the Discord `.env`. Separate database/storage, `dimby-fluxer` cookies, `fluxer-*` Compose services and independent local image names avoid accidental sharing. PostgreSQL row locks serialize OAuth refresh rotation across both processes. The Dashboard communicates with the Bot through HTTP and cookie-authenticated WebSockets on the same public cookie host; connect tokens in URLs are retired.

Production voice uses a glibc Node image and pipe-only FFmpeg decoding. The metadata image also uses an arm64-capable Java base; the former Alpine JRE tag did not support the test machine's architecture. Metadata HTTP/local playback sources are disabled because actual streaming belongs to the native source/transport boundary.

Gateway dispatches are acknowledged/deduplicated only after work is accepted. Permission-change checks coalesce per guild. Late guild availability can retry paused restoration without overwriting a user's newer action. Health and readiness remain separate, and shutdown suspends music before flushing snapshots, closing rooms, releasing the SDK and disconnecting databases.

Automatic remote publication/deployment is disabled. Existing Discord tables/files/history are preserved; data transfer and deferred feature activation require separate migration work.
