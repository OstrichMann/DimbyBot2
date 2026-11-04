import assert from "node:assert/strict"
import { test } from "node:test"
import WebSocket from "ws"
import { createNativeServer } from "../../src/botApi/nativeServer.js"
import { musicServiceHarness } from "../test-support/musicServiceFakes.js"
import { FluxerSessionError } from "../../src/shared/fluxer-session.js"

test("native health stays live through readiness failure; API and upgrade reject unauthorized requests", async () => {
    const h = musicServiceHarness()
    let ready = true,
        authorized = false,
        slowAuth = false,
        authReads = 0
    const runtime = createNativeServer({
        dashboardOrigin: "http://localhost:3000",
        ready: () => ready,
        authenticate: async () => {
            if (!authorized) throw new FluxerSessionError(401, "Sign in")
            if (slowAuth && ++authReads > 1) await new Promise((resolve) => setTimeout(resolve, 50))
            return {
                userId: "9",
                authUserId: "uuid",
                sessionId: "session",
                expiresAt: Date.now() + 60000,
            }
        },
        music: {
            music: h.service,
            playlists: { execute: async () => ({ kind: "list", playlists: [] }) },
            resolver: { search: async () => [] },
            access: { authorizeMusic: async (actor) => ({ ...actor, voiceChannelId: null }) },
            controlChannel: () => "4",
            viewer: () => ({ inVoiceWithBot: false, canQueueTracks: false }),
            guilds: async () => ({ guilds: [] }),
            voiceContext: async () => ({ activeGuild: null }),
        },
    })
    await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve))
    const address = runtime.server.address()
    assert.ok(address && typeof address !== "string")
    const origin = `http://127.0.0.1:${address.port}`
    try {
        assert.equal((await fetch(`${origin}/health`)).status, 200)
        assert.equal((await fetch(`${origin}/ready`)).status, 200)
        ready = false
        assert.equal((await fetch(`${origin}/health`)).status, 200)
        assert.equal((await fetch(`${origin}/ready`)).status, 503)
        ready = true
        assert.equal((await fetch(`${origin}/api/guilds`)).status, 401)
        assert.equal(
            (
                await fetch(`${origin}/api/guilds/1/player`, {
                    method: "POST",
                    headers: { origin: "https://evil.example", "content-type": "application/json" },
                    body: "{}",
                })
            ).status,
            403
        )
        authorized = true
        assert.equal(
            (
                await fetch(`${origin}/api/guilds/1/player`, {
                    method: "POST",
                    headers: {
                        origin: "http://localhost:3000",
                        "content-type": "application/json",
                    },
                    body: "bad-json",
                })
            ).status,
            400
        )
        const rejected = new WebSocket(origin.replace("http:", "ws:") + "/ws", {
            headers: { origin: "https://evil.example" },
        })
        const status = await new Promise<number>((resolve) => {
            rejected.on("unexpected-response", (_req, response) => {
                resolve(response.statusCode!)
                response.resume()
                rejected.terminate()
            })
            rejected.on("error", () => {})
        })
        assert.equal(status, 403)
        slowAuth = true
        const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws", {
            headers: { origin: "http://localhost:3000" },
        })
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve)
            socket.once("error", reject)
        })
        const update = new Promise<any>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error("Initial subscription was lost during authentication")),
                1500
            )
            socket.on("message", (raw) => {
                const value = JSON.parse(String(raw))
                if (value.type === "queueUpdate") {
                    clearTimeout(timeout)
                    resolve(value)
                }
            })
        })
        socket.send(JSON.stringify({ type: "subscribe", guildId: "1" }))
        assert.equal((await update).state.canQueueTracks, false)
        socket.close()
    } finally {
        await runtime.close()
        await h.service.shutdown()
    }
})
