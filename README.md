# DimbyBot for Fluxer

An independent Fluxer version of DimbyBot, focused on music. It has two applications: the **Bot** (`src/server.ts`) and the **Dashboard** (Next.js in `src/web/`). The Dashboard communicates with the Bot over HTTP and authenticated WebSockets. Shared contracts live in `src/shared/`. Source layout, containers, and health checks are in [the application layout](docs/application-layout.md).

The Bot uses Fluxer's native REST/Gateway protocol and LiveKit voice grants. FFmpeg decodes prepared byte streams into PCM. Lavalink is a **metadata search service only**; it never owns a queue or a Fluxer voice session. Saved queues restore paused and require an authorized user to resume.

## Features

- Search and URL playback, YouTube companion streaming, and supported catalog-to-audio resolution.
- Pause/resume, skip, stop, leave, seek, volume, repeat, shuffle, and ordered queue editing.
- Personal playlists: create, list, view, rename, add, move, remove, delete, and enqueue.
- A configurable text control channel, native now-playing embeds, and a music Dashboard with Fluxer OAuth and live updates.
- Fresh membership/channel/voice checks for mutations, owner-scoped playlists, bounded source fetching, DNS pinning and redirect checks, and versioned restart snapshots.

Countdowns, downloads/local-file playback, upload alerts, guild log forwarding, autoplay, round-robin queues, and admin tools are deferred. Their retired Discord implementations and tests are preserved in [legacy/discord](legacy/discord/README.md). They do not start jobs or register commands in the Fluxer runtime. Existing Discord data is not automatically transferred. The command-by-command comparison is in [docs/discord-to-fluxer.md](docs/discord-to-fluxer.md).

## Independent configuration

Use Node 24+ and Yarn. Copy `.env.example` to **`.env.fluxer`** and configure it locally. This version does not load a Discord `.env` or generate `lavaNodesConfig.js`.

Create a Fluxer application with a Bot, install it in a test server, and supply `FLUXER_BOT_TOKEN`, `FLUXER_CLIENT_ID`, and server-only `FLUXER_CLIENT_SECRET`. `FLUXER_INSTANCE_ORIGIN` defaults to `https://fluxer.com`; set it when the Bot should use another instance. That origin is discovered through `/.well-known/fluxer`; API, Gateway, assets and authorization URLs follow that instance. Dashboard sign-in requests the `identify`, `email`, and `guilds` scopes.

In the configured control channel, the Bot deletes each user query or command after processing and removes its reply after five seconds. The persistent music message stays in place. Grant the Bot **Manage Messages** in that channel so it can delete user messages; cleanup failures do not repeat commands. Messages in other channels are retained.

For local Dashboard sign-in, register exactly:

```text
http://localhost:3000/api/auth/oauth2/callback/fluxer
```

Set `BETTER_AUTH_URL=http://localhost:3000`. Generate a **new** `BETTER_AUTH_SECRET` and **new database credentials** for this deployment. Both applications must use the same Fluxer database and session secret. The cookie prefix is `dimby-fluxer`; provider identities are read from the Fluxer OAuth account, never inferred from an old Discord account or an email match. OAuth refresh rotation is serialized with a PostgreSQL row lock across both processes.

Generate secrets with `node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))'`. The companion key is a special case: it must contain **exactly 16 alphanumeric characters**, for example a fresh `randomBytes(8).toString("hex")` value. Replace every example credential before running services.

## Host execution

```bash
yarn install
yarn web:install
# Build source-search image and start only the isolated dependencies:
docker compose --env-file .env.fluxer -f docker-compose.yml -f docker-compose.dev.yml up --build -d fluxer-db fluxer-metadata fluxer-companion fluxer-cipher fluxer-spotify-tokener
yarn build:bot
yarn start
```

In another terminal, start the Dashboard (its dev script loads the same `.env.fluxer`):

```bash
yarn dev:web
```

The example host ports are Dashboard `3000`, Bot API/WebSocket `3010`, PostgreSQL `5434`, metadata `2334`, and companion `8283`. With `WEBSOCKET_CLIENT_URL` unset, local live updates use `ws://localhost:3010/ws`. The Bot API listens on `127.0.0.1` (`BOT_API_HOST`; published containers use `BOT_API_PUBLISH_HOST`). Host playback uses the bundled `ffmpeg-static` binary unless `FFMPEG_PATH` is set. The optional ignored `.env.fluxer.local` overlays generated host-only settings; both host applications load it consistently. The root Bot entrypoint loads the dedicated Fluxer files itself; Next can instead receive matching server environment variables or use its own local file based on `src/web/.env.example`.

The Bot applies Prisma migrations on startup. PostgreSQL is required; there is no fallback to a pre-existing default development database. Metadata readiness is checked during startup, after migrations and before the Gateway connects. Companion failures are surfaced when a source is prepared. Start only one Bot process per application token. For a rebuilding Bot process, use `yarn dev` instead of `yarn build:bot` and `yarn start`.

