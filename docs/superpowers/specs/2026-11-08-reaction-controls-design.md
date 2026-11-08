# Queue reaction controls

Add ⏯️ pause/resume, ⏭️ skip, ⏹️ stop, 🔀 shuffle and 🔁 loop (off → track → queue → off) to the existing Fluxer control message. The user requested this approach after discussing Fluxer's lack of message buttons. Prefix commands and the Dashboard remain available.

Use native reaction events and REST endpoints with no dependencies or Discord archive imports. Only the current configured message accepts controls. Ignore malformed events, custom emoji lookalikes, DMs and the Bot's own reactions. MusicService remains authoritative for membership and voice permissions. Use snapshot revisions to reject stale toggles. Remove a user's handled reaction, even on denial, to permit another click; cleanup failure must not replay playback actions. Unexpected failures get sanitized feedback. Seed reactions on new and retained messages, avoiding repeated writes after successful seeding. Add an embed legend and document Add Reactions, Read Message History and Manage Messages permissions.

## Approaches

Native message buttons are unavailable. Prefix commands alone do not meet the requested clickable interaction. Reaction controls reuse the existing music service and persistent queue message, and are the selected approach.
