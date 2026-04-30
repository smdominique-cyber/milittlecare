-- ============================================================
-- MI Little Care — Week 3: Business Information System
-- ============================================================

-- -------------------------------------------------------
-- 1. Business hours per day of week
-- -------------------------------------------------------
create table if not exists public.business_hours (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  day_of_week smallint not null,  -- 0=Sunday, 1=Monday, ..., 6=Saturday
  is_open boolean default true,
  open_time time,
  close_time time,
  notes text,  -- e.g., "Pickup window 5:30-6:00 PM"
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  unique(user_id, day_of_week)
);

create index if not exists idx_business_hours_user on public.business_hours(user_id);

alter table public.business_hours enable row level security;

create policy "Users can view their own hours"
  on public.business_hours for select using (auth.uid() = user_id);
create policy "Users can insert their own hours"
  on public.business_hours for insert with check (auth.uid() = user_id);
create policy "Users can update their own hours"
  on public.business_hours for update using (auth.uid() = user_id);
create policy "Users can delete their own hours"
  on public.business_hours for delete using (auth.uid() = user_id);

-- Parents can see business hours of their linked providers
create policy "Parents can view their providers' hours"
  on public.business_hours for select
  using (
    user_id in (
      select provider_user_id from public.parent_family_links
      where parent_id = auth.uid() and status = 'active'
    )
  );

create trigger set_business_hours_updated_at
  before update on public.business_hours
  for each row execute procedure public.set_updated_at();


-- -------------------------------------------------------
-- 2. Closures (holidays + one-off)
-- -------------------------------------------------------
create table if not exists public.closures (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade not null,

  -- Type: holiday (recurring annual) | vacation | sick | personal | other
  closure_type text default 'holiday' not null,
  is_recurring boolean default false,  -- if true, applies every year on this month/day

  -- Date range (single-day closures have start_date = end_date)
  start_date date not null,
  end_date date not null,

  -- For recurring holidays: just the month/day matters (year is ignored)
  -- We still store full start_date/end_date for the first occurrence

  reason text,  -- "Independence Day", "Provider vacation", etc.
  notify_parents boolean default true,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  created_by_user_id uuid references auth.users(id)
);

create index if not exists idx_closures_user on public.closures(user_id);
create index if not exists idx_closures_dates on public.closures(start_date, end_date);

alter table public.closures enable row level security;

create policy "Users can view their own closures"
  on public.closures for select using (auth.uid() = user_id);
create policy "Users can insert their own closures"
  on public.closures for insert with check (auth.uid() = user_id);
create policy "Users can update their own closures"
  on public.closures for update using (auth.uid() = user_id);
create policy "Users can delete their own closures"
  on public.closures for delete using (auth.uid() = user_id);

-- Parents can see closures of their linked providers
create policy "Parents can view their providers' closures"
  on public.closures for select
  using (
    user_id in (
      select provider_user_id from public.parent_family_links
      where parent_id = auth.uid() and status = 'active'
    )
  );

create trigger set_closures_updated_at
  before update on public.closures
  for each row execute procedure public.set_updated_at();


-- -------------------------------------------------------
-- 3. Business policies (one row per provider)
-- -------------------------------------------------------
create table if not exists public.business_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- Payment policies
  payment_due_day text default 'monday',  -- 'monday', 'friday', etc.
  payment_methods_accepted text[],  -- ['stripe', 'venmo', 'check', 'cash']

  -- Late fees
  late_fee_enabled boolean default false,
  late_fee_amount numeric(10,2),
  late_fee_after_days integer default 7,

  -- Late pickup fees
  late_pickup_fee_enabled boolean default false,
  late_pickup_fee_per_minute numeric(10,2),
  late_pickup_grace_minutes integer default 5,

  -- Emergency procedures (free text)
  emergency_procedures text,

  -- Drop-off & pickup notes
  drop_off_notes text,
  pickup_notes text,

  -- Setup progress flags (for dashboard widget)
  hours_set boolean default false,
  closures_set boolean default false,
  policies_set boolean default false,
  emergency_set boolean default false,

  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null
);

alter table public.business_policies enable row level security;

create policy "Users can view their own policies"
  on public.business_policies for select using (auth.uid() = user_id);
create policy "Users can insert their own policies"
  on public.business_policies for insert with check (auth.uid() = user_id);
create policy "Users can update their own policies"
  on public.business_policies for update using (auth.uid() = user_id);

-- Parents can see policies of their linked providers
create policy "Parents can view their providers' policies"
  on public.business_policies for select
  using (
    user_id in (
      select provider_user_id from public.parent_family_links
      where parent_id = auth.uid() and status = 'active'
    )
  );

create trigger set_business_policies_updated_at
  before update on public.business_policies
  for each row execute procedure public.set_updated_at();
