"use client"

// "Sub pages" (November 2026): a detail view or a form that opens as a full page inside the app
// instead of a small pop-up. <Dialog page> / <Sheet page> turn on this mode for everything inside:
// the content fills the page area under the header and next to the side menu (both stay usable),
// with a Back button at the top. Small questions (confirmations, results) stay pop-ups.
import * as React from "react"
import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui/button"

export const SubPageContext = React.createContext(false)

/** The page area: under the sticky header, right of the side menu on wide screens */
export const SUB_PAGE_FRAME =
  "fixed inset-x-0 bottom-0 top-[var(--shell-offset,0px)] z-30 overflow-y-auto overscroll-contain bg-muted/30 text-sm text-popover-foreground outline-none lg:left-60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"

/** Back button, then the content in one wide card */
export function SubPageBody({ close, children }: { close: React.ReactElement; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 sm:px-6">
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
