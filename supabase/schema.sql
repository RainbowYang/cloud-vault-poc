-- Cloud Vault POC · Supabase 初始化
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次。

create table if not exists public.vaults (
  user_id uuid primary key references auth.users(id) on delete cascade,
  envelope jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.vaults enable row level security;

create policy "vault_select_own" on public.vaults
  for select to authenticated using (auth.uid() = user_id);
create policy "vault_insert_own" on public.vaults
  for insert to authenticated with check (auth.uid() = user_id);
create policy "vault_update_own" on public.vaults
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
