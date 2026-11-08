import type { MusicAction } from "../../shared/music-contract.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import { MusicAccessError } from "../fluxer/access.js"
import { fluxerRecord } from "../fluxer/entities.js"
import type { FluxerRest } from "../fluxer/rest.js"
import { MusicError, type MusicService } from "./musicService.js"

export const CONTROL_REACTIONS = ["⏯️", "⏭️", "⏹️", "🔀", "🔁"] as const
export const CONTROL_REACTION_LEGEND = "⏯️ Pause/resume · ⏭️ Skip · ⏹️ Stop · 🔀 Shuffle · 🔁 Loop"

interface ReactionDependencies {
    botId: string
    matches(guildId: string, channelId: string, messageId: string): boolean
    music: Pick<MusicService, "snapshot" | "execute">
    rest: Pick<FluxerRest, "request">
    onError?: (message: string) => void
}

/** Only the configured queue message can control playback; MusicService rechecks voice authority. */
export async function dispatchControlReaction(
    value: unknown,
    dependencies: ReactionDependencies
): Promise<void> {
    const data = fluxerRecord(value),
        emoji = fluxerRecord(data.emoji),
        user = fluxerRecord(fluxerRecord(data.member).user)
    if (
        !isFluxerId(data.guild_id) ||
        !isFluxerId(data.channel_id) ||
        !isFluxerId(data.message_id) ||
        !isFluxerId(data.user_id) ||
        data.user_id === dependencies.botId ||
        user.bot === true ||
        emoji.id != null ||
        typeof emoji.name !== "string" ||
        !dependencies.matches(data.guild_id, data.channel_id, data.message_id)
    )
        return
    const name = emoji.name.replace(/\uFE0F/g, "")
    if (!["⏯", "⏭", "⏹", "🔀", "🔁"].includes(name)) return
    try {
        const snapshot = dependencies.music.snapshot(data.guild_id)
        let action: MusicAction
        switch (name) {
            case "⏯":
                action = { type: snapshot.status === "paused" ? "resume" : "pause" }
                break
            case "⏭":
                action = { type: "skip" }
                break
            case "⏹":
                action = { type: "stop" }
                break
            case "🔀":
                action = { type: "shuffle" }
                break
            default:
                action = {
                    type: "loop",
                    mode:
                        snapshot.repeatMode === "off"
                            ? "track"
                            : snapshot.repeatMode === "track"
                              ? "queue"
                              : "off",
                }
        }
        await dependencies.music.execute(
            { guildId: data.guild_id, userId: data.user_id, textChannelId: data.channel_id },
            action,
            { expectedRevision: snapshot.revision }
        )
    } catch (error) {
        const known = error instanceof MusicError || error instanceof MusicAccessError
        if (!known) dependencies.onError?.("Fluxer reaction control failed")
        try {
            await dependencies.rest.request("POST", `/channels/${data.channel_id}/messages`, {
                body: {
                    content: known
                        ? error.message
                        : "Unable to complete the control. Please try again.",
                    allowed_mentions: { parse: [] },
                },
            })
        } catch {
            dependencies.onError?.("Fluxer reaction feedback failed")
        }
    } finally {
        // Cleanup is separate from playback: an ambiguous deletion must never replay an action.
        try {
            await dependencies.rest.request(
                "DELETE",
                `/channels/${data.channel_id}/messages/${data.message_id}/reactions/${encodeURIComponent(emoji.name)}/${data.user_id}`
            )
        } catch {
            dependencies.onError?.("Fluxer reaction cleanup failed")
        }
    }
}
