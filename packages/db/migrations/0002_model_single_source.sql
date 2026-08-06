-- The model choice used to be stored twice: on the project (`default_model`)
-- and mirrored onto the AI connection's settings. `resolveAi` preferred the
-- connection copy, so changing the model in project settings was silently
-- ignored — the stale mirror won forever.
--
-- The project is now the single source of truth. Drop the mirror so no row
-- carries a value that looks authoritative but is not read.

UPDATE connections
SET settings = settings - 'model'
WHERE kind = 'ai' AND settings ? 'model';
