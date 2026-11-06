import assert from "node:assert/strict"
import { test } from "node:test"
import { buildFluxerBotInvite } from "../../../src/web/lib/fluxer-bot-invite.js"
import { queueEntryKey } from "../../../src/web/lib/music-ui.js"

test("Fluxer invite uses discovered webapp, bot scope and decimal permissions", () => {
    const url = new URL(
        buildFluxerBotInvite(
            {
                api: "https://api.example/v1",
                gateway: "wss://gw.example",
                media: "https://media.example",
                cdn: "https://static.example",
                webapp: "https://chat.example",
            },
            "9",
            3165184n
        )
    )
    assert.equal(url.origin, "https://chat.example")
    assert.equal(url.searchParams.get("scope"), "bot")
    assert.equal(url.searchParams.get("permissions"), "3165184")
    assert.throws(() =>
        buildFluxerBotInvite({ webapp: "https://chat.example" } as any, "invalid", 0n)
    )
})
test("duplicate source tracks use independent native queue entry IDs", () => {
    assert.notEqual(queueEntryKey({ entryId: "row-a" }), queueEntryKey({ entryId: "row-b" }))
})

test("discovered Fluxer media URLs render without a Discord host assumption", async () => {
    const { isValidGuildIconUrl, parseSafeGuildListItem } =
        await import("../../../src/shared/guild-list-parse.js")
    assert.equal(isValidGuildIconUrl("https://media.instance.example/icons/9/hash.webp"), true)
    assert.equal(parseSafeGuildListItem({ id: "9", name: "Native" })?.id, "9")
})

test("authentication errors identify Fluxer without provider payloads", async () => {
    const { authErrorMessage } = await import("../../../src/web/lib/auth-error-message.js")
    assert.equal(authErrorMessage("access_denied"), "Fluxer sign-in was cancelled.")
})
