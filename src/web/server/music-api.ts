import { serverFetchBot } from "@/server/fetch-bot-api"
import { parseBotApiActionResponse, type BotApiActionResult } from "@/lib/parse-bot-api-response"

/** Cookies are forwarded by serverFetchBot; identity and permissions are verified by the Bot. */
export async function musicApi<T>(
    path: string,
    method = "GET",
    body?: unknown
): Promise<BotApiActionResult<T>> {
    try {
        return await parseBotApiActionResponse<T>(
            await serverFetchBot(path, {
                method,
                ...(body !== undefined
                    ? { body: JSON.stringify(body), contentType: "application/json" }
                    : {}),
            })
        )
    } catch {
        return { ok: false, error: "The music service is unavailable. Please try again." }
    }
}
