-- Postgres grants EXECUTE on new functions to PUBLIC, and schema default privileges
-- cannot take that away, so revoke explicitly and grant back only what is intended.

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.reasoning_attempt_guard() from public, anon, authenticated;
revoke execute on function public.reasoning_response_guard() from public, anon, authenticated;
revoke execute on function public.applications_status_guard() from public, anon, authenticated;

-- Used inside RLS policies for signed-in users.
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Intentional RPCs for signed-in users; each checks auth.uid() / is_admin() itself.
revoke execute on function public.apply_to_role(text) from public, anon;
grant execute on function public.apply_to_role(text) to authenticated;
revoke execute on function public.admin_decide(uuid, text, text) from public, anon;
grant execute on function public.admin_decide(uuid, text, text) to authenticated;
