import { connectDB, json } from "../../_utils.js";

import {
    readBody,
    hashToken
} from "./_helpers.js";

/* =====================================================
   COMPLETE ACCOUNT SETUP
===================================================== */

export async function onRequestPost(context) {

    let client;

    try {

        const body = await readBody(context.request);

        if (!body?.setupToken || !body?.password) {
            return json({
                success: false,
                message: "Enter your new password."
            }, 400);
        }

        const password = String(body.password);

        if (password.length < 8) {
            return json({
                success: false,
                message: "Your password must contain at least 8 characters."
            }, 400);
        }

        if (password.length > 128) {
            return json({
                success: false,
                message: "Your password is too long."
            }, 400);
        }

        /* ---------------------------------------------
           HASH SETUP TOKEN
        --------------------------------------------- */

        const tokenHash = await hashToken(
            body.setupToken
        );

        client = await connectDB(context);

        await client.query("BEGIN");

        /* ---------------------------------------------
           FIND AND LOCK SETUP TOKEN
        --------------------------------------------- */

        const tokenResult = await client.query(
            `SELECT
                id,
                user_id,
                expires_at,
                used_at
             FROM password_setup_tokens
             WHERE token_hash = $1
             FOR UPDATE`,
            [tokenHash]
        );

        if (tokenResult.rows.length === 0) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Invalid or expired setup session. Start again."
            }, 401);

        }

        const token = tokenResult.rows[0];

        /* ---------------------------------------------
           CHECK TOKEN STATUS
        --------------------------------------------- */

        if (token.used_at !== null) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "This setup session has already been used."
            }, 401);

        }

        if (
            new Date(token.expires_at).getTime() <= Date.now()
        ) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Your setup session has expired. Start again."
            }, 401);

        }

        /* ---------------------------------------------
           LOCK USER ACCOUNT
        --------------------------------------------- */

        const userResult = await client.query(
            `SELECT
                id,
                email_verified,
                must_change_password,
                status
             FROM users
             WHERE id = $1
             FOR UPDATE`,
            [token.user_id]
        );

        if (userResult.rows.length === 0) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "User account not found."
            }, 404);

        }

        const user = userResult.rows[0];

        /* ---------------------------------------------
           ACCOUNT VALIDATION
        --------------------------------------------- */

        if (user.status !== "active") {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Your account is not active."
            }, 403);

        }

        if (user.email_verified !== true) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Please verify your email address first."
            }, 403);

        }

        if (user.must_change_password !== true) {

            await client.query("ROLLBACK");

            return json({
                success: false,
                message: "Your account setup has already been completed."
            }, 409);

        }

        /* ---------------------------------------------
           UPDATE PASSWORD AND ACCOUNT STATUS

           This follows the direct password-storage
           convention requested for this workflow.
        --------------------------------------------- */

        await client.query(
            `UPDATE users
             SET
                password_hash = $1,
                must_change_password = FALSE
             WHERE id = $2`,
            [
                password,
                token.user_id
            ]
        );

        /* ---------------------------------------------
           MARK CURRENT TOKEN AS USED
        --------------------------------------------- */

        await client.query(
            `UPDATE password_setup_tokens
             SET used_at = NOW()
             WHERE id = $1`,
            [token.id]
        );

        /* ---------------------------------------------
           INVALIDATE ALL OTHER UNUSED TOKENS
        --------------------------------------------- */

        await client.query(
            `UPDATE password_setup_tokens
             SET used_at = NOW()
             WHERE user_id = $1
               AND used_at IS NULL`,
            [token.user_id]
        );

        await client.query("COMMIT");

        return json({
            success: true,
            message: "Your account setup has been completed successfully."
        });

    } catch (error) {

        if (client) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Complete account setup error:", error);

        return json({
            success: false,
            message: "Unable to complete account setup. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}
