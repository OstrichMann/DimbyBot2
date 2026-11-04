import assert from "node:assert/strict"
import { test } from "node:test"
import { authorizeFluxerUpgrade } from "../../src/shared/websocket/fluxerUpgrade.js"
import { FluxerSessionError } from "../../src/shared/fluxer-session.js"

test("WebSocket upgrades require the Dashboard origin and a live verified Fluxer session", async () => {
    let reads = 0
    const actor = {
        userId: "9",
        authUserId: "uuid",
        sessionId: "session",
        expiresAt: Date.now() + 60000,
    }
    const authenticate = async () => {
        reads++
        return actor
    }
    await assert.rejects(
        authorizeFluxerUpgrade(
            new Headers({ origin: "https://evil.example" }),
            "http://localhost:3000",
            authenticate
        ),
        (e) => e instanceof FluxerSessionError && e.status === 403
    )
    assert.equal(reads, 0)
    assert.equal(
        (
            await authorizeFluxerUpgrade(
                new Headers({ origin: "http://localhost:3000" }),
                "http://localhost:3000",
                authenticate
            )
        ).userId,
        "9"
    )
    await assert.rejects(
        authorizeFluxerUpgrade(
            new Headers({ origin: "http://localhost:3000" }),
            "http://localhost:3000",
            async () => {
                throw new FluxerSessionError(401, "Sign in")
            }
        ),
        (e) => e instanceof FluxerSessionError && e.status === 401
    )
})
