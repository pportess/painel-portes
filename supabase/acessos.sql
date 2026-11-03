-- Painel Portes: login com usuário e senha, pedidos de acesso e aviso por e-mail.
-- Rode depois do banco.sql, uma vez, no SQL Editor. Pode rodar de novo sem estragar nada.

create extension if not exists pg_net;

-- perfil de cada conta: usuário, nome e se o Pedro já aprovou
create table if not exists public.perfis (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  usuario text unique,
  nome text,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'recusado')),
  criado timestamptz not null default now(),
  decidido timestamptz
);
alter table public.perfis enable row level security;
drop policy if exists "ve o proprio perfil" on public.perfis;
create policy "ve o proprio perfil" on public.perfis for select to authenticated
  using (user_id = auth.uid() or public.e_dono());

-- tem acesso: o dono, ou quem o dono aprovou
create or replace function public.tem_acesso() returns boolean
language sql stable security definer set search_path = public as $$
  select public.e_dono() or exists (select 1 from public.perfis where user_id = auth.uid() and status = 'aprovado');
$$;

-- banco e arquivos passam a valer para quem tem acesso
drop policy if exists "dono le" on public.docs;
drop policy if exists "dono cria" on public.docs;
drop policy if exists "dono muda" on public.docs;
drop policy if exists "dono apaga" on public.docs;
create policy "dono le" on public.docs for select to authenticated using (public.tem_acesso());
create policy "dono cria" on public.docs for insert to authenticated with check (public.tem_acesso());
create policy "dono muda" on public.docs for update to authenticated using (public.tem_acesso()) with check (public.tem_acesso());
create policy "dono apaga" on public.docs for delete to authenticated using (public.tem_acesso());

drop policy if exists "dono le midia" on storage.objects;
drop policy if exists "dono sobe midia" on storage.objects;
drop policy if exists "dono muda midia" on storage.objects;
drop policy if exists "dono apaga midia" on storage.objects;
create policy "dono le midia" on storage.objects for select to authenticated using (bucket_id = 'midia' and public.tem_acesso());
create policy "dono sobe midia" on storage.objects for insert to authenticated with check (bucket_id = 'midia' and public.tem_acesso());
create policy "dono muda midia" on storage.objects for update to authenticated using (bucket_id = 'midia' and public.tem_acesso());
create policy "dono apaga midia" on storage.objects for delete to authenticated using (bucket_id = 'midia' and public.tem_acesso());

-- e-mail para o Pedro quando alguém confirma a conta e pede acesso (Resend; chave guardada no Vault como 'resend_key')
create or replace function public.avisar_pedido(p_email text, p_usuario text, p_nome text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  k text;
  para text;
  quem text := replace(replace(coalesce(p_nome, '(sem nome)'), '<', '&lt;'), '>', '&gt;');
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'resend_key' limit 1;
  select email into para from public.donos limit 1;
  if k is null or para is null then return; end if;
  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || k, 'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', 'Painel Portes <onboarding@resend.dev>',
      'to', jsonb_build_array(para),
      'subject', 'Pedido de acesso ao painel: ' || coalesce(p_nome, p_email),
      'html', '<p><b>' || quem || '</b> criou uma conta e pediu acesso ao Painel Portes.</p>'
        || '<p>E-mail: ' || replace(p_email, '<', '&lt;') || '<br>Usuário: ' || replace(coalesce(p_usuario, '-'), '<', '&lt;') || '</p>'
        || '<p>Até você aprovar, essa pessoa não vê nada. Para aprovar ou recusar, abra o painel e clique em <b>Acessos</b>:<br>'
        || '<a href="https://pportess.github.io/painel-portes/">https://pportess.github.io/painel-portes/</a></p>'
    )
  );
exception when others then
  return; -- o aviso nunca pode impedir a conta de ser criada
end $$;

-- conta nova: cria o perfil (pendente, a não ser que seja o dono) e avisa quando o e-mail estiver confirmado
create or replace function public.conta_nova() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  u text := lower(nullif(trim(new.raw_user_meta_data ->> 'usuario'), ''));
  n text := nullif(trim(new.raw_user_meta_data ->> 'nome'), '');
  dono boolean := exists (select 1 from public.donos where email = lower(new.email));
begin
  if u is not null and (u !~ '^[a-z0-9._-]{3,30}$' or exists (select 1 from public.perfis where usuario = u)) then u := null; end if;
  insert into public.perfis (user_id, email, usuario, nome, status)
  values (new.id, lower(new.email), u, n, case when dono then 'aprovado' else 'pendente' end)
  on conflict (user_id) do nothing;
  if not dono and new.email_confirmed_at is not null then perform public.avisar_pedido(lower(new.email), u, n); end if;
  return new;
end $$;

create or replace function public.conta_confirmada() returns trigger
language plpgsql security definer set search_path = public as $$
declare p public.perfis;
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    select * into p from public.perfis where user_id = new.id;
    if found and p.status = 'pendente' then perform public.avisar_pedido(p.email, p.usuario, p.nome); end if;
  end if;
  return new;
end $$;

drop trigger if exists conta_nova on auth.users;
create trigger conta_nova after insert on auth.users for each row execute function public.conta_nova();
drop trigger if exists conta_confirmada on auth.users;
create trigger conta_confirmada after update of email_confirmed_at on auth.users for each row execute function public.conta_confirmada();

-- contas que já existem (a do Pedro) ganham perfil
insert into public.perfis (user_id, email, status)
select id, lower(email), case when exists (select 1 from public.donos d where d.email = lower(u.email)) then 'aprovado' else 'pendente' end
from auth.users u
on conflict (user_id) do nothing;

-- login por usuário: devolve o e-mail da conta (o login em si continua pedindo a senha)
create or replace function public.email_para_login(p_usuario text) returns text
language sql stable security definer set search_path = public as $$
  select email from public.perfis where usuario = lower(trim(p_usuario)) limit 1;
$$;

create or replace function public.usuario_livre(p_usuario text) returns boolean
language sql stable security definer set search_path = public as $$
  select lower(trim(p_usuario)) ~ '^[a-z0-9._-]{3,30}$'
     and not exists (select 1 from public.perfis where usuario = lower(trim(p_usuario)));
$$;

-- cada um escolhe o próprio usuário
create or replace function public.definir_usuario(p_usuario text) returns boolean
language plpgsql security definer set search_path = public as $$
declare u text := lower(trim(p_usuario));
begin
  if auth.uid() is null or u !~ '^[a-z0-9._-]{3,30}$' then return false; end if;
  if exists (select 1 from public.perfis where usuario = u and user_id <> auth.uid()) then return false; end if;
  update public.perfis set usuario = u where user_id = auth.uid();
  return found;
end $$;

-- só o dono aprova, recusa ou tira o acesso
create or replace function public.decidir_acesso(p_user uuid, p_status text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.e_dono() or p_status not in ('aprovado', 'recusado', 'pendente') then return false; end if;
  update public.perfis set status = p_status, decidido = now()
  where user_id = p_user and email not in (select email from public.donos);
  return found;
end $$;

revoke execute on function public.avisar_pedido(text, text, text) from public, anon, authenticated;
grant execute on function public.email_para_login(text) to anon, authenticated;
grant execute on function public.usuario_livre(text) to anon, authenticated;
grant execute on function public.definir_usuario(text) to authenticated;
grant execute on function public.decidir_acesso(uuid, text) to authenticated;
grant execute on function public.tem_acesso() to anon, authenticated;
