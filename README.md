# Ayron AI Assistant

Ayron is a Flask-powered AI assistant with Google and email-code sign-in, chat history, and assistant modules.

## Features

- Google sign-in and one-time email verification codes
- Firebase Authentication and Firestore user profiles
- AI assistant and utility APIs powered by Groq
- Weather, cricket, holiday/special-date, and PDF tools

## Requirements

- Python 3.11 or newer
- A Firebase project with Authentication (Google provider) and Firestore enabled
- Firebase Admin SDK credentials with Authentication and Firestore access
- SMTP credentials for email-code sign-in
- API keys for any assistant modules you want to use

## Run locally

1. Copy `.env.example` to `.env` and set the required values. Never commit `.env`, Firebase service-account JSON files, SMTP credentials, or API keys.
2. Install Python dependencies and start Flask:

   ```powershell
   python -m venv venv
   .\venv\Scripts\python.exe -m pip install -r requirements.txt
   .\venv\Scripts\python.exe app.py
   ```

3. Open `http://127.0.0.1:5000`.

For local Firebase Admin access, either set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON file outside the repository or provide `FIREBASE_SERVICE_ACCOUNT_JSON` through a secure environment variable.

## Deploy to Vercel

This is a Flask application. Vercel detects the `app` instance in the root `app.py` and serves all application routes through its Python function; do not add a catch-all rewrite or a separate `api/index.py` wrapper. Import the GitHub repository into Vercel, use the Flask framework preset, and deploy from the repository root. Set the required environment variables in the Vercel project settings; do not upload local `.env` or service-account files. The site and authentication-config route can load without `GROQ_API_KEY`; AI endpoints return a clear `503` until it is configured.

The Firebase service account must be provided through a protected environment variable or an appropriate workload identity. A path such as `C:\Users\...\Downloads\...json` only exists on the local computer and will not work in a cloud deployment.

Set these variables for both Preview and Production deployments:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_API_KEY`
- `FIREBASE_AUTH_DOMAIN`
- `FIREBASE_MESSAGING_SENDER_ID`
- `FIREBASE_APP_ID`
- `FIREBASE_SERVICE_ACCOUNT_JSON` (or a supported workload identity)
- `EMAIL_OTP_SECRET`
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, and `SMTP_PASSWORD`
- `GROQ_API_KEY`

Set optional module keys such as `OPENWEATHER_API_KEY` and `CRICKET_API_KEY` if those modules are needed.
To show the next holiday above the chat welcome screen, set `CALENDARIFIC_API_KEY` and optionally `CALENDARIFIC_COUNTRY` (two-letter country code, default `IN`) in the server environment. Do not put the Calendarific key in frontend code or commit it.

Firebase must authorize the deployed site's domain for Google sign-in. Deploy `firestore.rules` to the same Firebase project.

## Authentication setup

See [AUTH_SETUP.md](AUTH_SETUP.md) for Firebase, SMTP, email-code, and security setup details.

## License

No license is currently specified. All rights reserved unless the repository owner adds a license.
