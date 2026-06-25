-- Retired AccessFeatures value `workoutVideos` was merged into `workoutPlan`.
-- Prisma no longer maps the old enum label, so rows still storing it fail
-- on read (P2023). Rewrite arrays in place.

UPDATE "Plans"
SET "accessFeatures" = (
  SELECT COALESCE(
    array_agg(
      CASE
        WHEN val::text = 'workoutVideos' THEN 'workoutPlan'::"AccessFeatures"
        ELSE val
      END
    ),
    ARRAY[]::"AccessFeatures"[]
  )
  FROM unnest("accessFeatures") AS val
)
WHERE EXISTS (
  SELECT 1 FROM unnest("accessFeatures") AS val WHERE val::text = 'workoutVideos'
);

UPDATE "AppSettings"
SET "freeAccessFeatures" = (
  SELECT COALESCE(
    array_agg(
      CASE
        WHEN val::text = 'workoutVideos' THEN 'workoutPlan'::"AccessFeatures"
        ELSE val
      END
    ),
    ARRAY[]::"AccessFeatures"[]
  )
  FROM unnest("freeAccessFeatures") AS val
)
WHERE EXISTS (
  SELECT 1
  FROM unnest("freeAccessFeatures") AS val
  WHERE val::text = 'workoutVideos'
);

-- Remove duplicates introduced when aliasing workoutVideos → workoutPlan.
UPDATE "Plans"
SET "accessFeatures" = (
  SELECT COALESCE(array_agg(DISTINCT val), ARRAY[]::"AccessFeatures"[])
  FROM unnest("accessFeatures") AS val
);

UPDATE "AppSettings"
SET "freeAccessFeatures" = (
  SELECT COALESCE(array_agg(DISTINCT val), ARRAY[]::"AccessFeatures"[])
  FROM unnest("freeAccessFeatures") AS val
);
