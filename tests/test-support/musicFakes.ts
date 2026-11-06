import type { PreparedSource } from "../../src/lib/music/types.js"

/** Generates a tiny WAV fixture without shell commands or network media. */
export function wavBytes(samplesPerChannel = 4800): Uint8Array {
    const dataSize = samplesPerChannel * 4,
        bytes = Buffer.alloc(44 + dataSize)
    bytes.write("RIFF", 0)
    bytes.writeUInt32LE(36 + dataSize, 4)
    bytes.write("WAVEfmt ", 8)
    bytes.writeUInt32LE(16, 16)
    bytes.writeUInt16LE(1, 20)
    bytes.writeUInt16LE(2, 22)
    bytes.writeUInt32LE(48000, 24)
    bytes.writeUInt32LE(192000, 28)
    bytes.writeUInt16LE(4, 32)
    bytes.writeUInt16LE(16, 34)
    bytes.write("data", 36)
    bytes.writeUInt32LE(dataSize, 40)
    for (let i = 0; i < samplesPerChannel; i++)
        for (let channel = 0; channel < 2; channel++)
            bytes.writeInt16LE(
                Math.round(5000 * Math.sin((2 * Math.PI * 440 * i) / 48000)),
                44 + i * 4 + channel * 2
            )
    return bytes
}

export function preparedFixture(): PreparedSource {
    return {
        input: (async function* () {
            yield wavBytes()
        })(),
        durationMs: 100,
        playbackUrl: "https://example.com/song",
        seekable: true,
        close: async () => {},
    }
}
