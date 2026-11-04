import assert from "node:assert/strict"
import { test } from "node:test"
import { requireFluxerActor, FluxerSessionError } from "../../src/shared/fluxer-session.js"

test("session identity uses only an exact Fluxer provider account and ignores caller IDs", async () => {
    const deps = {
        getSession: async () => ({
            user: { id: "auth-uuid" },
            session: { id: "session", expiresAt: new Date(Date.now() + 60000) },
        }),
        accounts: async () => [{ providerId: "fluxer", accountId: "9" }],
    }
    const actor = await requireFluxerActor(new Headers({ "x-user-id": "attacker" }), deps)
    assert.equal(actor.userId, "9")
    assert.equal(actor.authUserId, "auth-uuid")
    await assert.rejects(
        requireFluxerActor(new Headers(), {
            ...deps,
            accounts: async () => [{ providerId: "discord", accountId: "9" }],
        }),
        (e) => e instanceof FluxerSessionError && e.status === 403
    )
    await assert.rejects(
        requireFluxerActor(new Headers(), { ...deps, getSession: async () => null }),
        (e) => e instanceof FluxerSessionError && e.status === 401
    )
    await assert.rejects(
        requireFluxerActor(new Headers(), {
            ...deps,
            getSession: async () => ({
                user: { id: "auth-uuid" },
                session: { id: "session", expiresAt: new Date(0) },
            }),
        }),
        (e) => e instanceof FluxerSessionError && e.status === 401
    )
    await assert.rejects(
        requireFluxerActor(new Headers(), {
            ...deps,
            accounts: async () => {
                throw new Error("database credential")
            },
        }),
        (e) =>
            e instanceof FluxerSessionError && e.status === 503 && !e.message.includes("credential")
    )
})
