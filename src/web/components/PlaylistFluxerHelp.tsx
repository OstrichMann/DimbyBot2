/** The same owner-scoped playlists are available through native Fluxer commands. */
export function PlaylistFluxerHelp() {
    const prefix = process.env.BOT_COMMAND_PREFIX || "!"
    return (
        <p className="text-sm text-muted-foreground">
            In Fluxer, use{" "}
            <code className="rounded bg-muted px-1">{prefix}playlist play "My Playlist"</code> to
            queue a saved playlist. Use <code>{prefix}help</code> for create, add, rename, move,
            remove and delete commands.
        </p>
    )
}
