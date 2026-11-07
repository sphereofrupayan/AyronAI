from functools import lru_cache, wraps
from threading import Lock
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import hashlib
import hmac
import re
import secrets
import smtplib
import ssl

from flask import Flask, request, jsonify, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from groq import Groq
from dotenv import load_dotenv
from pypdf import PdfReader
from google.api_core.exceptions import GoogleAPICallError
from google.auth.exceptions import GoogleAuthError
import os
import json
import logging
from pathlib import Path
import requests

import firebase_admin
from firebase_admin import auth as firebase_auth
from firebase_admin import credentials
from firebase_admin import exceptions as firebase_exceptions
from firebase_admin import firestore


env_path = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=env_path)

app = Flask(__name__, static_folder=None)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1)
app.config["MAX_CONTENT_LENGTH"] = 10 * 1024 * 1024
logger = logging.getLogger(__name__)

CRICKET_API_KEY = os.getenv("CRICKET_API_KEY")
OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY")

GROQ_MODEL = "openai/gpt-oss-120b"
FIREBASE_PUBLIC_CONFIG = {
    "apiKey": os.getenv("FIREBASE_API_KEY"),
    "authDomain": os.getenv("FIREBASE_AUTH_DOMAIN"),
    "projectId": os.getenv("FIREBASE_PROJECT_ID"),
    "storageBucket": os.getenv("FIREBASE_STORAGE_BUCKET"),
    "messagingSenderId": os.getenv("FIREBASE_MESSAGING_SENDER_ID"),
    "appId": os.getenv("FIREBASE_APP_ID"),
}
EMAIL_OTP_COLLECTION = "emailOtpChallenges"
EMAIL_OTP_RATE_COLLECTION = "emailOtpRateLimits"
EMAIL_OTP_LIFETIME = timedelta(minutes=10)
EMAIL_OTP_WINDOW = timedelta(minutes=15)
EMAIL_OTP_MAX_ATTEMPTS = 5
_firebase_app = None
_firebase_app_lock = Lock()


@lru_cache(maxsize=1)
def get_groq_client():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("AI features are unavailable because GROQ_API_KEY is not configured.")
    return Groq(api_key=api_key)


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin-allow-popups"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=(self)"
    if request.is_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000"
    if request.path.startswith(("/api/", "/auth/")) or request.method != "GET":
        response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://www.gstatic.com https://apis.google.com "
        "https://www.google.com https://www.recaptcha.net; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: https://*.googleusercontent.com https://images.unsplash.com; "
        "connect-src 'self' https://identitytoolkit.googleapis.com "
        "https://securetoken.googleapis.com https://firestore.googleapis.com "
        "https://firebaseinstallations.googleapis.com https://www.googleapis.com; "
        "frame-src https://*.firebaseapp.com https://accounts.google.com "
        "https://www.google.com https://recaptcha.google.com https://www.recaptcha.net; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    )
    return response


def get_firebase_app():
    global _firebase_app

    if _firebase_app is not None:
        return _firebase_app

    project_id = os.getenv("FIREBASE_PROJECT_ID")
    if not project_id:
        raise RuntimeError("FIREBASE_PROJECT_ID is not configured.")

    with _firebase_app_lock:
        if _firebase_app is not None:
            return _firebase_app

        try:
            _firebase_app = firebase_admin.get_app()
        except ValueError:
            service_account_json = os.getenv("FIREBASE_SERVICE_ACCOUNT_JSON")
            if service_account_json:
                service_account = json.loads(service_account_json)
                if service_account.get("project_id") != project_id:
                    raise ValueError(
                        "Firebase service account project_id does not match "
                        "FIREBASE_PROJECT_ID."
                    )
                credential = credentials.Certificate(service_account)
                _firebase_app = firebase_admin.initialize_app(
                    credential,
                    options={"projectId": project_id}
                )
            else:
                _firebase_app = firebase_admin.initialize_app(
                    options={"projectId": project_id}
                )

    return _firebase_app


