import assert from "node:assert/strict"
import { test } from "node:test"
import { decodePcm } from "../../../src/lib/music/decoder.js"
import { wavBytes } from "../../test-support/musicFakes.js"

async function decode(bytes: Uint8Array, offsetMs = 0) {
    const frames = []
    for await (const frame of decodePcm(
        (async function* () {
            yield bytes
        })(),
        offsetMs,
        new AbortController().signal
    ))
        frames.push(frame)
    return frames
}

test("real FFmpeg produces 20 ms stereo PCM frames and honors seek by decoding from the source", async () => {
    const frames = await decode(wavBytes(4800))
    assert.equal(frames.length, 5)
    assert.equal(
        frames.every((frame) => frame.length === 1920),
        true
    )
    assert.ok(frames[0].some((sample) => sample !== 0))
    assert.equal((await decode(wavBytes(4800), 40)).length, 3)
})

test("decoder errors are sanitized and invalid offsets are rejected", async () => {
    await assert.rejects(decode(new Uint8Array([1, 2, 3])), /decode/i)
    for (const offset of [-1, NaN, Infinity])
        await assert.rejects(decode(wavBytes(), offset), /position/i)
})

test(
    "cancellation tears down a stalled decoder without waiting for its input",
    { timeout: 3000 },
    async () => {
        const controller = new AbortController()
        const frames = decodePcm(
            (async function* () {
                yield wavBytes(48000)
                await new Promise(() => {})
            })(),
            0,
            controller.signal
        )
        const timer = setTimeout(() => controller.abort(), 20)
        try {
            await assert.rejects(
                async () => {
                    for await (const frame of frames) assert.equal(frame.length, 1920)
                },
                { name: "AbortError" }
            )
        } finally {
            clearTimeout(timer)
        }
    }
)
