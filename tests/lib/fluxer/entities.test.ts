import assert from "node:assert/strict"
import { test } from "node:test"
import { FluxerEntities, normalizeFluxerMessage } from "../../../src/lib/fluxer/entities.js"

test("voice state tracks each connection and removes only the departing connection", () => {
    const entities = new FluxerEntities()
    entities.apply({
        t: "GUILD_CREATE",
        d: {
            id: "1",
            properties: { owner_id: "9", name: "Friends" },
            roles: [],
            channels: [],
            members: [],
            voice_states: [],
        },
    })
    for (const [connection, channel] of [
        ["a", "2"],
        ["b", "3"],
    ]) {
        entities.apply({
            t: "VOICE_STATE_UPDATE",
            d: { guild_id: "1", user_id: "9", connection_id: connection, channel_id: channel },
        })
    }
    assert.deepEqual([...entities.voiceChannelsFor("1", "9")].sort(), ["2", "3"])
    entities.apply({
        t: "VOICE_STATE_UPDATE",
        d: { guild_id: "1", user_id: "9", connection_id: "a", channel_id: null },
    })
    assert.deepEqual([...entities.voiceChannelsFor("1", "9")], ["3"])
})

test("fresh READY clears guild state and guild deletion removes voice and permissions", () => {
    const entities = new FluxerEntities()
    entities.apply({
        t: "GUILD_CREATE",
        d: {
            id: "1",
            properties: { owner_id: "9", name: "Friends" },
            roles: [],
            channels: [],
            members: [],
            voice_states: [],
        },
    })
    assert.equal(entities.getGuild("1")?.name, "Friends")
    entities.apply({ t: "GUILD_DELETE", d: { id: "1" } })
    assert.equal(entities.getGuild("1"), undefined)
    entities.apply({ t: "GUILD_CREATE", d: { id: "1" } })
    entities.apply({ t: "READY", d: { session_id: "fresh" } })
    assert.equal(entities.getGuild("1"), undefined)
})

test("role, member and channel updates invalidate guild access revision", () => {
    const entities = new FluxerEntities()
    entities.apply({
        t: "GUILD_CREATE",
        d: {
            id: "1",
            properties: { owner_id: "9", name: "Friends" },
            roles: [],
            channels: [],
            members: [],
            voice_states: [],
        },
    })
    let revision = entities.getGuild("1")!.revision
    for (const event of [
        { t: "GUILD_ROLE_UPDATE", d: { guild_id: "1", role: { id: "7", permissions: "8" } } },
        { t: "GUILD_MEMBER_UPDATE", d: { guild_id: "1", user: { id: "9" }, roles: ["7"] } },
        { t: "CHANNEL_UPDATE", d: { guild_id: "1", id: "2", type: 2, permission_overwrites: [] } },
    ]) {
        entities.apply(event)
        assert.ok(entities.getGuild("1")!.revision > revision)
        revision = entities.getGuild("1")!.revision
    }
    assert.equal(entities.getGuild("1")!.roles.get("7")?.permissions, 8n)
    entities.apply({ t: "GUILD_MEMBER_REMOVE", d: { guild_id: "1", user: { id: "9" } } })
    assert.equal(entities.getGuild("1")!.members.has("9"), false)
})

test("native messages validate boundaries and mark bots, webhooks and DMs", () => {
    assert.deepEqual(
        normalizeFluxerMessage({
            id: "1",
            guild_id: "2",
            channel_id: "3",
            content: "!play hello",
            author: { id: "4", bot: true },
        }),
        {
            id: "1",
            guildId: "2",
            channelId: "3",
            content: "!play hello",
            authorId: "4",
            bot: true,
            webhook: false,
        }
    )
    assert.equal(
        normalizeFluxerMessage({ id: "1", channel_id: "3", author: { id: "4" }, webhook_id: "5" })
            ?.webhook,
        true
    )
    for (const value of [null, {}, { id: 1 }, { id: "1", channel_id: "3", author: {} }])
        assert.equal(normalizeFluxerMessage(value), null)
})
