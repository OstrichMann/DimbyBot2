import WebSocket from "ws"

export interface FluxerDispatch {
    t: string
    d: unknown
    s?: number
}
export interface FluxerSocket {
    readonly readyState: number
    send(value: string): void
    close(code?: number): void
    on(event: string, listener: (...args: unknown[]) => void): unknown
}
interface GatewayDependencies {
    socketFactory?: (url: string) => FluxerSocket
    schedule?: (callback: () => void, ms: number) => () => void
    now?: () => number
    random?: () => number
    /** Accept/enqueue work promptly; never await music completion in this callback. */
    onDispatch: (event: FluxerDispatch) => Promise<void>
    onError?: (error: Error) => void
}

/** Native protocol-v1 connection with accepted-sequence resume and bounded replay deduplication. */
export class FluxerGateway {
    private readonly dependencies: Required<GatewayDependencies>
    private socket: FluxerSocket | undefined
    private stopped = true
    private authenticated = false
    private resuming = false
    private sessionId: string | undefined
    private sequence: number | null = null
    private disconnectedAt = 0
    private epoch = 0
    private backoff = 0
    private ackPending = false
    private cancelHeartbeat: (() => void) | undefined
    private cancelReconnect: (() => void) | undefined
    private cancelStartup: (() => void) | undefined
    private dispatchTail: Promise<void> = Promise.resolve()
    private readonly seenMessages = new Map<string, number>()
    private started: Promise<void> | undefined
    private resolveStart: (() => void) | undefined
    private rejectStart: ((error: Error) => void) | undefined

    constructor(
        private readonly endpoint: string,
        private readonly token: string,
        dependencies: GatewayDependencies
    ) {
        this.dependencies = {
            socketFactory: (url) => new WebSocket(url),
            schedule: (callback, ms) => {
                const timer = setTimeout(callback, ms)
                return () => clearTimeout(timer)
            },
            now: Date.now,
            random: Math.random,
            onError: () => {},
            ...dependencies,
        }
    }

    get ready(): boolean {
        return this.authenticated && !this.stopped
    }

    start(): Promise<void> {
        if (this.started && !this.stopped) return this.started
        this.stopped = false
        this.started = new Promise<void>((resolve, reject) => {
            this.resolveStart = resolve
            this.rejectStart = reject
        })
        this.cancelStartup = this.dependencies.schedule(() => {
            this.fail(new Error("Fluxer Gateway startup timed out"))
        }, 30_000)
        this.connect()
        return this.started
    }

    send(op: number, data: unknown): void {
        if (
            !this.socket ||
            this.socket.readyState !== 1 ||
            this.stopped ||
            (!this.authenticated && ![1, 2, 6].includes(op))
        ) {
            throw new Error("Fluxer Gateway is not ready")
        }
        this.socket.send(JSON.stringify({ op, d: data }))
    }

    async stop(): Promise<void> {
        this.stopped = true
        this.authenticated = false
        this.resuming = false
        this.epoch++
        this.cancelHeartbeat?.()
        this.cancelReconnect?.()
        this.cancelStartup?.()
        this.socket?.close(1000)
        this.socket = undefined
        this.rejectStart?.(new Error("Fluxer Gateway stopped"))
        this.rejectStart = undefined
        this.resolveStart = undefined
        // Accepted work must not be stranded, but application execution is owned by its dispatcher.
        await this.dispatchTail
    }

    private connect(): void {
        if (this.stopped) return
        const epoch = ++this.epoch
        this.authenticated = false
        this.resuming = false
        this.ackPending = false
        this.dispatchTail = Promise.resolve()
        const url = new URL(this.endpoint)
        url.searchParams.set("v", "1")
        url.searchParams.set("encoding", "json")
        url.searchParams.delete("compress")
        url.searchParams.delete("stream")
        let socket: FluxerSocket
        try {
            socket = this.dependencies.socketFactory(url.href)
        } catch {
            this.reconnect()
            return
        }
        this.socket = socket
        socket.on("message", (raw) => {
            if (this.stopped || epoch !== this.epoch) return
            let packet: unknown
            try {
                packet = JSON.parse(String(raw))
            } catch {
                this.invalidPacket()
                return
            }
            if (
                !packet ||
                typeof packet !== "object" ||
                !("op" in packet) ||
                !Number.isInteger(packet.op)
            ) {
                this.invalidPacket()
                return
            }
            this.receive(packet as Record<string, unknown>, epoch)
        })
        socket.on("error", () => {
            if (epoch === this.epoch && !this.stopped) {
                this.dependencies.onError(new Error("Fluxer Gateway connection failed"))
                this.reconnect()
            }
        })
        socket.on("close", (code) => {
            if (this.stopped || epoch !== this.epoch) return
            if ([4004, 4010, 4011, 4012].includes(Number(code))) {
                this.fail(
                    new Error(
                        Number(code) === 4004
                            ? "Fluxer Gateway authentication failed"
                            : "Fluxer Gateway configuration rejected"
                    )
                )
            } else this.reconnect()
        })
    }

