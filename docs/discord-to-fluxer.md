# Discord bot vs Fluxer music release

Snapshot of what the archived Discord bot did and what the active Fluxer runtime does. Taken from the slash-command builders under `legacy/discord/src/commands/` and the prefix commands in `src/commands/musicCommands.ts` on November 5, 2026. Update this file when a deferred feature is migrated.

**12 of 31** Discord slash commands have a Fluxer equivalent. The other **19** remain only in `legacy/discord/` and do not register or start jobs. Six prefix commands (`pause`, `resume`, `volume`, `remove`, `move`, `help`) cover behavior Discord exposed through buttons, the Dashboard, or not at all.

Statuses:

- **Carried** — the same job exists on Fluxer.
- **Changed** — it works, with a different command or platform behavior.
- **Not migrated** — Discord had it; the Fluxer process does not.

## Slash commands by area

| Area         | Has a Fluxer equivalent | Not migrated |
| ------------ | ----------------------: | -----------: |
| Music        |                      11 |            4 |
| Server admin |                       1 |            5 |
| Downloads    |                       0 |            2 |
| Developer    |                       0 |            8 |

Music equivalents are `play`, `skip`, `stop`, `leave`, `queue`, `clearqueue`, `shuffle`, `seek`, `loop`, `nowplaying`, and `playlist`. `control-channel` is the only carried server-admin command. The prefix default is `!` (`BOT_COMMAND_PREFIX`).

## Music

| Feature                            | Discord                                            | Fluxer                                          | Status        |
| ---------------------------------- | -------------------------------------------------- | ----------------------------------------------- | ------------- |
| Search or URL playback             | `/play`                                            | `!play`                                         | Carried       |
| Skip                               | `/skip` and a control button                       | `!skip` and the Dashboard                       | Carried       |
| Stop, staying in voice             | `/stop` and a control button                       | `!stop` and the Dashboard                       | Carried       |
| Leave voice                        | `/leave`                                           | `!leave` and the Dashboard                      | Carried       |
| Show the queue                     | `/queue`                                           | `!queue` and the Dashboard                      | Carried       |
| Clear the queue                    | `/clearqueue`                                      | `!clear` and the Dashboard                      | Carried       |
| Shuffle upcoming tracks            | `/shuffle` and a control button                    | `!shuffle` and the Dashboard                    | Carried       |
| Seek                               | `/seek`                                            | `!seek` as seconds or `mm:ss`                   | Carried       |
| Loop off, track, or queue          | `/loop` and a control button                       | `!loop` and the Dashboard                       | Carried       |
| Playlists                          | create, list, view, add, remove, delete, play      | Those, plus rename and move                     | Changed       |
| Control channel                    | `/control-channel` set or unset; plain text queues | `!control-channel <id\|off>`; plain text queues | Carried       |
| Now playing                        | Embed with source, time, and requester             | Title and URL, plus a throttled control message | Changed       |
| Pause and resume                   | Control-message buttons                            | `!pause`, `!resume`, and the Dashboard          | Changed       |
| Volume                             | Player setting and the Dashboard                   | `!volume` 0–100 and the Dashboard               | Changed       |
| Remove or move a queue entry       | Dashboard                                          | `!remove`, `!move`, and the Dashboard           | Changed       |
| Command help                       | Slash command descriptions                         | `!help`                                         | New on Fluxer |
| Insert as the next track           | `/playnext`                                        | Not implemented                                 | Not migrated  |
| Autoplay                           | `/autoplay` and a control button                   | Controls hidden                                 | Not migrated  |
| Genre discovery                    | `/genre`                                           | Not implemented                                 | Not migrated  |
| Round-robin queue                  | `/roundrobin`                                      | Not implemented                                 | Not migrated  |
| Shuffle when enqueueing a playlist | `/playlist play` shuffle option                    | Enqueue keeps saved order                       | Not migrated  |
| Local audio files                  | A query could match local wav files                | `file:` and local queries are rejected          | Not migrated  |
| Control-message buttons            | Pause, stop, skip, shuffle, loop, autoplay         | Ordinary messages; Fluxer has no bot buttons    | Not migrated  |

## Server admin, downloads, and developer tools

| Feature                      | Discord                                           | Fluxer                                    | Status       |
| ---------------------------- | ------------------------------------------------- | ----------------------------------------- | ------------ |
| Countdowns                   | `/countdown` create, list, delete                 | Table remains; routes return unavailable  | Not migrated |
| YouTube upload alerts        | `/yt-alerts` add, list, edit, remove              | Tables remain; the monitor does not start | Not migrated |
| Log forwarding               | `/discord-logs` set, unset, min-level, show       | Not implemented                           | Not migrated |
| Clear messages               | `/clearmessages`                                  | Not implemented                           | Not migrated |
| Ping                         | `/ping`                                           | Not implemented                           | Not migrated |
| Download a YouTube URL       | `/download`                                       | Routes return unavailable                 | Not migrated |
| List and clean downloads     | `/downloads` list, cleanup                        | Not implemented                           | Not migrated |
| Eval                         | `/eval`                                           | Not implemented                           | Not migrated |
| Player control across guilds | `/playerctl` view, skip, stop, destroy, reconnect | Not implemented                           | Not migrated |
| Player stats                 | `/playerstats`                                    | Not implemented                           | Not migrated |
| Stack status                 | `/stackstatus`                                    | Health stays; this command does not       | Not migrated |
| Verbose logging              | `/verboselogging`                                 | Not implemented                           | Not migrated |
| Log review                   | `/logreview`                                      | Not implemented                           | Not migrated |
| Download size limit          | `/downloadlimit`                                  | Not implemented                           | Not migrated |
| Deploy slash commands        | `/deploycommands` and the yarn deploy scripts     | Retired; prefix commands need no deploy   | Not migrated |

The `/suggest` command was already disabled on Discord and was not carried over.

## Dashboard

| Feature                                            | Discord        | Fluxer                                              | Status       |
| -------------------------------------------------- | -------------- | --------------------------------------------------- | ------------ |
| Sign-in                                            | Discord OAuth  | Fluxer OAuth with PKCE; no email or numeric linking | Changed      |
| Guild list, player, queue, playlists, live updates | Working        | Working against the native music service            | Carried      |
| Bot invite                                         | Discord invite | Fluxer invite                                       | Changed      |
| Admin errors, database, and metrics                | Working pages  | Pages and API return unavailable                    | Not migrated |

## Runtime

| Piece                 | Discord                                   | Fluxer                                                    |
| --------------------- | ----------------------------------------- | --------------------------------------------------------- |
| Bot connection        | discord.js gateway and slash interactions | Native Fluxer gateway and prefix messages                 |
| Voice and queue owner | Lavalink player plus Discord voice        | Bot-owned queue, LiveKit audio, FFmpeg PCM                |
| Track search          | `lavalink-client`                         | Lavalink HTTP `/v4/loadtracks` for metadata only          |
| YouTube playback      | Companion stream                          | Companion stream, prepared just before play               |
| Restart               | Session snapshots                         | Restores paused until an authorized user resumes          |
| Database              | Discord `.env` and its production data    | Fresh `.env.fluxer` database; Discord rows are not copied |

Deferred Prisma models (`DownloadMetadata`, `YoutubeAlert`, `Countdown`, and the related YouTube watch tables) stay in `prisma/schema.prisma` for a later migration. See [ADR 0010](adr/0010-fluxer-native-music.md) for the voice and packaging decisions, and [legacy/discord](../legacy/discord/README.md) for the retired source.
