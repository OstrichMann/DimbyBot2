import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
    isValidGuildIconUrl,
    parseGuildListPlayerSummary,
    parseSafeGuildListItem,
} from "../../src/shared/guild-list-parse.js"

describe("parseSafeGuildListItem", () => {
    it("accepts a trimmed digit id and name, and floors player queueCount", () => {
        const item = parseSafeGuildListItem({
            id: " 123456789012345678 ",
            name: "  Cool Guild ",
            iconUrl: " https://media.instance.example/icons/1/a.png ",
            memberCount: 42,
            player: {
                status: "playing",
                queueCount: 3.9,
                currentTrackTitle: " Song ",
                currentTrackAuthor: " Artist ",
                botInVoiceChannel: "true",
                inVoiceWithBot: true,
            },
        })
        assert.deepEqual(item, {
            id: "123456789012345678",
            name: "Cool Guild",
            iconUrl: "https://media.instance.example/icons/1/a.png",
            memberCount: 42,
            player: {
                status: "playing",
                queueCount: 3,
                currentTrackTitle: "Song",
                currentTrackAuthor: "Artist",
                botInVoiceChannel: true,
                inVoiceWithBot: true,
            },
        })
    })

    it("rejects missing name, non-snowflake ids, and non-object entries", () => {
        assert.equal(parseSafeGuildListItem(null), null)
        assert.equal(parseSafeGuildListItem({ id: "1", name: "  " }), null)
        assert.equal(parseSafeGuildListItem({ id: "abc", name: "Guild" }), null)
        assert.equal(parseSafeGuildListItem({ id: 123, name: "Guild" }), null)
        assert.equal(parseSafeGuildListItem({ id: "0", name: "Guild" }), null)
        assert.equal(parseSafeGuildListItem({ id: "18446744073709551616", name: "Guild" }), null)
    })

    it("nulls invalid memberCount and drops invalid nested player summaries", () => {
        const item = parseSafeGuildListItem({
            id: "1",
            name: "G",
            memberCount: -1,
            player: { status: "buffering", queueCount: 1 },
        })
        assert.equal(item?.memberCount, null)
        assert.equal(item?.player, null)
    })
})

describe("parseGuildListPlayerSummary", () => {
    it("requires a known status and a finite non-negative queueCount", () => {
        assert.equal(parseGuildListPlayerSummary(null), null)
        assert.equal(parseGuildListPlayerSummary({ status: "idle", queueCount: -1 }), null)
        assert.equal(parseGuildListPlayerSummary({ status: "idle", queueCount: Number.NaN }), null)
        assert.deepEqual(parseGuildListPlayerSummary({ status: "paused", queueCount: 0 }), {
            status: "paused",
            botInVoiceChannel: false,
            inVoiceWithBot: false,
            currentTrackTitle: null,
            currentTrackAuthor: null,
            queueCount: 0,
        })
    })
})

describe("isValidGuildIconUrl", () => {
    it("allows native HTTP(S) assets and rejects credentials or executable schemes", () => {
        assert.equal(isValidGuildIconUrl("https://media.instance.example/icons/1/a.png"), true)
        assert.equal(isValidGuildIconUrl("HTTPS://media.instance.example/avatars/1/b.png"), true)
        assert.equal(isValidGuildIconUrl("file:///tmp/a.png"), false)
        assert.equal(isValidGuildIconUrl("https://secret@media.instance.example/x.png"), false)
        assert.equal(isValidGuildIconUrl("javascript:alert(1)"), false)
        assert.equal(isValidGuildIconUrl("data:image/png;base64,aaa"), false)
        assert.equal(isValidGuildIconUrl(""), false)
        assert.equal(isValidGuildIconUrl(null), false)
    })
})
