-- Add pre-command fields to monitor table
BEGIN TRANSACTION;

-- Add up status pre-command field
ALTER TABLE monitor ADD COLUMN pre_up_command TEXT;

-- Add down status pre-command field  
ALTER TABLE monitor ADD COLUMN pre_down_command TEXT;

COMMIT; 