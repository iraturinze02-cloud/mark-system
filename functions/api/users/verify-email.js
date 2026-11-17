
import {
    connectDB,
    json
} from "../../_utils.js";

import {
    hashOtp,
    sendEmail,
    welcomeEmail
} from "../../_email.js";

/* =====================================================
   VERIFY EMAIL ADDRESS
===================================================== */

export async function onRequestPost(context) {
    let client;

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
                message: "Please enter a valid email address."
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

        /* =============================================
           FIND UNVERIFIED ACCOUNT
        ============================================= */

        const userResult = await client.query(`
            SELECT id, full_name, email, email_verified
            FROM users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
            FOR UPDATE
        `, [email]);

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "No account was found with this email address."
            }, 404);
        }

        const user = userResult.rows[0];

        if (user.email_verified) {
            await client.query("ROLLBACK");

            return json({
                success: true,
                message: "This email address has already been verified."
            });
        }

        /* =============================================
           FIND LATEST VERIFICATION CODE
        ============================================= */

        const verificationResult = await client.query(`
            SELECT id, otp_hash, expires_at, attempts
            FROM email_verifications
            WHERE user_id = $1
              AND verified_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
            FOR UPDATE
        `, [user.id]);

        if (verificationResult.rowCount === 0) {
            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "No active verification code was found. Please request a new code."
            }, 400);
        }

        const verification = verificationResult.rows[0];

        /* =============================================
           CHECK EXPIRY
        ============================================= */

        if (new Date(verification.expires_at).getTime() <= Date.now()) {
            await client.query("ROLLBACK");

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

            return json({
                success: false,
                message: "Too many incorrect attempts. Please request a new verification code."
            }, 429);
        }

        /* =============================================
           CHECK OTP
        ============================================= */

        const submittedHash = await hashOtp(user.id, code);

        if (submittedHash !== verification.otp_hash) {
            await client.query(`
                UPDATE email_verifications
                SET attempts = attempts + 1
                WHERE id = $1
            `, [verification.id]);

            await client.query("COMMIT");

            return json({
                success: false,
                message: "Incorrect verification code."
            }, 400);
        }

        /* =============================================
           MARK EMAIL AS VERIFIED
        ============================================= */

        await client.query(`
            UPDATE users
            SET
                email_verified = TRUE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [user.id]);

        await client.query(`
            UPDATE email_verifications
            SET verified_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [verification.id]);

        await client.query("COMMIT");

        /* =============================================
           SEND WELCOME EMAIL
        ============================================= */

        try {
            const welcome = welcomeEmail(user.full_name);

            await sendEmail(context, {
                to: user.email,
                subject: welcome.subject,
                html: welcome.html,
                text: welcome.text
            });
        } catch (emailError) {
            console.error("Welcome email error:", emailError);
        }

        return json({
            success: true,
            message: "Your email address has been successfully verified."
        });

    } catch (error) {
        if (client) {
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
