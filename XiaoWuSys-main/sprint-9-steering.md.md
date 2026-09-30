# Project: XiaoWuSys Sprint 9 - Inventory Capacity Checks

## Objective
Implement backend capacity validation to evaluate incoming order quantities against current stock, halting impossible orders before approval[cite: 6]. Build a frontend UI for staff to handle these halted orders by selecting delay or cancellation options[cite: 6].

## Tech Stack
- Backend: Node.js, Express.js
- Database: Dual Architecture (PostgreSQL via Neon for cloud, SQLite for offline cache)
- Frontend: React (NextJS/Vite), Tailwind CSS

## Core Requirements
1. Context Gathering: Before writing any code, read the existing backend inventory routes (`routes/inventory.js`), the order creation routes, and the database schema files for tables relating to inventory and orders to understand the current data structure.
2. Backend Pre-Check Route (PB 9): Create an Express route (e.g., `POST /api/inventory/check-capacity`) that receives an incoming order quantity and strictly evaluates it against the current stock level in the database[cite: 6]. 
3. Halt Logic (PB 9): If the requested quantity exceeds available stock, the backend must return a specific error code (e.g., 409 Conflict) and a JSON payload detailing the deficit, halting the approval process[cite: 6].
4. Frontend Alert UI (PB 10): Update the React order creation component to catch this backend error. When caught, render a warning modal stating that the order exceeds maximum inventory[cite: 6].
5. Resolution Options (PB 10): Include interactive options in the frontend modal allowing the staff member to log a resolution by clicking either "Delay Order" or "Cancel Order" so expectations are managed[cite: 6].