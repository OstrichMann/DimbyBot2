import type { FluxerMessage } from "../lib/fluxer/entities.js"
import { MusicAccessError } from "../lib/fluxer/access.js"
import { MusicError } from "../lib/music/musicService.js"
import type { CommandDependencies } from "./context.js"
import { musicCommand } from "./musicCommands.js"
import { parseCommand } from "./parseCommand.js"

/** A reply is sent once: an ambiguous message write must never produce a second message. */
export async function dispatchCommand(
    message: FluxerMessage,
    dependencies: CommandDependencies
): Promise<void> {
    if (message.bot || message.webhook || !message.guildId || !message.content.trim()) return
    const prefixed = message.content.startsWith(dependencies.prefix)
    if (!prefixed && dependencies.controlChannel(message.guildId) !== message.channelId) return
    let content: string
    try {
        const command = parseCommand(message.content, dependencies.prefix) ?? {
            name: "play",
            args: [],
            remainder: message.content.trim(),
        }
        content = await musicCommand(command, {
            actor: {
                userId: message.authorId,
                guildId: message.guildId,
                textChannelId: message.channelId,
            },
            dependencies,
        })
    } catch (error) {
        content =
            error instanceof MusicError || error instanceof MusicAccessError
                ? error.message
                : "Unable to complete the command. Please try again."
        if (!(error instanceof MusicError || error instanceof MusicAccessError))
            dependencies.onError?.("Music command failed")
    }
    try {
        await dependencies.rest.request("POST", `/channels/${message.channelId}/messages`, {
            body: { content: content.slice(0, 2000), allowed_mentions: { parse: [] } },
        })
    } catch {
        dependencies.onError?.("Fluxer command reply failed")
    }
}
