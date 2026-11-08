import type { MusicSnapshot } from "../../shared/music-contract.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import { FluxerRestError, type FluxerRest } from "../fluxer/rest.js"
import type { MusicService } from "./musicService.js"

import { CONTROL_REACTIONS, CONTROL_REACTION_LEGEND } from "./controlReactions.js"

interface ControlMessageDependencies {
    music: Pick<MusicService, "subscribe">
    rest: Pick<FluxerRest, "request">
    settings(guildId: string): { channelId: string | null; messageId: string | null }
    saveMessageId(guildId: string, channelId: string, messageId: string): Promise<void>
    schedule?: (callback: () => void, ms: number) => () => void
    onError?: (message: string) => void
}
interface PendingControl {
    latest: MusicSnapshot
    channelId: string | null
    messageId: string | null
    seeded?: string
    cancel?: () => void
    busy: boolean
    dirty: boolean
}

/** Coalesces native control embeds and retains message identity across database write failures. */
export class ControlMessage {
    private readonly states = new Map<string, PendingControl>()
    private readonly unsubscribe: () => void
    private stopped = false
    constructor(private readonly dependencies: ControlMessageDependencies) {
        this.unsubscribe = dependencies.music.subscribe((snapshot) => this.update(snapshot))
    }
    /** Local IDs remain authoritative if saving a newly created message failed. */
    matches(guildId: string, channelId: string, messageId: string): boolean {
        if (this.stopped) return false
        const settings = this.dependencies.settings(guildId)
        const state = this.states.get(guildId)
        return (
            settings.channelId === channelId &&
            (state?.channelId === channelId ? state.messageId : settings.messageId) === messageId
        )
    }
    private async seed(state: PendingControl, channelId: string): Promise<void> {
        if (this.stopped || !state.messageId || state.seeded === state.messageId) return
        for (const emoji of CONTROL_REACTIONS) {
            if (this.stopped) return
            await this.dependencies.rest.request(
                "PUT",
                `/channels/${channelId}/messages/${state.messageId}/reactions/${encodeURIComponent(emoji)}/@me`
            )
        }
        state.seeded = state.messageId
    }
    private update(snapshot: MusicSnapshot): void {
        if (this.stopped) return
        let state = this.states.get(snapshot.guildId)
        if (!state) {
            if (this.states.size >= 2500) return
            state = { latest: snapshot, channelId: null, messageId: null, busy: false, dirty: true }
            this.states.set(snapshot.guildId, state)
        }
        state.latest = snapshot
        state.dirty = true
        this.schedule(state)
    }
    private schedule(state: PendingControl): void {
        if (state.cancel || state.busy || this.stopped) return
        const schedule =
            this.dependencies.schedule ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms)
                timer.unref?.()
                return () => clearTimeout(timer)
            })
        state.cancel = schedule(() => {
            state.cancel = undefined
            void this.flush(state)
        }, 1000)
    }
    private async flush(state: PendingControl): Promise<void> {
        if (this.stopped) return
        state.busy = true
        state.dirty = false
        const snapshot = state.latest,
            settings = this.dependencies.settings(snapshot.guildId)
        if (settings.channelId !== state.channelId) {
            state.seeded = undefined
            state.channelId = settings.channelId
            state.messageId = settings.messageId
        }
        const channelId = state.channelId
        try {
            if (!channelId || !isFluxerId(channelId)) return
            const body = {
                allowed_mentions: { parse: [] },
                embeds: [
                    {
                        footer: { text: CONTROL_REACTION_LEGEND },
                        title: (snapshot.current?.title ?? "Music queue").slice(0, 256),
                        description:
                            `${snapshot.status} · Volume ${snapshot.volume}% · Loop ${snapshot.repeatMode}\n${snapshot.queue.length} upcoming tracks${snapshot.lastError ? `\n${snapshot.lastError}` : ""}`.slice(
                                0,
                                4096
                            ),
                        ...(snapshot.current &&
                        snapshot.playbackUrl &&
                        /^https?:\/\//.test(snapshot.playbackUrl)
                            ? { url: snapshot.playbackUrl }
                            : {}),
                    },
                ],
            }
            if (state.messageId) {
                try {
                    await this.dependencies.rest.request(
                        "PATCH",
                        `/channels/${channelId}/messages/${state.messageId}`,
                        { body }
                    )
                } catch (error) {
                    if (!(error instanceof FluxerRestError) || error.status !== 404) throw error
                    state.messageId = null
                    state.seeded = undefined
                }
                if (state.messageId) {
                    await this.seed(state, channelId)
                    return
                }
            }
            const message = await this.dependencies.rest.request<{ id: string }>(
                "POST",
                `/channels/${channelId}/messages`,
                { body }
            )
            if (!isFluxerId(message?.id)) throw new Error("Invalid control message")
            state.messageId = message.id
            try {
                await this.dependencies.saveMessageId(snapshot.guildId, channelId, message.id)
            } finally {
                await this.seed(state, channelId)
            }
        } catch {
            this.dependencies.onError?.("Fluxer control message update failed")
        } finally {
            state.busy = false
            if (state.dirty) this.schedule(state)
        }
    }
    stop(): void {
        this.stopped = true
        this.unsubscribe()
        for (const state of this.states.values()) state.cancel?.()
        this.states.clear()
    }
}
