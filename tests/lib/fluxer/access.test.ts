import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerAccess, MusicAccessError } from "../../../src/lib/fluxer/access.js"
import { FluxerEntities } from "../../../src/lib/fluxer/entities.js"
import { FluxerRest } from "../../../src/lib/fluxer/rest.js"

const mask = ((1n << 10n) | (1n << 20n) | (1n << 21n)).toString()
function harness() {
    const entities = new FluxerEntities()
    entities.apply({ t: "GUILD_CREATE", d: { id: "1", properties: { owner_id: "99" } } })
    const member = {
        user: { id: "9" },
        roles: ["7"],
        mute: false,
        deaf: false,
        communication_disabled_until: null,
    }
    const roles = [
        { id: "1", permissions: mask },
        { id: "7", permissions: "0" },
    ]
    const channel = { id: "2", guild_id: "1", type: 2, permission_overwrites: [] as unknown[] }
    let ready = true,
        occupied: string | null = "2",
        fail = 0,
        owner = "99"
    const rest = new FluxerRest("https://api.example/v1", "secret", {
        sleep: async () => {},
        fetchImpl: async (input) => {
            const path = new URL(String(input)).pathname
            if (fail) return new Response(null, { status: fail })
            const body = path.endsWith("/roles")
                ? roles
                : path.includes("/members/")
                  ? { ...member, user: { id: path.split("/").at(-1) } }
                  : path.includes("/channels/")
                    ? channel
                    : { id: "1", owner_id: owner }
            return Response.json(body)
        },
    })
    const access = new FluxerAccess({
        rest,
        entities,
        botId: "8",
        isReady: () => ready,
        botChannelId: () => occupied,
    })
    const voice = (channelId: string | null, connection = "a") =>
        entities.apply({
            t: "VOICE_STATE_UPDATE",
            d: { guild_id: "1", user_id: "9", connection_id: connection, channel_id: channelId },
        })
    return {
        access,
        entities,
        member,
        roles,
        channel,
        voice,
        setReady: (value: boolean) => {
            ready = value
        },
        setOccupied: (value: string | null) => {
            occupied = value
        },
        fail: (value: number) => {
            fail = value
        },
        setOwner: (value: string) => {
            owner = value
        },
    }
}
const actor = { guildId: "1", userId: "9" }

test("authorizes the actual shared voice channel across multiple user connections", async () => {
    const h = harness()
    h.voice("3", "a")
    h.voice("2", "b")
    assert.equal((await h.access.authorizeMusic(actor, "control")).voiceChannelId, "2")
    h.voice(null, "b")
    await assert.rejects(
        h.access.authorizeMusic(actor, "control"),
        (e) => e instanceof MusicAccessError && e.status === 403
    )
})

test("initial enqueue requires an explicit channel when several user connections are possible", async () => {
    const h = harness()
    h.setOccupied(null)
    h.voice("2")
    h.voice("3", "b")
    await assert.rejects(h.access.authorizeMusic(actor, "queue"), /choose/i)
    assert.equal((await h.access.authorizeMusic(actor, "queue", "2")).voiceChannelId, "2")
    h.channel.permission_overwrites.push({
        id: "9",
        type: 1,
        allow: "0",
        deny: (1n << 20n).toString(),
    })
    await assert.rejects(h.access.authorizeMusic(actor, "queue", "2"), /permission/i)
})

test("member overwrite wins over combined roles and malformed authority grants nothing", async () => {
    const h = harness()
    h.voice("2")
    h.roles.push({ id: "6", permissions: "0" })
    h.member.roles.push("6")
    h.channel.permission_overwrites.push(
        { id: "7", type: 0, allow: "0", deny: (1n << 20n).toString() },
        { id: "6", type: 0, allow: (1n << 20n).toString(), deny: "0" }
    )
    assert.equal((await h.access.authorizeMusic(actor, "queue")).voiceChannelId, "2")
    h.channel.permission_overwrites.push({
        id: "9",
        type: 1,
        allow: "0",
        deny: (1n << 10n).toString(),
    })
    await assert.rejects(h.access.authorizeMusic(actor, "queue"), /permission/i)
    h.channel.permission_overwrites = [{ id: "9", type: 1, allow: "broken", deny: "0" }]
    await assert.rejects(
        h.access.authorizeMusic(actor, "queue"),
        (e) => e instanceof MusicAccessError && e.status === 503
    )
})

test("configure requires Manage Guild while even the owner must share voice to control", async () => {
    const h = harness()
    await assert.rejects(h.access.authorizeMusic(actor, "configure"), /permission/i)
    h.roles[1].permissions = (1n << 5n).toString()
    assert.equal((await h.access.authorizeMusic(actor, "configure")).userId, "9")
    h.setOwner("9")
    assert.equal((await h.access.authorizeMusic(actor, "configure")).userId, "9")
    await assert.rejects(h.access.authorizeMusic(actor, "control"), /voice/i)
})

test("lookup failure, non-membership and disconnected Gateway fail closed", async () => {
    const h = harness()
    h.voice("2")
    h.fail(404)
    await assert.rejects(
        h.access.authorizeMusic(actor, "view"),
        (e) => e instanceof MusicAccessError && e.status === 403
    )
    h.fail(500)
    await assert.rejects(
        h.access.authorizeMusic(actor, "view"),
        (e) => e instanceof MusicAccessError && e.status === 503
    )
    h.fail(0)
    h.setReady(false)
    await assert.rejects(
        h.access.authorizeMusic(actor, "queue"),
        (e) => e instanceof MusicAccessError && e.status === 503
    )
})

test("requires the bot's Speak permission and refuses channels from a different guild", async () => {
    const h = harness()
    h.voice("2")
    h.channel.permission_overwrites.push({
        id: "8",
        type: 1,
        deny: (1n << 21n).toString(),
        allow: "0",
    })
    await assert.rejects(h.access.authorizeMusic(actor, "queue"), /permission/i)
    h.channel.permission_overwrites = []
    h.channel.guild_id = "5"
    await assert.rejects(h.access.authorizeMusic(actor, "queue"), /permission/i)
})

test("control channel configuration requires a same-guild text channel visible to actor and writable by bot", async () => {
    const h = harness()
    h.roles[1].permissions = (1n << 5n).toString()
    h.channel.type = 0
    h.roles[0].permissions = ((1n << 10n) | (1n << 11n) | (1n << 14n)).toString()
    await h.access.authorizeMusic(actor, "configure", "2")
    h.channel.guild_id = "3"
    await assert.rejects(
        h.access.authorizeMusic(actor, "configure", "2"),
        (e) => e instanceof MusicAccessError && e.status === 403
    )
    h.channel.guild_id = "1"
    h.channel.permission_overwrites = [
        { id: "8", type: 1, allow: "0", deny: (1n << 11n).toString() },
    ]
    await assert.rejects(
        h.access.authorizeMusic(actor, "configure", "2"),
        (e) => e instanceof MusicAccessError && e.status === 403
    )
})
