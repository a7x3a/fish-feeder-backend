# FishFeeder Backend API 🐟

Next.js API backend for the FishFeeder IoT system. Handles automated feed scheduling via Vercel Cron Jobs.

## 📋 Overview

This is a **standalone backend project** that provides API routes for:
- Automated feed scheduling (cron jobs)
- Reservation feed execution
- Auto feed management
- Firebase Realtime Database integration

The frontend (React + Vite) is in a separate repository.

## 🏗️ Architecture

- **Framework:** Next.js 14 (API routes only, no pages)
- **Database:** Firebase Realtime Database (via Firebase Admin SDK)
- **Deployment:** Vercel (serverless functions + cron jobs)
- **Language:** JavaScript (ES Modules)

## 📦 Installation

```bash
# Install dependencies
npm install

# Create .env.local file (see Environment Setup below)
```

## ⚙️ Environment Setup

### Step 1: Create `.env.local` File

Create a `.env.local` file in the `fishfeeder-backend/` root directory:

```bash
cd fishfeeder-backend
touch .env.local  # or create manually
```

### Step 2: Add Environment Variables

Copy `.env.example` to `.env.local` and fill in your values:

```bash
cp .env.example .env.local
```

Or manually create `.env.local` with these variables:

```env
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"fishfeeder-81131",...}
FIREBASE_DB_URL=https://fishfeeder-81131-default-rtdb.firebaseio.com/
CRON_SECRET=your-random-secret-key-here
```

### Step 3: Get Firebase Service Account Key

**Option A: You already have the JSON (recommended)**

If you have the Firebase service account JSON file:

1. **Minify the JSON** to a single line:
   - Go to: https://www.freeformatter.com/json-minifier.html
   - Paste your JSON file content
   - Click "Minify"
   - Copy the result

2. **Add to `.env.local`:**
   ```env
   FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"fishfeeder-81131","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"...","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"...","universe_domain":"googleapis.com"}
   ```

**Option B: Generate new key**

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Project: **fishfeeder-81131**
3. ⚙️ Settings → Project settings → Service accounts
4. Click "Generate new private key"
5. Download JSON file
6. Follow Option A steps above to minify and add to `.env.local`

### Step 4: Set Other Variables

```env
# Firebase Database URL (already correct for this project)
FIREBASE_DB_URL=https://fishfeeder-81131-default-rtdb.firebaseio.com/

# Cron Secret (generate a random string)
# Use: https://randomkeygen.com/ or openssl rand -hex 32
CRON_SECRET=your-random-secret-key-here
```

### ✅ Verify Setup

After creating `.env.local`, test locally:

```bash
npm run dev
# Server should start without Firebase initialization errors
```

## 🚀 Development

```bash
# Start development server
npm run dev

# Server runs on http://localhost:3000
# Test endpoint: http://localhost:3000/api/cron
```

## 📦 Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

## 🌐 Deployment

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for complete deployment guide.

**Quick deploy to Vercel:**
1. Push code to GitHub
2. Import project in Vercel Dashboard
3. Set environment variables
4. Deploy!

## 📁 Project Structure

```
fishfeeder-backend/
├── app/
│   ├── api/
│   │   └── cron/
│   │       └── route.js      # Main cron handler
│   └── layout.js             # Minimal root layout
├── next.config.cjs          # Next.js configuration
├── vercel.json              # Vercel configuration
├── package.json             # Dependencies
└── README.md                # This file
```

## 🔄 API Endpoints

### `GET /api/cron`

Automated feed scheduling endpoint (called by Vercel Cron or external service).

**Authentication:**
- Vercel Cron: Automatic (via `x-vercel-cron` header)
- External: `?secret=YOUR_CRON_SECRET` query parameter
- Or: `Authorization: Bearer YOUR_CRON_SECRET` header

**Response:**
```json
{
  "ok": true,
  "type": "auto" | "reservation" | "none",
  "reason": "no_feed_needed" | "already_feeding" | "fasting_day"
}
```

## ⏰ Cron Schedule

- **Free Tier:** Once daily (`0 0 * * *` - midnight UTC)
- **Pro Tier:** Every minute (`*/1 * * * *`)

See `vercel.json` for current schedule configuration.

## 🔐 Security

- Environment variables stored securely in Vercel
- Firebase service account credentials never exposed
- `CRON_SECRET` for endpoint authentication
- Supports multiple authentication methods

## 📚 Related Documentation

- **[DEPLOYMENT.md](./DEPLOYMENT.md)** - Complete deployment guide
- **[DATABASE_STRUCTURE.md](../DATABASE_STRUCTURE.md)** - Firebase database schema (in main repo)
- **[SYSTEM_LOGIC.md](../SYSTEM_LOGIC.md)** - System logic and priorities (in main repo)

## 🐛 Troubleshooting

### Build Error: "Failed to collect page data"
- Make sure `app/layout.js` exists
- Verify `next.config.cjs` excludes frontend files
- This is an API-only project (no pages)

### Firebase Initialization Error
- Verify `FIREBASE_SERVICE_ACCOUNT` is valid JSON (single line)
- Check `FIREBASE_DB_URL` is correct
- Ensure environment variables are set in Vercel

### Cron Job Not Running
- Check `vercel.json` has cron configuration
- Verify environment variables are set
- Check Vercel Dashboard → Cron Jobs

## 📝 License

Private project

---

**For detailed deployment instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)**

