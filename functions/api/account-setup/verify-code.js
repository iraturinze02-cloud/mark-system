
import { connectDB, json } from "../../_utils.js";

import { hashOtp } from "../../_email.js";

import {
    readBody,
    verifyAccountToken,
    generateRandomToken,
    hashToken
} from "./_helpers.js";

/* =====================================================
   VERIFY ACCOUNT SETUP CODE
===================================================== */

export async function onRequestPost(context) {

    let client;

    try {

        const body = await readBody(context.request);

        if (!body?.accountToken || !body?.code) {
            return json({
                success: false,
                message: "Enter your verification code."
            }, 400);
        }

        const code = String(body.code).trim();

        if (!/^\d{6}$/.test(code)) {
            return json({
                success: false,
                message: "Enter a valid six-digit verification code."
            }, 400);
        }

        const userId = await verifyAccountToken(
            context,
            body.accountToken
        );

        if (!userId) {
            return json({
                success: false,
                message: "Your account setup session has expired. Start again."
            }, 401);
        }

        client = await connectDB(context);

        await client.query("BEGIN");

        /* ---------------------------------------------
           LOCK USER ACCOUNT
        --------------------------------------------- */

        const userResult = await client.query(
            `SELECT
                id,
                email,
                email_verified,
                must_change_password,
                status
             FROM users
             WHERE id = $1
             FOR UPDATE`,
            [userId]
        );

        if (userResult.rows.length === 0) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Account not found."
            }, 404);

        }

        const user = userResult.rows[0];

        if (
            user.status !== "active" ||
            user.must_change_password !== true ||
            !user.email
        ) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "This account cannot complete setup."
            }, 403);

        }

        /* ---------------------------------------------
           GET LATEST VERIFICATION CODE
        --------------------------------------------- */

        const otpResult = await client.query(
            `SELECT
                id,
                otp_hash,
                expires_at,
                attempts
             FROM email_verifications
             WHERE user_id = $1
               AND verified_at IS NULL
             ORDER BY created_at DESC
             LIMIT 1
             FOR UPDATE`,
            [userId]
        );

        if (otpResult.rows.length === 0) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "No active verification code was found. Request a new code."
            }, 400);

        }

        const otp = otpResult.rows[0];

        /* ---------------------------------------------
           CHECK EXPIRY
        --------------------------------------------- */

        if (new Date(otp.expires_at).getTime() <= Date.now()) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Your verification code has expired. Request a new code."
            }, 400);

        }

        /* ---------------------------------------------
           CHECK ATTEMPTS
        --------------------------------------------- */

        if (Number(otp.attempts) >= 5) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Too many incorrect attempts. Request a new verification code."
            }, 429);

        }

        /* ---------------------------------------------
           COMPARE OTP HASH
        --------------------------------------------- */

        const submittedHash = await hashOtp(
            userId,
            code
        );

        if (submittedHash !== otp.otp_hash) {

            await client.query(
                `UPDATE email_verifications
                 SET attempts = attempts + 1
                 WHERE id = $1`,
                [otp.id]
            );

            await client.query("COMMIT");

            return json({
                success: false,
                message: "Incorrect verification code. Please try again."
            }, 400);

        }

        /* ---------------------------------------------
           MARK EMAIL AS VERIFIED
        --------------------------------------------- */

        await client.query(
            `UPDATE email_verifications
             SET verified_at = NOW()
             WHERE id = $1`,
            [otp.id]
        );

        await client.query(
            `UPDATE users
             SET email_verified = TRUE
             WHERE id = $1`,
            [userId]
        );

        /* ---------------------------------------------
           GENERATE PASSWORD SETUP TOKEN
        --------------------------------------------- */

        const setupToken = generateRandomToken();

        const setupTokenHash = await hashToken(
            setupToken
        );

        /* Invalidate previous unused setup tokens */

        await client.query(
            `UPDATE password_setup_tokens
             SET used_at = NOW()
             WHERE user_id = $1
               AND used_at IS NULL`,
            [userId]
        );

        /* Save new token */

        await client.query(
            `INSERT INTO password_setup_tokens (
                user_id,
                token_hash,
                expires_at
            )
            VALUES (
                $1,
                $2,
                NOW() + INTERVAL '15 minutes'
            )`,
            [
                userId,
                setupTokenHash
            ]
        );

        await client.query("COMMIT");

        return json({
            success: true,
            message: "Your email has been verified successfully.",
            setupToken
        });

    } catch (error) {

        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Verify setup code error:", error);

        return json({
            success: false,
            message: "Unable to verify your account. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}
