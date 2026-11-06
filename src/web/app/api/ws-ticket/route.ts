/** Native live updates authenticate session cookies during the WebSocket upgrade. */
export function GET() {
    return Response.json(
        { error: "Use the cookie-authenticated Fluxer WebSocket" },
        { status: 410 }
    )
}
