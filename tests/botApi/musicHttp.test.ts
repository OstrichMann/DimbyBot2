import assert from "node:assert/strict"
import { test } from "node:test"
import { handleMusicRequest, type MusicHttpDependencies } from "../../src/botApi/musicHttp.js"
import { musicServiceHarness, musicTrack } from "../test-support/musicServiceFakes.js"
import { MusicAccessError } from "../../src/lib/fluxer/access.js"
import type { AuthenticatedActor } from "../../src/shared/fluxer-session.js"
const actor: AuthenticatedActor = {
    userId: "9",
    authUserId: "uuid",
    sessionId: "session",
    expiresAt: Date.now() + 60000,
}
function harness() {
    const h = musicServiceHarness()
    let denied = 0
    const deps: MusicHttpDependencies = {
        music: h.service,
        access: {
            authorizeMusic: async () => {
                if (denied) throw new MusicAccessError(denied as 403 | 503, "Access unavailable")
                return { userId: "9", guildId: "1", voiceChannelId: "2" }
            },
        },
        playlists: { execute: async () => ({ kind: "list", playlists: [] }) },
        resolver: { search: async () => [musicTrack("Search")] },
        controlChannel: () => "4",
        viewer: () => ({ inVoiceWithBot: true, canQueueTracks: true }),
        guilds: async () => ({ guilds: [] }),
        voiceContext: async () => ({ activeGuild: null }),
    }
    const request = (
        method: string,
        path: string,
        body?: unknown,
        who: AuthenticatedActor | null = actor
    ) => handleMusicRequest(who, { method, path, body }, deps)
    return {
        ...h,
        deps,
        request,
        deny: (status: number) => {
            denied = status
        },
    }
}
test("music API checks session, input, authoritative permissions and stale revisions", async () => {
    const h = harness()
    assert.equal((await h.request("GET", "/api/guilds/1/player", undefined, null)).status, 401)
    assert.equal((await h.request("GET", "/api/guilds/not-an-id/player")).status, 400)
    h.deny(403)
    assert.equal((await h.request("GET", "/api/guilds/1/player")).status, 403)
    h.deny(503)
    assert.equal((await h.request("GET", "/api/guilds/1/player")).status, 503)
    h.deny(0)
    assert.equal(
        (
            await h.request("POST", "/api/guilds/1/player", {
                action: "volume",
                percent: 25,
                revision: 0,
                userId: "attacker",
            })
        ).status,
        200
    )
    assert.equal(h.service.snapshot("1").volume, 25)
    assert.equal(
        (await h.request("POST", "/api/guilds/1/player", { action: "stop", revision: 0 })).status,
        409
    )
    assert.equal(
        (await h.request("POST", "/api/guilds/1/player", { action: "autoplay" })).status,
        400
    )
    assert.equal((await h.request("DELETE", "/api/guilds/1/queue/missing-entry")).status, 404)
})
test("HTTP and commands share the music service; DTOs expose stable IDs and viewer-specific flags", async () => {
    const h = harness()
    assert.equal(
        (await h.request("POST", "/api/guilds/1/player/play", { query: "Search" })).status,
        200
    )
    await h.request("POST", "/api/guilds/1/player/play", { query: "Search" })
    const response = await h.request("GET", "/api/guilds/1/queue")
    assert.equal(response.status, 200)
    const payload = response.body as any
    assert.ok(payload.data.items[0].entryId)
    assert.equal(payload.data.items[0].encoded, undefined)
    const player = (await h.request("GET", "/api/guilds/1/player")).body as any
    assert.equal(player.data.canQueueTracks, true)
    h.deps.viewer = () => ({ inVoiceWithBot: false, canQueueTracks: false })
    assert.equal(
        ((await h.request("GET", "/api/guilds/1/player")).body as any).data.canQueueTracks,
        false
    )
    const search = await h.request("GET", "/api/guilds/1/search?q=Search")
    assert.equal(search.status, 200)
    assert.equal((search.body as any).data.tracks[0].title, "Search")
    await h.service.shutdown()
})
test("playlists always use authenticated native owner; deferred and unknown routes are unavailable", async () => {
    const h = harness()
    const calls: unknown[] = []
    h.deps.playlists.execute = async (owner, action) => {
        calls.push([owner, action])
        return { kind: "list", playlists: [] }
    }
    assert.equal(
        (await h.request("POST", "/api/playlists", { name: "Mine", userId: "attacker" })).status,
        200
    )
    assert.deepEqual(calls, [["9", { type: "create", name: "Mine" }]])
    assert.equal((await h.request("GET", "/api/admin/metrics")).status, 503)
    assert.equal((await h.request("GET", "/api/unknown")).status, 404)
})