def require_firebase_user(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        authorization = request.headers.get("Authorization", "")
        scheme, separator, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not separator or not token.strip():
            return jsonify({"error": "Authentication required."}), 401

        try:
            firebase_app = get_firebase_app()
        except (firebase_exceptions.FirebaseError, GoogleAPICallError,
                GoogleAuthError, RuntimeError, ValueError):
            logger.exception("Firebase Admin SDK is not configured.")
            return jsonify({"error": "Authentication service is temporarily unavailable."}), 503

        try:
            claims = firebase_auth.verify_id_token(
                token.strip(),
                app=firebase_app,
                check_revoked=True
            )
        except (firebase_auth.InvalidIdTokenError,
                firebase_auth.ExpiredIdTokenError,
                firebase_auth.RevokedIdTokenError,
                firebase_auth.UserNotFoundError,
                ValueError):
            return jsonify({"error": "Your session is invalid or expired. Sign in again."}), 401
        except (firebase_exceptions.FirebaseError, RuntimeError, json.JSONDecodeError):
            logger.exception("Firebase token verification is unavailable.")
            return jsonify({"error": "Authentication service is temporarily unavailable."}), 503

        request.firebase_user = claims
        return handler(*args, **kwargs)

    return wrapped


def require_groq_api_key(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        if not os.getenv("GROQ_API_KEY"):
            return jsonify({
                "error": "AI features are unavailable because GROQ_API_KEY is not configured."
            }), 503
        return handler(*args, **kwargs)

    return wrapped


def email_otp_missing_settings():
    missing = []
    secret = os.getenv("EMAIL_OTP_SECRET", "")
    if len(secret.encode("utf-8")) < 32:
        missing.append("EMAIL_OTP_SECRET")
    for key in ("SMTP_USERNAME", "SMTP_PASSWORD"):
        if not os.getenv(key, "").strip():
            missing.append(key)

    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError:
        port = 0
    if not os.getenv("SMTP_HOST", "smtp.gmail.com").strip():
        missing.append("SMTP_HOST")
    if not 1 <= port <= 65535:
        missing.append("SMTP_PORT")
    return missing


def email_otp_is_configured():
    return not email_otp_missing_settings()


def email_otp_setup_error():
    missing = email_otp_missing_settings()
    if not missing:
        return None
    return (
        "Email code sign-in is not configured on this server. Set: "
        + ", ".join(missing)
        + "."
    )


def get_firestore_client():
    return firestore.client(app=get_firebase_app())


def consume_email_otp_rate_limit(database, key, limit):
    document_id = hashlib.sha256(key.encode("utf-8")).hexdigest()
    rate_ref = database.collection(EMAIL_OTP_RATE_COLLECTION).document(document_id)
    transaction = database.transaction()

    @firestore.transactional
    def update_rate(transaction):
        snapshot = rate_ref.get(transaction=transaction)
        now = datetime.now(timezone.utc)
        data = snapshot.to_dict() or {}
        window_start = data.get("window_started_at")
        if window_start and now - window_start < EMAIL_OTP_WINDOW:
            count = int(data.get("count", 0))
            if count >= limit:
                return False
            transaction.update(rate_ref, {"count": count + 1})
        else:
            transaction.set(rate_ref, {
                "count": 1,
                "window_started_at": now,
                "rate_limit_expires_at": now + timedelta(days=1)
            })
        return True

    return update_rate(transaction)


def send_email_otp_message(email_address, code):
    username = os.getenv("SMTP_USERNAME")
    password = os.getenv("SMTP_PASSWORD")
    sender = os.getenv("SMTP_FROM") or username
    host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    port = int(os.getenv("SMTP_PORT", "587"))

    message = EmailMessage()
    message["Subject"] = "Your Ayron sign-in code"
    message["From"] = sender
    message["To"] = email_address
    message.set_content(
        f"Your Ayron verification code is {code}.\n\n"
        "This code expires in 10 minutes and can only be used once. "
        "If you did not request it, you can ignore this email."
    )

    context = ssl.create_default_context()
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as server:
            server.login(username, password)
            server.send_message(message)
        return

    with smtplib.SMTP(host, port, timeout=15) as server:
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
        server.login(username, password)
        server.send_message(message)


def ask_groq(system_prompt, user_prompt):
    """Shared helper for every tool route."""
    response = get_groq_client().chat.completions.create(
        model=GROQ_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
    )
    return response.choices[0].message.content


def extract_pdf_text(file_storage):
    """Extracts text from an uploaded PDF file. Raises on failure."""
    reader = PdfReader(file_storage)
    text = ""
    for page in reader.pages:
        text += page.extract_text() or ""
    return text


@app.route("/")
def home():
    return send_from_directory(".", "index.html")


@app.get("/api/firebase-config")
def firebase_config():
    required = ("apiKey", "authDomain", "projectId", "messagingSenderId", "appId")
    missing = [key for key in required if not FIREBASE_PUBLIC_CONFIG.get(key)]
    if missing:
        return jsonify({
            "error": (
                "Firebase sign-in is not configured. Set the Firebase web "
                "configuration environment variables."
            )
        }), 503
    return jsonify({
        **FIREBASE_PUBLIC_CONFIG,
        "emailOtpEnabled": email_otp_is_configured(),
        "emailOtpMissingSettings": email_otp_missing_settings()
    })


@app.post("/auth/email/send")
def send_email_otp():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "A valid email address is required."}), 400

    email_input = data.get("email")
    if not isinstance(email_input, str):
        return jsonify({"error": "Enter a valid email address."}), 400
    email_address = email_input.strip().lower()
    if (len(email_address) > 254 or
            not re.fullmatch(r"[^@\s]{1,64}@[^@\s.]+(?:\.[^@\s.]+)+", email_address)):
        return jsonify({"error": "Enter a valid email address."}), 400
    setup_error = email_otp_setup_error()
    if setup_error:
        return jsonify({"error": setup_error}), 503

    try:
        database = get_firestore_client()
        ip_address = request.remote_addr or "unknown"
        if not consume_email_otp_rate_limit(database, f"email:{email_address}", 3):
            return jsonify({"error": "Too many codes requested. Try again in 15 minutes."}), 429
        if not consume_email_otp_rate_limit(database, f"ip:{ip_address}", 12):
            return jsonify({"error": "Too many codes requested from this network. Try again later."}), 429

        challenge_id = secrets.token_urlsafe(24)
        code = f"{secrets.randbelow(1_000_000):06d}"
        otp_secret = os.environ["EMAIL_OTP_SECRET"].encode("utf-8")
        otp_digest = hmac.new(
            otp_secret,
            f"{challenge_id}:{email_address}:{code}".encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        now = datetime.now(timezone.utc)
        challenge_ref = database.collection(EMAIL_OTP_COLLECTION).document(challenge_id)
        challenge_ref.create({
            "email": email_address,
            "otp_hash": otp_digest,
            "attempts": 0,
            "consumed": False,
            "created_at": now,
            "expires_at": now + EMAIL_OTP_LIFETIME
        })

        try:
            send_email_otp_message(email_address, code)
        except (smtplib.SMTPException, OSError, ValueError):
            logger.exception("Could not deliver a sign-in code.")
            challenge_ref.update({"consumed": True})
            return jsonify({
                "error": (
                    "Email delivery failed. Check the server's SMTP settings "
                    "and email provider's app password, then try again."
                )
            }), 503

        return jsonify({
            "challengeId": challenge_id,
            "message": "If this address can receive email, a sign-in code has been sent."
        })
    except (firebase_exceptions.FirebaseError, GoogleAPICallError,
            GoogleAuthError, RuntimeError, ValueError):
        logger.exception("Email sign-in is unavailable.")
        return jsonify({
            "error": (
                "Firebase Admin or Firestore is unavailable. Check the server "
                "credentials, project access, and Firestore database."
            )
        }), 503


@app.post("/auth/email/verify")
def verify_email_otp():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify({"error": "Enter the verification code."}), 400

    challenge_id = data.get("challengeId", "")
    code = data.get("code", "")
    if (not isinstance(challenge_id, str) or
            not re.fullmatch(r"[A-Za-z0-9_-]{20,100}", challenge_id) or
            not isinstance(code, str) or
            not re.fullmatch(r"\d{6}", code)):
        return jsonify({"error": "Enter a valid 6-digit verification code."}), 400
    setup_error = email_otp_setup_error()
    if setup_error:
        return jsonify({"error": setup_error}), 503

    try:
        database = get_firestore_client()
        firebase_app = get_firebase_app()
        challenge_ref = database.collection(EMAIL_OTP_COLLECTION).document(challenge_id)
        transaction = database.transaction()

        @firestore.transactional
        def consume_challenge(transaction):
            snapshot = challenge_ref.get(transaction=transaction)
            if not snapshot.exists:
                return None, "invalid"

            challenge = snapshot.to_dict()
            now = datetime.now(timezone.utc)
            if challenge.get("consumed"):
                return None, "invalid"
            if challenge.get("expires_at") <= now:
                transaction.update(challenge_ref, {"consumed": True})
                return None, "expired"
            if challenge.get("attempts", 0) >= EMAIL_OTP_MAX_ATTEMPTS:
                transaction.update(challenge_ref, {"consumed": True})
                return None, "locked"

            expected_hash = hmac.new(
                os.environ["EMAIL_OTP_SECRET"].encode("utf-8"),
                f"{challenge_id}:{challenge['email']}:{code}".encode("utf-8"),
                hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(challenge["otp_hash"], expected_hash):
                transaction.update(challenge_ref, {"attempts": challenge.get("attempts", 0) + 1})
                return None, "invalid"

            transaction.update(challenge_ref, {"consumed": True})
            return challenge["email"], "verified"

        email_address, result = consume_challenge(transaction)
        if result == "expired":
            return jsonify({"error": "That code has expired. Request a new one."}), 400
        if result == "locked":
            return jsonify({"error": "Too many incorrect codes. Request a new one."}), 429
        if result != "verified":
            return jsonify({"error": "That code is invalid. Check it or request a new one."}), 400

        try:
            user = firebase_auth.get_user_by_email(email_address, app=firebase_app)
        except firebase_auth.UserNotFoundError:
            try:
                user = firebase_auth.create_user(
                    email=email_address,
                    email_verified=True,
                    app=firebase_app
                )
            except firebase_auth.EmailAlreadyExistsError:
                user = firebase_auth.get_user_by_email(email_address, app=firebase_app)

        if not user.email_verified:
            user = firebase_auth.update_user(
                user.uid,
                email_verified=True,
                app=firebase_app
            )
        custom_token = firebase_auth.create_custom_token(user.uid, app=firebase_app)
        return jsonify({"token": custom_token.decode("utf-8")})
    except (firebase_exceptions.FirebaseError, GoogleAPICallError,
            GoogleAuthError, RuntimeError, ValueError):
        logger.exception("Email code verification is unavailable.")
        return jsonify({
            "error": (
                "Firebase Admin or Firestore is unavailable. Check the server "
                "credentials, project access, and Firestore database."
            )
        }), 503


@app.get("/style.css")
@app.get("/script.js")
@app.get("/auth.js")
@app.get("/R.png")
@app.get("/mic.svg")
def public_asset():
    filename = request.path.lstrip("/")
    return send_from_directory(Path(__file__).parent, filename)


@app.route("/chat", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def chat():

    data = request.get_json()
    user_message = data.get("message", "")
    message = user_message.lower()
    history = data.get("history", [])
    think_mode = data.get("think", False)

    weather_keywords = [
        "weather",
        "temperature",
        "forecast",
        "rain",
        "humidity",
        "hot",
        "cold",
        "climate"
    ]

    if any(keyword in message for keyword in weather_keywords):

        lat = data.get("lat")
        lon = data.get("lon")
        city = None

        if " in " in message:
            city = user_message.lower().split(" in ", 1)[1].strip().title()

        try:
            if city:
                url = (
                    f"https://api.openweathermap.org/data/2.5/weather?"
                    f"q={city}&appid={OPENWEATHER_API_KEY}&units=metric"
                )
            elif lat is not None and lon is not None:
                url = (
                    f"https://api.openweathermap.org/data/2.5/weather?"
                    f"lat={lat}&lon={lon}&appid={OPENWEATHER_API_KEY}&units=metric"
                )
            else:
                url = (
                    f"https://api.openweathermap.org/data/2.5/weather?"
                    f"q=Vellore&appid={OPENWEATHER_API_KEY}&units=metric"
                )

            response = requests.get(url)
            weather_data = response.json()

            if weather_data.get("cod") == 200:

                location_name = weather_data.get("name", city or "your area")
                temperature = weather_data["main"]["temp"]
                feels_like = weather_data["main"]["feels_like"]
                humidity = weather_data["main"]["humidity"]
                description = weather_data["weather"][0]["description"]
                wind_speed = weather_data["wind"]["speed"]

                reply = (
                    f"🌤 Weather in {location_name}\n\n"
                    f"🌡 Temperature: {temperature}°C\n"
                    f"🤗 Feels Like: {feels_like}°C\n"
                    f"☁ Condition: {description.title()}\n"
                    f"💧 Humidity: {humidity}%\n"
                    f"💨 Wind Speed: {wind_speed} m/s"
                )

            else:
                reply = "Sorry, I couldn't find weather information for that location."

        except Exception:
            reply = "Unable to fetch weather information."

        return jsonify({"reply": reply})



    messages = [
        {
            "role": "system",
            "content": (
                "You are Ayron, a friendly AI assistant created by "
                "Rupayan Chattaraj. Keep answers short unless the user "
                "asks for details."
                + (
                    " Think carefully and provide a clear, well-structured "
                    "answer with a brief explanation. Do not reveal private "
                    "chain-of-thought."
                    if think_mode else ""
                )
            )
        }
    ]


    for turn in history[-10:]:
        role = turn.get("role")
        content = turn.get("content")

        if role in ("user", "assistant") and content:
            messages.append({
                "role": role,
                "content": content
            })

    messages.append({
        "role": "user",
        "content": user_message
    })

    try:
        response = get_groq_client().chat.completions.create(
            model=GROQ_MODEL,
            messages=messages
        )

        answer = response.choices[0].message.content

    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({"reply": answer})

@app.route("/cricket-score", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def cricket_score():
    data = request.get_json()
    message = (data.get("message") or "").strip()

    system_prompt = (
        "You are Ayron. You do NOT have access to live or real-time "
        "sports scores. If asked about a live score, current match, or "
        "recent result, clearly say you can't provide live scores and "
        "suggest the user check a live source like Cricbuzz, ESPNcricinfo, "
        "or Google. Do not guess or invent scores, team names, or results."
    )

    try:
        reply = ask_groq(system_prompt, message)
    except Exception:
        return jsonify({"error": "Something went wrong."}), 500

    return jsonify({"reply": reply})
@app.route("/resume-analyze", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def resume_analyze():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    try:
        text = extract_pdf_text(file)
    except Exception:
        return jsonify({"error": "Could not read the PDF"}), 400

    if not text.strip():
        return jsonify({"error": "No readable text found in that PDF"}), 400

    system_prompt = (
        "You are an expert resume reviewer. Analyze the resume text and give "
        "structured feedback covering: overall impression, strengths, "
        "weaknesses, formatting/ATS issues, and 3-5 concrete improvement "
        "suggestions. Be concise and actionable."
    )

    try:
        reply = ask_groq(system_prompt, text[:6000])
    except Exception:
        return jsonify({"error": "AI analysis failed"}), 500

    return jsonify({"reply": reply})


@app.route("/notes-summarize", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def notes_summarize():
    data = request.get_json()
    notes = (data.get("text") or "").strip()

    if not notes:
        return jsonify({"error": "No text provided"}), 400

    system_prompt = (
        "You summarize study notes into clear, well-organized bullet points, "
        "highlighting key concepts and definitions. Use short headings where "
        "it helps readability."
    )

    try:
        reply = ask_groq(system_prompt, notes[:8000])
    except Exception:
        return jsonify({"error": "Summarization failed"}), 500

    return jsonify({"reply": reply})


@app.route("/code-review", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def code_review():
    data = request.get_json()
    code = (data.get("code") or "").strip()
    language = (data.get("language") or "").strip()

    if not code:
        return jsonify({"error": "No code provided"}), 400

    system_prompt = (
        "You are a senior software engineer performing a code review. Review "
        "the given code for bugs, readability, performance, and best "
        "practices. List issues clearly and suggest improved snippets where "
        "relevant. Be concise but thorough."
    )
    user_prompt = f"Language: {language or 'unspecified'}\n\nCode:\n{code[:8000]}"

    try:
        reply = ask_groq(system_prompt, user_prompt)
    except Exception:
        return jsonify({"error": "Code review failed"}), 500

    return jsonify({"reply": reply})


@app.route("/email-write", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def email_write():
    data = request.get_json()
    details = (data.get("details") or "").strip()
    tone = (data.get("tone") or "Professional").strip()

    if not details:
        return jsonify({"error": "No details provided"}), 400

    system_prompt = (
        f"You write clear, well-structured emails in a {tone.lower()} tone. "
        "Include an appropriate subject line and sign-off. Return the email "
        "ready to send, with no extra commentary."
    )

    try:
        reply = ask_groq(system_prompt, details[:4000])
    except Exception:
        return jsonify({"error": "Email generation failed"}), 500

    return jsonify({"reply": reply})


@app.route("/study-planner", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def study_planner():
    data = request.get_json()
    subject = (data.get("subject") or "").strip()
    duration = (data.get("duration") or "").strip()
    goal = (data.get("goal") or "").strip()

    if not subject:
        return jsonify({"error": "No subject provided"}), 400

    system_prompt = (
        "You are a study planning assistant. Create a structured, day-by-day "
        "or week-by-week study plan based on the subject, timeframe, and "
        "goal given. Keep it realistic and organized under clear headings."
    )
    user_prompt = (
        f"Subject: {subject}\n"
        f"Timeframe: {duration or 'not specified'}\n"
        f"Goal: {goal or 'not specified'}"
    )

    try:
        reply = ask_groq(system_prompt, user_prompt)
    except Exception:
        return jsonify({"error": "Planner generation failed"}), 500

    return jsonify({"reply": reply})


@app.route("/quiz-generate", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def quiz_generate():
    data = request.get_json()
    topic = (data.get("topic") or "").strip()
    count = data.get("count", "5")
    difficulty = (data.get("difficulty") or "Medium").strip()

    if not topic:
        return jsonify({"error": "No topic provided"}), 400

    system_prompt = (
        "You generate multiple-choice quizzes. Respond ONLY with valid JSON, "
        "no preamble, no markdown fences, in exactly this shape: "
        '{"questions": [{"question": "...", "options": ["...", "...", "...", "..."], '
        '"answer": "..."}]}. The "answer" value must exactly match one of the options.'
    )
    user_prompt = f"Topic: {topic}\nNumber of questions: {count}\nDifficulty: {difficulty}"

    try:
        raw = ask_groq(system_prompt, user_prompt)
        cleaned = raw.replace("```json", "").replace("```", "").strip()
        quiz = json.loads(cleaned)
    except Exception:
        return jsonify({"error": "Quiz generation failed"}), 500

    return jsonify(quiz)


@app.route("/pdf-upload", methods=["POST"])
@require_firebase_user
def pdf_upload():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    try:
        text = extract_pdf_text(file)
    except Exception:
        return jsonify({"error": "Could not read the PDF"}), 400

    if not text.strip():
        return jsonify({"error": "No readable text found in that PDF"}), 400

    return jsonify({"text": text[:15000]})


@app.route("/pdf-chat", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def pdf_chat():
    data = request.get_json()
    context = (data.get("context") or "").strip()
    question = (data.get("question") or "").strip()

    if not context or not question:
        return jsonify({"error": "Missing document context or question"}), 400

    system_prompt = (
        "Answer the user's question using only the provided document "
        "context. If the answer isn't in the document, say so clearly "
        "instead of guessing."
    )
    user_prompt = f"Document:\n{context[:12000]}\n\nQuestion: {question}"

    try:
        reply = ask_groq(system_prompt, user_prompt)
    except Exception:
        return jsonify({"error": "PDF chat failed"}), 500

    return jsonify({"reply": reply})


@app.route("/translate", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def translate():
    data = request.get_json()
    text = (data.get("text") or "").strip()
    target_language = (data.get("target_language") or "").strip()

    if not text or not target_language:
        return jsonify({"error": "Missing text or target language"}), 400

    system_prompt = (
        "You are a professional translator. Translate the given text "
        "accurately into the target language, preserving tone and meaning. "
        "Return only the translated text, with no extra commentary."
    )
    user_prompt = f"Translate to {target_language}:\n\n{text[:4000]}"

    try:
        reply = ask_groq(system_prompt, user_prompt)
    except Exception:
        return jsonify({"error": "Translation failed"}), 500

    return jsonify({"reply": reply})


@app.route("/grammar-check", methods=["POST"])
@require_firebase_user
@require_groq_api_key
def grammar_check():
    data = request.get_json()
    text = (data.get("text") or "").strip()

    if not text:
        return jsonify({"error": "No text provided"}), 400

    system_prompt = (
        "You proofread text for grammar, spelling, punctuation, and clarity. "
        "Return the corrected version first under a 'Corrected:' heading, "
        "then a short bullet list of the key issues fixed under a "
        "'Changes:' heading."
    )

    try:
        reply = ask_groq(system_prompt, text[:4000])
    except Exception:
        return jsonify({"error": "Grammar check failed"}), 500

    return jsonify({"reply": reply})


if __name__ == "__main__":
    app.run(debug=False)