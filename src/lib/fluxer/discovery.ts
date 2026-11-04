export interface FluxerEndpoints {
    api: string
    gateway: string
    cdn: string
    media: string
    webapp: string
}

function endpoint(value: unknown, protocols: readonly string[]): string {
    if (typeof value !== "string") throw new Error("Invalid Fluxer discovery endpoint")
    try {
        const url = new URL(value)
        if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) {
            throw new Error()
        }
        return url.href.replace(/\/$/, "")
    } catch {
        throw new Error("Invalid Fluxer discovery endpoint")
    }
}

/** Discover the bot-facing public API; never attach credentials to discovery requests. */
export async function discoverFluxer(
    origin: string,
    fetchImpl: typeof fetch = fetch,
    signal?: AbortSignal
): Promise<FluxerEndpoints> {
    const signals = [AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]
    let response: Response
    try {
        response = await fetchImpl(new URL("/.well-known/fluxer", origin), {
            redirect: "error",
            signal: AbortSignal.any(signals),
        })
    } catch {
        signal?.throwIfAborted()
        throw new Error("Fluxer discovery request failed")
    }
    if (!response.ok) throw new Error(`Fluxer discovery failed (HTTP ${response.status})`)
    let document: unknown
    try {
        document = await response.json()
    } catch {
        throw new Error("Invalid Fluxer discovery JSON")
    }
    if (!document || typeof document !== "object" || !("endpoints" in document)) {
        throw new Error("Invalid Fluxer discovery document")
    }
    const fields = document.endpoints
    if (!fields || typeof fields !== "object") throw new Error("Invalid Fluxer discovery endpoints")
    const data = fields as Record<string, unknown>
    const http = ["http:", "https:"]
    const api = endpoint(data.api_public ?? data.api, http)
    if (new URL(api).search) throw new Error("Invalid Fluxer discovery API query")
    return {
        api: /\/v1$/.test(api) ? api : `${api}/v1`,
        gateway: endpoint(data.gateway, ["ws:", "wss:"]),
        cdn: endpoint(data.static_cdn, http),
        media: endpoint(data.media, http),
        webapp: endpoint(data.webapp, http),
    }
}
