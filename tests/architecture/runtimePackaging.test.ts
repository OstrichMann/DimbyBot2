import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"

test("startup migrations remain available after a production-only dependency install", () => {
    const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
    assert.ok(
        manifest.dependencies.prisma,
        "The Bot runs prisma migrate deploy at startup, so the CLI must be a production dependency"
    )
})
