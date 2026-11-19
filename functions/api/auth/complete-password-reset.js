
import {
    connectDB,
    json
} from "../../_utils.js";


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

        const token = String(data.token || "").trim();
        const password = String(data.password || "");

        if (!/^[a-f0-9]{64}$/i.test(token)) {
            return json({
                success: false,
                message: "Invalid password reset request."
            }, 400);
        }

        if (password.length < 8 || password.length > 128) {
            return json({
                success: false,
                message: "Password must contain between 8 and 128 characters."
            }, 400);
        }

        const tokenHash = await hashResetToken(token);

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        const tokenResult = await client.query(`
            SELECT
                id,
                user_id,
                expires_at,
                used_at
            FROM password_reset_tokens
            WHERE token_hash = $1
            LIMIT 1
            FOR UPDATE
        `, [tokenHash]);

        if (tokenResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Invalid or expired password reset request. Please start again."
            }, 400);
        }

        const reset = tokenResult.rows[0];

        if (reset.used_at) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This password reset request has already been used."
            }, 400);
        }

        if (
            new Date(reset.expires_at).getTime()
            <= Date.now()
        ) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Your password reset request has expired. Please start again."
            }, 400);
        }

        const userResult = await client.query(`
            SELECT id
            FROM users
            WHERE id = $1
              AND email_verified = TRUE
              AND status = 'active'
            LIMIT 1
            FOR UPDATE
        `, [reset.user_id]);

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This account is not eligible for password reset."
            }, 403);
        }

        const user = userResult.rows[0];

        /* =============================================
           UPDATE PASSWORD
        ============================================= */

        await client.query(`
            UPDATE users
            SET
                password_hash = $1,
                must_change_password = FALSE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [password, user.id]);

        /* =============================================
           MARK CURRENT RESET TOKEN AS USED
        ============================================= */

        await client.query(`
            UPDATE password_reset_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [reset.id]);

        /* =============================================
           INVALIDATE OTHER RESET TOKENS
        ============================================= */

        await client.query(`
            UPDATE password_reset_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
              AND used_at IS NULL
              AND id <> $2
        `, [user.id, reset.id]);

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Your password has been reset successfully. You can now log in using your new password."
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error(
            "Complete password reset error:",
            error
        );

        return json({
            success: false,
            message: "Could not reset your password. Please try again."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
