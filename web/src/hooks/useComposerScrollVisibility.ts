import { useEffect, useRef, type RefObject } from 'react'

/** Only deliberate gestures change the composer. History prepends and streaming
 * resize/scroll events must not hide it or discard the current draft. */
export function useComposerScrollVisibility(
    viewportRef: RefObject<HTMLElement | null>,
    onChange?: (visible: boolean) => void,
) {
    const callback = useRef(onChange)
    callback.current = onChange
    useEffect(() => {
        const viewport = viewportRef.current
        if (!viewport || !onChange) return
        let touchY: number | null = null
        let distance = 0
        const nested = (event: Event) => event.target instanceof Element
            && Boolean(event.target.closest('[data-hapi-nested-scroll="true"], textarea, input, [contenteditable="true"]'))
        const move = (delta: number) => {
            if (Math.sign(delta) !== Math.sign(distance)) distance = 0
            distance += delta
            if (Math.abs(distance) < 14) return
            callback.current?.(distance > 0)
            distance = 0
        }
        const wheel = (event: WheelEvent) => {
            if (!nested(event) && !event.ctrlKey) move(event.deltaY)
        }
        const start = (event: TouchEvent) => {
            touchY = nested(event) || event.touches.length !== 1 ? null : event.touches[0].clientY
            distance = 0
        }
        const touch = (event: TouchEvent) => {
            if (touchY === null || event.touches.length !== 1) return
            const next = event.touches[0].clientY
            move(touchY - next)
            touchY = next
        }
        const end = () => { touchY = null; distance = 0 }
        const key = (event: KeyboardEvent) => {
            if (nested(event) || event.defaultPrevented) return
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) callback.current?.(false)
            if (['ArrowDown', 'PageDown', 'End'].includes(event.key)) callback.current?.(true)
        }
        viewport.addEventListener('wheel', wheel, { passive: true })
        viewport.addEventListener('touchstart', start, { passive: true })
        viewport.addEventListener('touchmove', touch, { passive: true })
        viewport.addEventListener('touchend', end, { passive: true })
        viewport.addEventListener('touchcancel', end, { passive: true })
        viewport.addEventListener('keydown', key)
        return () => {
            viewport.removeEventListener('wheel', wheel)
            viewport.removeEventListener('touchstart', start)
            viewport.removeEventListener('touchmove', touch)
            viewport.removeEventListener('touchend', end)
            viewport.removeEventListener('touchcancel', end)
            viewport.removeEventListener('keydown', key)
        }
    }, [viewportRef, Boolean(onChange)])
}
