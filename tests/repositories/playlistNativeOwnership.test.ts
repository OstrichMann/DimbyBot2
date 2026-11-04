import assert from "node:assert/strict"
import { test, mock, beforeEach } from "node:test"

let owner = true,
    trackWrites = 0,
    ownerQueries: unknown[] = []
let reorderRows: { id: number; position: number }[] = [],
    reorderWrites: unknown[] = []
const row = {
    id: 1,
    name: "List",
    userId: "9",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    tracks: [],
}
const tx = {
    playlist: {
        updateMany: async (query: unknown) => {
            ownerQueries.push(query)
            return { count: owner ? 1 : 0 }
        },
        update: async () => row,
    },
    playlistTrack: {
        aggregate: async () => ({ _max: { position: 0 } }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
            trackWrites++
            return { id: 1, ...data }
        },
        findMany: async () => reorderRows,
        findFirst: async () => null,
        update: async (query: unknown) => {
            reorderWrites.push(query)
        },
    },
}
mock.module("../../src/lib/database.js", {
    namedExports: {
        getPrismaClient: () => ({
            $transaction: async (work: (value: unknown) => Promise<unknown>) => work(tx),
            playlist: {
                findFirst: async (query: unknown) => {
                    ownerQueries.push(query)
                    return owner ? row : null
                },
                updateMany: tx.playlist.updateMany,
            },
        }),
    },
})
const repo = await import("../../src/repositories/playlistRepository.js")
beforeEach(() => {
    owner = true
    trackWrites = 0
    ownerQueries = []
    reorderRows = []
    reorderWrites = []
})

test("native reads and renames include owner in the database predicate", async () => {
    assert.equal((await repo.getOwnedPlaylistById("9", 1))?.name, "List")
    assert.deepEqual((ownerQueries[0] as { where: unknown }).where, { id: 1, userId: "9" })
    await repo.renameOwnedPlaylist("9", 1, "Renamed")
    assert.deepEqual((ownerQueries[1] as { where: unknown }).where, { id: 1, userId: "9" })
})

test("lost ownership aborts append, remove and even no-op reorder before any track write", async () => {
    owner = false
    const track = {
        title: "Song",
        uri: "https://example.com/song",
        author: "Artist",
        duration: 1000,
        addedAt: new Date(0),
    }
    await assert.rejects(repo.addTracksToPlaylist(1, [track], "9"), repo.PlaylistNotFoundError)
    await assert.rejects(repo.removeTrackFromPlaylist(1, 1, "9"), repo.PlaylistNotFoundError)
    await assert.rejects(repo.removeTrackFromPlaylistById(1, 123, "9"), repo.PlaylistNotFoundError)
    await assert.rejects(repo.movePlaylistTrack(1, 1, 1, "9"), repo.PlaylistNotFoundError)
    assert.equal(trackWrites, 0)
    assert.equal(ownerQueries.length, 4)
})

test("native reorder finds the selected stable row ID inside the ownership-locked transaction", async () => {
    reorderRows = [
        { id: 2, position: 1 },
        { id: 1, position: 2 },
    ]
    await repo.movePlaylistTrackById(1, 2, 2, "9")
    assert.deepEqual(reorderWrites.slice(-2), [
        { where: { id: 1 }, data: { position: 1 } },
        { where: { id: 2 }, data: { position: 2 } },
    ])
    assert.deepEqual((ownerQueries[0] as { where: unknown }).where, { id: 1, userId: "9" })
})

test("an owned append validates/locks the parent before writing ordered tracks", async () => {
    const track = {
        title: "Song",
        uri: "https://example.com/song",
        author: "Artist",
        duration: 1000,
        addedAt: new Date(0),
    }
    await repo.addTracksToPlaylist(1, [track, track], "9")
    assert.equal(trackWrites, 2)
    assert.deepEqual((ownerQueries[0] as { where: unknown }).where, { id: 1, userId: "9" })
})

test("native append checks the playlist limit inside the owner-locked transaction before all writes", async () => {
    const original = tx.playlistTrack.aggregate
    tx.playlistTrack.aggregate = async () => ({ _max: { position: 999 } })
    const track = {
        title: "Song",
        uri: "https://example.com/song",
        author: "Artist",
        duration: 1000,
        addedAt: new Date(0),
    }
    try {
        await assert.rejects(repo.addTracksToPlaylist(1, [track, track], "9"), /1000/)
        assert.equal(trackWrites, 0)
    } finally {
        tx.playlistTrack.aggregate = original
    }
})
