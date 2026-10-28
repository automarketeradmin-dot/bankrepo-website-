-- =====================================================================
-- BANK REPO CARS: database setup
-- Paste this whole file into Supabase > SQL Editor > New query > Run.
-- It is safe to run more than once.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. Admins (only people listed here can open the admin side)
-- ---------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

drop policy if exists "admins read own row" on public.admins;
create policy "admins read own row" on public.admins
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------
-- 2. Vehicles
-- ---------------------------------------------------------------------
create table if not exists public.vehicles (
  id            uuid primary key default gen_random_uuid(),
  stock_number  text not null,
  make          text not null,
  model         text not null,
  year          int  not null check (year between 1950 and 2100),
  mileage       int  check (mileage is null or mileage >= 0),
  price         numeric(12,2) not null default 0 check (price >= 0),
  body_type     text not null check (body_type in
                  ('Hatchback','Sedan','Bakkie','SUV','Station wagon','Bus / Minibus','Panel van','Other')),
  condition     text not null default 'not_confirmed' check (condition in
                  ('runs_drives','needs_repairs','non_runner','not_confirmed')),
  description   text not null default '',
  status        text not null default 'hidden' check (status in ('hidden','published','sold')),
  rto_enabled   boolean not null default false,
  rto_deposit   numeric(12,2),
  rto_m48       numeric(12,2),
  rto_m54       numeric(12,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint rto_complete check (
    not rto_enabled
    or (coalesce(rto_deposit,0) > 0 and (coalesce(rto_m48,0) > 0 or coalesce(rto_m54,0) > 0))
  )
);
create unique index if not exists vehicles_stock_unique on public.vehicles (lower(stock_number));
create index if not exists vehicles_status_idx on public.vehicles (status, created_at desc);

-- Where the car is: at Bank Repo, or on the Executive Motor World floor (shown as "Premium").
alter table public.vehicles add column if not exists location text not null default 'bank_repo';
alter table public.vehicles drop constraint if exists vehicles_location_check;
alter table public.vehicles add constraint vehicles_location_check check (location in ('bank_repo','executive'));

-- A longer rent to own period always costs less per month.
alter table public.vehicles drop constraint if exists rto_longer_cheaper;
alter table public.vehicles add constraint rto_longer_cheaper
  check (rto_m48 is null or rto_m54 is null or rto_m54 < rto_m48);

create table if not exists public.vehicle_images (
  id         uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references public.vehicles(id) on delete cascade,
  path       text not null,
  position   int  not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists vehicle_images_vehicle_idx on public.vehicle_images (vehicle_id, position);

-- A car can only be published with a price and at least 5 photos (maximum 15).
create or replace function public.check_publish()
returns trigger language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  if new.status = 'published' then
    if new.price <= 0 then
      raise exception 'A published car needs a price.';
    end if;
    if tg_op = 'INSERT' or (select count(*) from public.vehicle_images where vehicle_id = new.id) < 5 then
      raise exception 'A published car needs at least 5 photos.';
    end if;
  end if;
  return new;
end $$;

create or replace function public.limit_photos()
returns trigger language plpgsql
set search_path = public
as $$
begin
  if (select count(*) from public.vehicle_images where vehicle_id = new.vehicle_id) >= 15 then
    raise exception 'A car can have at most 15 photos.';
  end if;
  return new;
end $$;
drop trigger if exists vehicle_images_limit on public.vehicle_images;
create trigger vehicle_images_limit before insert on public.vehicle_images
  for each row execute function public.limit_photos();
drop trigger if exists vehicles_check_publish on public.vehicles;
create trigger vehicles_check_publish before insert or update on public.vehicles
  for each row execute function public.check_publish();

-- ---------------------------------------------------------------------
-- 3. Leads (enquiries) and rent to own applications
--    Customers never write here directly. The "submit" function does it.
-- ---------------------------------------------------------------------
create table if not exists public.leads (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  first_name     text not null,
  surname        text not null,
  phone          text not null,
  location       text not null,
  budget         text not null,
  payment        text not null,
  vehicle_id     uuid references public.vehicles(id) on delete set null,
  stock_number   text not null,
  vehicle_title  text not null,
  price          numeric(12,2) not null,
  status         text not null default 'new' check (status in ('new','contacted','qualified','converted','lost')),
  notes          jsonb not null default '[]'::jsonb,
  consent_at     timestamptz not null default now(),
  privacy_version text not null default '2026-10-v1',
  ip_hash        text
);
create index if not exists leads_created_idx on public.leads (created_at desc);
create index if not exists leads_ip_idx on public.leads (ip_hash, created_at);

create table if not exists public.applications (
  id             uuid primary key default gen_random_uuid(),
  ref            text not null unique,
  created_at     timestamptz not null default now(),
  vehicle_id     uuid references public.vehicles(id) on delete set null,
  stock_number   text not null,
  vehicle_title  text not null,
  price          numeric(12,2) not null,
  deposit        numeric(12,2) not null,
  term_months    int  not null check (term_months in (48,54)),
  monthly        numeric(12,2) not null,
  employment     text not null check (employment in ('employed','self')),
  status         text not null default 'new' check (status in ('new','review','approved','declined')),
  answers        jsonb not null,
  consent_at     timestamptz not null default now(),
  privacy_version text not null default '2026-10-v1',
  ip_hash        text
);
create index if not exists applications_created_idx on public.applications (created_at desc);
create index if not exists applications_ip_idx on public.applications (ip_hash, created_at);

create table if not exists public.application_documents (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  label          text not null,
  path           text not null,
  position       int  not null default 0
);
create index if not exists application_documents_app_idx on public.application_documents (application_id, position);

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
alter table public.vehicles              enable row level security;
alter table public.vehicle_images        enable row level security;
alter table public.leads                 enable row level security;
alter table public.applications          enable row level security;
alter table public.application_documents enable row level security;

drop policy if exists "public reads published cars" on public.vehicles;
create policy "public reads published cars" on public.vehicles
  for select to anon, authenticated using (status = 'published');

drop policy if exists "admin manages cars" on public.vehicles;
create policy "admin manages cars" on public.vehicles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public reads photos of published cars" on public.vehicle_images;
create policy "public reads photos of published cars" on public.vehicle_images
  for select to anon, authenticated
  using (exists (select 1 from public.vehicles v where v.id = vehicle_id and v.status = 'published'));

drop policy if exists "admin manages photos" on public.vehicle_images;
create policy "admin manages photos" on public.vehicle_images
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin manages leads" on public.leads;
create policy "admin manages leads" on public.leads
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin manages applications" on public.applications;
create policy "admin manages applications" on public.applications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "admin manages application documents" on public.application_documents;
create policy "admin manages application documents" on public.application_documents
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------
-- 5. File storage
--    vehicle-images       : public (car photos)
--    application-documents: PRIVATE (customer documents, admin only)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vehicle-images', 'vehicle-images', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = true, file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-documents', 'application-documents', false, 10485760,
        array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public = false, file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf','image/jpeg','image/png','image/webp'];

drop policy if exists "admin uploads car photos" on storage.objects;
create policy "admin uploads car photos" on storage.objects
  for insert to authenticated with check (bucket_id = 'vehicle-images' and public.is_admin());

drop policy if exists "admin changes car photos" on storage.objects;
create policy "admin changes car photos" on storage.objects
  for update to authenticated using (bucket_id = 'vehicle-images' and public.is_admin());

drop policy if exists "admin deletes car photos" on storage.objects;
create policy "admin deletes car photos" on storage.objects
  for delete to authenticated using (bucket_id = 'vehicle-images' and public.is_admin());

drop policy if exists "admin reads customer documents" on storage.objects;
create policy "admin reads customer documents" on storage.objects
  for select to authenticated using (bucket_id = 'application-documents' and public.is_admin());

drop policy if exists "admin deletes customer documents" on storage.objects;
create policy "admin deletes customer documents" on storage.objects
  for delete to authenticated using (bucket_id = 'application-documents' and public.is_admin());

-- ---------------------------------------------------------------------
-- 6. MAKE YOURSELF THE ADMIN (do this AFTER you create your login)
--    1. Supabase > Authentication > Users > Add user > Create new user
--       (tick "Auto Confirm User").
--    2. Put that same email below and run just this statement.
-- ---------------------------------------------------------------------
-- insert into public.admins (user_id)
-- select id from auth.users where email = 'PUT-YOUR-EMAIL-HERE'
-- on conflict do nothing;
