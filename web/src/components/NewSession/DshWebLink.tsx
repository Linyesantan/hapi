import { useEffect, useState } from 'react'
import type { ApiClient, DshWebStatusResponse } from '@/api/client'
import { useTranslation } from '@/lib/use-translation'

export function DshWebLink(props: { api: ApiClient }) {
    const { t } = useTranslation()
    const [status, setStatus] = useState<DshWebStatusResponse | null>(null)

    useEffect(() => {
        let cancelled = false
        const load = () => {
            props.api.getDshWebStatus()
                .then(s => {
                    if (!cancelled) setStatus(s)
                })
                .catch(() => {})
        }
        load()
        const timer = setInterval(load, 10000)
        return () => {
            cancelled = true
            clearInterval(timer)
        }
    }, [props.api])

    if (!status?.running || !status.url) return null

    return (
        <div className="px-3 py-2">
            <a
                href={status.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-3 rounded-lg border border-[var(--app-divider)] px-3 py-2.5 text-sm transition-colors hover:bg-[var(--app-subtle-bg)]"
            >
                <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-green-500" aria-hidden />
                    <span className="font-medium">{t('newSession.dshWebRunning')}</span>
                </span>
                <span className="text-xs text-[var(--app-link)]">{t('newSession.dshWebOpen')}</span>
            </a>
        </div>
    )
}
