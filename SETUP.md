# 🔧 Quick Setup Guide

## Create `.env.local` File

1. **Navigate to the backend directory:**
   ```bash
   cd fishfeeder-backend
   ```

2. **Create `.env.local` file** (copy the content below):

```env
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"fishfeeder-81131","private_key_id":"0b31969f2137fe27f50a211cdd2d2159744475b8","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDRI+WR94URgEMS\nowc9soFSU3TyT6dqE1ERXnD+x7N9ajgSHgDVASY6KG2PG79NgcbFIVpZuwRG1/Pe\nh2zwhP2TG3qQkeV5+4+QRNoSFc5MiItQleqShA1WaHVInhM96duvsLMlHnurzxPR\nISthDD1z4V4X36F6MhDRl+0Dl4V9vz3rp7QcqYVdEOXqfjj8rxfHdImES4fosARI\nGeK9+EuOQs4SDYv04QA/YYUhWnVAwWQLq45+DwwjVX+NYIE/l8ZvCr/N9TIuwBOw\nlkRGw2buOmONzv2IUGM8sARPLqNP3pOI04djORLXTB4LTbd80UF/15QRmIwEnZ81\nPYOQvtWlAgMBAAECggEADWfVzyGaC9FNu1PsOBCz8xElaw4fBuYeaVTFPReTkkOX\nkisOgO4gw1PpveVt7EEYJXT/WRwV6Jfuv6ys7M021ydI7Ru6UAjcyXHDDAC40gq4\nlLL0r8KQ0PaYz02j9xvWjfBEyL7STOTU+i/m8MK7l6zHqWkXbSvotxPxcyxTDV3H\nTvmleDrAFmBc/BWw/4opwguxfSmtKf7QZj9j25tgooJOqE/2jcweLMh2WyGd6ruS\nfE5j/SY4+QlHclEeX14KLdo6uFYTKzS6V80Kqs71VlaN6XFQtVKrOJRuQjASDgXD\nNckNBt5nN9p4LkpMjPrG1tWxhN5Gu3SyNGaZZOuPywKBgQDuSKs8sgd0tAnrLIYw\nuRyAdYCJO/y4Hz2vdmrftA3uzsA06/PghZ0zhFyZrKV0mwdFXj8W0LUiJK8ccT7r\nCTfiSVs9jtFzpypGk7ur+VReCoHNZsAyoqQiWz28Aw2nw97A+bD8JvtW60bjbPqh\nDOYSoGghRhC7r2OME55LzRU1GwKBgQDgsIchGih9fezYM8aqZER1KRh7Xst+8wT1\nx2hgKnQSlzY621RQAiFw9eOrGORZplEYpD/kWgCjpMnN/klrhkr++kgHGkXpQIEu\nG4phDx/yFwd6k8gfg7VsGkYugJQQT8qRGziDn2fJqJQcjx8GG8fjr52UN49F2i7A\nGCMqgjSMPwKBgQDi+8xKpBggHoS4RpCJhzxUThokIEWLqw7avwXtlRoUm1RS1VVa\nUk0+Tt7a8LAn1KnndXDJrgRtwt4gTOwvfneCknhculhhQCMwWfhTSM4KSx386N07\nHt0VcS7sk0gFwLrHvtLOT9/qm3LKn/xbP+tGYRDwaUr1ToyYWfPXp0OFcwKBgQCk\nrZ0MjOB6QW3yc9g6kCyAdjNEUJDzJWhQPutn+BWEfqE3eAMOdNFPulg30ZGjhztO\nxSsy0ShAyAlEWggzr4SN5qAd3Iq6zxUe1v6P7obqZyiLFX8KYfz5EzS25nQelGyR\n95JvHcjyywRq/hat4nSZkt/6ftIaTzQOhGJZyH58/wKBgFBFCG3zuVxMknozXhiS\nadlLpXXyV+HEh4WhCZu59Om67VU7eFh8h+vYrqJlIzVmdCMFFSwTkHu9cg5K9mmp\nhE9A1xUvffkraD5ym7mP08/rd5wwfyir337DTppmzGm7PYcIHgCw+CexSUs5Bvko\nk6pPjrfkOTBijJASFzPID2DN\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-fbsvc@fishfeeder-81131.iam.gserviceaccount.com","client_id":"105004366660903426214","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_x509_cert_url":"https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40fishfeeder-81131.iam.gserviceaccount.com","universe_domain":"googleapis.com"}
FIREBASE_DB_URL=https://fishfeeder-81131-default-rtdb.firebaseio.com/
CRON_SECRET=dev-secret-key-change-in-production
```

3. **Save the file** as `.env.local` in the `fishfeeder-backend/` directory

4. **Test the setup:**
   ```bash
   npm install
   npm run dev
   ```

5. **Test the endpoint:**
   ```bash
   curl http://localhost:3000/api/cron
   ```

You should see a JSON response like:
```json
{"ok":true,"type":"none","reason":"no_feed_needed"}
```

## ⚠️ Important Notes

- **Never commit `.env.local`** to Git (it's already in `.gitignore`)
- **For production (Vercel):** Add these same environment variables in Vercel Dashboard → Settings → Environment Variables
- **Change `CRON_SECRET`** to a random string for production

## 🚀 Next Steps

Once `.env.local` is set up:
1. Test locally: `npm run dev`
2. Deploy to Vercel: See [DEPLOYMENT.md](./DEPLOYMENT.md)
3. Add environment variables in Vercel Dashboard

