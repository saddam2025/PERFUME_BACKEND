const mongoose = require('mongoose');

/**
 * Establishes a connection to the MongoDB database.
 * Database Name: toronto_db
 *
 * Expects process.env.MONGO_URI to be set (see .env.example).
 * If the URI does not already specify a database name, 'toronto_db'
 * will be used as the default via the dbName option.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      dbName: 'deja_perfume', // Default database name if not specified in URI
    });

    console.log(`[MongoDB] Connected: ${conn.connection.host}`);
    console.log(`[MongoDB] Database: ${conn.connection.name}`);
  } catch (error) {
    console.error(`[MongoDB] Connection Error: ${error.message}`);
    // Exit process with failure since the app cannot function without DB
    process.exit(1);
  }
};

// Optional: log unexpected runtime disconnects (e.g., network blip)
mongoose.connection.on('disconnected', () => {
  console.warn('[MongoDB] Connection lost. Attempting to reconnect is handled by the driver.');
});

module.exports = connectDB;
