# 🚀 FishFeeder Backend Deployment Guide

Complete guide for deploying the FishFeeder backend API to Vercel.

## 📋 Prerequisites

- Node.js installed (for local testing)
- Vercel account (free tier works) - [Sign up here](https://vercel.com/signup)
- Firebase project with service account key
- GitHub account (recommended for easy deployment)

## 🔧 Step 1: Environment Setup

### Prepare Firebase Service Account Key

1. **Get Firebase Service Account Key:**
   - Go to [Firebase Console](https://console.firebase.google.com/)
   - Project: **fishfeeder-81131**
   - ⚙️ Settings → Project settings → Service accounts
   - Click "Generate new private key"
   - Download the JSON file

2. **Convert JSON to Single Line:**
   - Use: https://www.freeformatter.com/json-minifier.html
   - Paste JSON → Minify → Copy result
   - **Save this minified JSON** - you'll need it for Vercel

3. **Generate CRON Secret:**
   - Use any random string generator
   - Example: `openssl rand -hex 32` (if you have OpenSSL)
   - Or use: https://randomkeygen.com/
   - **Save this secret** - you'll need it for Vercel

## 🧪 Step 2: Test Locally (Optional)

```bash
# Install dependencies
npm install

# Create .env.local file
# Copy the content from env.example.txt and fill in your values

# Start development server
npm run dev

# Test the endpoint
curl http://localhost:3000/api/cron
```

Expected response:
```json
{"ok":true,"type":"none","reason":"no_feed_needed"}
```

## 🚀 Step 3: Deploy to Vercel

### Option A: Deploy from GitHub (Recommended)

1. **Push your code to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/yourusername/fishfeeder-backend.git
   git push -u origin main
   ```

2. **Import Project in Vercel:**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard)
   - Click **"Add New..."** → **"Project"**
   - Click **"Import Git Repository"**
   - Select your GitHub repository
   - Click **"Import"**

3. **Configure Project Settings:**
   - **Framework Preset:** Next.js (auto-detected)
   - **Root Directory:** `./` (leave as default)
   - **Build Command:** `npm run build` (already in vercel.json)
   - **Output Directory:** `.next` (already in vercel.json)
   - **Install Command:** `npm install --legacy-peer-deps` (already in vercel.json)
   - Click **"Deploy"**

### Option B: Deploy from Local Directory (CLI)

1. **Install Vercel CLI:**
   ```bash
   npm install -g vercel
   ```

2. **Login to Vercel:**
   ```bash
   vercel login
   ```

3. **Deploy:**
   ```bash
   vercel
   ```

   **Answer prompts:**
   - Set up and deploy? → **Yes**
   - Link to existing project? → **No** (first time) or **Yes** (if updating)
   - Project name? → `fishfeeder-backend` (or your preferred name)
   - Directory? → Press Enter (current directory)
   - Override settings? → **No** (vercel.json will be used)

## ⚙️ Step 4: Configure Environment Variables

1. **Go to Vercel Dashboard:**
   - Visit [Vercel Dashboard](https://vercel.com/dashboard)
   - Select your **fishfeeder-backend** project

2. **Navigate to Settings:**
   - Click on your project
   - Go to **Settings** tab
   - Click **Environment Variables** in the left sidebar

3. **Add Environment Variables:**
   Click **"Add New"** and add these 3 variables:

   **Variable 1: FIREBASE_SERVICE_ACCOUNT**
   - **Key:** `FIREBASE_SERVICE_ACCOUNT`
   - **Value:** Paste your minified Firebase JSON (the entire JSON as a single line)
   - **Environment:** Select all (Production, Preview, Development)
   - Click **"Save"**

   **Variable 2: FIREBASE_DB_URL**
   - **Key:** `FIREBASE_DB_URL`
   - **Value:** `https://fishfeeder-81131-default-rtdb.firebaseio.com/`
   - **Environment:** Select all (Production, Preview, Development)
   - Click **"Save"**

   **Variable 3: CRON_SECRET**
   - **Key:** `CRON_SECRET`
   - **Value:** Your random secret string (e.g., `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6`)
   - **Environment:** Select all (Production, Preview, Development)
   - Click **"Save"**

4. **Redeploy After Adding Variables:**
   - Go to **Deployments** tab
   - Click the **"..."** menu on the latest deployment
   - Click **"Redeploy"**
   - Or trigger a new deployment by pushing to your Git repository

## 🔄 Step 5: Configure Cron Jobs

### ⚠️ Important: Vercel Plan Limitations

**Vercel Hobby (Free) Plan:**
- ✅ Supports cron jobs, but **only once per day**
- ❌ Cannot run more frequently than daily
- Current schedule: `0 0 * * *` (runs once daily at midnight UTC)

**Vercel Pro Plan:**
- ✅ Supports cron jobs with any frequency
- ✅ Can run every minute: `*/1 * * * *`

### Option A: Use Free Tier (Daily Execution)

The current `vercel.json` is configured for **free tier** with daily execution:

1. **Go to Cron Jobs Settings:**
   - In your Vercel project dashboard
   - Go to **Settings** → **Cron Jobs**

2. **Verify Cron Configuration:**
   - Vercel should auto-detect the cron job from `vercel.json`
   - You should see:
     - **Path:** `/api/cron`
     - **Schedule:** `0 0 * * *` (once daily at midnight UTC)

3. **Enable Cron Jobs:**
   - Make sure **Cron Jobs** are enabled for your project

**Note:** With daily execution, the system will check for feeds once per day. For minute-by-minute checking, use Option B or C below.

### Option B: Upgrade to Vercel Pro (Recommended for Production)

1. **Upgrade your Vercel account:**
   - Go to [Vercel Dashboard](https://vercel.com/dashboard) → **Settings** → **Billing**
   - Upgrade to **Pro plan** ($20/month)
   - Unlocks unlimited cron job frequency

2. **Update `vercel.json` for minute-by-minute execution:**
   ```json
   "crons": [
     {
       "path": "/api/cron",
       "schedule": "*/1 * * * *"
     }
   ]
   ```

3. **Redeploy** your project

### Option C: Use External Cron Service (Free Alternative)

Use a free external cron service to call your API every minute:

1. **Services to consider:**
   - [cron-job.org](https://cron-job.org) (free, supports minute intervals)
   - [EasyCron](https://www.easycron.com) (free tier available)
   - [UptimeRobot](https://uptimerobot.com) (free monitoring + cron)

2. **Setup with cron-job.org:**
   - Sign up at https://cron-job.org
   - Create new cron job:
     - **URL:** `https://your-project.vercel.app/api/cron?secret=YOUR_CRON_SECRET`
     - **Schedule:** Every minute (`*/1 * * * *`)
     - **Method:** GET
   - Add your `CRON_SECRET` as a query parameter for security

3. **Configure the cron service:**
   - The API route already supports query parameter authentication
   - Use URL format: `https://your-project.vercel.app/api/cron?secret=YOUR_CRON_SECRET`
   - Replace `YOUR_CRON_SECRET` with the value from your Vercel environment variables

4. **Keep Vercel cron disabled** or remove it from `vercel.json` (optional - both can run simultaneously)

## ✅ Step 6: Verify Deployment

### Test Production Endpoint

1. **Get your deployment URL:**
   - Go to Vercel Dashboard → Your project → **Deployments**
   - Copy the deployment URL (e.g., `https://fishfeeder-backend.vercel.app`)

2. **Test the API endpoint:**
   - Visit: `https://your-project.vercel.app/api/cron?secret=YOUR_CRON_SECRET`
   - Should see JSON response like:
     ```json
     {"ok":true,"type":"none","reason":"no_feed_needed"}
     ```

### Check Logs

1. **View Function Logs:**
   - Vercel Dashboard → Your project → **Functions** tab
   - Click on `/api/cron` function
   - View **Logs** tab
   - Look for `[CRON] Starting feed check...` messages
   - Should appear every minute when cron runs

2. **Check Deployment Logs:**
   - Go to **Deployments** tab
   - Click on a deployment
   - View build logs and runtime logs

### Monitor Cron Job Execution

1. **Cron Jobs Tab:**
   - Go to **Settings** → **Cron Jobs**
   - You can see the execution history
   - Check for any errors or failures

## 🔄 Step 7: Updating Your Deployment

### Automatic Updates (GitHub Integration)

If you deployed from GitHub, updates are automatic:

1. **Make changes to your code**
2. **Commit and push to GitHub:**
   ```bash
   git add .
   git commit -m "Update code"
   git push origin main
   ```
3. **Vercel automatically deploys** the new version
4. **Check deployment status** in Vercel Dashboard

### Manual Updates (CLI)

If you deployed via CLI:

1. **Make changes to your code**
2. **Deploy again:**
   ```bash
   vercel --prod
   ```

### Updating Environment Variables

1. Go to **Settings** → **Environment Variables**
2. Edit or add new variables
3. **Redeploy** your project for changes to take effect

## 🔍 Troubleshooting

### Build Error: "Failed to collect page data for /Dashboard"
This error occurs when Next.js tries to build pages that don't exist.

**Solution:**
- The project is configured for API routes only (no pages)
- Make sure `app/layout.js` exists (minimal root layout)
- Verify `next.config.cjs` excludes the `src/` directory
- The `.vercelignore` file should exclude frontend files
- Next.js should only process the `app/api/` directory

### Firebase Initialization Error
- Verify `FIREBASE_SERVICE_ACCOUNT` is valid JSON (single line)
- Check `FIREBASE_DB_URL` is correct
- Ensure Firebase Realtime Database Rules allow Admin SDK

### Function Timeout
- Vercel Free: 10 seconds timeout
- Optimize Firebase queries if needed
- Upgrade to Pro for 60 seconds timeout

### Cron Job Not Running
- Check `vercel.json` exists with cron configuration
- Verify environment variables are set
- Check Cron Jobs enabled in Vercel Dashboard

## 📁 Project Structure

```
fishfeeder-backend/
├── app/
│   ├── api/
│   │   └── cron/
│   │       └── route.js          # Main cron handler
│   └── layout.js                 # Minimal root layout
├── vercel.json                   # Vercel configuration
├── next.config.cjs              # Next.js configuration
├── package.json                 # Dependencies
└── README.md                    # Project documentation
```

## 🎉 What Happens After Deployment

- ✅ Cron runs automatically (daily on free tier, or as configured)
- ✅ Executes reservation feeds (FIFO)
- ✅ Executes auto feeds (after cooldown + delay)
- ✅ Works 24/7 independently
- ✅ No user interaction needed

---

**Need help?** Check Vercel Dashboard → Functions → Logs for detailed error messages.

