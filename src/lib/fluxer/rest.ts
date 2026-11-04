import { setTimeout as delay } from "node:timers/promises"

/** Only status is exposed; upstream bodies and request credentials are deliberately omitted. */
export class FluxerRestError extends Error {
    constructor(readonly status: number) {
        super(`Fluxer API request failed (HTTP ${status})`)
        this.name = "FluxerRestError"
    }
}

interface RestDependencies {
    fetchImpl?: typeof fetch
    now?: () => number
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function seconds(value: unknown): number | null {
    if (typeof value !== "string" && typeof value !== "number") return null
    if (value === "") return null
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? number * 1000 : null
}

/** Serializes bot requests and honors route/global cooldowns without replaying ambiguous writes. */
export class FluxerRest {
    private readonly fetchImpl: typeof fetch
    private readonly now: () => number
    private readonly sleep: NonNullable<RestDependencies["sleep"]>
    private tail: Promise<unknown> = Promise.resolve()
    private globalReadyAt = 0
    private readonly routeBuckets = new Map<string, string>()
    private readonly readyAt = new Map<string, number>()

    constructor(
        private readonly api: string,
        private readonly token: string,
        dependencies: RestDependencies = {}
    ) {
        const url = new URL(api)
        if (
            !/^(https?):$/.test(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
        ) {
            throw new Error("Invalid Fluxer API endpoint")
        }
        this.api = api.replace(/\/$/, "")
        this.fetchImpl = dependencies.fetchImpl ?? fetch
        this.now = dependencies.now ?? Date.now
        this.sleep =
            dependencies.sleep ??
            (async (ms, signal) => {
                await delay(ms, undefined, { signal })
            })
    }

    request<T>(
        method: string,
        path: string,
        options: { body?: unknown; signal?: AbortSignal } = {}
    ): Promise<T> {
        const execute = async () => this.perform<T>(method.toUpperCase(), path, options)
        const result = this.tail.then(execute)
        this.tail = result.catch(() => undefined)
        return result
    }

    private async perform<T>(
        method: string,
        path: string,
        options: { body?: unknown; signal?: AbortSignal }
    ): Promise<T> {
        const signal = options.signal
        signal?.throwIfAborted()
        if (!path.startsWith("/") || path.startsWith("//") || /[\\?#]/.test(path)) {
            throw new Error("Invalid Fluxer API path")
        }
        const url = new URL(`${this.api}${path}`)
        if (!url.href.startsWith(`${this.api}/`)) throw new Error("Invalid Fluxer API path")
        const decoded = decodeURIComponent(path)
        if (decoded.split("/").some((part) => part === "." || part === ".."))
            throw new Error("Invalid Fluxer API path")
        const route = `${method} ${path}`
        for (let attempt = 0; attempt < 3; attempt++) {
            signal?.throwIfAborted()
            const bucket = this.routeBuckets.get(route) ?? route
            const waitMs = Math.max(this.globalReadyAt, this.readyAt.get(bucket) ?? 0) - this.now()
            if (waitMs > 0) await this.sleep(waitMs, signal)
            signal?.throwIfAborted()
            this.globalReadyAt = this.now() + 20
            let response: Response
            try {
                response = await this.fetchImpl(url, {
                    method,
                    redirect: "error",
                    signal: AbortSignal.any([
                        AbortSignal.timeout(10_000),
                        ...(signal ? [signal] : []),
                    ]),
                    headers: {
                        Authorization: `Bot ${this.token}`,
                        ...(options.body === undefined
                            ? {}
                            : { "Content-Type": "application/json" }),
                    },
                    body: options.body === undefined ? undefined : JSON.stringify(options.body),
                })
            } catch {
                signal?.throwIfAborted()
                throw new Error("Fluxer API connection failed")
            }
            const serverBucket = response.headers.get("X-RateLimit-Bucket")
            const actualBucket = serverBucket ?? bucket
            if (serverBucket) this.routeBuckets.set(route, serverBucket)
            if (response.headers.get("X-RateLimit-Remaining") === "0") {
                this.readyAt.set(
                    actualBucket,
                    this.now() + (seconds(response.headers.get("X-RateLimit-Reset-After")) ?? 1000)
                )
            }
            // Bound bookkeeping even when channel IDs or paths are numerous.
            if (this.routeBuckets.size > 1000)
                this.routeBuckets.delete(this.routeBuckets.keys().next().value)
            if (this.readyAt.size > 1000) this.readyAt.delete(this.readyAt.keys().next().value)
            if (response.status === 429) {
                const payload: unknown = await response.json().catch(() => null)
                const data =
                    payload && typeof payload === "object"
                        ? (payload as Record<string, unknown>)
                        : {}
                const retryMs =
                    seconds(data.retry_after) ??
                    seconds(response.headers.get("Retry-After")) ??
                    1000
                const until = this.now() + Math.max(1, retryMs)
                if (data.global === true || response.headers.get("X-RateLimit-Global") === "true")
                    this.globalReadyAt = until
                else this.readyAt.set(actualBucket, until)
                if (attempt < 2) continue
            }
            if (!response.ok) throw new FluxerRestError(response.status)
            if (response.status === 204) return undefined as T
            try {
                return (await response.json()) as T
            } catch {
                throw new Error("Invalid Fluxer API JSON response")
            }
        }
        throw new FluxerRestError(429)
    }
}
