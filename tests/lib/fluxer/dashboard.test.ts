import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerDashboard } from "../../../src/lib/fluxer/dashboard.js"
import { FluxerEntities } from "../../../src/lib/fluxer/entities.js"
import { musicServiceHarness, musicTrack } from "../../test-support/musicServiceFakes.js"
import { MusicAccessError } from "../../../src/lib/fluxer/access.js"
const actor = {
    userId: "9",
    authUserId: "uuid",
    sessionId: "session",
    expiresAt: Date.now() + 60000,
}
test("guild discovery intersects native Bot guilds, verifies membership, and uses instance assets/invites", async () => {
    const entities = new FluxerEntities(),
        h = musicServiceHarness()
    entities.apply({
        t: "GUILD_CREATE",
        d: { id: "1", properties: { name: "Server", owner_id: "9" } },
    })
    let denied = false
    const dashboard = new FluxerDashboard({
        entities,
        music: h.service,
        ready: () => true,
        botChannelId: () => "2",
        access: {
            authorizeMusic: async (_actor, action) => {
                if (denied || action === "queue") throw new MusicAccessError(403, "Denied")
                return { ..._actor, voiceChannelId: "2" }
            },
        },
        accounts: { accessToken: async () => "synthetic-access" },
        endpoints: {
            api: "https://api.example/v1",
            media: "https://media.example",
            webapp: "https://chat.example",
        },
        clientId: "8",
        fetchImpl: async (input, options) => {
            assert.equal(new URL(String(input)).origin, "https://api.example")
            assert.equal(
                new Headers(options?.headers).get("authorization"),
                "Bearer synthetic-access"
            )
            return Response.json([
                { id: "1", name: "Server", icon: "hash" },
                { id: "3", name: "No Bot" },
            ])
        },
    })
    const result = await dashboard.guilds(actor)
    assert.equal(result.guilds.length, 1)
    assert.equal(result.guilds[0].iconUrl, "https://media.example/icons/1/hash.webp")
    assert.match(result.botInviteUrl!, /^https:\/\/chat.example\/oauth2\/authorize/)
    assert.equal((await dashboard.viewer("1", "9")).canQueueTracks, false)
    denied = true
    assert.equal((await dashboard.guilds(actor)).guilds.length, 1)
    assert.deepEqual(await dashboard.voiceContext(actor), { activeGuild: null })
})
test("guild list stays available when a mutual guild cannot be authorized or snapshotted", async () => {
    const entities = new FluxerEntities()
    for (const id of ["1", "4"])
        entities.apply({
            t: "GUILD_CREATE",
            d: { id, properties: { name: `Server ${id}`, owner_id: "9" } },
        })
    entities.apply({
        t: "VOICE_STATE_UPDATE",
        d: { guild_id: "1", user_id: "9", connection_id: "c", channel_id: "2" },
    })
    const h = musicServiceHarness()
    let checks = 0
    const dashboard = new FluxerDashboard({
        entities,
        music: {
            allSnapshots: () => h.service.allSnapshots(),
            snapshot: (guildId) => {
                if (guildId === "4") throw new Error("guild lookup failed")
                return {
                    ...h.service.snapshot(guildId),
                    connected: true,
                    status: "playing",
                    current: musicTrack("Song"),
                }
            },
        },
        ready: () => true,
        botChannelId: () => "2",
        access: {
            authorizeMusic: async () => {
                checks++
                throw new MusicAccessError(503, "Fluxer permissions unavailable")
            },
        },
        accounts: { accessToken: async () => "synthetic-access" },
        endpoints: {
            api: "https://api.example/v1",
            media: "https://media.example",
            webapp: "https://chat.example",
        },
        clientId: "8",
        fetchImpl: async () =>
            Response.json([
                { id: "1", name: "Server 1", icon: null },
                { id: "4", name: "Server 4", icon: null },
                { id: "3", name: "No Bot", icon: null },
            ]),
    })
    const result = await dashboard.guilds(actor)
    assert.equal(checks, 0)
    assert.deepEqual(
        result.guilds.map((guild) => guild.id),
        ["1", "4"]
    )
    assert.equal(result.guilds[0].player?.inVoiceWithBot, true)
    assert.equal(result.guilds[0].player?.currentTrackTitle, "Song")
    assert.equal(result.guilds[1].player, null)
})
