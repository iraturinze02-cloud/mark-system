
import {
    connectDB,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {

    let client;

    try {
        const body = await context.request.json();

        const email = String(body.email || "")
            .trim()
            .toLowerCase();

        if (
            !email ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
            return json({
                success: false,
                valid: false,
                message: "Invalid or expired verification link."
            }, 403);
        }

        client = await connectDB(context);

        const result = await client.query(
            `SELECT u.id
             FROM users u
             INNER JOIN email_verifications ev
                ON ev.user_id = u.id
             WHERE LOWER(u.email) = $1
               AND u.email_verified = FALSE
               AND ev.verified_at IS NULL
               AND ev.expires_at > NOW()
               AND ev.attempts < 5
             ORDER BY ev.created_at DESC
             LIMIT 1`,
            [email]
        );

        if (result.rows.length === 0) {
            return json({
                success: false,
                valid: false,
                message: "This verification link is invalid or expired. Please request a new verification email."
            }, 403);
        }

        return json({
            success: true,
            valid: true
        });

    } catch (error) {
        console.error(
            "Verification link validation error:",
            error
        );

        return json({
            success: false,
            valid: false,
            message: "Unable to validate this verification link. Please try again."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
