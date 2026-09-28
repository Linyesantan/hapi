import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useTranslation } from '@/lib/use-translation'
import { useSyncExternalStore } from 'react'
import type { OfflineCache } from '@/lib/offline-cache'

const subscribeNothing = () => () => {}
const onlineSnapshot = () => 'online'

export function OfflineBanner({
    isHubConnected,
    isReconnecting,
    cache
}: {
    isHubConnected: boolean
    isReconnecting: boolean
    cache?: OfflineCache | null
}) {
    const { t } = useTranslation()
    const isOnline = useOnlineStatus()
    const status = useSyncExternalStore(cache?.subscribe ?? subscribeNothing, cache?.getStatus ?? onlineSnapshot)

    if (status === 'online' && (isOnline || isHubConnected || isReconnecting)) {
        return null
    }

    return (
        <div role="status" data-testid="offline-cache-status" className="shrink-0 bg-amber-600 text-white text-center px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] text-sm font-medium z-50">
            {status === 'storage-error' ? '本地缓存写入失败，请检查浏览器存储空间。'
                : status === 'offline' ? '离线阅读 · 已同步内容可翻阅，连接恢复后自动补齐' : t('offline.message')}
        </div>
    )
}