    private receive(packet: Record<string, unknown>, epoch: number): void {
        const data =
            packet.d && typeof packet.d === "object" ? (packet.d as Record<string, unknown>) : {}
        switch (packet.op) {
            case 10: {
                const interval = data.heartbeat_interval
                if (
                    typeof interval !== "number" ||
                    !Number.isFinite(interval) ||
                    interval < 100 ||
                    interval > 300_000
                ) {
                    this.invalidPacket()
                    return
                }
                this.cancelHeartbeat?.()
                const tick = () => {
                    if (this.stopped || epoch !== this.epoch) return
                    if (this.ackPending) {
                        this.reconnect()
                        return
                    }
                    this.heartbeat()
                    this.cancelHeartbeat = this.dependencies.schedule(tick, interval)
                }
                this.cancelHeartbeat = this.dependencies.schedule(tick, interval)
                if (this.sessionId && this.dependencies.now() - this.disconnectedAt <= 60_000) {
                    this.resuming = true
                    this.send(6, {
                        token: this.token,
                        session_id: this.sessionId,
                        seq: this.sequence,
                    })
                } else {
                    this.sessionId = undefined
                    this.sequence = null
                    this.send(2, {
                        token: this.token,
                        properties: {
                            os: process.platform,
                            browser: "DimbyBot Fluxer",
                            device: "bot",
                        },
                    })
                }
                return
            }
            case 1:
                this.heartbeat()
                return
            case 11:
                this.ackPending = false
                return
            case 7:
                this.reconnect()
                return
            case 9:
                this.sessionId = undefined
                this.sequence = null
                this.reconnect()
                return
            case 0: {
                if (
                    typeof packet.t !== "string" ||
                    !Number.isSafeInteger(packet.s) ||
                    Number(packet.s) < 0
                ) {
                    this.invalidPacket()
                    return
                }
                const event: FluxerDispatch = { t: packet.t, d: packet.d, s: Number(packet.s) }
                this.dispatchTail = this.dispatchTail.then(async () => {
                    if (this.stopped || epoch !== this.epoch) return
                    if (event.t === "READY") {
                        if (typeof data.session_id !== "string" || !data.session_id) {
                            this.invalidPacket()
                            return
                        }
                        this.sessionId = data.session_id
                    }
                    if (
                        event.t !== "READY" &&
                        event.t !== "RESUMED" &&
                        !this.authenticated &&
                        !this.resuming
                    )
                        return
                    const now = this.dependencies.now()
                    for (const [key, expires] of this.seenMessages) {
                        if (expires <= now) this.seenMessages.delete(key)
                    }
                    const messageId =
                        event.t === "MESSAGE_CREATE" && typeof data.id === "string"
                            ? data.id
                            : undefined
                    const duplicate = messageId && this.seenMessages.has(messageId)
                    if (messageId && !duplicate) {
                        this.seenMessages.set(messageId, now + 600_000)
                        if (this.seenMessages.size > 10_000)
                            this.seenMessages.delete(this.seenMessages.keys().next().value)
                    }
                    if (!duplicate) {
                        try {
                            await this.dependencies.onDispatch(event)
                        } catch {
                            this.dependencies.onError(new Error("Fluxer dispatch handler failed"))
                        }
                    }
                    if (this.stopped || epoch !== this.epoch) return
                    this.sequence = event.s!
                    if (event.t === "READY" || event.t === "RESUMED") {
                        this.authenticated = true
                        this.backoff = 0
                        this.resuming = false
                        this.cancelStartup?.()
                        this.resolveStart?.()
                        this.resolveStart = undefined
                        this.rejectStart = undefined
                    }
                })
                return
            }
        }
    }

    private heartbeat(): void {
        this.send(1, this.sequence)
        this.ackPending = true
    }
    private invalidPacket(): void {
        this.dependencies.onError(new Error("Malformed Fluxer Gateway packet"))
        this.reconnect()
    }
    private fail(error: Error): void {
        this.dependencies.onError(error)
        this.rejectStart?.(error)
        this.rejectStart = undefined
        this.resolveStart = undefined
        this.stopped = true
        this.authenticated = false
        this.epoch++
        this.cancelHeartbeat?.()
        this.cancelReconnect?.()
        this.cancelStartup?.()
        this.socket?.close(1000)
    }
    private reconnect(): void {
        if (this.stopped) return
        this.epoch++
        this.authenticated = false
        this.disconnectedAt = this.dependencies.now()
        this.cancelHeartbeat?.()
        this.cancelReconnect?.()
        this.socket?.close(1000)
        this.socket = undefined
        const wait =
            Math.min(30_000, 1000 * 2 ** Math.min(this.backoff++, 5)) +
            Math.floor(this.dependencies.random() * 250)
        this.cancelReconnect = this.dependencies.schedule(() => this.connect(), wait)
    }
}
