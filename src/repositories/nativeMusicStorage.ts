import {
    initializeDatabaseConnection,
    runPrismaMigrateDeploy,
    getPrismaClient,
    disconnectDatabase,
} from "../lib/database.js"
import type { LoggerInterface } from "../types/index.js"
import type { MusicSessionStore } from "../lib/music/sessionPersistence.js"
import { parseMusicSessionSnapshot } from "../lib/music/sessionPersistence.js"
import {
    upsertMusicPlayerSession,
    listRawPlayerSessions,
    deletePlayerSession,
} from "./playerSessionRepository.js"
import { isFluxerId } from "../shared/fluxer-user-id.js"

export interface ControlSettings {
    channelId: string | null
    messageId: string | null
}
export interface RuntimeStorage {
    start(): Promise<void>
    close(): Promise<void>
    settings(guildId: string): ControlSettings
    setControlChannel(guildId: string, channelId: string | null): Promise<void>
    saveMessageId(guildId: string, channelId: string, messageId: string): Promise<void>
    sessions: MusicSessionStore
}

/** Loads only music settings; retained non-music tables and legacy files are never activated. */
export class NativeMusicStorage implements RuntimeStorage {
    private readonly cache = new Map<string, ControlSettings>()
    private settingsTail: Promise<unknown> = Promise.resolve()
    constructor(private readonly logger: Partial<LoggerInterface>) {}
    readonly sessions: MusicSessionStore = {
        list: listRawPlayerSessions,
        save: async (row) => {
            const snapshot = parseMusicSessionSnapshot(row.snapshot)
            if (!snapshot) throw new Error("Invalid native music snapshot")
            await upsertMusicPlayerSession(
                row.guildId,
                row.voiceChannelId,
                row.textChannelId,
                snapshot
            )
        },
        delete: deletePlayerSession,
    }
    async start(): Promise<void> {
        await initializeDatabaseConnection(this.logger)
        await runPrismaMigrateDeploy(this.logger)
        const rows = await getPrismaClient().guildSettings.findMany({
            select: { guildId: true, controlChannelId: true, controlMessageId: true },
        })
        for (const row of rows)
            if (isFluxerId(row.guildId))
                this.cache.set(row.guildId, {
                    channelId: isFluxerId(row.controlChannelId) ? row.controlChannelId : null,
                    messageId: isFluxerId(row.controlMessageId) ? row.controlMessageId : null,
                })
    }
    settings(guildId: string): ControlSettings {
        return { ...(this.cache.get(guildId) ?? { channelId: null, messageId: null }) }
    }
    private write(work: () => Promise<void>): Promise<void> {
        const result = this.settingsTail.then(work)
        this.settingsTail = result.catch(() => {})
        return result
    }
    setControlChannel(guildId: string, channelId: string | null): Promise<void> {
        return this.write(async () => {
            if (!isFluxerId(guildId) || (channelId !== null && !isFluxerId(channelId)))
                throw new Error("Invalid control channel")
            await getPrismaClient().guildSettings.upsert({
                where: { guildId },
                create: { guildId, controlChannelId: channelId },
                update: { controlChannelId: channelId, controlMessageId: null },
            })
            this.cache.set(guildId, { channelId, messageId: null })
        })
    }
    saveMessageId(guildId: string, channelId: string, messageId: string): Promise<void> {
        return this.write(async () => {
            if (this.settings(guildId).channelId !== channelId || !isFluxerId(messageId)) return
            const result = await getPrismaClient().guildSettings.updateMany({
                where: { guildId, controlChannelId: channelId },
                data: { controlMessageId: messageId },
            })
            if (result.count && this.settings(guildId).channelId === channelId)
                this.cache.set(guildId, { channelId, messageId })
        })
    }
    async close(): Promise<void> {
        await this.settingsTail
        await disconnectDatabase(this.logger)
    }
}
