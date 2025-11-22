-- Check if the new columns exist in the SyncJob table
-- Run these queries in your PostgreSQL database to verify the migration

-- 1. Check if the columns exist and their data types
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'SyncJob'
    AND column_name IN ('errors', 'assetsCreated', 'assetsUpdated')
ORDER BY column_name;

-- 2. Check the full structure of the SyncJob table
SELECT 
    column_name, 
    data_type, 
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_name = 'SyncJob'
ORDER BY ordinal_position;

-- 3. Check if any sync jobs have data in the new columns
SELECT 
    id,
    status,
    assetsProcessed,
    assetsCreated,
    assetsUpdated,
    CASE 
        WHEN errors IS NULL THEN 'No errors'
        ELSE 'Has errors'
    END as error_status,
    LENGTH(errors) as errors_length,
    startedAt,
    completedAt
FROM "SyncJob"
ORDER BY createdAt DESC
LIMIT 10;

-- 4. Count sync jobs with the new fields populated
SELECT 
    COUNT(*) as total_jobs,
    COUNT(assetsCreated) as jobs_with_created_count,
    COUNT(assetsUpdated) as jobs_with_updated_count,
    COUNT(errors) as jobs_with_errors,
    SUM(assetsCreated) as total_assets_created,
    SUM(assetsUpdated) as total_assets_updated
FROM "SyncJob";

-- 5. Check the most recent sync job details (if any exist)
SELECT 
    id,
    status,
    assetsProcessed,
    assetsCreated,
    assetsUpdated,
    errors,
    startedAt,
    completedAt,
    createdAt
FROM "SyncJob"
WHERE status = 'completed'
ORDER BY completedAt DESC
LIMIT 1;

