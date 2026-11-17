
/* =====================================================
   EMAIL HELPERS — RESEND
   FILA MARKS SYSTEM
===================================================== */

const VERIFICATION_PAGE =
    "https://www.filagrades.online/pages/sector/verify-email.html";

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

    const hash = await crypto.subtle.digest("SHA-256", data);

    return Array.from(new Uint8Array(hash))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   SAVE VERIFICATION CODE IN DATABASE
===================================================== */

export async function saveOtp(client, userId, code) {
    const otpHash = await hashOtp(userId, code);

    await client.query(
        `DELETE FROM email_verifications
         WHERE user_id = $1
           AND verified_at IS NULL`,
        [userId]
    );

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
   ESCAPE HTML
===================================================== */

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

/* =====================================================
   ACCOUNT CREATION & EMAIL VERIFICATION EMAIL
===================================================== */

export function verificationEmail(fullName, code, email) {
    const safeName = escapeHtml(fullName || "User");

    const verificationLink =
        `${VERIFICATION_PAGE}?email=${encodeURIComponent(email || "")}`;

    return {
        subject: "Welcome to Fila Grades System — Verify Your Email",

        html: `
            <div style="font-family:Arial,sans-serif;max-width:550px;margin:auto;padding:25px;color:#1f2937;line-height:1.6;">

                <h2 style="color:#1d4ed8;">
                    Welcome to Fila Grades System!
                </h2>

                <p>Hello ${safeName},</p>

                <p>
                    An administrator has created an account for you
                    on Fila Grades System.
                </p>

                <p>
                    Before you can access your account, you must
                    verify your email address.
                </p>

                <p><strong>Your email verification code is:</strong></p>

                <div style="background:#f1f5f9;padding:20px;text-align:center;border-radius:8px;margin:25px 0;">
                    <strong style="font-size:32px;letter-spacing:8px;">
                        ${code}
                    </strong>
                </div>

                <p>
                    This verification code expires in
                    <strong>5 minutes</strong>.
                </p>

                <div style="text-align:center;margin:30px 0;">
                    <a href="${verificationLink}"
                       style="background:#1d4ed8;color:white;padding:14px 25px;text-decoration:none;border-radius:7px;font-weight:bold;display:inline-block;">
                        Verify Email Address
                    </a>
                </div>

                <p>
                    Open the verification page, enter your email address
                    and the six-digit code above to activate your account.
                </p>

                <p>
                    If you did not expect this account, please contact
                    your administrator.
                </p>

                <p>
                    Best regards,<br>
                    <strong>Fila Grades System Team</strong>
                </p>

            </div>
        `,

        text: `Hello ${fullName || "User"},

Welcome to Fila Grades System!

An administrator has created an account for you.

Before you can access your account, you must verify your email address.

Your six-digit verification code is: ${code}

This code expires in 5 minutes.

Open this link to verify your email address:
${verificationLink}

Enter your email address and the six-digit code to activate your account.

If you did not expect this account, please contact your administrator.

Fila Grades System Team`
    };
}

/* =====================================================
   SUCCESSFUL VERIFICATION EMAIL
===================================================== */

export function welcomeEmail(fullName) {
    const safeName = escapeHtml(fullName || "User");

    return {
        subject: "Your Fila Grades System Account Is Activated",

        html: `
            <div style="font-family:Arial,sans-serif;max-width:550px;margin:auto;padding:25px;color:#1f2937;line-height:1.6;">

                <h2 style="color:#16a34a;">
                    Email Verification Successful!
                </h2>

                <p>Hello ${safeName},</p>

                <p>
                    Your email address has been successfully verified
                    and your Fila Grades System account is now activated.
                </p>

                <p>
                    You can now log in using your registered phone number
                    and password.
                </p>

                <p>
                    Welcome to Fila Grades System!
                </p>

                <p>
                    Best regards,<br>
                    <strong>Fila Grades System Team</strong>
                </p>

            </div>
        `,

        text: `Hello ${fullName || "User"},

Your email address has been successfully verified and your Fila Grades System account is now activated.

You can now log in using your registered phone number and password.

Welcome to Fila Grades System!

Fila Grades System Team`
    };
}
