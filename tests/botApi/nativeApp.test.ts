import assert from "node:assert/strict"
import { test } from "node:test"
import { createNativeBotApiApp, validateMusicRequestOrigin } from "../../src/botApi/nativeApp.js"

test("Bot API origin policy rejects foreign or missing origins on mutations and allows reads", () => {
    assert.equal(
        validateMusicRequestOrigin(
            "POST",
            new Headers({ origin: "https://evil.example" }),
            "http://localhost:3000"
        ),
        false
    )
    assert.equal(validateMusicRequestOrigin("POST", new Headers(), "http://localhost:3000"), false)
    assert.equal(
        validateMusicRequestOrigin(
            "POST",
            new Headers({ origin: "http://localhost:3000" }),
            "http://localhost:3000"
        ),
        true
    )
    assert.equal(validateMusicRequestOrigin("GET", new Headers(), "http://localhost:3000"), true)
    assert.equal(typeof createNativeBotApiApp, "function")
})
