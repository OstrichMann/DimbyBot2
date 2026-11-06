# Glossary

| Name             | Meaning                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot              | The native Fluxer process, starting at `src/server.ts`, including music orchestration and the Bot API.                                                |
| Dashboard        | The nested Next.js application in `src/web/`, accessed through the browser.                                                                           |
| Contract         | The authenticated HTTP/WebSocket boundary between the Dashboard and the Bot; shared DTOs live in `src/shared/`.                                       |
| Music service    | Platform-independent queue/session decisions under `src/lib/music/`, shared by commands and API handlers.                                             |
| Source resolver  | Metadata lookup and preparation of cancellable audio byte streams. Catalog identity is distinct from the actual playback URL.                         |
| Voice transport  | LiveKit room/audio publication using a native Fluxer session grant and bounded PCM from FFmpeg.                                                       |
| Metadata service | Lavalink REST search only; it owns no native queue or voice session.                                                                                  |
| Queue entry      | One independently editable occurrence, identified by `entryId`; duplicate songs retain distinct entries.                                              |
| Session snapshot | Version 2 restart data containing reusable source identities, preferences and position; restored paused, without credentials or prepared stream URLs. |
| Discord archive  | Historical source/tests under `legacy/discord/`, retained for future migration and excluded from active compile/runtime graphs.                       |

The Bot and Dashboard remain two applications in one checkout. Keep their compile graphs and deployment settings separate. “Portal”, “control panel” and “web app” are not additional names for the Dashboard.
