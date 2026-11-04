import { EventEmitter } from "node:events"

export class FakeFluxerSocket extends EventEmitter {
    readyState = 1
    sent: { op: number; d: unknown }[] = []
    send(value: string) {
        this.sent.push(JSON.parse(value))
    }
    close(code = 1000) {
        this.readyState = 3
        this.emit("close", code)
    }
    packet(value: unknown) {
        this.emit("message", Buffer.from(JSON.stringify(value)))
    }
}

export class FluxerClock {
    now = 0
    private tasks = new Map<number, { at: number; callback: () => void }>()
    private next = 0
    schedule = (callback: () => void, ms: number): (() => void) => {
        const id = ++this.next
        this.tasks.set(id, { at: this.now + ms, callback })
        return () => {
            this.tasks.delete(id)
        }
    }
    async advance(ms: number) {
        const end = this.now + ms
        for (;;) {
            const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]
            if (!next || next[1].at > end) break
            this.now = next[1].at
            this.tasks.delete(next[0])
            next[1].callback()
            await flushFluxer()
        }
        this.now = end
        await flushFluxer()
    }
    get pending() {
        return this.tasks.size
    }
}

export async function flushFluxer() {
    await new Promise<void>((resolve) => setImmediate(resolve))
}
