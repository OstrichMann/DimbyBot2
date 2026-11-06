import assert from "node:assert/strict"
import { test } from "node:test"
import { isFluxerId } from "../../src/shared/fluxer-user-id.js"

test("accepts opaque positive uint64 decimal IDs without a Discord epoch or length floor", () => {
    for (const value of ["1", "12345", "18446744073709551615"])
        assert.equal(isFluxerId(value), true)
    for (const value of ["0", "01", "18446744073709551616", "-1", "1.0", " 1", 1, null, ""])
        assert.equal(isFluxerId(value), false)
})
