/* =====================================================
   EMAIL HELPERS — RESEND
===================================================== */

export function normalizeEmail(value) {
    const email = String(value || "").trim().toLowerCase();

    if (
        email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
        return null;
    }

    return email;
}

/* =====================================================
   GENERATE SIX-DIGIT VERIFICATION CODE
===================================================== */

export function generateOtp() {
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);

    return String(random[0] % 1000000).padStart(6, "0");
}

/* =====================================================
   HASH VERIFICATION CODE
===================================================== */

export async function hashOtp(userId, code) {
    const value = `${userId}:${code}`;

    const data = new TextEncoder().encode(value);

    const hash = await crypto.subtle.digest(
        "SHA-256",
        data
    );

    return Array.from(new Uint8Array(hash))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   SAVE VERIFICATION CODE IN DATABASE
===================================================== */

export async function saveOtp(client, userId, code) {
    const otpHash = await hashOtp(userId, code);

    // Invalidate previous unused codes.
    await client.query(
        `DELETE FROM email_verifications
         WHERE user_id = $1
           AND verified_at IS NULL`,
        [userId]
    );

    // New code expires after five minutes.
    await client.query(
        `INSERT INTO email_verifications (
            user_id,
            otp_hash,
            expires_at,
            attempts
        )
        VALUES (
            $1,
            $2,
            NOW() + INTERVAL '5 minutes',
            0
        )`,
        [userId, otpHash]
    );
}

/* =====================================================
   SEND EMAIL THROUGH RESEND
===================================================== */

export async function sendEmail(context, {
    to,
    subject,
    html,
    text
}) {
    const apiKey = context.env.RESEND_API_KEY;
    const from = context.env.EMAIL_FROM;

    if (!apiKey || !from) {
        throw new Error("Email sending is not configured.");
    }

    const response = await fetch(
        "https://api.resend.com/emails",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from,
                to: [to],
                subject,
                html,
                text
            })
        }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
        console.error("Resend email error:", result);

        throw new Error(
            result.message || "Could not send email."
        );
    }

    return result;
}

/* =====================================================
   VERIFICATION EMAIL
===================================================== */

export function verificationEmail(fullName, code) {
    const safeName = String(fullName || "User")
        .replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);

    return {
        subject: "Verify your Fila Marks Platform account",

        html: `
            <div style="font-family:Arial,sans-serif;max-width:550px;margin:auto;padding:25px;color:#1f2937;">
                <h2>Welcome to the Fila Marks Platform</h2>

                <p>Hello ${safeName},</p>

                <p>Your account has been created. Use the verification code below to verify your email address.</p>

                <div style="background:#f1f5f9;padding:20px;text-align:center;border-radius:8px;margin:25px 0;">
                    <strong style="font-size:32px;letter-spacing:8px;">${code}</strong>
                </div>

                <p>This code expires in <strong>5 minutes</strong>.</p>

                <p>If you did not expect this account, please contact your administrator.</p>

                <p>Fila Marks  Platform</p>
            </div>
        `,

        text: `Hello ${fullName},

Your Sector Education Platform account has been created.

Your email verification code is: ${code}

This code expires in 5 minutes.

Fila Marks Platform`
    };
}

/* =====================================================
   WELCOME EMAIL
===================================================== */

export function welcomeEmail(fullName) {
    const safeName = String(fullName || "User")
        .replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);

    return {
        subject: "Your Fila Marks Platform account is verified",

        html: `
            <div style="font-family:Arial,sans-serif;max-width:550px;margin:auto;padding:25px;color:#1f2937;">
                <h2>Email verification successful</h2>

                <p>Hello ${safeName},</p>

                <p>Your email address has been successfully verified.</p>

                <p>You can now log in using your registered phone number and password.</p>

                <p>Welcome to the Fila Marks Platform!</p>

                <p>Fila Marks Platform</p>
            </div>
        `,

        text: `Hello ${fullName},

Your email address has been successfully verified.

You can now log in using your registered phone number and password.

Welcome to the Sector Education Platform!

Fila Marks Platform`
    };
}
