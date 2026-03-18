const { Pool } = require("pg")

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for cloud DB
})

module.exports = pool