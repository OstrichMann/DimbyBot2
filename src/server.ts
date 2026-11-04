import { config as loadEnv } from "dotenv"
import path from "node:path"
import { fileURLToPath } from "node:url"
import BotClient from "./lib/BotClient.js"
import Logger from "./lib/Logger.js"
import { setBotClient } from "./lib/botClientRegistry.js"
import { resolvedBotApiPort } from "./lib/botApiPortEnv.js"
import { createNativeServer } from "./botApi/nativeServer.js"
import { disconnectWebPrismaClient } from "./lib/webPrisma.js"

/** Independent Fluxer entrypoint loads only its dedicated environment file. */
export async function run(): Promise<void> {
    loadEnv({ path: [".env.fluxer.local", ".env.fluxer"], quiet: true })
    const logger = new Logger(path.resolve("storage/fluxer/app.log")),
        client = new BotClient(logger)
    let runtime: ReturnType<typeof createNativeServer> | undefined
    let stopping: Promise<void> | undefined
    const shutdown = () =>
        (stopping ??= (async () => {
            const results = await Promise.allSettled([runtime?.close(), client.destroy()])
            await disconnectWebPrismaClient()
            if (results.some((result) => result.status === "rejected")) process.exitCode = 1
        })())
    try {
        await client.start()
        setBotClient(client)
        const dashboardOrigin = process.env.BETTER_AUTH_URL?.trim() || "http://localhost:3000"
        runtime = createNativeServer({
            dashboardOrigin,
            ready: () => client.ready,
            music: {
                music: client.music,
                playlists: client.playlists,
                access: client.access,
                resolver: {
                    search: (query, requester, signal) => client.search(query, requester, signal),
                },
                controlChannel: (guildId) => client.storage.settings(guildId).channelId,
                viewer: (guildId, userId) => client.dashboard.viewer(guildId, userId),
                guilds: (actor) => client.dashboard.guilds(actor),
                voiceContext: (actor) => client.dashboard.voiceContext(actor),
            },
            onAccessChange: (callback) => client.onAccessChange(callback),
        })
        await new Promise<void>((resolve, reject) => {
            runtime!.server.once("error", reject)
            runtime!.server.listen(
                resolvedBotApiPort(),
                process.env.BOT_API_HOST || "127.0.0.1",
                resolve
            )
        })
        logger.info(`Fluxer Bot API listening on port ${resolvedBotApiPort()}`)
        for (const signal of ["SIGINT", "SIGTERM"] as const)
            process.once(signal, () => {
                const timeout = setTimeout(() => {
                    logger.error("Native shutdown timed out")
                    process.exit(1)
                }, 15000)
                void shutdown().finally(() => clearTimeout(timeout))
            })
    } catch {
        logger.error("Fluxer startup failed; check credentials, database and music services")
        process.exitCode = 1
        await shutdown()
    }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void run()
