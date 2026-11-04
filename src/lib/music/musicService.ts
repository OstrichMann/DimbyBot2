import { randomUUID } from "node:crypto"
import type {
    MusicAction,
    MusicSnapshot,
    MusicTrack,
    MusicSessionSnapshotV2,
} from "../../shared/music-contract.js"
import { isFluxerId } from "../../shared/fluxer-user-id.js"
import type { FluxerAccess } from "../fluxer/access.js"
import type { FluxerVoice } from "../fluxer/voice.js"
import type { SourceResolver } from "./sourceResolver.js"
import type { MusicTransport, PreparedSource } from "./types.js"
import { MusicTransportDisconnectedError } from "./types.js"
import { canonicalMusicTrack } from "./sessionPersistence.js"

export class MusicError extends Error {
    constructor(
        readonly status: 400 | 404 | 409 | 503,
        message: string
    ) {
        super(message)
        this.name = "MusicError"
    }
}
export interface MusicActor {
    guildId: string
    userId: string
    textChannelId: string
}
interface ServiceDependencies {
    access: Pick<FluxerAccess, "authorizeMusic">
    voice: Pick<FluxerVoice, "join" | "leave" | "channelId">
    resolver: Pick<SourceResolver, "load" | "prepare">
    transportFactory: (guildId: string) => MusicTransport
    verifyBotAccess: (guildId: string, channelId: string) => Promise<void>
    hasListeners: (guildId: string, channelId: string) => boolean
    schedule?: (callback: () => void, ms: number) => () => void
    emptyVoiceTimeoutMs?: number
    random?: () => number
    onError?: (error: Error) => void
}
interface GuildMusic {
    value: MusicSnapshot
    generation: AbortController
    mutations: Promise<unknown>
    searchTail: Promise<void>
    transport?: MusicTransport
    runner?: Promise<void>
    trackController?: AbortController
    /** True once the current source was handed to the transport, whose position is then live. */
    handedOff: boolean
    /** Shared voice join + transport connect, so a successor track reuses an in-flight connect. */
    connecting?: Promise<void>
    /** Settles when every stop/leave accepted so far has finished; later requests wait on it. */
    barrier: Promise<void>
    seekable: boolean
    cancelEmpty?: () => void
    requests: number
}

function empty(guildId: string): MusicSnapshot {
    return {
        guildId,
        voiceChannelId: null,
        textChannelId: null,
        revision: 0,
        connected: false,
        status: "idle",
        current: null,
        queue: [],
        positionMs: 0,
        durationMs: 0,
        playbackUrl: null,
        volume: 100,
        repeatMode: "off",
        lastError: null,
    }
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener("abort", abort)
            reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        promise.then(
            (value) => {
                signal.removeEventListener("abort", abort)
                resolve(value)
            },
            (error) => {
                signal.removeEventListener("abort", abort)
                reject(error)
            }
        )
    })
}

