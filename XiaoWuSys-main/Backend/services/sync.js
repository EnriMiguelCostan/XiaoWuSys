// You will need to pass in your active database connections when calling this
const syncOfflineData = async (pgPool, localDb) => {
  console.log('🔄 Checking for offline data to sync...');

  // Helper function to query SQLite using Promises
  const getPendingRecords = (tableName) => {
    return new Promise((resolve, reject) => {
      localDb.all(
        `SELECT * FROM ${tableName} WHERE sync_status = 'pending_insert' OR sync_status = 'pending_update'`,
        [],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  };

  // Helper function to mark records as synced in SQLite
  const markAsSynced = (tableName, idColumn, idValue) => {
    return new Promise((resolve, reject) => {
      localDb.run(
        `UPDATE ${tableName} SET sync_status = 'synced' WHERE ${idColumn} = ?`,
        [idValue],
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
  };

  try {
    // ==========================================
    // SYNC: ORDER PROFILES
    // ==========================================
    const pendingOrders = await getPendingRecords('order_profiles');
    
    if (pendingOrders.length > 0) {
      console.log(`📦 Found ${pendingOrders.length} pending orders. Syncing to Cloud...`);
      
      for (const order of pendingOrders) {
        try {
          // INSERT into PostgreSQL. 
          // ON CONFLICT DO UPDATE handles 'pending_update' seamlessly.
          await pgPool.query(
            `INSERT INTO order_profiles (order_id, customer_id, production_deadline, production_status, design_drive_link, total_quote_amount) 
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (order_id) DO UPDATE SET 
                production_deadline = EXCLUDED.production_deadline,
                production_status = EXCLUDED.production_status,
                design_drive_link = EXCLUDED.design_drive_link,
                total_quote_amount = EXCLUDED.total_quote_amount`,
            [
              order.order_id, 
              order.customer_id, 
              order.production_deadline, 
              order.production_status, 
              order.design_drive_link, 
              order.total_quote_amount
            ]
          );

          // If the cloud push succeeds, update the local SQLite status
          await markAsSynced('order_profiles', 'order_id', order.order_id);
          console.log(`✅ Synced Order: ${order.order_id}`);

        } catch (syncErr) {
          console.error(`❌ Failed to sync order ${order.order_id}:`, syncErr.message);
          // It will remain 'pending' and try again on the next cycle
        }
      }
    } else {
      console.log('✅ No pending orders to sync.');
    }

    // You will duplicate the block above for order_items, material_loss, etc.
    // const pendingItems = await getPendingRecords('order_items');
    // ...

  } catch (error) {
    console.error('❌ Critical Sync Error:', error);
  }
};

module.exports = { syncOfflineData };