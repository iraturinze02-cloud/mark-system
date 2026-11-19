
import {
    connectDB,
    json
} from "../../_utils.js";

import {
    normalizeEmail,
    hashOtp
} from "../../_email.js";


function generateResetToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}


async function hashResetToken(token) {
    const encoded = new TextEncoder().encode(token);

    const digest = await crypto.subtle.digest(
        "SHA-256",
        encoded
    );

    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}


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

        const identifier =
            String(data.identifier || "").trim();

        const code =
            String(data.code || "").trim();

        if (!identifier || identifier.length > 254) {
            return json({
                success: false,
                message: "Invalid confirmation request."
            }, 400);
        }

        if (!/^\d{6}$/.test(code)) {
            return json({
                success: false,
                message: "Enter the six-digit confirmation code."
            }, 400);
        }

        const isEmail = identifier.includes("@");

        const accountIdentifier = isEmail
            ? normalizeEmail(identifier)
            : identifier;

        if (isEmail && !accountIdentifier) {
            return json({
                success: false,
                message: "Invalid confirmation request."
            }, 400);
        }

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        const userResult = await client.query(`
            SELECT id
            FROM users
            WHERE
    (
        (
            $1 = TRUE
            AND LOWER(email) = LOWER($2)
        )
        OR
        (
            $1 = FALSE
            AND phone = $2
        )
    )
    AND email_verified = TRUE
    AND status = 'active'
            LIMIT 1
            FOR UPDATE
        `, [isEmail, accountIdentifier]);

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Invalid or expired confirmation code."
            }, 400);
        }

        const user = userResult.rows[0];

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
                message: "Invalid or expired confirmation code."
            }, 400);
        }

        const verification = verificationResult.rows[0];

        if (
            new Date(verification.expires_at).getTime()
            <= Date.now()
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Your confirmation code has expired. Please request a new one."
            }, 400);
        }

        if (verification.attempts >= 5) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Too many incorrect attempts. Please request a new confirmation code."
            }, 429);
        }

        const submittedHash = await hashOtp(
            user.id,
            code
        );

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
                message: "Incorrect confirmation code."
            }, 400);
        }

        const resetToken = generateResetToken();

        const tokenHash = await hashResetToken(
            resetToken
        );

        await client.query(`
            UPDATE email_verifications
            SET verified_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [verification.id]);

        await client.query(`
            UPDATE password_reset_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
              AND used_at IS NULL
        `, [user.id]);

        await client.query(`
            INSERT INTO password_reset_tokens (
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
            message: "Your confirmation code has been verified.",
            resetToken
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error(
            "Verify password reset error:",
            error
        );

        return json({
            success: false,
            message: "Could not verify your confirmation code. Please try again."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
