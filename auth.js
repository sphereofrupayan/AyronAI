import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
    GoogleAuthProvider,
    getAuth,
    onAuthStateChanged,
    signInWithCustomToken,
    signInWithPopup,
    signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
    doc,
    getDoc,
    getFirestore,
    serverTimestamp,
    setDoc
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

const authGate = document.querySelector("#authGate");
const appShell = document.querySelector("#appShell");
const authStatus = document.querySelector("#authStatus");
const googleSignInBtn = document.querySelector("#googleSignInBtn");
const emailAuthToggle = document.querySelector("#emailAuthToggle");
const emailAuthSetupNotice = document.querySelector("#emailAuthSetupNotice");
const emailAuthForm = document.querySelector("#emailAuthForm");
const emailAddressInput = document.querySelector("#emailAddress");
const sendEmailOtpBtn = document.querySelector("#sendEmailOtpBtn");
const emailOtpEntry = document.querySelector("#emailOtpEntry");
const emailOtpCodeInput = document.querySelector("#emailOtpCode");
const verifyEmailOtpBtn = document.querySelector("#verifyEmailOtpBtn");
const resendEmailOtpBtn = document.querySelector("#resendEmailOtpBtn");
const changeEmailBtn = document.querySelector("#changeEmailBtn");
const emailEntry = document.querySelector("#emailEntry");

let auth = null;
let database = null;
let emailResendTimer = null;
let emailResendWait = 0;
let emailChallengeId = null;
let emailOtpEnabled = false;
let emailOtpMissingSettings = [];

function getSignInPrompt() {
    return emailOtpEnabled
        ? "Sign in with Google or email to continue."
        : "Sign in with Google to continue.";
}

function setStatus(message, kind = "") {
    authStatus.textContent = message;
    authStatus.className = `auth-status${kind ? ` ${kind}` : ""}`;
}

async function readJsonResponse(response, endpoint) {
    if (!response.headers.get("content-type")?.includes("json")) {
        throw new Error(
            `${endpoint} returned a webpage instead of JSON (HTTP ${response.status}). ` +
            "Make sure the site is served by the Flask app, not a static server."
        );
    }
    return response.json();
}

function setAuthButtonsEnabled(enabled) {
    googleSignInBtn.disabled = !enabled;
    emailAuthToggle.disabled = !enabled || !emailOtpEnabled;
    sendEmailOtpBtn.disabled = !enabled || !emailOtpEnabled;
}

function showAppToast(message) {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 3500);
}

function describeAuthError(error) {
    const messages = {
        "auth/popup-closed-by-user": "The Google sign-in window was closed before finishing.",
        "auth/popup-blocked": "Your browser blocked the sign-in popup. Allow popups and try again.",
        "auth/cancelled-popup-request": "Another sign-in window is already open.",
        "auth/invalid-api-key": "Firebase rejected this app's API key. Check that the ayron-7535f Web App config is in the server's .env file.",
        "auth/app-not-authorized": "This app is not authorized to use Firebase Authentication. Check the API key restrictions in Google Cloud Console.",
        "auth/auth-domain-config-required": "Firebase Auth domain is missing. Set FIREBASE_AUTH_DOMAIN to ayron-7535f.firebaseapp.com and restart the app.",
        "auth/configuration-not-found": "Firebase Authentication is not set up for ayron-7535f yet. In Firebase Console, open Authentication, select Get started, then enable Google under Sign-in method.",
        "auth/invalid-oauth-client-id": "Google sign-in is misconfigured. Check the Google provider's Web SDK configuration in Firebase Authentication.",
        "auth/account-exists-with-different-credential": "An account already exists with this email using another sign-in method. Sign in with that method first.",
        "auth/code-expired": "That code has expired. Request a new one.",
        "auth/too-many-requests": "Too many attempts. Please wait a while before trying again.",
        "auth/operation-not-allowed": `Firebase rejected this sign-in method for project "${auth?.app?.options?.projectId || "unknown"}". Check Authentication → Sign-in method in that exact project. If the provider is already enabled, verify the site's Firebase web config and redeploy.`,
        "auth/unauthorized-domain": "Add this website's domain to Firebase Authentication's authorized domains.",
        "auth/network-request-failed": "Network request failed. Check your connection and try again.",
        "auth/invalid-custom-token": "Email sign-in could not be completed. Request a new code.",
        "auth/custom-token-mismatch": "Email sign-in is connected to the wrong Firebase project. Contact the app administrator."
    };
    if (messages[error?.code]) return messages[error.code];
    if (error?.code) {
        return `Sign-in failed (${error.code}). Check the browser console and Firebase Authentication setup.`;
    }
    return error?.message || "Sign-in failed. Check the browser console for details.";
}

