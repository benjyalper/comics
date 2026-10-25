-- Bubbles (בועות) comic studio: database + file storage setup.
-- Run once in Supabase: SQL Editor → New query → paste this whole file → Run.
-- Safe to run again; it skips or replaces what already exists.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.comics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null default 'קומיקס חדש',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pages (
  id uuid primary key default gen_random_uuid(),
  comic_id uuid not null references public.comics (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  position integer not null default 0,
  image_path text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  -- Speech bubbles, captions and text boxes for this page (positions in % of the image).
  bubbles jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists comics_user_idx on public.comics (user_id);
create index if not exists pages_comic_position_idx on public.pages (comic_id, position);

-- ---------------------------------------------------------------------------
-- Row-level security: every user sees and edits only their own comics.
-- ---------------------------------------------------------------------------

alter table public.comics enable row level security;
alter table public.pages enable row level security;

drop policy if exists "comics: owner full access" on public.comics;
create policy "comics: owner full access" on public.comics
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "pages: owner full access" on public.pages;
create policy "pages: owner full access" on public.pages
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.comics c
      where c.id = comic_id and c.user_id = (select auth.uid())
    )
  );

-- ---------------------------------------------------------------------------
-- Timestamps: keep updated_at fresh and bump a comic when its pages change,
-- so the comics list shows the most recently worked-on comic first.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function public.touch_parent_comic()
returns trigger language plpgsql set search_path = '' as $$
begin
  update public.comics set updated_at = now() where id = new.comic_id;
  return null;
end $$;

drop trigger if exists comics_touch on public.comics;
create trigger comics_touch before update on public.comics
  for each row execute function public.touch_updated_at();

drop trigger if exists pages_touch on public.pages;
create trigger pages_touch before update on public.pages
  for each row execute function public.touch_updated_at();

drop trigger if exists pages_touch_comic on public.pages;
create trigger pages_touch_comic after insert or update on public.pages
  for each row execute function public.touch_parent_comic();

-- ---------------------------------------------------------------------------
-- File storage: a private bucket for page images.
-- Files live under "<user id>/<comic id>/<file>.jpg"; users reach only their own folder.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comic-pages', 'comic-pages', false, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "comic-pages: read own" on storage.objects;
create policy "comic-pages: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'comic-pages' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "comic-pages: upload own" on storage.objects;
create policy "comic-pages: upload own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'comic-pages' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "comic-pages: update own" on storage.objects;
create policy "comic-pages: update own" on storage.objects
  for update to authenticated
  using (bucket_id = 'comic-pages' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'comic-pages' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "comic-pages: delete own" on storage.objects;
create policy "comic-pages: delete own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'comic-pages' and (storage.foldername(name))[1] = (select auth.uid())::text);
