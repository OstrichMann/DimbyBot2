function unavailable() {
    return Response.json(
        {
            ok: false,
            error: { error: "Admin features are unavailable in the Fluxer music release" },
        },
        { status: 503 }
    )
}
export const GET = unavailable
export const POST = unavailable
export const DELETE = unavailable