function resetSignInForms() {
    emailAuthForm.hidden = true;
    emailEntry.hidden = false;
    emailOtpEntry.hidden = true;
    window.clearInterval(emailResendTimer);
    emailResendWait = 0;
    resendEmailOtpBtn.disabled = false;
    resendEmailOtpBtn.textContent = "Resend code";
    emailChallengeId = null;
    emailOtpCodeInput.value = "";
}

function startResendCountdown(button) {
    window.clearInterval(emailResendTimer);
    emailResendWait = 30;
    button.disabled = true;
    button.textContent = "Resend code in 30s";
    const interval = window.setInterval(() => {
        emailResendWait -= 1;
        if (emailResendWait <= 0) {
            window.clearInterval(interval);
            button.disabled = false;
            button.textContent = "Resend code";
            return;
        }
        button.textContent = `Resend code in ${emailResendWait}s`;
    }, 1000);
    emailResendTimer = interval;
}

async function saveUserProfile(user) {
    const profileRef = doc(database, "users", user.uid);
    const existingProfile = await getDoc(profileRef);
    const profile = {
        displayName: user.displayName || "Ayron user",
        email: user.email || null,
        phoneNumber: user.phoneNumber || null,
        photoURL: user.photoURL || null,
        providerIds: user.providerData.map(provider => provider.providerId),
        lastLoginAt: serverTimestamp()
    };
    if (!existingProfile.exists()) profile.createdAt = serverTimestamp();
    await setDoc(profileRef, profile, { merge: true });
}

async function handleAuthState(user) {
    window.dispatchEvent(new CustomEvent("rusho-auth-state-changed", {
        detail: { userId: user?.uid || null }
    }));
    if (!user) {
        resetSignInForms();
        appShell.inert = true;
        authGate.hidden = false;
        setStatus(getSignInPrompt());
        return;
    }

    authGate.hidden = true;
    appShell.inert = false;
    const accountName = user.displayName || user.phoneNumber || "Ayron user";
    document.querySelector("#accountName").textContent = accountName;
    document.querySelector("#accountEmail").textContent = user.email || user.phoneNumber || "Signed in";
    const initials = accountName.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    document.querySelector(".avatar").textContent = initials || "R";

    try {
        await saveUserProfile(user);
    } catch (error) {
        console.error("Could not save the user's Firestore profile:", error);
        showAppToast("Signed in, but your profile could not sync. Check Firestore setup and try again.");
    }
}

async function sendEmailCode() {
    const email = emailAddressInput.value.trim().toLowerCase();
    if (!emailOtpEnabled) {
        setStatus("Email code sign-in is not configured on this server.", "error");
        return;
    }
    if (!emailAddressInput.checkValidity() || email.length > 254) {
        setStatus("Enter a valid email address.", "error");
        emailAddressInput.focus();
        return;
    }

    sendEmailOtpBtn.disabled = true;
    sendEmailOtpBtn.textContent = "Sending code…";
    setStatus("Sending your one-time code securely…");
    try {
        const response = await fetch("/auth/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email })
        });
        const data = await readJsonResponse(response, "/auth/email/send");
        if (!response.ok) throw new Error(data.error || "Could not send an email code.");

        emailChallengeId = data.challengeId;
        emailEntry.hidden = true;
        emailOtpEntry.hidden = false;
        document.querySelector("#emailOtpSentNotice").textContent = `Enter the code sent to ${email}.`;
        setStatus("If this address can receive email, a sign-in code has been sent.", "success");
        startResendCountdown(resendEmailOtpBtn);
        emailOtpCodeInput.focus();
    } catch (error) {
        console.error("Could not send email verification code:", error);
        setStatus(error.message || "Could not send the email code. Try again later.", "error");
    } finally {
        sendEmailOtpBtn.disabled = !emailOtpEnabled;
        sendEmailOtpBtn.innerHTML = 'Send email code <span>→</span>';
    }
}

googleSignInBtn.addEventListener("click", async () => {
    if (!auth) return;
    googleSignInBtn.disabled = true;
    setStatus("Opening secure Google sign-in…");
    try {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: "select_account" });
        await signInWithPopup(auth, provider);
    } catch (error) {
        console.error("Google sign-in failed:", {
            code: error?.code || "unknown",
            message: error?.message || String(error)
        });
        setStatus(describeAuthError(error), "error");
    } finally {
        googleSignInBtn.disabled = false;
    }
});

