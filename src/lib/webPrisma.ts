import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const globalForPrisma = globalThis as unknown as {
    __webPrismaClient?: InstanceType<typeof PrismaClient>
}

function createWebPrismaClient(): InstanceType<typeof PrismaClient> {
    const databaseUrl = process.env.DATABASE_URL?.trim()
    if (!databaseUrl)
        throw new Error("DATABASE_URL is required for the independent Fluxer database.")
    const adapter = new PrismaPg({
        connectionString: databaseUrl,
    })
    return new PrismaClient({ adapter })
}

/** Lazily creates (and caches) the web Prisma client on first call. */
export function getWebPrismaClient() {
    if (!globalForPrisma.__webPrismaClient) {
        globalForPrisma.__webPrismaClient = createWebPrismaClient()
    }
    return globalForPrisma.__webPrismaClient
}

/** Closes the auth database pool only when it was actually opened. */
export async function disconnectWebPrismaClient(): Promise<void> {
    if (globalForPrisma.__webPrismaClient) {
        await globalForPrisma.__webPrismaClient.$disconnect()
        delete globalForPrisma.__webPrismaClient
    }
}
