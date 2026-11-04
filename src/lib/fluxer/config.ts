export interface FluxerConfig {
    instanceOrigin: string
    token: string
    clientId: string
    commandPrefix: string
}

/** Validate operator configuration without falling back to Discord credentials. */
export function readFluxerConfig(env: NodeJS.ProcessEnv): FluxerConfig {
    const token = env.FLUXER_BOT_TOKEN?.trim()
    const clientId = env.FLUXER_CLIENT_ID?.trim()
    const commandPrefix = env.BOT_COMMAND_PREFIX ?? "!"
    if (!token || /\s/.test(token)) throw new Error("FLUXER_BOT_TOKEN must be a raw bot token")
    if (!clientId || !/^[1-9]\d{0,19}$/.test(clientId) || BigInt(clientId) > 2n ** 64n - 1n) {
        throw new Error("FLUXER_CLIENT_ID must be an unsigned snowflake")
    }
    if (!commandPrefix || /\s/.test(commandPrefix) || commandPrefix.length > 32) {
        throw new Error("BOT_COMMAND_PREFIX must contain 1–32 non-whitespace characters")
    }
    let origin: URL
    try {
        origin = new URL(env.FLUXER_INSTANCE_ORIGIN?.trim() || "https://fluxer.com")
    } catch {
        throw new Error("FLUXER_INSTANCE_ORIGIN must be an HTTP(S) origin")
    }
    if (
        !["http:", "https:"].includes(origin.protocol) ||
        origin.username ||
        origin.password ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
    )
        throw new Error("FLUXER_INSTANCE_ORIGIN must be an HTTP(S) origin without credentials")
    return { instanceOrigin: origin.origin, token, clientId, commandPrefix }
}
