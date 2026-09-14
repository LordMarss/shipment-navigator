CREATE OR REPLACE FUNCTION public.register_automation_cron(_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM cron.unschedule(jobname) FROM cron.job WHERE jobname = 'automation-hourly-sweep';
  PERFORM cron.schedule(
    'automation-hourly-sweep',
    '7 * * * *',
    format($job$SELECT extensions.http_post(url := 'https://project--82261180-ca97-436d-bacc-172ff59a12bb.lovable.app/api/public/hooks/automation-run', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer %s'), body := '{}'::jsonb);$job$, _secret)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.register_automation_cron(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_automation_cron(text) TO sandbox_exec;