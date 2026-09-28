import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'

export type ComposerRevealHandle = { setVisible: (visible: boolean) => void }

/** Keep the composer mounted so scrolling never discards text or uploads. */
export function ComposerReveal(props: { ref?: Ref<ComposerRevealHandle>; children: ReactNode }) {
    const [visible, setVisible] = useState(true)
    const container = useRef<HTMLDivElement>(null)
    const content = useRef<HTMLDivElement>(null)
    const [height, setHeight] = useState<number>()
    const [animating, setAnimating] = useState(false)
    const desired = useRef(true)
    const frames = useRef<[number, number]>([0, 0])
    const reveal = useCallback((next: boolean) => {
        if (desired.current === next) return
        desired.current = next
        if (!next && document.activeElement instanceof HTMLElement
            && container.current?.contains(document.activeElement)) document.activeElement.blur()
        frames.current.forEach(cancelAnimationFrame)
        // Let scroll anchoring and viewport updates paint before starting the
        // transition, so a costly history layout cannot skip its first frames.
        frames.current[0] = requestAnimationFrame(() => {
            frames.current[1] = requestAnimationFrame(() => setVisible(desired.current))
        })
    }, [])
    useImperativeHandle(props.ref, () => ({ setVisible: reveal }), [reveal])
    useEffect(() => () => frames.current.forEach(cancelAnimationFrame), [])
    useLayoutEffect(() => {
        const element = content.current
        if (!element) return
        const measure = () => setHeight(element.getBoundingClientRect().height)
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
    }, [])
    useEffect(() => {
        setAnimating(true)
        const timer = window.setTimeout(() => setAnimating(false), 240)
        return () => window.clearTimeout(timer)
    }, [visible])
    return <>
        {!visible ? <button type="button" className="shrink-0 self-end px-3 py-1 text-xs text-[var(--app-link)]" onClick={() => reveal(true)}>显示输入框</button> : null}
        <div
        ref={container}
        data-testid="composer-reveal"
        aria-hidden={!visible}
        inert={!visible}
        className={`shrink-0 transition-[height,opacity,transform] duration-200 ease-out motion-reduce:transition-none ${!visible || animating ? 'overflow-hidden' : ''}`}
        style={{ height: visible ? height ?? 'auto' : 0, opacity: visible ? 1 : 0,
            transform: visible ? 'translateY(0)' : 'translateY(12px)' }}
    >
        <div ref={content} className="flow-root">{props.children}</div>
    </div>
    </>
}
