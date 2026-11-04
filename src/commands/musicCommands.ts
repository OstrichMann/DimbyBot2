import type { MusicAction } from "../shared/music-contract.js"
import { MusicError } from "../lib/music/musicService.js"
import type { PlaylistAction, PlaylistResult } from "../lib/music/playlistService.js"
import { isFluxerId } from "../shared/fluxer-user-id.js"
import type { CommandContext } from "./context.js"
import { parseSeekMs, type ParsedCommand } from "./parseCommand.js"

function index(value: string): number {
    if (!/^[1-9]\d*$/.test(value ?? "") || !Number.isSafeInteger(Number(value)))
        throw new MusicError(400, "Positions start at 1")
    return Number(value)
}
function playlistReply(result: PlaylistResult): string {
    switch (result.kind) {
        case "list":
            return result.playlists.length
                ? result.playlists.map((p) => `${p.name} (${p.trackCount} tracks)`).join("\n")
                : "You have no playlists."
        case "deleted":
            return "Playlist deleted."
        case "enqueue":
            return `Queued ${result.tracks.length} tracks from ${result.playlist.name}.`
        case "playlist":
            return `${result.playlist.name} (${result.playlist.tracks.length} tracks)\n${result.playlist.tracks
                .slice(0, 20)
                .map((track, i) => `${i + 1}. ${track.title}`)
                .join("\n")}`
    }
}
function playlistAction(args: string[]): PlaylistAction {
    const [operation, playlist, ...rest] = args
    if (operation === "list") return { type: "list" }
    if (operation === "create") return { type: "create", name: args.slice(1).join(" ") }
    if (!playlist) throw new MusicError(400, "Choose a playlist; quote names containing spaces")
    switch (operation) {
        case "view":
        case "delete":
            return { type: operation, playlist }
        case "play":
            return { type: "enqueue", playlist }
        case "rename":
            return { type: "rename", playlist, name: rest.join(" ") }
        case "add":
            return { type: "add", playlist, query: rest.join(" ") }
        case "remove":
            return { type: "remove", playlist, position: index(rest[0]) }
        case "move":
            return { type: "move", playlist, from: index(rest[0]), to: index(rest[1]) }
        default:
            throw new MusicError(
                400,
                "Use playlist create/list/view/rename/delete/add/remove/move/play"
            )
    }
}

/** Every command name `musicCommand` answers; anything else is another bot's command. */
export const MUSIC_COMMANDS: ReadonlySet<string> = new Set([
    "help",
    "control-channel",
    "playlist",
    "queue",
    "nowplaying",
    "play",
    "pause",
    "resume",
    "skip",
    "stop",
    "leave",
    "clear",
    "shuffle",
    "seek",
    "volume",
    "loop",
    "remove",
    "move",
])

/** Converts native text commands to application actions; all authorization stays in the services. */
export async function musicCommand(
    command: ParsedCommand,
    context: CommandContext
): Promise<string> {
    const { actor, dependencies: deps } = context
    const { name, args, remainder } = command
    // `play` reads the raw remainder, so a leading apostrophe ('Til Tuesday) is just text.
    if (command.unclosedQuote && name !== "play")
        throw new MusicError(400, "Close the quoted argument")
    if (name === "help")
        return `${deps.prefix}play <query or URL> · pause · resume · skip · stop · leave · queue · remove <position> · move <from> <to> · clear · seek <seconds|mm:ss> · volume <0–100> · loop <off|track|queue> · shuffle · nowplaying\n${deps.prefix}playlist create/list/view/rename/delete/add/remove/move/play\n${deps.prefix}control-channel <channel-id|off>`
    if (name === "control-channel") {
        await deps.access.authorizeMusic(actor, "configure")
        const channelId = args[0] === "off" ? null : args[0]
        if (args.length !== 1 || (channelId !== null && !isFluxerId(channelId)))
            throw new MusicError(400, "Choose a text channel ID or off")
        if (channelId) await deps.validateControlChannel(actor, channelId)
        await deps.setControlChannel(actor.guildId, channelId)
        return channelId ? `Control channel set to <#${channelId}>.` : "Control channel disabled."
    }
    if (name === "playlist") {
        const result = await deps.playlists.execute(actor.userId, playlistAction(args))
        if (result.kind === "enqueue")
            await deps.music.execute(actor, { type: "enqueue", tracks: result.tracks })
        return playlistReply(result)
    }
    if (name === "queue" || name === "nowplaying") {
        await deps.access.authorizeMusic(actor, "view")
        const state = deps.music.snapshot(actor.guildId)
        if (name === "queue")
            return state.queue.length
                ? state.queue
                      .slice(0, 25)
                      .map((track, i) => `${i + 1}. ${track.title}`)
                      .join("\n")
                : "The queue is empty."
        return state.current
            ? `${state.status === "paused" ? "Paused" : "Now playing"}: ${state.current.title}${state.playbackUrl ? `\n${state.playbackUrl}` : ""}`
            : "Nothing is playing."
    }
    let action: MusicAction
    switch (name) {
        case "play":
            action = { type: "play", query: remainder }
            break
        case "pause":
        case "resume":
        case "skip":
        case "stop":
        case "leave":
        case "clear":
        case "shuffle":
            action = { type: name }
            break
        case "seek": {
            const positionMs = args.length === 1 ? parseSeekMs(args[0]) : null
            if (positionMs === null) throw new MusicError(400, "Use seek <seconds|mm:ss>")
            action = { type: "seek", positionMs }
            break
        }
        case "volume": {
            if (args.length !== 1 || !/^\d{1,3}$/.test(args[0]) || Number(args[0]) > 100)
                throw new MusicError(400, "Volume must be 0–100")
            action = { type: "volume", percent: Number(args[0]) }
            break
        }
        case "loop": {
            const mode = args[0]
            if (args.length !== 1 || (mode !== "off" && mode !== "track" && mode !== "queue"))
                throw new MusicError(400, "Loop must be off, track or queue")
            action = { type: "loop", mode }
            break
        }
        case "remove":
        case "move": {
            await deps.access.authorizeMusic(actor, "control")
            const from = index(args[0])
            const entry = deps.music.snapshot(actor.guildId).queue[from - 1]
            if (!entry) throw new MusicError(404, "Queue entry not found")
            const toIndex = name === "move" ? index(args[1]) - 1 : 0
            if (name === "move" && toIndex >= deps.music.snapshot(actor.guildId).queue.length)
                throw new MusicError(400, "Queue position is out of range")
            action =
                name === "remove"
                    ? { type: "remove", entryId: entry.entryId }
                    : { type: "move", entryId: entry.entryId, toIndex }
            break
        }
        default:
            return `Unknown command. Use ${deps.prefix}help.`
    }
    await deps.music.execute(actor, action)
    return name === "play" ? "Added to the music queue." : `Music ${name} applied.`
}
