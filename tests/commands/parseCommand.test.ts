import assert from "node:assert/strict"
import { test } from "node:test"
import { parseCommand, parseSeekMs } from "../../src/commands/parseCommand.js"

test("preserves play remainder and natural apostrophes while supporting quoted playlist names", () => {
    assert.deepEqual(parseCommand("!play Can't Stop  https://example.com/a?q=x", "!"), {
        name: "play",
        args: ["Can't", "Stop", "https://example.com/a?q=x"],
        remainder: "Can't Stop  https://example.com/a?q=x",
    })
    assert.deepEqual(parseCommand('?playlist add "My List" a song', "?")?.args, [
        "add",
        "My List",
        "a",
        "song",
    ])
    assert.equal(parseCommand("hello", "!"), null)
    assert.equal(parseCommand("!HELP", "!")?.name, "help")
    assert.equal(parseCommand('!playlist create "Unfinished', "!")?.unclosedQuote, true)
    assert.equal(parseCommand("!play 'Til Tuesday", "!")?.remainder, "'Til Tuesday")
})

test("seek parses seconds or mm:ss and rejects invalid positions", () => {
    for (const [text, expected] of [
        ["12", 12000],
        ["1:05", 65000],
        ["0", 0],
        ["2.5", 2500],
    ] as const)
        assert.equal(parseSeekMs(text), expected)
    for (const text of ["-1", "NaN", "Infinity", "1:90", "1:2:3", "", "0x10"])
        assert.equal(parseSeekMs(text), null)
})
