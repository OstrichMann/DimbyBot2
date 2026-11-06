import { proxyBotApi } from "@/server/bot-api-proxy"

/** The Bot verifies the forwarded session and all guild permissions. */
export async function POST(request: Request) {
    return proxyBotApi(request)
}
