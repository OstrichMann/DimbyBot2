import assert from "node:assert/strict"
import { test } from "node:test"
import { nativePlayerState } from "../../src/shared/fluxer-player-state.js"
import { musicServiceHarness } from "../test-support/musicServiceFakes.js"

test("native player DTO exposes sanitized asynchronous source/voice failures to the Dashboard", () => {
    const state = musicServiceHarness().service.snapshot("1")
    state.lastError = "Voice connection unavailable; resume to retry"
    assert.equal(
        nativePlayerState(state, { inVoiceWithBot: false, canQueueTracks: false }).lastError,
        state.lastError
    )
})

test("a restarted Bot can replace a larger revision from the previous process", async () => {
    const { acceptsNativePlayerUpdate } = await import("../../src/shared/fluxer-player-state.js")
    assert.equal(
        acceptsNativePlayerUpdate(
            { instanceId: "old", revision: 90 },
            { instanceId: "new", revision: 1 }
        ),
        true
    )
    assert.equal(
        acceptsNativePlayerUpdate(
            { instanceId: "same", revision: 90 },
            { instanceId: "same", revision: 1 }
        ),
        false
    )
    assert.equal(
        acceptsNativePlayerUpdate(
            { instanceId: "same", revision: 90 },
            { instanceId: "same", revision: 90 }
        ),
        true
    )
})
