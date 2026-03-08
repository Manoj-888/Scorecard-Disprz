# 📊 ScoreCard — Quality Audit Tool

A full-stack scorecard application with Supabase cloud storage and Vercel hosting.

---

## 🚀 Deploy in 4 Steps

### Step 1 — Set up Supabase (5 minutes)

1. Go to **https://supabase.com** → Sign up (free)
2. Click **"New Project"** → give it a name (e.g. `scorecard`) → set a password → choose a region → **Create project** (takes ~2 min)
3. Once ready, go to the **SQL Editor** (left sidebar)
4. Click **"New Query"** → paste the entire contents of `supabase-schema.sql` → click **Run**
5. Go to **Project Settings** → **API** → copy these two values:
   - **Project URL** (looks like `https://xxxxxxxxxxx.supabase.co`)
   - **anon public** key (long JWT string)

---

### Step 2 — Set up GitHub (3 minutes)

1. Go to **https://github.com** → sign in (or sign up free)
2. Click **"New repository"** → name it `scorecard-app` → **Create repository**
3. Upload all the project files (drag & drop the folder contents into GitHub's web UI)
   - OR install Git and run:
     ```bash
     git init
     git add .
     git commit -m "Initial commit"
     git remote add origin https://github.com/YOUR_USERNAME/scorecard-app.git
     git push -u origin main
     ```

---

### Step 3 — Deploy to Vercel (3 minutes)

1. Go to **https://vercel.com** → Sign up with GitHub (free)
2. Click **"Add New Project"** → Import your `scorecard-app` GitHub repo
3. In the **"Environment Variables"** section, add:
   | Name | Value |
   |------|-------|
   | `VITE_SUPABASE_URL` | Your Supabase Project URL |
   | `VITE_SUPABASE_ANON_KEY` | Your Supabase anon key |
4. Click **"Deploy"** — Vercel builds and hosts it automatically
5. Your app is live at `https://scorecard-app-xxxx.vercel.app` 🎉

---

### Step 4 — First Launch

1. Open your Vercel URL
2. The app will show a **Setup screen** — paste your Supabase URL and anon key
3. Click **"Connect & Start"**
4. You're ready to use the app!

> **Note:** If you set the env variables in Vercel (Step 3), the setup screen is skipped automatically.

---

## 📁 Project Structure

```
scorecard-app/
├── index.html              # App entry point
├── vite.config.js          # Vite bundler config
├── package.json            # Dependencies
├── .env.example            # Copy to .env for local dev
├── supabase-schema.sql     # Run this once in Supabase SQL Editor
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx            # React root
    ├── App.jsx             # Full application (all pages + logic)
    └── supabase.js         # Supabase client
```

---

## 🖥️ Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env and fill in your Supabase URL + key

# 3. Start dev server
npm run dev

# 4. Open http://localhost:5173
```

---

## ✨ Features

| Feature | Details |
|---------|---------|
| **Form Builder** | Create sections, sub-sections (up to 2 levels), questions |
| **Custom Fields** | Edit Ticket ID, Employee Name, Month, Manager labels — add/remove fields |
| **Inline Editing** | Click any text to edit it directly |
| **Cloud Save** | All form config saved to Supabase instantly |
| **Scoring** | Yes = full points · No = 0 pts · N/A = question excluded |
| **Reports** | Sortable table, search, stats (avg/high/low) |
| **Detail View** | Click any row to see full question-by-question breakdown |
| **Excel Export** | Downloads .xlsx with all submissions column-by-column + Summary sheet |
| **Multi-device** | Any team member can access the same data from any device |
| **Sync button** | Refresh data from cloud at any time |

---

## 🔐 Security Notes

- The app uses Supabase **Row Level Security (RLS)** with open policies for now
- When you add user authentication later, update the RLS policies in Supabase to restrict by user
- Never commit your `.env` file to GitHub (it's in `.gitignore`)
- The anon key is safe to use in frontend code — it only allows what RLS permits

---

## 🛠️ Future Upgrades

- **Add auth**: Supabase Auth → `supabase.auth.signIn()` + update RLS policies
- **Role-based access**: Admins edit forms; agents only submit
- **Real-time**: Use `supabase.channel()` to see new submissions live
- **Charts**: Add a chart library (Recharts) to visualize score trends

---

## 📞 Support

Built with: React + Vite + Supabase + Vercel + SheetJS (xlsx)
