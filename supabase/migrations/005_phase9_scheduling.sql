-- =============================================================================
-- Phase 9 — Scheduled execution of the DesignRadar Edge Function.
--
-- Adds two Postgres cron jobs that invoke the `daily-radar` Supabase Edge
-- Function, each with a different execution mode:
--
--   DISCOVERY  every 4 hours on the hour   mode: full
--              00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC
--              Searches, classifies, scores, persists, and delivers new posts.
--
--   DIGEST     daily at 07:00 UTC          mode: digest
--              = 08:00 Africa/Lagos (UTC+1, no DST).
--              Safety net for anything the 4-hour runs left unsent.
--
-- The 4-hour job runs mode 'full' so a new opportunity can reach ntfy without
-- waiting for the daily digest. Already-sent posts are skipped.
--
-- SECRETS
-- -------
-- Credentials are stored in Supabase Vault.
--
-- The deployment script (`npm run schedule:enable`) creates/updates:
--
--   design_radar_supabase_url
--   design_radar_service_role_key
--
-- The cron jobs retrieve the decrypted values from vault.decrypted_secrets
-- at runtime. No credentials are stored in this migration.
--
-- HTTP CALL PARAMETERS
-- --------------------
-- net.http_post defaults to a 5000 ms timeout, but a mode 'full' run needs
-- 15–60 s (search + Gemini classification + delivery). The first scheduled
-- run on 2026-10-06 therefore recorded timed_out = true at 5 s while the
-- function itself kept running to completion — the request is not cancelled
-- by the timeout, but the outcome was invisible. Both jobs pass pg_net's
-- maximum (120000 ms) so net._http_response records the real HTTP status and
-- body, which is how a scheduled run is verified:
--
--   select id, status_code, timed_out, left(content, 200), created
--     from net._http_response order by created desc limit 5;
-- =============================================================================

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

-- -----------------------------------------------------------------------------
-- Remove any previous definitions of these two jobs so this migration is
-- re-runnable and a corrected schedule replaces the old one rather than adding
-- duplicates.
-- -----------------------------------------------------------------------------
do $$
declare
  existing_job text;
begin
  foreach existing_job in array array[
    'design-radar-discovery',
    'design-radar-digest'
  ]
  loop
    if exists (
      select 1
      from cron.job
      where jobname = existing_job
    ) then
      perform cron.unschedule(existing_job);
    end if;
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- Discovery + immediate delivery — every 4 hours.
--
-- Mode 'full': searches, classifies, scores, persists qualified posts, then
-- delivers whatever is new.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'design-radar-discovery',
  $cron$0 */4 * * *$cron$,
  $body$
  do $$
  declare
    base_url text;
    service_role text;
  begin

    select decrypted_secret
      into base_url
      from vault.decrypted_secrets
     where name = 'design_radar_supabase_url'
     limit 1;

    select decrypted_secret
      into service_role
      from vault.decrypted_secrets
     where name = 'design_radar_service_role_key'
     limit 1;

    if base_url is null or btrim(base_url) = '' then
      raise exception
        'DesignRadar discovery cron is not configured: Supabase URL is missing from Vault';
    end if;

    if service_role is null or btrim(service_role) = '' then
      raise exception
        'DesignRadar discovery cron is not configured: service-role key is missing from Vault';
    end if;

    perform net.http_post(
      url := base_url || '/functions/v1/daily-radar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_role
      ),
      body := jsonb_build_object('mode', 'full'),
      timeout_milliseconds := 120000
    );

  end
  $$;
  $body$
);

-- -----------------------------------------------------------------------------
-- Daily digest — 07:00 UTC = 08:00 Africa/Lagos.
--
-- Mode 'digest': no web searches. Loads already-qualified posts and delivers
-- anything that remains unsent.
-- -----------------------------------------------------------------------------
select cron.schedule(
  'design-radar-digest',
  $cron$0 7 * * *$cron$,
  $body$
  do $$
  declare
    base_url text;
    service_role text;
  begin

    select decrypted_secret
      into base_url
      from vault.decrypted_secrets
     where name = 'design_radar_supabase_url'
     limit 1;

    select decrypted_secret
      into service_role
      from vault.decrypted_secrets
     where name = 'design_radar_service_role_key'
     limit 1;

    if base_url is null or btrim(base_url) = '' then
      raise exception
        'DesignRadar digest cron is not configured: Supabase URL is missing from Vault';
    end if;

    if service_role is null or btrim(service_role) = '' then
      raise exception
        'DesignRadar digest cron is not configured: service-role key is missing from Vault';
    end if;

    perform net.http_post(
      url := base_url || '/functions/v1/daily-radar',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_role
      ),
      body := jsonb_build_object('mode', 'digest'),
      timeout_milliseconds := 120000
    );

  end
  $$;
  $body$
);

-- -----------------------------------------------------------------------------
-- Comment describing the schedules.
-- -----------------------------------------------------------------------------
comment on extension pg_cron is
  'DesignRadar schedules the daily-radar Edge Function: full discovery + immediate ntfy delivery every 4 hours (UTC), plus daily digest at 07:00 UTC = 08:00 Africa/Lagos.';