test("native routes reject invalid action payloads and keep queue writes attached to stable identities", async () => {
    const h = harness()
    await h.request("POST", "/api/guilds/1/player/play", { query: "Song" })
    await h.request("POST", "/api/guilds/1/player/play", { query: "Song" })
    await h.request("POST", "/api/guilds/1/player/play", { query: "Song" })
    const entry = h.service.snapshot("1").queue[0].entryId
    assert.equal(
        (await h.request("PATCH", `/api/guilds/1/queue/${entry}`, { toIndex: 1 })).status,
        200
    )
    assert.equal(h.service.snapshot("1").queue[1].entryId, entry)
    assert.equal((await h.request("DELETE", `/api/guilds/1/queue/${entry}`)).status, 200)
    assert.equal(
        h.service.snapshot("1").queue.some((track) => track.entryId === entry),
        false
    )
    for (const payload of [
        { action: "volume", percent: 101 },
        { action: "seek", positionMs: -1 },
        { action: "loop", mode: "unknown" },
        { action: "pause", revision: "0" },
    ])
        assert.equal((await h.request("POST", "/api/guilds/1/player", payload)).status, 400)
    assert.equal((await h.request("GET", "/api/guilds/1/search?q=")).status, 400)
    assert.equal((await h.request("GET", "/api/guilds/1/queue?page=0")).status, 400)
    assert.equal((await h.request("POST", "/api/guilds/1/queue", { query: "Another" })).status, 200)
    assert.equal((await h.request("DELETE", "/api/guilds/1/queue")).status, 200)
    assert.equal(h.service.snapshot("1").queue.length, 0)
    assert.equal((await h.request("GET", "/api/guilds")).status, 200)
    assert.equal((await h.request("GET", "/api/guilds/voice-context")).status, 200)
    const permissions = await h.request("GET", "/api/guilds/1/dashboard-permissions")
    assert.equal(permissions.status, 200)
    assert.deepEqual((permissions.body as any).data.primaryPermissions, [
        "VIEW_PLAYER",
        "MANAGE_QUEUE",
        "CONTROL_PLAYBACK",
    ])
    h.deps.controlChannel = () => null
    const blank = musicServiceHarness()
    h.deps.music = blank.service
    assert.equal(
        (await h.request("POST", "/api/guilds/1/player/play", { query: "Song" })).status,
        400
    )
    await h.service.shutdown()
})

test("an expired Fluxer grant asks the user to sign in again instead of reporting an outage", async () => {
    const { FluxerReauthRequiredError } = await import("../../src/shared/fluxer-oauth.js")
    const h = harness()
    h.deps.guilds = async () => {
        throw new FluxerReauthRequiredError()
    }
    const response = await h.request("GET", "/api/guilds")
    assert.equal(response.status, 401)
    assert.deepEqual(response.body, { ok: false, error: { error: "Sign in with Fluxer again" } })
    h.deps.guilds = async () => {
        throw new Error("Fluxer authorization unavailable; try again shortly")
    }
    assert.equal((await h.request("GET", "/api/guilds")).status, 503)
})
