// Shapes of the inventory API (Backend/routes/inventory.js, services/inventorySnapshot.js).
// Types only: every number and status here is computed by the server and only displayed.
import { can, type Capability, type SessionUser } from '@xiaowu/client-core/permissions';

export type StockStatus = 'in_stock' | 'low_stock' | 'out_of_stock';

export interface InventoryItem {
  inventory_id: string;
  item_name: string;
  item_category: string;
  unit: string | null;
  supplier: string | null;
  quantity_available: number;
  quantity_reserved: number;
  /** free to use = on hand minus reserved, computed by the server */
  quantity_available_net: number;
  minimum_threshold: number;
  unit_cost: number;
  /** on hand x unit cost, computed by the server (absent on an older server) */
  stock_value?: number;
  stock_status: StockStatus | string;
  sync_status: string;
  version?: number | null;
  deleted_at?: string | null;
}

export interface InventorySummary {
  total_items: number;
  in_stock: number;
  low_stock: number;
  out_of_stock: number;
  unsynced: number;
  recycle_bin: number;
  /** whole catalog, computed by the server */
  stock_value: number;
  /** units on hand across the active catalog, computed by the server (absent on an older server) */
  total_units?: number;
}

/** GET /api/inventory and the "inventory_updated" socket event */
export interface InventorySnapshot {
  source: 'cloud' | 'local' | null;
  fetched_at: string | null;
  summary: InventorySummary;
  categories: string[];
  items: InventoryItem[];
}

/** GET /api/inventory/recycle-bin */
export interface RecycleBinPage {
  source?: 'cloud' | 'local';
  items: InventoryItem[];
  total: number;
  limit: number;
  offset: number;
  retention_days: number;
}

// ---------------------------------------------------------------------------------------------
// Who may change the catalog
//
// The catalog has its own capabilities (Batch M6; Backend/services/domain/permissions.js), the
// same ones Backend/routes/inventory.js guards its routes with:
//   edit_inventory   add, edit, stock changes, move to / restore from the Recycle Bin
//   purge_inventory  delete forever, empty the Recycle Bin
// Hiding is cosmetic either way: Express answers 403 to anyone else.
// ---------------------------------------------------------------------------------------------
const INVENTORY_EDIT: Capability = 'edit_inventory';
const INVENTORY_PURGE: Capability = 'purge_inventory';

export const canEditInventory = (user: SessionUser | null) => can(user, INVENTORY_EDIT);
export const canPurgeInventory = (user: SessionUser | null) => can(user, INVENTORY_PURGE);

// Suggestions only: any unit can be typed
export const COMMON_UNITS = ['pcs', 'pack', 'ream', 'box', 'roll', 'meter', 'yard', 'bottle', 'pad', 'set', 'sheet'];

/** Saved-offline note appended to success messages (data.source === 'local'). */
export const offlineNote = (data: { source?: unknown }) =>
  data.source === 'local' ? '\nSaved offline: it will sync to the cloud when the connection returns.' : '';

/**
 * Form text -> JSON number for the request (the server rejects "5"). Input check only
 * ("is it a number?"); limits such as whole numbers, 2 decimals or ranges are the server's
 * to enforce, and its plain-language 400 message is shown.
 *   '' -> undefined (field left out, the server applies its default), 'abc' -> NaN
 */
export const toNumberInput = (text: string): number | undefined => {
  const t = text.trim();
  return t === '' ? undefined : Number(t);
};
