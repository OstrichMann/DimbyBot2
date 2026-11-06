import { lookup } from "node:dns/promises"
import http from "node:http"
import https from "node:https"
import { isIP } from "node:net"
import { isBlockedUserMediaUrl } from "../../util/userMediaUrl.js"

export interface MediaAddress {
    address: string
    family: number
}
export interface MediaResponse {
    status: number
    headers: Headers
    body: AsyncIterable<Uint8Array>
    close(): void
}
interface MediaDependencies {
    lookup?: (hostname: string) => Promise<MediaAddress[]>
    request?: (url: URL, address: MediaAddress, signal: AbortSignal) => Promise<MediaResponse>
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

function pinnedRequest(
    url: URL,
    address: MediaAddress,
    signal: AbortSignal
): Promise<MediaResponse> {
    return new Promise((resolve, reject) => {
        const request = (url.protocol === "https:" ? https : http).request(url, {
            method: "GET",
            signal,
            agent: false,
            lookup: (_host, options, callback) => {
                callback(null, options.all ? [address] : address.address, address.family)
            },
            headers: {
                "User-Agent": "DimbyBot-Fluxer",
                Accept: "audio/*, video/*, application/octet-stream",
            },
        })
        const timer = setTimeout(
            () => request.destroy(new Error("Media headers timed out")),
            10_000
        )
        request.on("error", (error) => {
            clearTimeout(timer)
            reject(error)
        })
        request.on("response", (response) => {
            clearTimeout(timer)
            const headers = new Headers()
            for (const [name, value] of Object.entries(response.headers))
                if (value !== undefined)
                    headers.set(name, Array.isArray(value) ? value.join(", ") : value)
            resolve({
                status: response.statusCode ?? 0,
                headers,
                body: response,
                close: () => {
                    response.destroy()
                    request.destroy()
                },
            })
        })
        request.end()
    })
}

/** Validates every DNS answer and pins one to the actual socket; each redirect starts validation anew. */
export class PublicMediaFetcher {
    private readonly dependencies: Required<MediaDependencies>
    constructor(dependencies: MediaDependencies = {}) {
        this.dependencies = {
            lookup: (hostname) => lookup(hostname, { all: true }),
            request: pinnedRequest,
            ...dependencies,
        }
    }
    async open(input: string, signal: AbortSignal): Promise<MediaResponse> {
        try {
            let url = new URL(input)
            for (let hop = 0; hop <= 5; hop++) {
                signal.throwIfAborted()
                if (
                    !["http:", "https:"].includes(url.protocol) ||
                    url.username ||
                    url.password ||
                    isBlockedUserMediaUrl(url.href)
                )
                    throw new Error("That URL isn't allowed")
                const hostname = url.hostname.replace(/^\[|\]$/g, "")
                const addresses = isIP(hostname)
                    ? [{ address: hostname, family: isIP(hostname) }]
                    : await abortable(
                          this.dependencies.lookup(hostname),
                          AbortSignal.any([signal, AbortSignal.timeout(10_000)])
                      )
                signal.throwIfAborted()
                if (
                    !addresses.length ||
                    addresses.some(
                        ({ address, family }) =>
                            !isIP(address) ||
                            isIP(address) !== family ||
                            isBlockedUserMediaUrl(
                                `http://${family === 6 ? `[${address}]` : address}/`
                            )
                    )
                )
                    throw new Error("That URL isn't allowed")
                const response = await this.dependencies.request(url, addresses[0], signal)
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    const location = response.headers.get("location")
                    response.close()
                    if (!location || hop === 5) throw new Error("Media redirect limit reached")
                    url = new URL(location, url)
                    continue
                }
                if (response.status < 200 || response.status >= 300) {
                    response.close()
                    throw new Error("Media source unavailable")
                }
                return response
            }
            throw new Error("Media redirect limit reached")
        } catch (error) {
            signal.throwIfAborted()
            if (
                error instanceof Error &&
                ["That URL isn't allowed", "Media redirect limit reached"].includes(error.message)
            )
                throw error
            // eslint-disable-next-line preserve-caught-error -- Upstream causes may contain private URLs or credentials.
            throw new Error("Media source unavailable")
        }
    }
}
