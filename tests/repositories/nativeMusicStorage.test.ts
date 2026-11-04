import assert from "node:assert/strict"
import { test, mock } from "node:test"
let row = { guildId: "1", controlChannelId: "4", controlMessageId: "5" },
    snapshot: unknown,
    writes = 0
const calls: string[] = []
const prisma = {
    guildSettings: {
        findMany: async () => [row],
        upsert: async (query: { update: Partial<typeof row> }) => {
            row = { ...row, ...query.update }
        },
        updateMany: async (query: {
            where: { controlChannelId: string }
            data: { controlMessageId: string }
        }) => {
            if (query.where.controlChannelId !== row.controlChannelId) return { count: 0 }
            row.controlMessageId = query.data.controlMessageId
            return { count: 1 }
        },
    },
    playerSession: {
        findMany: async () => [
            { guildId: "1", voiceChannelId: "2", textChannelId: "4", snapshot: { version: 1 } },
        ],
        upsert: async (query: { update: { snapshot: unknown } }) => {
            writes++
            snapshot = query.update.snapshot
        },
        deleteMany: async () => {},
    },
}
mock.module("../../src/lib/database.js", {
    namedExports: {
        getPrismaClient: () => prisma,
        initializeDatabaseConnection: async () => {
            calls.push("connect")
        },
        runPrismaMigrateDeploy: async () => {
            calls.push("migrate")
        },
        disconnectDatabase: async () => {
            calls.push("close")
        },
    },
})
const { NativeMusicStorage } = await import("../../src/repositories/nativeMusicStorage.js")
test("native storage retains only matching-channel message IDs and writes sanitized V2 snapshots", async () => {
    const storage = new NativeMusicStorage({})
    await storage.start()
    assert.deepEqual(calls, ["connect", "migrate"])
    assert.deepEqual(storage.settings("1"), { channelId: "4", messageId: "5" })
    await storage.setControlChannel("1", "6")
    await storage.saveMessageId("1", "4", "7")
    assert.deepEqual(storage.settings("1"), { channelId: "6", messageId: null })
    await storage.saveMessageId("1", "6", "8")
    assert.equal(storage.settings("1").messageId, "8")
    assert.equal(((await storage.sessions.list())[0].snapshot as { version: number }).version, 1)
    await assert.rejects(
        storage.sessions.save({
            guildId: "1",
            voiceChannelId: "2",
            textChannelId: "6",
            snapshot: { version: 1 },
        })
    )
    assert.equal(writes, 0)
    await storage.sessions.save({
        guildId: "1",
        voiceChannelId: "2",
        textChannelId: "6",
        snapshot: {
            version: 2,
            current: null,
            queue: [],
            volume: 40,
            repeatMode: "off",
            positionMs: 0,
            paused: true,
            privateToken: "must-not-persist",
        },
    })
    assert.equal(JSON.stringify(snapshot).includes("must-not-persist"), false)
    await storage.close()
    assert.equal(calls.at(-1), "close")
})
