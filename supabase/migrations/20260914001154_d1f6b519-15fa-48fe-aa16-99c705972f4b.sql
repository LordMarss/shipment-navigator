CREATE OR REPLACE FUNCTION public.register_automation_cron(_secret text, _url text)
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
    format($job$SELECT extensions.http_post(url := %L, headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer %s'), body := '{}'::jsonb);$job$, _url, _secret)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.register_automation_cron(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_automation_cron(text, text) TO sandbox_exec;