import { spawn } from "node:child_process"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { createRequire } from "node:module"

const bundledFfmpeg: unknown = createRequire(import.meta.url)("ffmpeg-static")

/** Decode pipe bytes to owned 20 ms / 48 kHz stereo frames; FFmpeg cannot open files or URLs. */
export async function* decodePcm(
    input: AsyncIterable<Uint8Array>,
    offsetMs: number,
    signal: AbortSignal
): AsyncIterable<Int16Array> {
    signal.throwIfAborted()
    if (!Number.isFinite(offsetMs) || offsetMs < 0) throw new Error("Invalid playback position")
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener("abort", abort, { once: true })
    const child = spawn(
        process.env.FFMPEG_PATH ?? (typeof bundledFfmpeg === "string" ? bundledFfmpeg : "ffmpeg"),
        [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-protocol_whitelist",
            "pipe",
            "-i",
            "pipe:0",
            "-ss",
            String(offsetMs / 1000),
            "-vn",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-f",
            "s16le",
            "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    )
    const exited = new Promise<{ code: number | null; error?: boolean }>((resolve) => {
        child.once("error", () => resolve({ code: null, error: true }))
        child.once("close", (code) => resolve({ code }))
    })
    const terminate = () => {
        child.stdin.destroy()
        child.stdout.destroy()
        child.kill("SIGTERM")
    }
    controller.signal.addEventListener("abort", terminate, { once: true })
    child.stderr.resume()
    let inputFailed = false
    const pumping = pipeline(Readable.from(input), child.stdin, {
        signal: controller.signal,
    }).catch(() => {
        inputFailed = !controller.signal.aborted
    })
    let carry = Buffer.alloc(0)
    try {
        for await (const chunk of child.stdout) {
            signal.throwIfAborted()
            const bytes = Buffer.concat([carry, Buffer.from(chunk)])
            let offset = 0
            while (offset + 3840 <= bytes.length) {
                const samples = new Int16Array(1920)
                for (let i = 0; i < samples.length; i++)
                    samples[i] = bytes.readInt16LE(offset + i * 2)
                offset += 3840
                yield samples
            }
            carry = bytes.subarray(offset)
        }
        const result = await exited
        signal.throwIfAborted()
        if (result.error || result.code !== 0) throw new Error("Audio decode failed")
        await pumping
        if (inputFailed) throw new Error("Audio decode failed")
        if (carry.length % 4 !== 0) throw new Error("Audio decode returned an incomplete sample")
        if (carry.length) {
            const samples = new Int16Array(1920)
            for (let i = 0; i < carry.length / 2; i++) samples[i] = carry.readInt16LE(i * 2)
            yield samples
        }
    } catch {
        signal.throwIfAborted()
        throw new Error("Audio decode failed")
    } finally {
        signal.removeEventListener("abort", abort)
        controller.abort()
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 500)
        killTimer.unref()
        await exited
        clearTimeout(killTimer)
    }
}
