import assert from "node:assert/strict"
import { test } from "node:test"
import { readFluxerConfig } from "../../../src/lib/fluxer/config.js"

const env = { FLUXER_BOT_TOKEN: "secret", FLUXER_CLIENT_ID: "123" }

test("defaults to hosted Fluxer and ! commands without consuming Discord credentials", () => {
    assert.deepEqual(readFluxerConfig(env), {
        instanceOrigin: "https://fluxer.com",
        token: "secret",
        clientId: "123",
        commandPrefix: "!",
    })
    assert.throws(() => readFluxerConfig({ BOT_TOKEN: "discord", CLIENT_ID: "123" }))
})

test("allows an explicitly configured local instance and custom prefix", () => {
    assert.equal(
        readFluxerConfig({
            ...env,
            FLUXER_INSTANCE_ORIGIN: "http://localhost:8080/",
            BOT_COMMAND_PREFIX: "?",
        }).instanceOrigin,
        "http://localhost:8080"
    )
    assert.equal(readFluxerConfig({ ...env, BOT_COMMAND_PREFIX: "music!" }).commandPrefix, "music!")
})

test("rejects malformed origins, identifiers, tokens, and empty/whitespace prefixes", () => {
    for (const origin of [
        "ftp://host",
        "https://user:pass@host",
        "https://host/path",
        "https://host/?x=1",
        "garbage",
    ]) {
        assert.throws(() => readFluxerConfig({ ...env, FLUXER_INSTANCE_ORIGIN: origin }))
    }
    for (const patch of [
        { FLUXER_CLIENT_ID: "NaN" },
        { FLUXER_BOT_TOKEN: "Bot secret" },
        { BOT_COMMAND_PREFIX: "" },
        { BOT_COMMAND_PREFIX: "a b" },
    ])
        assert.throws(() => readFluxerConfig({ ...env, ...patch }))
})
