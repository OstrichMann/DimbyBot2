import assert from "node:assert/strict"
import { test } from "node:test"
import { getWebPrismaClient, disconnectWebPrismaClient } from "../../../src/lib/webPrisma.js"

test("Fluxer auth never falls back to an existing default PostgreSQL database", async () => {
    const old = {
        database: process.env.DATABASE_URL,
        node: process.env.NODE_ENV,
        fallback: process.env.ALLOW_DEV_DATABASE_FALLBACK,
    }
    delete process.env.DATABASE_URL
    process.env.NODE_ENV = "development"
    process.env.ALLOW_DEV_DATABASE_FALLBACK = "true"
    try {
        assert.throws(() => getWebPrismaClient(), /DATABASE_URL/)
    } finally {
        await disconnectWebPrismaClient()
        for (const [key, value] of [
            ["DATABASE_URL", old.database],
            ["NODE_ENV", old.node],
            ["ALLOW_DEV_DATABASE_FALLBACK", old.fallback],
        ])
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
    }
})
