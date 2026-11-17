
import {
    connectDB,
    json
} from "../../_utils.js";

import {
    normalizeEmail,
    generateOtp,
    saveOtp,
    sendEmail,
    verificationEmail
} from "../../_email.js";

/* =====================================================
   RESEND EMAIL VERIFICATION CODE
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

        const email = normalizeEmail(data.email);

        if (!email) {
            return json({
                success: false,
                message: "Please enter a valid email address."
            }, 400);
        }

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           FIND ACCOUNT
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
                message: "This email address has already been verified."
            }, 400);
        }

        /* =============================================
           CHECK RESEND WAITING PERIOD
        ============================================= */

        const previousResult = await client.query(`
            SELECT created_at
            FROM email_verifications
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 1
        `, [user.id]);

        if (previousResult.rowCount > 0) {
            const lastSent = new Date(
                previousResult.rows[0].created_at
            ).getTime();

            const elapsed = Date.now() - lastSent;
            const remaining = 60000 - elapsed;

            if (remaining > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: `Please wait ${Math.ceil(remaining / 1000)} seconds before requesting another code.`,
                    retry_after: Math.ceil(remaining / 1000)
                }, 429);
            }
        }

        /* =============================================
           GENERATE NEW OTP
        ============================================= */

        const otp = generateOtp();

        await saveOtp(client, user.id, otp);

        /* =============================================
           SEND EMAIL
        ============================================= */

        const emailContent = verificationEmail(
            user.full_name,
            otp
        );

        await sendEmail(context, {
            to: user.email,
            subject: emailContent.subject,
            html: emailContent.html,
            text: emailContent.text
        });

        /* =============================================
           COMMIT
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "A new verification code has been sent to your email address."
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("Resend verification error:", error);

        return json({
            success: false,
            message: "Could not send a new verification code. Please try again later."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
