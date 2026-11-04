import type { FluxerDispatch } from "./gateway.js"
import { fluxerRecord } from "./entities.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"

export interface VoiceGrant {
    endpoint: string
    token: string
    connectionId: string
    e2eeKey?: string
}
interface VoiceDependencies {
    send: (op: number, data: unknown) => void
    schedule?: (callback: () => void, ms: number) => () => void
    onGrant?: (guildId: string, grant: VoiceGrant) => void
    onDisconnect?: (guildId: string) => void
}
interface PendingJoin {
    channelId: string
    canceled: boolean
    resolve: (grant: VoiceGrant) => void
    reject: (error: Error) => void
    cleanup: () => void
}

/** Correlates session-only grants; canceled joins stay quarantined until drained or a fresh READY. */
export class FluxerVoice {
    private readonly pending = new Map<string, PendingJoin>()
    private readonly active = new Map<string, { channelId: string; grant: VoiceGrant }>()
    private readonly schedule: NonNullable<VoiceDependencies["schedule"]>
    constructor(private readonly dependencies: VoiceDependencies) {
        this.schedule =
            dependencies.schedule ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms)
                return () => clearTimeout(timer)
            })
    }
    channelId(guildId: string): string | null {
        return this.active.get(guildId)?.channelId ?? null
    }

    async join(guildId: string, channelId: string, signal: AbortSignal): Promise<VoiceGrant> {
        signal.throwIfAborted()
        if (!isFluxerId(guildId) || !isFluxerId(channelId))
            throw new Error("Invalid voice channel identifier")
        if (this.pending.has(guildId)) throw new Error("Previous voice join is still settling")
        if (this.active.has(guildId)) throw new Error("Voice session is already connected")
        return new Promise<VoiceGrant>((resolve, reject) => {
            const pending: PendingJoin = {
                channelId,
                canceled: false,
                resolve,
                reject,
                cleanup: () => {},
            }
            const cancel = (error: Error) => {
                pending.canceled = true
                pending.cleanup()
                reject(error)
            }
            const abort = () => cancel(new DOMException("Voice join aborted", "AbortError"))
            const cancelTimer = this.schedule(
                () => cancel(new Error("Fluxer voice join timed out")),
                15_000
            )
            pending.cleanup = () => {
                cancelTimer()
                signal.removeEventListener("abort", abort)
            }
            this.pending.set(guildId, pending)
            signal.addEventListener("abort", abort, { once: true })
            try {
                this.dependencies.send(4, {
                    guild_id: guildId,
                    channel_id: channelId,
                    self_mute: false,
                    self_deaf: false,
                    self_video: false,
                    self_stream: false,
                })
            } catch {
                pending.cleanup()
                this.pending.delete(guildId)
                reject(new Error("Fluxer voice join could not be sent"))
            }
        })
    }

    async leave(guildId: string): Promise<void> {
        const pending = this.pending.get(guildId)
        if (pending && !pending.canceled) {
            pending.canceled = true
            pending.cleanup()
            pending.reject(new DOMException("Voice join canceled", "AbortError"))
        }
        const active = this.active.get(guildId)
        this.active.delete(guildId)
        if (active)
            this.dependencies.send(4, {
                guild_id: guildId,
                channel_id: null,
                connection_id: active.grant.connectionId,
            })
    }

    handleDispatch(event: FluxerDispatch): void {
        if (event.t === "READY") {
            for (const pending of this.pending.values()) {
                pending.cleanup()
                pending.reject(new Error("Fluxer voice session replaced"))
            }
            this.pending.clear()
            for (const id of this.active.keys()) this.dependencies.onDisconnect?.(id)
            this.active.clear()
            return
        }
        const data = fluxerRecord(event.d),
            guildId = data.guild_id
        if (!isFluxerId(guildId)) return
        const current = this.active.get(guildId)
        if (
            event.t === "VOICE_STATE_UPDATE" &&
            current &&
            data.connection_id === current.grant.connectionId &&
            data.channel_id !== current.channelId
        ) {
            this.active.delete(guildId)
            this.dependencies.onDisconnect?.(guildId)
            this.dependencies.send(4, {
                guild_id: guildId,
                channel_id: null,
                connection_id: current.grant.connectionId,
            })
            return
        }
        if (event.t !== "VOICE_SERVER_UPDATE") return
        const pending = this.pending.get(guildId)
        const matchesPending = pending?.channelId === data.channel_id
        const matchesActive =
            current?.grant.connectionId === data.connection_id &&
            current?.channelId === data.channel_id
        if (!matchesPending && !matchesActive) return
        if (pending?.canceled && matchesPending) {
            if (typeof data.connection_id === "string")
                this.dependencies.send(4, {
                    guild_id: guildId,
                    channel_id: null,
                    connection_id: data.connection_id,
                })
            this.pending.delete(guildId)
            return
        }
        let valid =
            typeof data.token === "string" &&
            !!data.token &&
            typeof data.endpoint === "string" &&
            typeof data.connection_id === "string" &&
            !!data.connection_id &&
            data.p2p !== true &&
            (data.e2ee_key === undefined || typeof data.e2ee_key === "string")
        try {
            const url = new URL(String(data.endpoint))
            valid =
                valid &&
                ["ws:", "wss:"].includes(url.protocol) &&
                !url.username &&
                !url.password &&
                !url.hash
        } catch {
            valid = false
        }
        if (!valid) {
            if (pending) {
                pending.cleanup()
                this.pending.delete(guildId)
                pending.reject(new Error("Unsupported or malformed Fluxer voice grant"))
            }
            if (typeof data.connection_id === "string")
                this.dependencies.send(4, {
                    guild_id: guildId,
                    channel_id: null,
                    connection_id: data.connection_id,
                })
            if (current) {
                this.active.delete(guildId)
                this.dependencies.onDisconnect?.(guildId)
            }
            return
        }
        const grant: VoiceGrant = {
            endpoint: data.endpoint as string,
            token: data.token as string,
            connectionId: data.connection_id as string,
            ...(typeof data.e2ee_key === "string" ? { e2eeKey: data.e2ee_key } : {}),
        }
        this.active.set(guildId, { channelId: data.channel_id as string, grant })
        if (pending) {
            pending.cleanup()
            this.pending.delete(guildId)
            pending.resolve(grant)
        } else this.dependencies.onGrant?.(guildId, grant)
    }

    async stop(): Promise<void> {
        for (const id of new Set([...this.active.keys(), ...this.pending.keys()]))
            await this.leave(id)
        this.pending.clear()
    }
}
