import type { Metadata } from "next"
import type { LucideIcon } from "lucide-react"
import {
  HandCoins,
  PackageX,
  PhilippinePeso,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Dashboard · XiaoMei ERP" }

/* -------------------------------------------------------------------------- */
/* Mock data (prototype only, no backend).                                    */
/* Some values are deliberately oversized to stress-test overflow handling.   */
/* -------------------------------------------------------------------------- */

type OrderStatus = "Pending" | "Completed" | "Cancelled"
type PaymentStatus = "Unpaid" | "Partial" | "Fully Paid"

type Order = {
  id: string
  customer: string
  items: number
  total: number
  payment: PaymentStatus
  status: OrderStatus
  date: string
}

type LowStockItem = { sku: string; name: string; onHand: number; reorderAt: number }

const LOW_STOCK_ITEMS: LowStockItem[] = [
  { sku: "BRD-0042", name: "Pandesal Flour 25kg", onHand: 3, reorderAt: 10 },
  { sku: "PKG-1180", name: "Kraft Paper Bag (Medium)", onHand: 40, reorderAt: 200 },
  { sku: "DRY-0007", name: "Muscovado Sugar 1kg", onHand: 0, reorderAt: 15 },
  {
    sku: "INGR-000000000000000000000000000000991",
    name: "UltraPremiumImportedMadagascarBourbonVanillaBeanExtractConcentrate500ml",
    onHand: 1,
    reorderAt: 6,
  },
]

const SUMMARY = {
  activeOrders: 128,
  activeOrdersDelta: 12,
  pendingDownpayments: 37,
  pendingDownpaymentAmount: 184_250.5,
  salesToday: 98_765_432_109_876.55, // intentionally massive
  salesTodayDelta: -4.3,
  lowStockCount: LOW_STOCK_ITEMS.length,
}

const RECENT_ORDERS: Order[] = [
  { id: "SO-2026-11-0412", customer: "Dela Cruz Bakeshop", items: 14, total: 12_450, payment: "Fully Paid", status: "Completed", date: "2026-11-13T09:42:00" },
  { id: "SO-2026-11-0411", customer: "Maria Santos", items: 3, total: 1_870.75, payment: "Partial", status: "Pending", date: "2026-11-13T09:15:00" },
  { id: "SO-2026-11-0410", customer: "Kusina ni Lola Catering Services Inc.", items: 52, total: 88_300, payment: "Unpaid", status: "Pending", date: "2026-11-13T08:51:00" },
  { id: "SO-2026-11-0409", customer: "J. Reyes", items: 1, total: 350, payment: "Fully Paid", status: "Cancelled", date: "2026-11-12T17:30:00" },
  {
    id: "SO-2026-11-0408-REPLACEMENT-FOR-0391-BATCH-B-REISSUED",
    customer: "SuperLongCorporateCustomerNameWithoutAnySpacesHoldingsAndSubsidiariesPhilippines",
    items: 9_999_999,
    total: 9_876_543_210_987.65,
    payment: "Partial",
    status: "Pending",
    date: "2026-11-12T16:05:00",
  },
  { id: "SO-2026-11-0407", customer: "Tindahan ni Aling Nena", items: 6, total: 4_215.25, payment: "Fully Paid", status: "Completed", date: "2026-11-12T14:22:00" },
  { id: "SO-2026-11-0406", customer: "Bautista Family Reunion", items: 22, total: 31_900, payment: "Partial", status: "Pending", date: "2026-11-12T11:48:00" },
]

/* -------------------------------------------------------------------------- */
/* Formatting + status token → style maps (one place per component).          */
/* -------------------------------------------------------------------------- */

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" })
const count = new Intl.NumberFormat("en-PH")
const dateTime = new Intl.DateTimeFormat("en-PH", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

const ORDER_STATUS_STYLES: Record<OrderStatus, string> = {
  Pending: "bg-amber-100 text-amber-900 dark:bg-amber-400/15 dark:text-amber-300",
  Completed: "bg-emerald-100 text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-300",
  Cancelled: "bg-destructive/10 text-destructive dark:bg-destructive/20",
}

const PAYMENT_STATUS_STYLES: Record<PaymentStatus, string> = {
  "Fully Paid": "border-emerald-300 text-emerald-800 dark:border-emerald-400/40 dark:text-emerald-300",
  Partial: "border-sky-300 text-sky-800 dark:border-sky-400/40 dark:text-sky-300",
  Unpaid: "border-border text-muted-foreground",
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default function DashboardPage() {
  return (
    <>
      <LowStockBanner items={LOW_STOCK_ITEMS} />

      <main className="mx-auto flex w-full max-w-7xl min-w-0 flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="truncate text-sm text-muted-foreground">
            Snapshot of today&apos;s orders, payments and stock.
          </p>
        </header>

        <section
          aria-label="Summary"
          className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <SummaryCard
            title="Active Orders"
            icon={ShoppingCart}
            value={count.format(SUMMARY.activeOrders)}
            footnote={`+${count.format(SUMMARY.activeOrdersDelta)} since yesterday`}
            trend="up"
          />
          <SummaryCard
            title="Pending Downpayments"
            icon={HandCoins}
            value={count.format(SUMMARY.pendingDownpayments)}
            footnote={`${peso.format(SUMMARY.pendingDownpaymentAmount)} outstanding`}
          />
          <SummaryCard
            title="Total Sales Today"
            icon={PhilippinePeso}
            value={peso.format(SUMMARY.salesToday)}
            footnote={`${SUMMARY.salesTodayDelta}% vs. same time yesterday`}
            trend={SUMMARY.salesTodayDelta >= 0 ? "up" : "down"}
          />
          <SummaryCard
            title="Low-Stock Items"
            icon={PackageX}
            value={count.format(SUMMARY.lowStockCount)}
            footnote="At or below reorder level"
            tone="warning"
          />
        </section>

        <RecentOrders orders={RECENT_ORDERS} />
      </main>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

function LowStockBanner({ items }: { items: LowStockItem[] }) {
  if (items.length === 0) return null
  const names = items.map((i) => i.name).join(", ")

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-yellow-300 bg-yellow-100 text-yellow-950 dark:border-yellow-500/40 dark:bg-yellow-950 dark:text-yellow-100"
    >
      <div className="mx-auto flex w-full max-w-7xl min-w-0 items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <TriangleAlert className="size-5 shrink-0 text-yellow-700 dark:text-yellow-400" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-sm" title={names}>
          <span className="font-semibold">Low-stock warning:</span>{" "}
          {items.length} {items.length === 1 ? "item is" : "items are"} at or below reorder level ({names})
        </p>
      </div>
    </div>
  )
}

function SummaryCard({
  title,
  icon: Icon,
  value,
  footnote,
  trend,
  tone,
}: {
  title: string
  icon: LucideIcon
  value: string
  footnote: string
  trend?: "up" | "down"
  tone?: "warning"
}) {
  const TrendIcon = trend === "down" ? TrendingDown : TrendingUp

  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardDescription className="min-w-0 truncate" title={title}>
          {title}
        </CardDescription>
        <CardAction>
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground",
              tone === "warning" &&
                "bg-yellow-100 text-yellow-800 dark:bg-yellow-400/15 dark:text-yellow-300"
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        </CardAction>
        <CardTitle
          className="min-w-0 truncate text-2xl font-semibold tabular-nums"
          title={value}
        >
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        {trend && (
          <TrendIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0",
              trend === "up" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
            )}
          />
        )}
        <span className="min-w-0 truncate" title={footnote}>
          {footnote}
        </span>
      </CardContent>
    </Card>
  )
}

function RecentOrders({ orders }: { orders: Order[] }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="min-w-0">
        <CardTitle className="truncate">Recent Orders</CardTitle>
        <CardDescription className="truncate">
          Latest {orders.length} sales orders across all channels.
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 px-0">
        <Table className="table-fixed">
          {/* table-fixed: widths come from this header row; Customer takes the rest. */}
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4 sm:w-48">Order #</TableHead>
              <TableHead className="hidden sm:table-cell">Customer</TableHead>
              <TableHead className="hidden w-24 text-right md:table-cell">Items</TableHead>
              <TableHead className="w-28 text-right sm:w-44">Total</TableHead>
              <TableHead className="hidden w-28 lg:table-cell">Payment</TableHead>
              <TableHead className="w-28 pr-4 xl:pr-2">Status</TableHead>
              <TableHead className="hidden w-36 pr-4 xl:table-cell">Date</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((order) => (
              <TableRow key={order.id}>
                <TableCell className="pl-4">
                  <Cell className="font-mono text-xs" value={order.id} />
                  {/* Phones: customer stacks under the order number. */}
                  <Cell
                    className="text-xs text-muted-foreground sm:hidden"
                    value={order.customer}
                  />
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Cell className="font-medium" value={order.customer} />
                </TableCell>
                <TableCell className="hidden text-right md:table-cell">
                  <Cell className="tabular-nums" value={count.format(order.items)} />
                </TableCell>
                <TableCell className="text-right">
                  <Cell className="tabular-nums" value={peso.format(order.total)} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Badge
                    variant="outline"
                    className={cn("max-w-full", PAYMENT_STATUS_STYLES[order.payment])}
                  >
                    <span className="truncate">{order.payment}</span>
                  </Badge>
                </TableCell>
                <TableCell className="pr-4 xl:pr-2">
                  <Badge className={cn("max-w-full", ORDER_STATUS_STYLES[order.status])}>
                    <span className="truncate">{order.status}</span>
                  </Badge>
                </TableCell>
                <TableCell className="hidden pr-4 text-muted-foreground xl:table-cell">
                  <Cell value={dateTime.format(new Date(order.date))} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/** Truncating table-cell content; full value stays available on hover. */
function Cell({ value, className }: { value: string; className?: string }) {
  return (
    <div className={cn("min-w-0 truncate", className)} title={value}>
      {value}
    </div>
  )
}