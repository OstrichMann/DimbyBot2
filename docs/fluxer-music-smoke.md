# Fluxer music validation

## Native voice feasibility probe

Create a Fluxer application with a bot, install it into a test guild, and grant View Channel, Send Messages, Embed Links, Connect, and Speak in the intended channels. Enable developer mode in Fluxer to copy guild/channel IDs.

Create a local, ignored `.env.fluxer` in the repository root:

```dotenv
FLUXER_INSTANCE_ORIGIN=https://fluxer.com
FLUXER_BOT_TOKEN=your_raw_bot_token
FLUXER_CLIENT_ID=your_application_id
FLUXER_TEST_GUILD_ID=your_test_guild_id
FLUXER_TEST_CHANNEL_ID=your_voice_channel_id
```

Use independent Fluxer credentials. Do not paste tokens into chat or commit this file. The probe does not require PostgreSQL, Lavalink, a companion service, or a Dashboard OAuth secret. It does require Node 24+, the installed native LiveKit SDK, and FFmpeg (`FFMPEG_PATH` can select an existing executable).

Join the target voice channel as a listener, then run:

```bash
yarn smoke:fluxer-voice
```

Expected: a quiet 440 Hz tone starts, pauses for two seconds, resumes, ends, and the Bot leaves. Ctrl+C cancels and tears down resources. The command is bounded to one minute. It does not send channel messages or touch saved music data. A successful exit still requires a listener to confirm the sound and pause/resume behavior.

If a join times out, check installation/permissions and the target channel ID. A canceled/timed-out join is quarantined within that Gateway session until its late grant is drained or the session is replaced; rerunning the standalone probe starts a fresh session. Keep room keys, tokens, and authenticated stream URLs out of diagnostic reports.

## Validation record

- November 4, 2026: pinned LiveKit Node SDK 1.2.1 / FFI 0.13.1; native audio source loaded and closed on macOS arm64 with Node 26.13.0.
- Automated real FFmpeg decode/seek/cancel tests and injected transport tests cover PCM framing, buffering, gain, pause/resume, cancellation, grant encryption configuration, and cleanup. Test results are recorded in the execution ledger.
- November 4, 2026: Linux arm64 production image built on Node 24 / Debian Bookworm. A network-disabled container passed native LiveKit PCM capture/drain/cleanup and real FFmpeg WAV decoding into five 20 ms stereo frames.
- November 4, 2026: credentialed unencrypted-channel probe passed on the configured instance. The Bot joined, published the tone, paused for two seconds, resumed, and left; the user confirmed all audible behavior. Earlier setup failures were resolved by installing the Bot, granting channel permissions, and normalizing the instance's HTTPS LiveKit endpoint to WSS.
- Encrypted-channel interoperability remains unverified live; key-provider configuration is covered by unit tests.

## Full music acceptance after the feasibility gate

After the native probe passes, validate Fluxer sign-in and guild selection, query/URL/catalog playback, every first-release command and matching Dashboard control, queue ordering and duplicate entries, playlist ownership and editing, independent guild playback, live updates, reconnect, paused restart recovery, permission changes, and shutdown without leftover decoders or voice sessions. Record pass/fail and any missing cases explicitly. Never infer these outcomes from the tone probe alone.

## Native music acceptance record — November 4, 2026

| Case                                                            | Result and evidence                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fluxer OAuth sign-in, callback, native profile, guild selection | Passed in the local Dashboard at localhost:3000 against the configured instance. The user completed consent directly.                                                                                                                                                                                                                                                                                                           |
| Configure control text channel                                  | Passed: user ran the native `!control-channel` command and confirmed setup; subsequent Dashboard music actions used that channel.                                                                                                                                                                                                                                                                                               |
| Metadata search and actual source resolution                    | Passed: Dashboard returned 20 YouTube test-tone results; companion resolved the selected source; real FFmpeg decoding passed.                                                                                                                                                                                                                                                                                                   |
| Audible source playback, quiet volume, pause/resume, leave      | Passed: a one-minute YouTube 440 Hz source played at 11% volume. Dashboard showed pause at 13 seconds, resume, and an empty player after leave. User explicitly confirmed hearing playback, pause/resume, and the Bot leaving.                                                                                                                                                                                                  |
| Live player updates                                             | Observed playing/paused/current track and queue updates. Own-join authorization races and transient lookup subscription loss received failing regressions and fixes. Latest recovery behavior is unit/integration verified.                                                                                                                                                                                                     |
| Restart restores paused                                         | Passed on the native host: graceful restart retained the selected tone, queued track and 11% volume; restoration remained paused until explicit resume. Runtime-instance ordering guards now permit lower revisions from a restarted Bot.                                                                                                                                                                                       |
| Playlist database behavior                                      | Passed against the fresh local PostgreSQL database with disposable fixtures: create/read/rename/reorder/remove/enqueue/delete, duplicates, stale revision409 and foreign owner404. No real user playlists were deleted.                                                                                                                                                                                                         |
| Refresh-token rotation across processes                         | Passed with two independent Node processes and PostgreSQL: one synthetic token exchange and one winning encrypted credential pair.                                                                                                                                                                                                                                                                                              |
| Production packaging                                            | Both production images built locally; Linux arm64 native PCM capture/drain/disposal, FFmpeg decoding, production-only Prisma migration/connect, Dashboard health/sign-in/static assets and database access passed. No images were published.                                                                                                                                                                                    |
| Native shutdown                                                 | Graceful SIGTERM closed the database and restored paused on the next start. Transport/decoder cleanup and lost-room suspension have regression coverage.                                                                                                                                                                                                                                                                        |
| Remaining live coverage                                         | Every prefix command and matching Dashboard control, explicit seek destination, catalog-provider playback, playlist UI drag/edit, simultaneous real guilds, encrypted voice, forced Gateway/room reconnect, permission revocation during audio, expired-source recovery, and an exact mobile viewport were not all exercised manually. These paths have automated coverage where implemented; do not treat that as a live pass. |

The local test configuration uses ignored `.env.fluxer` and `.env.fluxer.local` files and an independent database/volume. Keep these files private. The historical Discord implementation remains archived for future feature migration; deferred features are not active in this release.
