import { createRef } from 'react'
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useComposerScrollVisibility } from './useComposerScrollVisibility'

describe('翻历史时收回输入框', () => {
    it('向下触滑收起，上划恢复，程序滚动和内嵌终端滚动不改变输入框', () => {
        const viewport = createRef<HTMLDivElement>()
        const { getByTestId } = render(<div ref={viewport}><pre data-testid="terminal" data-hapi-nested-scroll="true">内容</pre></div>)
        const changed = vi.fn()
        renderHook(() => useComposerScrollVisibility(viewport, changed))
        fireEvent.touchStart(viewport.current!, { touches: [{ clientY: 200 }] })
        fireEvent.touchMove(viewport.current!, { touches: [{ clientY: 250 }] })
        expect(changed).toHaveBeenLastCalledWith(false)
        fireEvent.touchMove(viewport.current!, { touches: [{ clientY: 190 }] })
        expect(changed).toHaveBeenLastCalledWith(true)
        changed.mockClear()
        fireEvent.scroll(viewport.current!)
        fireEvent.wheel(getByTestId('terminal'), { deltaY: -100 })
        fireEvent.touchStart(getByTestId('terminal'), { touches: [{ clientY: 200 }] })
        fireEvent.touchMove(getByTestId('terminal'), { touches: [{ clientY: 250 }] })
        expect(changed).not.toHaveBeenCalled()
    })
    it('滚轮和键盘方向一致，微小抖动不切换，卸载后移除监听', () => {
        const viewport = createRef<HTMLDivElement>()
        render(<div ref={viewport} />)
        const changed = vi.fn()
        const hook = renderHook(() => useComposerScrollVisibility(viewport, changed))
        fireEvent.wheel(viewport.current!, { deltaY: -4 })
        expect(changed).not.toHaveBeenCalled()
        fireEvent.wheel(viewport.current!, { deltaY: -40 })
        expect(changed).toHaveBeenLastCalledWith(false)
        fireEvent.keyDown(viewport.current!, { key: 'PageDown' })
        expect(changed).toHaveBeenLastCalledWith(true)
        hook.unmount()
        changed.mockClear()
        act(() => viewport.current!.dispatchEvent(new WheelEvent('wheel', { deltaY: -80 })))
        expect(changed).not.toHaveBeenCalled()
    })
})
