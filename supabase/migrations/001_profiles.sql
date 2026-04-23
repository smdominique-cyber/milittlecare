-- ============================================================
-- Mi Little Care — Phase 1 Database Schema
-- Run this in your Supabase SQL editor
-- ============================================================

-- Enable Row Level Security on all tables by default
-- This file sets up the profiles table which extends auth.users

-- -------------------------------------------------------
-- 1. Profiles table (extends Supabase auth.users)
-- -------------------------------------------------------
create table if not exists public.profiles (
  id           uuid references auth.users(id) on delete cascade primary key,
  full_name    text,
  daycare_name text,
  email        text,
  created_at   timestamptz default now() not null,
  updated_at   timestamptz default now() not null
);

-- RLS: users can only see/edit their own profile
alter table public.profiles enable row level security;

create policy "Users can view their own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

create policy "Users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

-- -------------------------------------------------------
-- 2. Auto-create profile on signup
-- -------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    new.raw_user_meta_data ->> 'full_name',
    new.email
  );
  return new;
end;
$$;

-- Drop trigger if it exists, then recreate
drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- -------------------------------------------------------
-- 3. Updated_at auto-update trigger
-- -------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();
