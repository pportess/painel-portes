-- Painel Portes: banco, arquivos e regras de acesso no Supabase.
-- Rode uma vez no SQL Editor do projeto. Pode rodar de novo sem estragar nada.
-- Troque SEU_EMAIL_AQUI pelo e-mail com que você entra no painel.

-- quem pode ver e mexer em tudo
create table if not exists public.donos (email text primary key);
alter table public.donos enable row level security;
insert into public.donos (email) values (lower('SEU_EMAIL_AQUI')) on conflict do nothing;

create or replace function public.e_dono() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.donos where email = lower(auth.jwt() ->> 'email'));
$$;

-- documentos do painel: config/agenda, config/conteudo, midia/<id>, cronograma/<id>, marketing/<dia>
create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
alter table public.docs enable row level security;

drop policy if exists "dono le" on public.docs;
drop policy if exists "dono cria" on public.docs;
drop policy if exists "dono muda" on public.docs;
drop policy if exists "dono apaga" on public.docs;
create policy "dono le" on public.docs for select to authenticated using (public.e_dono());
create policy "dono cria" on public.docs for insert to authenticated with check (public.e_dono());
create policy "dono muda" on public.docs for update to authenticated using (public.e_dono()) with check (public.e_dono());
create policy "dono apaga" on public.docs for delete to authenticated using (public.e_dono());

create or replace function public.docs_versao() returns trigger language plpgsql as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists docs_versao on public.docs;
create trigger docs_versao before update on public.docs for each row execute function public.docs_versao();

-- avisa o site na hora quando a Duda ou o Rafa gravam algo
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- fotos e vídeos: pasta privada, até 50 MB por arquivo
insert into storage.buckets (id, name, public, file_size_limit)
values ('midia', 'midia', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "dono le midia" on storage.objects;
drop policy if exists "dono sobe midia" on storage.objects;
drop policy if exists "dono muda midia" on storage.objects;
drop policy if exists "dono apaga midia" on storage.objects;
create policy "dono le midia" on storage.objects for select to authenticated using (bucket_id = 'midia' and public.e_dono());
create policy "dono sobe midia" on storage.objects for insert to authenticated with check (bucket_id = 'midia' and public.e_dono());
create policy "dono muda midia" on storage.objects for update to authenticated using (bucket_id = 'midia' and public.e_dono());
create policy "dono apaga midia" on storage.objects for delete to authenticated using (bucket_id = 'midia' and public.e_dono());
