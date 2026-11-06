import type { ReactNode } from "react"
export default function AdminLayout({ children }: { children: ReactNode }) {
    return <main className="mx-auto max-w-4xl p-6">{children}</main>
}
