import { useEffect, useState } from 'react'
import { getPhoneCurfew } from '@hapi/protocol/phoneCurfew'

export function usePhoneCurfew(enabled: boolean) {
    const [state, setState] = useState(getPhoneCurfew)
    useEffect(() => {
        if (!enabled) return
        const update = () => {
            const next = getPhoneCurfew()
            setState(current => current.restricted === next.restricted && current.nextChangeAt === next.nextChangeAt ? current : next)
        }
        update()
        const timer = window.setInterval(update, 1000)
        window.addEventListener('visibilitychange', update)
        return () => { window.clearInterval(timer); window.removeEventListener('visibilitychange', update) }
    }, [enabled])
    return { ...state, restricted: enabled && state.restricted }
}

export function PhoneCurfewBanner(props: { restricted: boolean; message: string }) {
    return props.restricted ? <div role="status" className="shrink-0 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs">{props.message}</div> : null
}
