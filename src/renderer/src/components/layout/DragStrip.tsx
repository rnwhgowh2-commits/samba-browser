import type React from 'react'
import { cn } from '@renderer/lib/utils'

// 제목 표시줄을 숨긴 창(titleBarStyle: 'hidden')은 드래그 영역을 직접 그려야 끌어서 옮길 수 있다.
// 위쪽 빈 곳에 깔아 두는 투명 띠 — 버튼·입력칸과 겹치지 않는 자리에만 둔다
export function DragStrip({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={cn('absolute inset-x-0 top-0 z-0 [-webkit-app-region:drag]', className)}
    />
  )
}
