-- Admins can upload and replace assessment datasets (the synthetic files candidates download
-- after pressing Start, and the internal answer keys), without the service-role key.
-- Candidates still only get short-lived signed links to candidate/ files after Start.
create policy datasets_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'datasets' and public.is_admin());
create policy datasets_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'datasets' and public.is_admin())
  with check (bucket_id = 'datasets' and public.is_admin());
