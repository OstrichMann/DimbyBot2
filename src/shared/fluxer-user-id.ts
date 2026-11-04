/** Fluxer IDs are opaque positive uint64 strings; no Discord timestamp or length assumptions. */
export function isFluxerId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[1-9]\d{0,19}$/.test(value) &&
        BigInt(value) <= (1n << 64n) - 1n
    )
}
