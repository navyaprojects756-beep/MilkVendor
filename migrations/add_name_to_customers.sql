-- Add name column to customers table
ALTER TABLE customers ADD COLUMN IF NOT EXISTS name TEXT;
