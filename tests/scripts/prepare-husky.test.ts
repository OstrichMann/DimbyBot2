import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

test("fresh Fluxer checkouts install the mandatory test hook through Husky's supported export", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fluxer-hooks-"))
    try {
        assert.equal(spawnSync("git", ["init", "--quiet", directory]).status, 0)
        const environment = { ...process.env }
        delete environment.HUSKY
        const result = spawnSync(
            process.execPath,
            [fileURLToPath(new URL("../../scripts/prepare-husky.mjs", import.meta.url))],
            { cwd: directory, env: environment, encoding: "utf8" }
        )
        assert.equal(result.status, 0)
        assert.equal(existsSync(path.join(directory, ".husky/_/pre-commit")), true)
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})
