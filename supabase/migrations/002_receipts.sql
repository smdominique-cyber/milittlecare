-- ============================================================
-- Mi Little Care — Phase 2: Receipts Table
-- Run this in your Supabase SQL editor
-- ============================================================

create table if not exists public.receipts (
  id            uuid default gen_random_uuid() primary key,
  user_id       uuid references auth.users(id) on delete cascade not null,
  
  -- Core receipt data (AI extracted)
  merchant      text,
  amount        numeric(10,2),
  tax           numeric(10,2),
  tip           numeric(10,2),
  total         numeric(10,2),
  date          date,
  category      text,
  subcategory   text,
  description   text,
  notes         text,
  payment_method text,
  
  -- Image storage
  image_url     text,
  image_path    text,
  
  -- AI processing metadata
  ai_confidence text,  -- 'high' | 'medium' | 'low'
  ai_raw        jsonb, -- full AI response for reference
  
  -- Status
  status        text default 'pending', -- 'pending' | 'reviewed' | 'approved'
  is_deductible boolean default true,
  deduction_pct numeric(5,2) default 100,
  
  created_at    timestamptz default now() not null,
  updated_at    timestamptz default now() not null
);

-- RLS
alter table public.receipts enable row level security;

create policy "Users can view their own receipts"
  on public.receipts for select
  using (auth.uid() = user_id);

create policy "Users can insert their own receipts"
  on public.receipts for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own receipts"
  on public.receipts for update
  using (auth.uid() = user_id);

create policy "Users can delete their own receipts"
  on public.receipts for delete
  using (auth.uid() = user_id);

-- Updated at trigger
create trigger set_receipts_updated_at
  before update on public.receipts
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------
-- Storage bucket for receipt images
-- -------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

create policy "Users can upload their own receipt images"
  on storage.objects for insert
  with check (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can view their own receipt images"
  on storage.objects for select
  using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);

create policy "Users can delete their own receipt images"
  on storage.objects for delete
  using (bucket_id = 'receipts' and auth.uid()::text = (storage.foldername(name))[1]);
