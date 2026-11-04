import assert from "node:assert/strict"
import { test, mock } from "node:test"
import { musicTrack } from "../test-support/musicServiceFakes.js"

const rows = [
    {
        guildId: "1",
        voiceChannelId: "2",
        textChannelId: "3",
        snapshot: { version: 99 },
        updatedAt: new Date(0),
    },
]
const writes: unknown[] = []
mock.module("../../src/lib/database.js", {
    namedExports: {
        getPrismaClient: () => ({
            playerSession: {
                findMany: async () => rows,
                upsert: async (query: unknown) => {
                    writes.push(query)
                },
            },
        }),
    },
})
const repository = await import("../../src/repositories/playerSessionRepository.js")

test("native repository retains raw unsupported snapshot versions for safe skipping", async () => {
    assert.deepEqual(await repository.listRawPlayerSessions(), rows)
})

test("native snapshot upsert stores V2 source identity in both create and update", async () => {
    const snapshot = {
        version: 2 as const,
        volume: 50,
        repeatMode: "off" as const,
        paused: true,
        positionMs: 42,
        current: musicTrack("A"),
        queue: [],
    }
    await repository.upsertMusicPlayerSession("1", "2", "3", snapshot)
    assert.deepEqual(writes[0], {
        where: { guildId: "1" },
        create: { guildId: "1", voiceChannelId: "2", textChannelId: "3", snapshot },
        update: { voiceChannelId: "2", textChannelId: "3", snapshot },
    })
})