For container Bot development, `./dev-env.sh up` or the `yarn docker:dev:*` scripts use the dedicated environment and development override. Named volumes are retained by `down`. Use the explicit volume-removal command only when intentionally discarding this Fluxer development data.

## Containers

```bash
docker compose --env-file .env.fluxer -f docker-compose.yml -f docker-compose.dashboard.yml up --build -d
```

The project is `dimbybot-fluxer`, with `fluxer-*` services, separate named volumes, and local image defaults `dimbybot-fluxer-bot`, `dimbybot-fluxer-dashboard`, and `dimbybot-fluxer-metadata`. No fixed container names or Discord image tags are shared. The Bot image uses Debian/glibc because LiveKit's native Linux binaries do not support musl. FFmpeg runs with pipe-only input; yt-dlp and the retired Discord voice stack are not required.

Container entrypoints construct an encoded URL for the separate `fluxer-db` service from `POSTGRES_*`. `FLUXER_DOCKER_DATABASE_URL` is an optional explicit override for containers; the host's `DATABASE_URL` is not accidentally forwarded as `localhost` inside Docker.

For production, use HTTPS and route **`/ws` on the Dashboard's cookie host** to the Bot, with `WEBSOCKET_CLIENT_URL=wss://your-dashboard-host/ws`. Session cookies authenticate upgrades; URL connect tokens are retired. Keep the Bot API on a private address (`BOT_API_REQUIRE_PRIVATE_CLIENT_IP=1`). `/health` is process liveness; `/ready` reports Gateway readiness. The Dashboard status page probes its database and the Bot HTTP endpoint independently.

CI validates both applications. Automatic image publication and remote deployment are disabled until this independent project is explicitly configured. No remote repository or production environment is provisioned by the conversion.

## Music commands

The default prefix is `!`; `BOT_COMMAND_PREFIX` changes it.

```text
!help
!play song title, artist, or URL
!pause / !resume / !skip / !stop / !leave
!queue / !remove 2 / !move 3 1 / !clear
!seek 90 / !seek 1:30
!volume 50 / !loop off|track|queue / !shuffle / !nowplaying
!playlist create "My Music"
!playlist list / !playlist view "My Music"
!playlist add "My Music" song title or URL
!playlist rename "My Music" "New Name"
!playlist move "New Name" 3 1
!playlist remove "New Name" 2
!playlist play "New Name"
!playlist delete "New Name"
!control-channel TEXT_CHANNEL_ID
!control-channel off
```

Queue/playlist positions start at one. Playlist names containing spaces should be quoted. Stop clears music while retaining the connection; leave also disconnects. Queue clear preserves the current track. Configure a control channel with Manage Guild permission. Ordinary text there queues a query, and an unknown prefix command there shows guidance. The same unknown command is ignored in other channels so the prefix can be shared. Bot messages, webhooks and DMs are ignored. Replies disable mentions.

A controller must share the Bot's voice channel. To start a new session, join a voice channel first; multiple simultaneous voice connections require an explicit target through the API. Give the Bot View Channel, Connect and Speak permissions in that voice channel, and View Channel, Send Messages and Embed Links in its control channel. Permission loss suspends playback immediately and retains a paused queue. An empty voice channel does the same after two minutes.

## Validation and troubleshooting

```bash
yarn typecheck
yarn lint
yarn prettier --check .
yarn test
yarn build:bot
yarn build:web
```

The root compiler excludes `src/web/`; building the Bot does not emit the Dashboard. Unit tests use Node's test runner and tsx under `tests/`; Dashboard tests are under `tests/web/`.

See [the application layout](docs/application-layout.md), [native music smoke tests](docs/fluxer-music-smoke.md), [the architecture decision](docs/adr/0010-fluxer-native-music.md), and [the glossary](GLOSSARY.md). A successful unit suite does not establish audible playback. Run `yarn smoke:fluxer-voice` for the tone/pause/resume/leave probe; a listener must confirm the sound. Sign-in errors should be diagnosed without printing cookies, grants, authorization codes or OAuth tokens. A Dashboard “Bot API unreachable” notice means its configured Bot HTTP listener is unavailable, even if OAuth succeeded.

Search and catalog availability also depend on upstream YouTube/Spotify behavior and metadata/companion services. A failed source is skipped once; unsupported or unreadable persisted session versions are left intact. Encrypted voice configurations are implemented and unit-covered; verify an encrypted channel separately if your instance requires it.

### Queue message reaction controls

The configured control channel's queue message has reactions for ⏯️ pause/resume,
⏭️ skip, ⏹️ stop (clears the queue and stays in voice), 🔀 shuffle upcoming tracks,
and 🔁 loop (off → track → queue → off). Join the Bot's voice channel to use them;
the same membership and voice permissions as prefix commands apply.

Give the Bot View Channel, Send Messages, Embed Links, Read Message History,
Add Reactions, and Manage Messages in the control channel. Manage Messages lets
it remove your reaction after handling the click so you can click again. If
cleanup is unavailable, remove your own reaction before clicking it again.
Existing queue messages gain reactions on their next music update, including
restored queues after a restart. Prefix commands and Dashboard controls remain available.
