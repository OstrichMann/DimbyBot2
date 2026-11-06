import type { Prisma } from "@prisma/client"
import { getPrismaClient } from "../lib/database.js"
import type { MusicSessionSnapshotV2 } from "../shared/music-contract.js"

/** Versioned native snapshots retain reusable source identity without transport credentials. */
export async function upsertMusicPlayerSession(
    guildId: string,
    voiceChannelId: string,
    textChannelId: string | null,
    snapshot: MusicSessionSnapshotV2
): Promise<void> {
    const data = {
        voiceChannelId,
        textChannelId,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
    }
    await getPrismaClient().playerSession.upsert({
        where: { guildId },
        create: { guildId, ...data },
        update: data,
    })
}
/** Unsupported versions remain available to the persistence parser and are never rewritten implicitly. */
export async function listRawPlayerSessions() {
    return getPrismaClient().playerSession.findMany()
}
export async function deletePlayerSession(guildId: string): Promise<void> {
    await getPrismaClient().playerSession.deleteMany({ where: { guildId } })
}
