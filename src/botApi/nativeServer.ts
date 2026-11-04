import http from "node:http"
import { WebSocketServer } from "ws"
import { createNativeBotApiApp } from "./nativeApp.js"
import type { MusicHttpDependencies } from "./musicHttp.js"
import { incomingMessageToHeaders } from "./httpUtil.js"
import { NativeMusicConnections } from "../shared/websocket/NativeMusicConnections.js"
import { authorizeFluxerUpgrade } from "../shared/websocket/fluxerUpgrade.js"
import {
    requireFluxerActor,
    FluxerSessionError,
    type AuthenticatedActor,
} from "../shared/fluxer-session.js"
import {
    isPrivateLanOrLoopbackPeer,
    shouldEnforceBotApiPrivateClientIp,
} from "../util/botApiPrivatePeer.js"

interface ServerDependencies {
    dashboardOrigin: string
    ready(): boolean
    music: MusicHttpDependencies
    authenticate?: (headers: Headers) => Promise<AuthenticatedActor>
    onAccessChange?: (callback: (guildId: string) => void) => () => void
}

/** Keeps health independent of Gateway readiness and authenticates before accepting a WebSocket. */
export function createNativeServer(dependencies: ServerDependencies) {
    const authenticate = dependencies.authenticate ?? requireFluxerActor
    const app = createNativeBotApiApp(
        dependencies.music,
        dependencies.dashboardOrigin,
        authenticate
    )
    const connections = new NativeMusicConnections({
        music: dependencies.music.music,
        authenticate,
        authorize: async (actor, guildId) => {
            await dependencies.music.access.authorizeMusic(
                { userId: actor.userId, guildId },
                "view"
            )
            return dependencies.music.viewer(guildId, actor.userId)
        },
    })
    const invalidate = dependencies.onAccessChange?.((guildId) => connections.invalidate(guildId))
    let closing = false
    const permitted = (request: http.IncomingMessage) =>
        !shouldEnforceBotApiPrivateClientIp() ||
        isPrivateLanOrLoopbackPeer(request.socket.remoteAddress)
    const server = http.createServer((req, res) => {
        if (!permitted(req)) {
            res.writeHead(403).end()
            return
        }
        const pathname = new URL(req.url ?? "/", "http://bot.internal").pathname
        if (pathname === "/health" || pathname === "/ready") {
            const ready = dependencies.ready() && !closing
            res.writeHead(pathname === "/ready" && !ready ? 503 : 200, {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            }).end(
                JSON.stringify({ ok: pathname === "/health" || ready, ready, platform: "fluxer" })
            )
            return
        }
        if (closing || !dependencies.ready()) {
            res.writeHead(503, { "Content-Type": "application/json" }).end(
                JSON.stringify({ ok: false, error: { error: "Bot is reconnecting" } })
            )
            return
        }
        app(req, res)
    })
    server.maxConnections = 1024
    server.maxHeadersCount = 64
    server.headersTimeout = 10000
    server.requestTimeout = 15000
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
    server.on("upgrade", (request, socket, head) => {
        void (async () => {
            try {
                if (
                    !permitted(request) ||
                    new URL(request.url ?? "/", "http://bot.internal").pathname !== "/ws"
                )
                    throw new FluxerSessionError(403, "Forbidden")
                if (closing || !dependencies.ready()) {
                    socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
                    return
                }
                const headers = incomingMessageToHeaders(request)
                const actor = await authorizeFluxerUpgrade(
                    headers,
                    dependencies.dashboardOrigin,
                    authenticate
                )
                if (closing || socket.destroyed) {
                    socket.destroy()
                    return
                }
                wss.handleUpgrade(request, socket, head, (websocket) => {
                    void connections
                        .add(websocket, headers, actor)
                        .catch(() => websocket.close(1008, "Session unavailable"))
                })
            } catch (error) {
                const status = error instanceof FluxerSessionError ? error.status : 503
                socket.end(
                    `HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable"}\r\nConnection: close\r\n\r\n`
                )
            }
        })()
    })
    async function close(): Promise<void> {
        if (closing) return
        closing = true
        invalidate?.()
        connections.stop()
        for (const websocket of wss.clients) websocket.terminate()
        await new Promise<void>((resolve) => wss.close(() => resolve()))
        if (server.listening) {
            const closed = new Promise<void>((resolve) => server.close(() => resolve()))
            server.closeAllConnections()
            await closed
        }
    }
    return { server, connections, close }
}
