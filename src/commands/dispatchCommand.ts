import { isFluxerId } from "../shared/fluxer-user-id.js"
import { FluxerRestError } from "../lib/fluxer/rest.js"
import type { FluxerMessage } from "../lib/fluxer/entities.js"
import { MusicAccessError } from "../lib/fluxer/access.js"
import { MusicError } from "../lib/music/musicService.js"
import type { CommandDependencies } from "./context.js"
import { MUSIC_COMMANDS, musicCommand } from "./musicCommands.js"
import { parseCommand } from "./parseCommand.js"

/** A reply is sent once: an ambiguous message write must never produce a second message. */
export async function dispatchCommand(
    message: FluxerMessage,
    dependencies: CommandDependencies
): Promise<void> {
    if (message.bot || message.webhook || !message.guildId || !message.content.trim()) return
    const prefixed = message.content.startsWith(dependencies.prefix)
    const inControlChannel = dependencies.controlChannel(message.guildId) === message.channelId
    if (!prefixed && !inControlChannel) return
    const command = parseCommand(message.content, dependencies.prefix) ?? {
        name: "play",
        args: [],
        remainder: message.content.trim(),
    }
    // The prefix is often shared with other bots: answer unknown names only where we own the channel.
    if (!inControlChannel && !MUSIC_COMMANDS.has(command.name)) return
    let content: string
    try {
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
        const reply = await dependencies.rest.request<{ id: string }>(
            "POST",
            `/channels/${message.channelId}/messages`,
            { body: { content: content.slice(0, 2000), allowed_mentions: { parse: [] } } }
        )
        if (inControlChannel && isFluxerId(reply?.id)) {
            const timer = setTimeout(() => {
                void deleteControlMessage(message.channelId, reply.id, dependencies)
            }, 5000)
            timer.unref?.()
        }
    } catch {
        dependencies.onError?.("Fluxer command reply failed")
    } finally {
        if (inControlChannel)
            await deleteControlMessage(message.channelId, message.id, dependencies)
    }
}

/** Cleanup is best effort: missing permissions or messages must not replay a command or reply. */
async function deleteControlMessage(
    channelId: string,
    messageId: string,
    dependencies: CommandDependencies
): Promise<void> {
    try {
        await dependencies.rest.request("DELETE", `/channels/${channelId}/messages/${messageId}`)
    } catch (error) {
        if (!(error instanceof FluxerRestError && error.status === 404))
            dependencies.onError?.("Fluxer control message cleanup failed")
    }
}
