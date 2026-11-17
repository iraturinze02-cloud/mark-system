
import bcrypt from "bcryptjs";

import {
    connectDB,
    json
} from "../../_utils.js";

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
   SET NEW PASSWORD
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

        const token = String(data.token || "").trim();
        const password = String(data.password || "");

        /* =============================================
           VALIDATE INPUT
        ============================================= */

        if (!/^[a-f0-9]{64}$/i.test(token)) {
            return json({
                success: false,
                message: "Invalid password setup link."
            }, 400);
        }

        if (password.length < 8 || password.length > 128) {
            return json({
                success: false,
                message: "Password must contain between 8 and 128 characters."
            }, 400);
        }

        /* =============================================
           HASH TOKEN
        ============================================= */

        const tokenHash = await hashSetupToken(token);

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           FIND AND LOCK PASSWORD SETUP TOKEN
        ============================================= */

        const tokenResult = await client.query(`
            SELECT
                id,
                user_id,
                expires_at,
                used_at
            FROM password_setup_tokens
            WHERE token_hash = $1
            LIMIT 1
            FOR UPDATE
        `, [tokenHash]);

        if (tokenResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Invalid or expired password setup link. Please verify your email again."
            }, 400);
        }

        const setup = tokenResult.rows[0];

        if (setup.used_at) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This password setup link has already been used."
            }, 400);
        }

        if (new Date(setup.expires_at).getTime() <= Date.now()) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Your password setup link has expired. Please verify your email again."
            }, 400);
        }

        /* =============================================
           LOCK AND CHECK USER ACCOUNT
        ============================================= */

        const userResult = await client.query(`
            SELECT
                id,
                email_verified,
                must_change_password
            FROM users
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
        `, [setup.user_id]);

        if (userResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "User account not found."
            }, 404);
        }

        const user = userResult.rows[0];

        if (!user.email_verified || !user.must_change_password) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This account is not eligible for password setup."
            }, 403);
        }

        /* =============================================
           HASH NEW PASSWORD
        ============================================= */

        const passwordHash = await bcrypt.hash(password, 12);

        /* =============================================
           SAVE NEW PASSWORD
        ============================================= */

        await client.query(`
            UPDATE users
            SET
                password_hash = $1,
                must_change_password = FALSE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2
        `, [passwordHash, user.id]);

        /* =============================================
           MARK TOKEN AS USED
        ============================================= */

        await client.query(`
            UPDATE password_setup_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [setup.id]);

        /* =============================================
           INVALIDATE OTHER PASSWORD SETUP TOKENS
        ============================================= */

        await client.query(`
            UPDATE password_setup_tokens
            SET used_at = CURRENT_TIMESTAMP
            WHERE user_id = $1
              AND used_at IS NULL
              AND id <> $2
        `, [user.id, setup.id]);

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "Your password has been set successfully. You can now log in."
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Set password error:", error);

        return json({
            success: false,
            message: "Could not set your password. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
