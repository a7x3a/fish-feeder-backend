# 🕐 Cron Job Setup Guide

## 📍 API Endpoint for Cron Jobs

### Endpoint URL
```
POST https://your-backend-domain.vercel.app/api/cron/execute
```

**Replace `your-backend-domain.vercel.app` with your actual Vercel deployment URL.**

To find your deployment URL:
1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your `fishfeeder-backend` project
3. Copy the deployment URL (e.g., `fishfeeder-backend-abc123.vercel.app`)

### Request Headers
```
Authorization: Bearer YOUR_CRON_SECRET
Content-Type: application/json
```

### Request Method
- **Method:** `POST`
- **Body:** Empty (no body required)

## 🔧 FastCron Setup

### Step 1: Create Account
1. Go to [FastCron.com](https://fastcron.com) or [Cron-Job.org](https://cron-job.org)
2. Sign up for a free account

### Step 2: Create New Cron Job

**For FastCron:**
1. Click "Add Cron Job"
2. Fill in the details:
   - **Name:** FishFeeder Auto Feed
   - **URL:** `https://your-backend-domain.vercel.app/api/cron/execute`
   - **Method:** `POST`
   - **Schedule:** Every 5 minutes (`*/5 * * * *`)
   - **Headers:**
     ```
     Authorization: Bearer YOUR_CRON_SECRET
     Content-Type: application/json
     ```
   - **Body:** Leave empty

**For Cron-Job.org:**
1. Click "Create cronjob"
2. Fill in:
   - **Title:** FishFeeder Auto Feed
   - **Address:** `https://your-backend-domain.vercel.app/api/cron/execute`
   - **Schedule:** Every 5 minutes
   - **Request Method:** POST
   - **Request Headers:**
     ```
     Authorization: Bearer YOUR_CRON_SECRET
     ```
   - **Request Body:** Leave empty

### Step 3: Get Your CRON_SECRET

Your `CRON_SECRET` is set in Vercel environment variables:
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Find `CRON_SECRET`
3. Copy the value
4. Use it in the Authorization header: `Bearer YOUR_CRON_SECRET`

## 📋 Alternative: Using Vercel Cron Jobs (Recommended)

If you're using Vercel, you can use built-in cron jobs instead of external services:

### Create `vercel.json` (already exists)
```json
{
  "crons": [
    {
      "path": "/api/cron/execute",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

### Add Environment Variable in Vercel
- **Name:** `CRON_SECRET`
- **Value:** Your random secret key

Vercel will automatically call the endpoint every 5 minutes with the `x-vercel-cron` header.

## ✅ Testing

### Test the Endpoint Manually
```bash
curl -X POST https://your-backend-domain.vercel.app/api/cron/execute \
  -H "Authorization: Bearer YOUR_CRON_SECRET" \
  -H "Content-Type: application/json"
```

### Expected Response
```json
{
  "type": "none",
  "reason": "cooldown_active"
}
```

Or if a feed was executed:
```json
{
  "type": "timer",
  "user": "System"
}
```

## 🔍 Troubleshooting

### Endpoint Returns 401 Unauthorized
- Check that `CRON_SECRET` matches in both Vercel and your cron service
- Verify the Authorization header format: `Bearer YOUR_CRON_SECRET`

### Endpoint Returns 500 Error
- Check Vercel function logs
- Verify Firebase environment variables are set correctly
- Check that Firebase service account has proper permissions

### Auto Feed Not Triggering
- Check that device is online (`lastSeen` is recent)
- Verify cooldown has finished
- Check that no reservations exist (reservations have priority)
- Verify `autoFeedDelayMinutes` is set in Firebase (`system/feeder/priority/autoFeedDelayMinutes`)