emailAuthToggle.addEventListener("click", () => {
    emailAuthForm.hidden = !emailAuthForm.hidden;
    if (!emailAuthForm.hidden) {
        setStatus("Enter your email address to receive a one-time sign-in code.");
        emailAddressInput.focus();
    } else {
        setStatus(getSignInPrompt());
    }
});

emailAuthForm.addEventListener("submit", event => {
    event.preventDefault();
    if (emailChallengeId) verifyEmailCode();
    else sendEmailCode();
});

async function verifyEmailCode() {
    const code = emailOtpCodeInput.value.trim();
    if (!emailChallengeId || !/^\d{6}$/.test(code)) {
        setStatus("Enter the 6-digit code from your email.", "error");
        emailOtpCodeInput.focus();
        return;
    }
    verifyEmailOtpBtn.disabled = true;
    verifyEmailOtpBtn.textContent = "Verifying…";
    try {
        const response = await fetch("/auth/email/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challengeId: emailChallengeId, code })
        });
        const data = await readJsonResponse(response, "/auth/email/verify");
        if (!response.ok) throw new Error(data.error || "Could not verify the email code.");
        await signInWithCustomToken(auth, data.token);
    } catch (error) {
        console.error("Email code verification failed:", error);
        setStatus(error.message || describeAuthError(error), "error");
    } finally {
        verifyEmailOtpBtn.disabled = false;
        verifyEmailOtpBtn.innerHTML = 'Verify and sign in <span>→</span>';
    }
}

resendEmailOtpBtn.addEventListener("click", () => {
    if (emailResendWait > 0) return;
    emailOtpEntry.hidden = true;
    emailEntry.hidden = false;
    emailOtpCodeInput.value = "";
    emailChallengeId = null;
    sendEmailCode();
});

changeEmailBtn.addEventListener("click", () => {
    emailChallengeId = null;
    emailOtpCodeInput.value = "";
    emailOtpEntry.hidden = true;
    emailEntry.hidden = false;
    window.clearInterval(emailResendTimer);
    emailResendWait = 0;
    resendEmailOtpBtn.disabled = false;
    resendEmailOtpBtn.textContent = "Resend code";
    setStatus("Check the email address and request a new verification code.");
    emailAddressInput.focus();
});

document.querySelector("#logoutBtn").addEventListener("click", async () => {
    if (!auth) return;
    try {
        await signOut(auth);
    } catch (error) {
        console.error("Sign-out failed:", error);
        showAppToast("Could not sign out. Please try again.");
    }
});

window.rushoAuth = Object.freeze({
    getUserId() {
        return auth?.currentUser?.uid || null;
    },
    async getIdToken() {
        if (!auth?.currentUser) throw new Error("Please sign in to continue.");
        return auth.currentUser.getIdToken();
    }
});

async function initializeAuthentication() {
    setStatus("Loading secure sign-in…");
    try {
        const response = await fetch("/api/firebase-config", { cache: "no-store" });
        const config = await readJsonResponse(response, "/api/firebase-config");
        if (!response.ok) throw new Error(config.error || "Firebase sign-in is not configured.");

        const firebaseApp = initializeApp(config);
        auth = getAuth(firebaseApp);
        database = getFirestore(firebaseApp);
        emailOtpEnabled = config.emailOtpEnabled === true;
        emailOtpMissingSettings = Array.isArray(config.emailOtpMissingSettings)
            ? config.emailOtpMissingSettings.filter(setting => typeof setting === "string")
            : [];
        if (emailOtpEnabled) {
            emailAuthSetupNotice.hidden = true;
            emailAuthSetupNotice.textContent = "";
        } else {
            const missingSettings = emailOtpMissingSettings.length
                ? ` Set ${emailOtpMissingSettings.join(", ")} in the server environment and restart or redeploy.`
                : " Check the server's email-code configuration and restart or redeploy.";
            emailAuthSetupNotice.textContent =
                `Email code sign-in is unavailable.${missingSettings} Firebase Admin credentials and Firestore access are also required.`;
            emailAuthSetupNotice.hidden = false;
        }
        setAuthButtonsEnabled(true);
        setStatus(emailOtpEnabled
            ? getSignInPrompt()
            : "Sign in with Google. Email codes are not configured.");
        onAuthStateChanged(auth, handleAuthState);
    } catch (error) {
        console.error("Could not initialize Firebase authentication:", error);
        setAuthButtonsEnabled(false);
        setStatus(error.message || "Secure sign-in could not be initialized.", "error");
    }
}

initializeAuthentication();
