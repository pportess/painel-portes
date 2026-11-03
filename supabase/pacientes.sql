-- Painel Portes: fichas de pacientes com fotos de antes e depois.
-- Rode depois do acessos.sql, uma vez, no SQL Editor. Pode rodar de novo sem estragar nada.
-- Só o dono (Pedro) vê e mexe nos pacientes. Contas aprovadas e os agentes não veem.

-- documentos: a coleção "pacientes" fica só para o dono
drop policy if exists "dono le" on public.docs;
drop policy if exists "dono cria" on public.docs;
drop policy if exists "dono muda" on public.docs;
drop policy if exists "dono apaga" on public.docs;
create policy "dono le" on public.docs for select to authenticated
  using (public.tem_acesso() and (col <> 'pacientes' or public.e_dono()));
create policy "dono cria" on public.docs for insert to authenticated
  with check (public.tem_acesso() and (col <> 'pacientes' or public.e_dono()));
create policy "dono muda" on public.docs for update to authenticated
  using (public.tem_acesso() and (col <> 'pacientes' or public.e_dono()))
  with check (public.tem_acesso() and (col <> 'pacientes' or public.e_dono()));
create policy "dono apaga" on public.docs for delete to authenticated
  using (public.tem_acesso() and (col <> 'pacientes' or public.e_dono()));

-- fotos dos pacientes: pasta privada separada, só imagens, até 15 MB
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pacientes', 'pacientes', false, 15728640, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "dono le pacientes" on storage.objects;
drop policy if exists "dono sobe pacientes" on storage.objects;
drop policy if exists "dono muda pacientes" on storage.objects;
drop policy if exists "dono apaga pacientes" on storage.objects;
create policy "dono le pacientes" on storage.objects for select to authenticated using (bucket_id = 'pacientes' and public.e_dono());
create policy "dono sobe pacientes" on storage.objects for insert to authenticated with check (bucket_id = 'pacientes' and public.e_dono());
create policy "dono muda pacientes" on storage.objects for update to authenticated using (bucket_id = 'pacientes' and public.e_dono());
create policy "dono apaga pacientes" on storage.objects for delete to authenticated using (bucket_id = 'pacientes' and public.e_dono());
