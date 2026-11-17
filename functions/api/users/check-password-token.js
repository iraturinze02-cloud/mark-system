
import {
    connectDB,
    json
} from "../../_utils.js";

import { createHash } from "node:crypto";

export async function onRequestPost(context) {

    let client;

    try {
        const body = await context.request.json();

        const token = String(body.token || "").trim();

        if (!/^[a-f0-9]{64}$/i.test(token)) {
            return json({
                success: false,
                valid: false,
                message: "Invalid password setup link."
            }, 403);
        }

        const tokenHash = createHash("sha256")
            .update(token)
            .digest("hex");

        client = await connectDB(context);

        const result = await client.query(
            `SELECT pst.id
             FROM password_setup_tokens pst
             INNER JOIN users u
                ON u.id = pst.user_id
             WHERE pst.token_hash = $1
               AND pst.used_at IS NULL
               AND pst.expires_at > NOW()
               AND u.email IS NOT NULL
               AND u.email_verified = TRUE
               AND u.must_change_password = TRUE
               AND u.status = 'active'
             LIMIT 1`,
            [tokenHash]
        );

        if (result.rows.length === 0) {
            return json({
                success: false,
                valid: false,
                message: "This password setup link is invalid, expired, or has already been used. Please contact your administrator."
            }, 403);
        }

        return json({
            success: true,
            valid: true
        });

    } catch (error) {

        console.error(
            "Password token validation error:",
            error
        );

        return json({
            success: false,
            valid: false,
            message: "Unable to validate your password setup link."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }
}
