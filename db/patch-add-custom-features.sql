-- Add columns for HTTP(s) with DB Check Feature
ALTER TABLE monitor ADD COLUMN database_password TEXT;
ALTER TABLE monitor ADD COLUMN database_max_rows INTEGER DEFAULT 10;

-- Add columns for Consecutive UP/DOWN Notification Feature
ALTER TABLE monitor ADD COLUMN consecutive_ups INTEGER DEFAULT 1;
ALTER TABLE monitor ADD COLUMN consecutive_downs INTEGER DEFAULT 1;
ALTER TABLE heartbeat ADD COLUMN up_count INTEGER DEFAULT 0;