/** Native queue authority shared by prefix commands and Bot API actions; network work is cancelable. */
export class MusicService {
    private readonly states = new Map<string, GuildMusic>()
    private readonly listeners = new Set<(snapshot: MusicSnapshot) => void>()
    private readonly schedule: NonNullable<ServiceDependencies["schedule"]>
    private readonly emptyTimeout: number
    private closed = false
    constructor(private readonly dependencies: ServiceDependencies) {
        this.emptyTimeout = dependencies.emptyVoiceTimeoutMs ?? 120_000
        if (
            !Number.isFinite(this.emptyTimeout) ||
            this.emptyTimeout < 1000 ||
            this.emptyTimeout > 3_600_000
        )
            throw new Error("MUSIC_EMPTY_VOICE_TIMEOUT_MS must be 1000–3600000")
        this.schedule =
            dependencies.schedule ??
            ((callback, ms) => {
                const timer = setTimeout(callback, ms)
                timer.unref()
                return () => clearTimeout(timer)
            })
    }
    snapshot(guildId: string): MusicSnapshot {
        const state = this.states.get(guildId),
            value = state?.value ?? empty(guildId)
        const positionMs =
            state?.runner && state.handedOff && state.transport
                ? state.transport.positionMs()
                : value.positionMs
        return {
            ...value,
            current: value.current ? { ...value.current } : null,
            queue: value.queue.map((track) => ({ ...track })),
            positionMs,
            durationMs: value.current ? Math.max(value.durationMs, positionMs) : 0,
        }
    }
    allSnapshots(): MusicSnapshot[] {
        return [...this.states.keys()].map((id) => this.snapshot(id))
    }
    subscribe(listener: (snapshot: MusicSnapshot) => void): () => void {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    async execute(
        actor: MusicActor,
        action: MusicAction,
        options: { expectedRevision?: number } = {}
    ): Promise<MusicSnapshot> {
        if (this.closed) throw new MusicError(503, "Music is shutting down")
        if (
            !isFluxerId(actor.guildId) ||
            !isFluxerId(actor.userId) ||
            !isFluxerId(actor.textChannelId)
        )
            throw new MusicError(400, "Invalid music actor")
        this.validate(action)
        if (
            options.expectedRevision !== undefined &&
            (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0)
        )
            throw new MusicError(400, "Invalid music revision")
        const state = this.state(actor.guildId)
        const checkRevision = () => {
            if (
                options.expectedRevision !== undefined &&
                options.expectedRevision !== state.value.revision
            )
                throw new MusicError(409, "Music changed; refresh and try again")
        }
        state.requests++
        // Requests accepted after a stop/leave wait for it, so the stop cannot cancel them.
        const barrier = state.barrier
        let stopped = () => {}
        if (action.type === "stop" || action.type === "leave") {
            const own = new Promise<void>((resolve) => {
                stopped = resolve
            })
            state.barrier = barrier.then(() => own)
        }
        const queued = action.type === "play" || action.type === "enqueue"
        let release = () => {}
        try {
            await barrier
            const signal = state.generation.signal
            const previous = state.searchTail
            if (queued)
                state.searchTail = new Promise<void>((resolve) => {
                    release = resolve
                })
            const [level, channelId] = this.accessFor(state, action)
            const access = await this.dependencies.access.authorizeMusic(actor, level, channelId)
            signal.throwIfAborted()
            if (action.type === "stop" || action.type === "leave") {
                await this.mutate(state, async () => {
                    checkRevision()
                    this.cancel(state)
                    await this.stopTrack(state)
                    state.value.current = null
                    state.value.queue = []
                    state.value.status = "idle"
                    state.value.positionMs = 0
                    state.value.durationMs = 0
                    state.value.playbackUrl = null
                    state.value.lastError = null
                    if (action.type === "leave" || !state.value.connected)
                        await this.disconnect(state)
                    if (action.type === "leave") state.value.voiceChannelId = null
                    this.publish(state)
                })
                return this.snapshot(actor.guildId)
            }
            if (queued) {
                const result =
                    action.type === "play"
                        ? await abortable(
                              this.dependencies.resolver.load(action.query, actor.userId, signal),
                              signal
                          )
                        : { kind: "playlist", tracks: action.tracks }
                const tracks = result.kind === "search" ? result.tracks.slice(0, 1) : result.tracks
                if (!tracks.length) throw new MusicError(404, "No matching tracks found")
                const normalized = tracks.map((track) =>
                    canonicalMusicTrack({
                        ...track,
                        entryId: randomUUID(),
                        requesterId: actor.userId,
                    })
                )
                if (normalized.some((track) => !track))
                    throw new MusicError(400, "Invalid queue track")
                await abortable(previous, signal)
                // Appends do not depend on queue order, so a stale revision must not reject them.
                await this.mutate(state, () => {
                    signal.throwIfAborted()
                    if (
                        state.value.queue.length +
                            (state.value.current ? 1 : 0) +
                            normalized.length >
                        1000
                    )
                        throw new MusicError(400, "Queue limit is 1000 tracks")
                    const active = state.runner || state.value.connected
                    if (active && access.voiceChannelId !== state.value.voiceChannelId)
                        throw new MusicError(409, "Music moved to another voice channel; try again")
                    state.value.voiceChannelId = access.voiceChannelId
                    state.value.textChannelId = actor.textChannelId
                    state.value.queue.push(...(normalized as MusicTrack[]))
                    if (!state.value.current) {
                        state.value.current = state.value.queue.shift()!
                        state.value.status = "playing"
                        state.value.positionMs = 0
                        state.value.durationMs = state.value.current.durationMs
                        state.value.playbackUrl = null
                    }
                    this.publish(state)
                    if (state.value.status === "playing") this.ensureTrack(state)
                })
                return this.snapshot(actor.guildId)
            }
            await this.mutate(state, async () => {
                signal.throwIfAborted()
                checkRevision()
                const value = state.value
                switch (action.type) {
                    case "pause":
                        if (!value.current) throw new MusicError(404, "Nothing is playing")
                        await state.transport?.pause()
                        value.positionMs = this.snapshot(actor.guildId).positionMs
                        value.status = "paused"
                        break
                    case "resume":
                        if (!value.current) throw new MusicError(404, "Nothing to resume")
                        value.voiceChannelId = access.voiceChannelId ?? value.voiceChannelId
                        value.status = "playing"
                        if (state.runner) await state.transport?.resume()
                        else this.ensureTrack(state)
                        break
                    case "skip":
                        if (!value.current) throw new MusicError(404, "Nothing is playing")
                        await this.advance(state, "skip")
                        return
                    case "seek":
                        if (!value.current) throw new MusicError(404, "Nothing is playing")
                        if (
                            value.current.isStream ||
                            !state.seekable ||
                            (value.durationMs > 0 && action.positionMs > value.durationMs)
                        )
                            throw new MusicError(400, "This track cannot seek to that position")
                        await this.stopTrack(state)
                        value.positionMs = action.positionMs
                        this.ensureTrack(state)
                        break
                    case "volume":
                        value.volume = action.percent
                        state.transport?.setVolume(action.percent)
                        break
                    case "loop":
                        value.repeatMode = action.mode
                        break
                    case "clear":
                        value.queue = []
                        break
                    case "remove":
                    case "move": {
                        const index = value.queue.findIndex(
                            (track) => track.entryId === action.entryId
                        )
                        if (index < 0) throw new MusicError(404, "Queue entry not found")
                        if (action.type === "move" && action.toIndex >= value.queue.length)
                            throw new MusicError(400, "Queue position is out of range")
                        const [track] = value.queue.splice(index, 1)
                        if (action.type === "move") value.queue.splice(action.toIndex, 0, track)
                        break
                    }
                    case "shuffle":
                        for (let index = value.queue.length - 1; index > 0; index--) {
                            const other = Math.floor(
                                (this.dependencies.random ?? Math.random)() * (index + 1)
                            )
                            ;[value.queue[index], value.queue[other]] = [
                                value.queue[other],
                                value.queue[index],
                            ]
                        }
                        break
                }
                this.publish(state)
            })
            return this.snapshot(actor.guildId)
        } finally {
            release()
            stopped()
            state.requests--
            if (state.requests === 0 && state.value.revision === 0 && !state.transport)
                this.states.delete(actor.guildId)
        }
    }

    /** Restoring never opens voice or resolves audio; the next resume must pass current access checks. */
    restore(row: {
        guildId: string
        voiceChannelId: string
        textChannelId: string | null
        snapshot: MusicSessionSnapshotV2
    }): void {
        const state = this.state(row.guildId),
            data = row.snapshot
        state.value = {
            ...empty(row.guildId),
            voiceChannelId: row.voiceChannelId,
            textChannelId: row.textChannelId,
            current: data.current ? { ...data.current } : null,
            queue: data.queue.map((track) => ({ ...track })),
            volume: data.volume,
            repeatMode: data.repeatMode,
            positionMs: data.positionMs,
            durationMs: data.current?.durationMs ?? 0,
            status: data.current ? "paused" : "idle",
        }
        this.publish(state)
    }
    async onPlatformChange(guildId: string): Promise<void> {
        const state = this.states.get(guildId)
        if (!state?.value.connected || !state.value.voiceChannelId) return
        try {
            if (this.dependencies.voice.channelId(guildId) !== state.value.voiceChannelId)
                throw new Error()
            await this.dependencies.verifyBotAccess(guildId, state.value.voiceChannelId)
        } catch {
            await this.suspend(state)
            return
        }
        if (this.dependencies.hasListeners(guildId, state.value.voiceChannelId)) {
            state.cancelEmpty?.()
            state.cancelEmpty = undefined
        } else if (!state.cancelEmpty) {
            state.cancelEmpty = this.schedule(() => {
                state.cancelEmpty = undefined
                void this.suspend(state).catch(() => this.report("Music idle cleanup failed"))
            }, this.emptyTimeout)
        }
    }
    async shutdown(): Promise<void> {
        this.closed = true
        await Promise.all([...this.states.values()].map((state) => this.suspend(state)))
    }

    private state(guildId: string): GuildMusic {
        let state = this.states.get(guildId)
        if (!state) {
            if (this.states.size >= 2500)
                throw new MusicError(503, "Music session capacity reached")
            state = {
                value: empty(guildId),
                generation: new AbortController(),
                mutations: Promise.resolve(),
                searchTail: Promise.resolve(),
                barrier: Promise.resolve(),
                handedOff: false,
                seekable: false,
                requests: 0,
            }
            this.states.set(guildId, state)
        }
        return state
    }
    /**
     * Picks the access check for an action. A connected Bot needs `control` in its channel; a
     * joining or suspended session is bound to its stored channel, so acting on it needs voice
     * presence there (`queue`). Only an idle, sessionless guild falls back to `view`.
     */
    private accessFor(
        state: GuildMusic,
        action: MusicAction
    ): ["view" | "queue" | "control", string | undefined] {
        const value = state.value
        const botChannel = this.dependencies.voice.channelId(value.guildId)
        const joining = !!state.runner && !value.connected
        const stored = value.voiceChannelId ?? undefined
        if (action.type === "play" || action.type === "enqueue")
            return ["queue", !botChannel && joining ? stored : action.voiceChannelId]
        if (action.type === "resume" && !value.connected)
            return ["queue", joining ? stored : undefined]
        if (botChannel) return ["control", undefined]
        if (stored && (value.current || value.queue.length)) return ["queue", stored]
        return ["view", undefined]
    }
    private validate(action: MusicAction): void {
        const known = [
            "play",
            "enqueue",
            "pause",
            "resume",
            "skip",
            "stop",
            "leave",
            "clear",
            "shuffle",
            "remove",
            "move",
            "seek",
            "volume",
            "loop",
        ]
        if (!action || !known.includes(action.type))
            throw new MusicError(400, "Unknown music action")
        if (
            action.type === "play" &&
            (typeof action.query !== "string" || !action.query.trim() || action.query.length > 2048)
        )
            throw new MusicError(400, "Enter a music query or URL")
        if (
            action.type === "enqueue" &&
            (!Array.isArray(action.tracks) || !action.tracks.length || action.tracks.length > 1000)
        )
            throw new MusicError(400, "Choose 1–1000 tracks")
        if (
            action.type === "volume" &&
            (!Number.isFinite(action.percent) || action.percent < 0 || action.percent > 100)
        )
            throw new MusicError(400, "Volume must be 0–100")
        if (
            action.type === "seek" &&
            (!Number.isFinite(action.positionMs) || action.positionMs < 0)
        )
            throw new MusicError(400, "Invalid seek position")
        if (action.type === "loop" && !["off", "track", "queue"].includes(action.mode))
            throw new MusicError(400, "Loop must be off, track or queue")
        if (
            (action.type === "move" || action.type === "remove") &&
            (typeof action.entryId !== "string" || !action.entryId)
        )
            throw new MusicError(400, "Invalid queue entry")
        if (action.type === "move" && (!Number.isInteger(action.toIndex) || action.toIndex < 0))
            throw new MusicError(400, "Invalid queue position")
    }
    private mutate<T>(state: GuildMusic, work: () => T | Promise<T>): Promise<T> {
        const result = state.mutations.then(work)
        state.mutations = result.catch(() => undefined)
        return result
    }
    private publish(state: GuildMusic): void {
        state.value.revision++
        const snapshot = this.snapshot(state.value.guildId)
        for (const listener of this.listeners) {
            try {
                listener(snapshot)
            } catch {
                this.report("Music subscriber failed")
            }
        }
    }
    private report(message: string): void {
        this.dependencies.onError?.(new Error(message))
    }
    private cancel(state: GuildMusic): void {
        state.generation.abort()
        state.generation = new AbortController()
        state.searchTail = Promise.resolve()
        state.trackController?.abort()
        state.cancelEmpty?.()
        state.cancelEmpty = undefined
    }
    private async stopTrack(state: GuildMusic): Promise<void> {
        state.trackController?.abort()
        try {
            await state.transport?.stop()
        } catch {
            this.report("Music track cleanup failed")
        } finally {
            state.runner = undefined
            state.trackController = undefined
            state.handedOff = false
            state.seekable = false
        }
    }
    private async disconnect(state: GuildMusic): Promise<void> {
        try {
            await state.transport?.disconnect()
        } catch {
            this.report("Music transport cleanup failed")
        } finally {
            try {
                await this.dependencies.voice.leave(state.value.guildId)
            } catch {
                this.report("Voice leave could not be sent")
            } finally {
                state.transport = undefined
                state.value.connected = false
            }
        }
    }
    private async suspend(state: GuildMusic): Promise<void> {
        const position = this.snapshot(state.value.guildId).positionMs
        this.cancel(state)
        await this.mutate(state, async () => {
            await this.stopTrack(state)
            await this.disconnect(state)
            state.value.positionMs = position
            state.value.status = state.value.current ? "paused" : "idle"
            this.publish(state)
        })
    }
    private async advance(state: GuildMusic, reason: "end" | "skip" | "error"): Promise<void> {
        const current = state.value.current
        const suspended = !state.value.connected && !state.runner
        await this.stopTrack(state)
        if (
            current &&
            reason !== "error" &&
            (state.value.repeatMode === "queue" ||
                (reason === "end" && state.value.repeatMode === "track"))
        ) {
            if (state.value.repeatMode === "track" && reason === "end")
                state.value.queue.unshift(current)
            else state.value.queue.push(current)
        }
        state.value.current = state.value.queue.shift() ?? null
        state.value.positionMs = 0
        state.value.durationMs = state.value.current?.durationMs ?? 0
        state.value.playbackUrl = null
        // A suspended or restored session stays paused: only an authorized resume reopens voice.
        state.value.status = !state.value.current ? "idle" : suspended ? "paused" : "playing"
        if (reason === "error")
            state.value.lastError = "A track could not be played and was skipped"
        this.publish(state)
        if (!suspended) this.ensureTrack(state)
    }
    /**
     * Joins voice and connects the transport under the session generation, not one track, so a
     * skip mid-connect hands the connection to the next track instead of stranding the join.
     */
    private connect(state: GuildMusic, transport: MusicTransport): Promise<void> {
        const signal = state.generation.signal
        const work = (async () => {
            const grant = await abortable(
                this.dependencies.voice.join(
                    state.value.guildId,
                    state.value.voiceChannelId!,
                    signal
                ),
                signal
            )
            await abortable(transport.connect(grant, signal), signal)
            state.value.connected = true
        })()
        const settled = work.finally(() => {
            if (state.connecting === settled) state.connecting = undefined
        })
        return settled
    }
    private ensureTrack(state: GuildMusic): void {
        if (state.runner || !state.value.current || !state.value.voiceChannelId || this.closed)
            return
        const controller = new AbortController(),
            signal = AbortSignal.any([controller.signal, state.generation.signal])
        state.trackController = controller
        const track = state.value.current
        state.transport ??= this.dependencies.transportFactory(state.value.guildId)
        const transport = state.transport
        let verified = false,
            prepared: PreparedSource | undefined,
            handedOff = false
        const current = () =>
            !signal.aborted &&
            state.trackController === controller &&
            state.value.current?.entryId === track.entryId
        const run = async () => {
            try {
                if (!state.value.connected) {
                    state.connecting ??= this.connect(state, transport)
                    await abortable(state.connecting, signal)
                    if (!current()) return
                }
                await abortable(
                    this.dependencies.verifyBotAccess(
                        state.value.guildId,
                        state.value.voiceChannelId!
                    ),
                    signal
                )
                verified = true
                const preparing = this.dependencies.resolver.prepare(track, signal)
                void preparing
                    .then((source) => {
                        if (signal.aborted && !handedOff) return source.close()
                    })
                    .catch(() => {})
                prepared = await abortable(preparing, signal)
                if (!current()) return
                state.seekable = prepared.seekable
                if (prepared.durationMs !== null && prepared.durationMs > 0) {
                    track.durationMs = prepared.durationMs
                    track.isStream = false
                }
                state.value.durationMs = track.durationMs
                state.value.playbackUrl = prepared.playbackUrl
                const offset = prepared.seekable ? state.value.positionMs : 0
                state.value.positionMs = offset
                transport.setVolume(state.value.volume)
                if (state.value.status === "paused") await transport.pause()
                if (!current()) return
                state.value.lastError = null
                this.publish(state)
                handedOff = true
                state.handedOff = true
                await transport.play(prepared, offset, signal)
                if (current())
                    await this.mutate(state, async () => {
                        if (current()) await this.advance(state, "end")
                    })
            } catch (error) {
                if (!current()) return
                this.report(
                    verified ? "Music track playback failed" : "Music voice connection failed"
                )
                if (!verified || error instanceof MusicTransportDisconnectedError) {
                    state.value.lastError = "Voice connection unavailable; resume to retry"
                    await this.suspend(state)
                } else
                    await this.mutate(state, async () => {
                        if (current()) await this.advance(state, "error")
                    })
            } finally {
                if (prepared && !handedOff) await prepared.close().catch(() => {})
                if (state.trackController === controller) {
                    state.runner = undefined
                    state.trackController = undefined
                }
            }
        }
        state.runner = run().catch(() => this.report("Music session recovery failed"))
    }
}
