
import {
    connectDB,
    json
} from "../../_utils.js";

/* =====================================================
   GENERATE SECURE PASSWORD SETUP TOKEN
===================================================== */

function generateSetupToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   HASH PASSWORD SETUP TOKEN
===================================================== */

async function hashSetupToken(token) {
    const encoded = new TextEncoder().encode(token);
    const digest = await crypto.subtle.digest("SHA-256", encoded);

    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   VERIFY EMAIL ADDRESS
===================================================== */

export async function onRequestPost(context) {
    let client;
    let transactionStarted = false;

    try {
        let data;

        try {
            data = await context.request.json();
        } catch {
            return json({
                success: false,
                message: "Invalid request data."
            }, 400);
        }

        const email = String(data.email || "")
            .trim()
            .toLowerCase();

        const code = String(data.code || "").trim();

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return json({
                success: false,
                message: "Invalid email address."
            }, 400);
        }

        if (!/^\d{6}$/.test(code)) {
            return json({
                success: false,
                message: "Enter the six-digit verification code."
            }, 400);
        }

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           FIND ACCOUNT
        ============================================= */

        const userResult = await client.query(`
            SELECT
                id,
                full_name,
                email,
                email_verified
            FROM users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
            FOR UPDATE
        `, [email]);

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "No account was found with this email address."
            }, 404);
        }

        const user = userResult.rows[0];

        if (user.email_verified) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                alreadyVerified: true,
                message: "This email is already verified. Please continue through the login page."
            }, 409);
        }

        /* =============================================
           FIND LATEST OTP
        ============================================= */

        const verificationResult = await client.query(`
            SELECT
                id,
                otp_hash,
                expires_at,
                attempts
            FROM email_verifications
            WHERE user_id = $1
              AND verified_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
        `, [user.id]);

        if (verificationResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "No active verification code was found. Please request a new code."
            }, 400);
        }

        const verification = verificationResult.rows[0];

        /* =============================================
           CHECK EXPIRY
        ============================================= */

        if (
            new Date(verification.expires_at).getTime()
            <= Date.now()
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Your verification code has expired. Please request a new one."
            }, 400);
        }

        /* =============================================
           LIMIT INCORRECT ATTEMPTS
        ============================================= */

        if (verification.attempts >= 5) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Too many incorrect attempts. Please request a new verification code."
            }, 429);
        }

        /* =============================================
           CHECK OTP
        ============================================= */

        const { hashOtp } = await import("../../_email.js");

        const submittedHash = await hashOtp(user.id, code);

        if (submittedHash !== verification.otp_hash) {

            await client.query(`
                UPDATE email_verifications
                SET attempts = attempts + 1
                WHERE id = $1
            `, [verification.id]);

            await client.query("COMMIT");
            transactionStarted = false;

            return json({
                success: false,
                message: "Incorrect verification code."
            }, 400);
        }

        /* =============================================
           GENERATE PASSWORD SETUP TOKEN
        ============================================= */

        const setupToken = generateSetupToken();
        const tokenHash = await hashSetupToken(setupToken);

        /* =============================================
           VERIFY EMAIL AND REQUIRE NEW PASSWORD
        ============================================= */

        await client.query(`
            UPDATE users
            SET
                email_verified = TRUE,
                must_change_password = TRUE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [user.id]);

        await client.query(`
            UPDATE email_verifications
            SET verified_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [verification.id]);

        /* =============================================
           REMOVE OLD UNUSED PASSWORD SETUP TOKENS
        ============================================= */

        await client.query(`
            DELETE FROM password_setup_tokens
            WHERE user_id = $1
              AND used_at IS NULL
        `, [user.id]);

        /* =============================================
           SAVE NEW PASSWORD SETUP TOKEN
        ============================================= */

        await client.query(`
            INSERT INTO password_setup_tokens (
                user_id,
                token_hash,
                expires_at
            )
            VALUES (
                $1,
                $2,
                CURRENT_TIMESTAMP + INTERVAL '15 minutes'
            )
        `, [user.id, tokenHash]);

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Your email has been verified. Please set your new password.",
            setupToken
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Email verification error:", error);

        return json({
            success: false,
            message: "Could not verify your email address. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
