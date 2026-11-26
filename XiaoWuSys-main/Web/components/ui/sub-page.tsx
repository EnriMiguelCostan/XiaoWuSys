"use client"

// Sub pages: a detail view or a form that opens as its own page instead of a pop-up.
// <Dialog page> / <Sheet page> turn on this mode for everything inside.
//
// How it shows (fixed November 2026): the content is not laid over the screen. AppShell keeps
// an empty slot after the page in <main>; a sub page is rendered into that slot, and while the
// slot holds one, the page it came from is hidden (globals.css, "Sub pages"). So a sub page IS
// the page: same header and side menu, full width, scrolls like any page, and the list behind it
// keeps its filters and place for when Back brings it back. A sub page opened from a sub page
// (a payment from an order) shows on its own the same way; Back returns to the one before.
//
// Each screen gives its sub pages their own address (lib/sub-route.ts), e.g. /catalog/<id>, so
// the browser's Back button closes them and a link or a reload opens the same page again.
// Small questions (confirmations, results) stay pop-ups.
import * as React from "react"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"

export const SubPageContext = React.createContext(false)

/** The <main> slot sub pages render into (set by AppShell) */
export const SubPageSlotContext = React.createContext<HTMLElement | null>(null)

/** A sub page's own box: in the page flow, no overlay, no fixed position */
export const SUB_PAGE_FRAME = "block min-w-0 text-sm text-popover-foreground outline-none data-open:animate-in data-open:fade-in-0"

/** Opens at the top of the page; going Back puts the page behind where it was */
function useScrollToTop() {
  React.useLayoutEffect(() => {
    const before = window.scrollY
    window.scrollTo(0, 0)
    return () => {
      requestAnimationFrame(() => window.scrollTo(0, before))
    }
  }, [])
}

/** Back button, then the content in one wide card */
export function SubPageBody({ close, children }: { close: React.ReactElement; children: React.ReactNode }) {
  useScrollToTop()
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4">
      {React.cloneElement(close as React.ReactElement<{ children?: React.ReactNode }>, {
        children: (
          <Button variant="ghost" size="sm" className="-ml-2">
            <ArrowLeft aria-hidden /> Back
          </Button>
        ),
      })}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 rounded-xl bg-popover p-4 ring-1 ring-foreground/10 *:min-w-0">
        {children}
      </div>
    </div>
  )
}
