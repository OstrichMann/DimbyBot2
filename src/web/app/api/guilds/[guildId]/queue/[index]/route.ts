import { proxyBotApi } from "@/server/bot-api-proxy"

/** The Bot verifies the forwarded session and all guild permissions. */
export async function DELETE(request: Request) {
    return proxyBotApi(request)
}
export async function PATCH(request: Request) {
    return proxyBotApi(request)
}
