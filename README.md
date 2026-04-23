# Mi Little Care

Smart tools for home daycare providers. Track deductions, manage families, and run your business with confidence.

## Stack

- **Frontend**: React 18 + Vite
- **Auth & DB**: Supabase
- **Hosting**: Vercel
- **Domain**: milittlecare.com

---

## Phase 1 Setup Guide

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Then fill in your values from your [Supabase project dashboard](https://supabase.com/dashboard):

```
VITE_SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 3. Run the Supabase migration

1. Open your [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql)
2. Copy the contents of `supabase/migrations/001_profiles.sql`
3. Paste and run it

This creates the `profiles` table and auto-creates a profile for every new signup.

### 4. Configure Supabase Auth

In your Supabase project dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://milittlecare.com`
- **Redirect URLs** (add all of these):
  - `https://milittlecare.com/auth/callback`
  - `http://localhost:5173/auth/callback` (for local dev)

### 5. Run locally

```bash
npm run dev
```

Visit `http://localhost:5173`

### 6. Deploy to Vercel

```bash
# Install Vercel CLI if you haven't
npm i -g vercel

# Deploy
vercel

# Set environment variables in Vercel dashboard:
# Settings → Environment Variables
# Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY
```

Or connect your GitHub repo in the Vercel dashboard for automatic deploys on push.

---

## Project Structure

```
src/
├── components/
│   ├── auth/
│   │   └── ProtectedRoute.jsx     # Redirects to /login if not authed
│   └── dashboard/
│       ├── DashboardLayout.jsx    # Shell with sidebar + topbar
│       └── Sidebar.jsx            # Navigation sidebar
├── hooks/
│   └── useAuth.jsx                # Auth context + hook
├── lib/
│   └── supabase.js                # Supabase client
├── pages/
│   ├── LoginPage.jsx              # Login + signup + magic link
│   ├── AuthCallbackPage.jsx       # Handles email link redirects
│   ├── DashboardPage.jsx          # Main dashboard with stats
│   └── PlaceholderPages.jsx       # Stubs for Phase 2+ features
├── styles/
│   ├── globals.css                # Design system variables + reset
│   ├── auth.css                   # Auth page styles
│   └── dashboard.css              # Dashboard layout styles
└── App.jsx                        # Routes
```

---

## Roadmap

| Phase | Feature |
|-------|---------|
| ✅ 1 | Auth + Dashboard shell |
| 🔜 2 | AI Receipt Scanner (Anthropic API) |
| 🔜 3 | Deductions tracker + categories |
| 🔜 4 | T/S Ratio calculator |
| 🔜 5 | Family management |
| 🔜 6 | Tax reports + PDF export |
