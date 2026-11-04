import { isFluxerId } from "../fluxer-user-id.js"
import type { AuthenticatedActor } from "../fluxer-session.js"
import { nativePlayerState, nativeTrackSummary, type MusicViewer } from "../fluxer-player-state.js"
import type { MusicSnapshot } from "../music-contract.js"

interface MusicSocket {
    readyState: number
    send(data: string): void
    close(code?: number, reason?: string): void
    on(event: string, listener: (...args: unknown[]) => void): unknown
}
interface SocketState {
    socket: MusicSocket
    headers: Headers
    actor: AuthenticatedActor
    subscriptions: Map<string, number>
    generation: number
    expiry: ReturnType<typeof setTimeout>
}
interface Dependencies {
    music: {
        snapshot(guildId: string): MusicSnapshot
        subscribe(listener: (snapshot: MusicSnapshot) => void): () => void
    }
    authenticate(headers: Headers): Promise<AuthenticatedActor>
    authorize(actor: AuthenticatedActor, guildId: string): Promise<MusicViewer>
    schedule?: (callback: () => void, ms: number) => () => void
}

/** Sessions and permission flags are rechecked separately for every viewer and every delivered update. */
export class NativeMusicConnections {
    private readonly sockets = new Set<SocketState>()
    private readonly pending = new Map<string, () => void>()
    private readonly unsubscribe: () => void
    private readonly interval: ReturnType<typeof setInterval>
    private stopped = false
    constructor(private readonly dependencies: Dependencies) {
        this.unsubscribe = dependencies.music.subscribe((state) => this.invalidate(state.guildId))
        this.interval = setInterval(() => {
            for (const state of this.sockets)
                for (const guild of state.subscriptions.keys()) this.invalidate(guild)
        }, 15000)
        this.interval.unref?.()
    }
    async add(socket: MusicSocket, headers: Headers): Promise<void> {
        if (this.stopped || this.sockets.size >= 1000) {
            socket.close(1013, "Live updates unavailable")
            return
        }
        let actor: AuthenticatedActor
        try {
            actor = await this.dependencies.authenticate(headers)
        } catch {
            socket.close(1008, "Sign in with Fluxer")
            return
        }
        if (this.stopped || socket.readyState !== 1 || actor.expiresAt <= Date.now()) {
            socket.close(1008, "Session expired")
            return
        }
        const expiry = setTimeout(
            () => socket.close(1008, "Session expired"),
            Math.min(2147483647, actor.expiresAt - Date.now())
        )
        expiry.unref?.()
        const state: SocketState = {
            socket,
            headers,
            actor,
            subscriptions: new Map(),
            generation: 0,
            expiry,
        }
        this.sockets.add(state)
        socket.on("message", (data) => {
            void this.message(state, data).catch(() => socket.close(1008, "Live update failed"))
        })
        socket.on("close", () => {
            clearTimeout(expiry)
            state.generation++
            state.subscriptions.clear()
            this.sockets.delete(state)
        })
        socket.on("error", () => socket.close(1011, "Live update failed"))
    }
    private send(state: SocketState, value: unknown): void {
        if (state.socket.readyState === 1 && this.sockets.has(state))
            state.socket.send(JSON.stringify(value))
    }
    private async authenticate(state: SocketState): Promise<AuthenticatedActor | null> {
        try {
            const actor = await this.dependencies.authenticate(state.headers)
            if (
                actor.userId !== state.actor.userId ||
                actor.sessionId !== state.actor.sessionId ||
                actor.expiresAt <= Date.now()
            )
                throw new Error("Session changed")
            return actor
        } catch {
            state.socket.close(1008, "Session expired")
            return null
        }
    }
    private async message(state: SocketState, raw: unknown): Promise<void> {
        if (!this.sockets.has(state)) return
        let message: Record<string, unknown>
        try {
            const text = String(raw)
            if (text.length > 16384) throw new Error("Too large")
            const parsed: unknown = JSON.parse(text)
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("Invalid frame")
            message = parsed as Record<string, unknown>
            if (
                !["subscribe", "unsubscribe", "ping"].includes(String(message.type)) ||
                (message.type !== "ping" && !isFluxerId(message.guildId))
            )
                throw new Error("Invalid frame")
        } catch {
            this.send(state, {
                type: "error",
                code: "INVALID_MESSAGE",
                message: "Invalid live update request",
            })
            return
        }
        if (message.type === "ping") {
            this.send(state, { type: "pong" })
            return
        }
        const guildId = message.guildId as string
        const generation = ++state.generation
        if (message.type === "unsubscribe") {
            state.subscriptions.delete(guildId)
            this.send(state, { type: "unsubscribed", guildId })
            return
        }
        if (state.subscriptions.size >= 5 && !state.subscriptions.has(guildId)) {
            this.send(state, {
                type: "error",
                code: "SUBSCRIBE_LIMIT",
                message: "Too many subscriptions",
            })
            return
        }
        const actor = await this.authenticate(state)
        if (!actor) return
        try {
            const viewer = await this.dependencies.authorize(actor, guildId)
            if (this.stopped || !this.sockets.has(state) || state.generation !== generation) return
            state.subscriptions.set(guildId, generation)
            this.send(state, { type: "subscribed", guildId })
            this.deliver(state, guildId, viewer)
        } catch {
            if (state.generation === generation)
                this.send(state, {
                    type: "error",
                    code: "SUBSCRIBE_FORBIDDEN",
                    message: "Unable to verify player access",
                })
        }
    }
    private deliver(state: SocketState, guildId: string, viewer: MusicViewer): void {
        const snapshot = this.dependencies.music.snapshot(guildId)
        this.send(state, {
            type: "queueUpdate",
            guildId,
            revision: snapshot.revision,
            state: nativePlayerState(snapshot, viewer),
            queue: snapshot.queue.slice(0, 100).map(nativeTrackSummary),
        })
    }
    invalidate(guildId: string): void {
        if (this.stopped || this.pending.has(guildId)) return
        const schedule =
            this.dependencies.schedule ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms)
                timer.unref?.()
                return () => clearTimeout(timer)
            })
        this.pending.set(
            guildId,
            schedule(() => {
                this.pending.delete(guildId)
                for (const state of this.sockets)
                    if (state.subscriptions.has(guildId)) void this.refresh(state, guildId)
            }, 500)
        )
    }
    private async refresh(state: SocketState, guildId: string): Promise<void> {
        const generation = state.subscriptions.get(guildId)
        const actor = await this.authenticate(state)
        if (!actor) return
        try {
            const viewer = await this.dependencies.authorize(actor, guildId)
            if (
                !this.stopped &&
                this.sockets.has(state) &&
                state.subscriptions.get(guildId) === generation
            )
                this.deliver(state, guildId, viewer)
        } catch {
            if (state.subscriptions.get(guildId) !== generation) return
            state.subscriptions.delete(guildId)
            this.send(state, {
                type: "error",
                code: "SUBSCRIBE_FORBIDDEN",
                message: "Player access changed",
            })
            this.send(state, { type: "unsubscribed", guildId })
        }
    }
    stop(): void {
        this.stopped = true
        this.unsubscribe()
        clearInterval(this.interval)
        for (const cancel of this.pending.values()) cancel()
        this.pending.clear()
        for (const state of this.sockets) {
            clearTimeout(state.expiry)
            state.socket.close(1001, "Bot is shutting down")
        }
        this.sockets.clear()
    }
}
