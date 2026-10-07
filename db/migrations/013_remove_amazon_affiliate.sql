-- Remove the retired Amazon affiliate product feature flag.
DELETE FROM feature_flags
WHERE key = 'amazon_affiliate';
