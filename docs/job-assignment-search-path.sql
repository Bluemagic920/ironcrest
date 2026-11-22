-- Preserve the invoker role, function body, permissions and records.
begin;
alter function public.ironcrest_enforce_job_assignment_org() set search_path = '';
commit;
