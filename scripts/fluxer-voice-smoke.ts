import { setTimeout as delay } from "node:timers/promises"
import { readFluxerConfig } from "../src/lib/fluxer/config.js"
import { discoverFluxer } from "../src/lib/fluxer/discovery.js"
import { FluxerGateway } from "../src/lib/fluxer/gateway.js"
import { FluxerEntities } from "../src/lib/fluxer/entities.js"
import { FluxerVoice } from "../src/lib/fluxer/voice.js"
import { isFluxerId } from "../src/shared/fluxer-user-id.js"
import { LivekitTransport } from "../src/lib/music/livekitTransport.js"
import type { PreparedSource } from "../src/lib/music/types.js"

/** A bounded local WAV source exercises the real decoder and publisher without a media service. */
function toneSource(): PreparedSource {
    const samples = 48000 * 8,
        header = Buffer.alloc(44)
    header.write("RIFF", 0)
    header.writeUInt32LE(36 + samples * 4, 4)
    header.write("WAVEfmt ", 8)
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(2, 22)
    header.writeUInt32LE(48000, 24)
    header.writeUInt32LE(192000, 28)
    header.writeUInt16LE(4, 32)
    header.writeUInt16LE(16, 34)
    header.write("data", 36)
    header.writeUInt32LE(samples * 4, 40)
    return {
        durationMs: 8000,
        playbackUrl: "local-test-tone",
        seekable: false,
        close: async () => {},
        input: (async function* () {
            yield header
            for (let frame = 0; frame < samples / 960; frame++) {
                const bytes = Buffer.alloc(3840)
                for (let i = 0; i < 960; i++) {
                    const value = Math.round(
                        3000 * Math.sin((2 * Math.PI * 440 * (frame * 960 + i)) / 48000)
                    )
                    bytes.writeInt16LE(value, i * 4)
                    bytes.writeInt16LE(value, i * 4 + 2)
                }
                yield bytes
            }
        })(),
    }
}

async function main(): Promise<void> {
    const config = readFluxerConfig(process.env)
    const guildId = process.env.FLUXER_TEST_GUILD_ID,
        channelId = process.env.FLUXER_TEST_CHANNEL_ID
    if (!isFluxerId(guildId) || !isFluxerId(channelId))
        throw new Error("Configure FLUXER_TEST_GUILD_ID and FLUXER_TEST_CHANNEL_ID")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    const interrupt = () => controller.abort()
    process.once("SIGINT", interrupt)
    process.once("SIGTERM", interrupt)
    const entities = new FluxerEntities(),
        transport = new LivekitTransport()
    let gateway: FluxerGateway | undefined,
        voice: FluxerVoice | undefined,
        usedNativeSdk = false
    try {
        const endpoints = await discoverFluxer(config.instanceOrigin, fetch, controller.signal)
        voice = new FluxerVoice({
            send: (op, data) => gateway!.send(op, data),
            onDisconnect: () => controller.abort(),
        })
        gateway = new FluxerGateway(endpoints.gateway, config.token, {
            onDispatch: async (event) => {
                entities.apply(event)
                voice!.handleDispatch(event)
            },
            onError: (error) => {
                console.error(error.message)
                controller.abort()
            },
        })
        await gateway.start()
        const deadline = Date.now() + 10_000
        while (!entities.getGuild(guildId)?.available) {
            if (Date.now() > deadline)
                throw new Error("Test guild did not become available; check bot installation")
            await delay(100, undefined, { signal: controller.signal })
        }
        const grant = await voice.join(guildId, channelId, controller.signal)
        usedNativeSdk = true
        await transport.connect(grant, controller.signal)
        console.log(
            `Voice connected (${grant.e2eeKey ? "encrypted media" : "unencrypted media"}); publishing a quiet 440 Hz test tone.`
        )
        const playing = transport.play(toneSource(), 0, controller.signal)
        void playing.catch(() => controller.abort())
        await delay(2000, undefined, { signal: controller.signal })
        await transport.pause()
        console.log("Paused; listeners should hear silence for two seconds.")
        await delay(2000, undefined, { signal: controller.signal })
        await transport.resume()
        console.log("Resumed; listeners should hear the tone again.")
        await playing
        console.log(
            "Probe finished. Listener confirmation is still required; SDK success alone does not prove audible playback."
        )
    } finally {
        controller.abort()
        clearTimeout(timer)
        process.removeListener("SIGINT", interrupt)
        process.removeListener("SIGTERM", interrupt)
        try {
            await transport.disconnect()
        } finally {
            try {
                await voice?.stop()
            } finally {
                await gateway?.stop()
                if (usedNativeSdk) await (await import("@livekit/rtc-node")).dispose()
            }
        }
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fluxer voice probe failed")
    process.exitCode = 1
})
