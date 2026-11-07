# Authentication setup

The website and the planned React Native app should use the **same Firebase project**. Users can sign in with Google or a one-time email code. Email codes are sent by this Flask backend, verified once, and exchanged for a Firebase custom token. Verified Firebase ID tokens are required on all assistant and module APIs. User profiles are stored in Firestore under `users/{uid}`.

## 1. Configure Firebase

1. Create a Firebase project and register a **Web app**.
2. In **Authentication → Sign-in method**, enable **Google**. Configure the authorized domains for local development and the deployed website. This app does not use phone sign-in; email codes are issued by the Flask backend.
3. Create a Firestore database in production mode.
4. Install the Firebase CLI, sign in, then deploy the included owner-only rules:

   ```sh
   firebase deploy --only firestore:rules
   ```

5. Create a server service account with only the Firebase Authentication and Firestore permissions this app needs. Prefer the hosting platform's workload identity. On Render, store the service account JSON as a protected environment variable; never commit it.

## 2. Configure server environment

Copy `.env.example` to `.env` for local development. Set the Firebase web app values from **Project settings → Your apps**:

- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_STORAGE_BUCKET` (optional)

Set `FIREBASE_SERVICE_ACCOUNT_JSON` to the server service account JSON as one line, or set `GOOGLE_APPLICATION_CREDENTIALS` to the local JSON file path. On the hosting provider, use its secret environment variable or workload identity rather than a path from your computer. The Admin SDK uses credentials to verify/revoke-check ID tokens, access Firestore OTP records, and sign email-OTP custom tokens.

The browser loads the Firebase SDK from Google's CDN, so `npm install firebase` is not needed. On Windows, open PowerShell in the project folder and run:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\venv\Scripts\python.exe app.py
```

Then open `http://127.0.0.1:5000`. Do not open `index.html` directly or use a static-only server, because `/api/firebase-config` and the sign-in APIs are served by Flask. If Firebase reports `CONFIGURATION_NOT_FOUND`, open Firebase Console → Authentication → Get started to initialize Authentication. For Google sign-in, add `localhost` under Authentication → Settings → Authorized domains.

If sign-in reports `auth/operation-not-allowed` even though the provider is enabled, check the project ID shown in the app's error message. It must match the Firebase project where the provider is enabled. For a deployed service, check the `FIREBASE_*` web configuration variables in the hosting provider's environment settings and redeploy after correcting them. `auth/unauthorized-domain` instead means the current website domain must be added under Authentication → Settings → Authorized domains.

For numeric email codes:

- Generate `EMAIL_OTP_SECRET` with `python -c "import secrets; print(secrets.token_urlsafe(48))"`. It must be at least 32 characters. Keep the same random value across deploys; never expose it to the browser or mobile app.
- Set `SMTP_USERNAME` and `SMTP_PASSWORD`; optionally set `SMTP_FROM`. Gmail requires two-step verification and a dedicated **App Password**; use the App Password, never your normal Gmail password. Keep SMTP credentials in your host's secret manager. A transactional email provider is preferable if the app will send at scale.
- `SMTP_HOST` and `SMTP_PORT` default to Gmail's STARTTLS endpoint (`smtp.gmail.com:587`). Port 465 uses implicit TLS; other ports use STARTTLS and fail if the server does not support it.
- Email codes also need the Firebase Admin SDK to access Firestore and sign custom tokens. Configure `FIREBASE_SERVICE_ACCOUNT_JSON` (or valid Application Default Credentials) with Firebase Authentication and Firestore access. In Firestore, create the database and deploy `firestore.rules`.
- If **Continue with email code** is disabled, the login page lists any missing SMTP or OTP environment variables. Set them in `.env` locally or in the hosting provider's environment settings, then restart the Flask app or redeploy. Firebase Admin credentials and Firestore access are also required; backend errors identify when those are unavailable. The server's `/api/firebase-config` response reports readiness without exposing secret values.

Set all production values in the Render service's environment settings. The Firebase web config is public by design; the service account, SMTP password, and OTP HMAC secret are private. Do not copy secrets into frontend code.

## 3. React Native app

Register the Android/iOS apps in this same Firebase project and use the native Firebase Auth SDK for Google sign-in. For email code sign-in, call:

- `POST /auth/email/send` with `{ "email": "..." }`
- `POST /auth/email/verify` with `{ "challengeId": "...", "code": "..." }`

Exchange the returned custom token with the native Firebase SDK's `signInWithCustomToken`. Send the resulting Firebase **ID token** as `Authorization: Bearer <id-token>` when calling any assistant API. Do not trust a UID or profile supplied by the app without a verified Firebase token.

## Security behavior

- Email codes expire after 10 minutes, are stored as keyed hashes, are single-use, and allow at most five guesses.
- Email code sending is rate-limited per email and source IP. Firestore rate-limit records also require server credentials.
- OTP/challenge collections are not readable or writable from client apps; only the backend Admin SDK can access them. Configure Firestore TTL policies for `expires_at` on `emailOtpChallenges` and `rate_limit_expires_at` on `emailOtpRateLimits` to remove expired records.
- `firestore.rules` lets a signed-in user access only their own profile and denies all other client database access by default.
- All AI, PDF, and assistant-module API routes reject requests without a verified, non-revoked Firebase ID token. Static serving is allowlisted so `.env` and service files are not exposed.

Before launch, test Google, SMS, email, sign-out, expired/reused/wrong OTPs, rate limits, Firestore rules, and the deployed domain on both web and mobile. Configure Firebase billing/quotas, restrict SMS regions, monitor authentication abuse, and rotate any credential that is accidentally exposed.
