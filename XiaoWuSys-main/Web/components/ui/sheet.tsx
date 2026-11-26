"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as SheetPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { isToastTarget } from "@/lib/toast"
import { XIcon } from "lucide-react"
import { SUB_PAGE_FRAME, SubPageBody, SubPageContext } from "@/components/ui/sub-page"

/** page: open as a full sub page (components/ui/sub-page.tsx) instead of a side panel */
function Sheet({ page = false, ...props }: React.ComponentProps<typeof SheetPrimitive.Root> & { page?: boolean }) {
  return (
    <SubPageContext.Provider value={page}>
      <SheetPrimitive.Root data-slot="sheet" modal={!page} {...props} />
    </SubPageContext.Provider>
  )
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        // isolate + contain:strict: the blurred backdrop is its own layer, so the browser blurs the
        // page once and reuses it; scrolling the panel above it does not make it blur again
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 [contain:strict] supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  const page = React.useContext(SubPageContext)
  if (page) {
    return (
      <SheetPortal>
        <SheetPrimitive.Content
          data-slot="sheet-content"
          data-page=""
          className={SUB_PAGE_FRAME}
          onInteractOutside={(event) => {
            event.preventDefault()
            onInteractOutside?.(event)
          }}
          {...props}
        >
          <SubPageBody close={<SheetPrimitive.Close data-slot="sheet-close" asChild />}>{children}</SubPageBody>
        </SheetPrimitive.Content>
      </SheetPortal>
    )
  }
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          // isolate + contain: changes inside the panel never repaint the page or the blur under it
          "fixed isolate z-50 flex flex-col gap-4 bg-popover bg-clip-padding [contain:layout_paint] text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10",
          className
        )}
        onInteractOutside={(event) => {
          // Clicking a pop-up notice (components/feedback/toaster.tsx) is not "outside"
          if (isToastTarget(event.target)) {
            event.preventDefault()
            return
          }
          onInteractOutside?.(event)
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close data-slot="sheet-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-3 right-3"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPortal>
  )
}

/**
 * Classes for a sheet's scrolling body. They keep scrolling smooth on low-end computers while
 * the blurred backdrop stays exactly as it looks:
 *  - bg-popover: an opaque scroller lets the browser scroll it on the GPU (composited scrolling)
 *    instead of repainting the panel every frame
 *  - will-change scroll-position: asks for that GPU scrolling up front
 *  - contain content: layout and paint inside never spill out to the page behind
 *  - overscroll-contain: reaching the end does not try to scroll the (locked) page behind
 */
const SHEET_SCROLL_BODY = "bg-popover overscroll-contain [will-change:scroll-position] [contain:content]"

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-3 p-4", className)}
      {...props}
    />
  )
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("max-w-prose text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  SHEET_SCROLL_BODY,
}
