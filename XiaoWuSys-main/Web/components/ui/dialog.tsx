"use client"

import * as React from "react"
import { cn } from "cn"
import { Dialog as DialogPrimitive } from "radix-ui"

import { Button } from "@/components/ui/button"
import { isToastTarget } from "@/lib/toast"
import { XIcon } from "lucide-react"
import { SUB_PAGE_FRAME, SubPageBody, SubPageContext } from "@/components/ui/sub-page"

/** page: open as a full sub page (components/ui/sub-page.tsx) instead of a pop-up */
function Dialog({
  page = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root> & { page?: boolean }) {
  return (
    <SubPageContext.Provider value={page}>
      <DialogPrimitive.Root data-slot="dialog" modal={!page} {...props} />
    </SubPageContext.Provider>
  )
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  dismissible = false,
  overlayClassName,
  onInteractOutside,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  /** extra classes for the dimmed background behind the dialog (e.g. a stronger blur) */
  overlayClassName?: string
  /**
   * false (default): a click / tap outside or the Escape key does NOT close the dialog, so a
   * misclick never throws away what was typed. Only Cancel and the X close it.
   * true: for read-only messages (e.g. ResultDialog) that are safe to dismiss anywhere.
   */
  dismissible?: boolean
}) {
  const page = React.useContext(SubPageContext)
  if (page) {
    return (
      <DialogPortal>
        <DialogPrimitive.Content
          data-slot="dialog-content"
          data-page=""
          className={SUB_PAGE_FRAME}
          onInteractOutside={(event) => {
            // A sub page closes only with Back (or by leaving the page)
            event.preventDefault()
            onInteractOutside?.(event)
          }}
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault()
            onEscapeKeyDown?.(event)
          }}
          {...props}
        >
          <SubPageBody close={<DialogPrimitive.Close data-slot="dialog-close" asChild />}>{children}</SubPageBody>
        </DialogPrimitive.Content>
      </DialogPortal>
    )
  }
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // grid-cols-[minmax(0,1fr)] + *:min-w-0: grid children may be narrower than their content,
          // so one long unbroken string (e.g. a selected item name) can't widen the form, its
          // buttons and info boxes past the dialog. (No *:max-w-full: footers bleed with -mx-4.)
          "fixed top-1/2 left-1/2 z-50 grid w-full grid-cols-[minmax(0,1fr)] *:min-w-0 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        onInteractOutside={(event) => {
          // Clicking a pop-up notice (components/feedback/toaster.tsx) is not "outside"
          if (!dismissible || isToastTarget(event.target)) {
            event.preventDefault()
            return
          }
          onInteractOutside?.(event)
        }}
        onEscapeKeyDown={(event) => {
          if (!dismissible) event.preventDefault()
          onEscapeKeyDown?.(event)
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              className="absolute top-2 right-2"
              size="icon-sm"
            >
              <XIcon
              />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      // pt-2 + pr-8: room for the X button in the top-right corner, so a long title wraps
      // before reaching it instead of running underneath it
      className={cn("flex min-w-0 flex-col gap-2 pt-2 pr-8", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-3 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-snug font-medium wrap-anywhere [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "max-w-prose text-sm leading-relaxed text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
