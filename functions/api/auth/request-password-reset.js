
import {
    connectDB,
    json
} from "../../_utils.js";

import {
    normalizeEmail,
    generateOtp,
    saveOtp,
    sendEmail
} from "../../_email.js";


const GENERIC_MESSAGE =
    "If an account matches the information provided, a password reset code has been sent to the email address registered with your account.";


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

        if (!identifier || identifier.length > 254) {
            return json({
                success: false,
                message: "Enter your registered phone number or email address."
            }, 400);
        }

        const isEmail = identifier.includes("@");

        const accountIdentifier = isEmail
            ? normalizeEmail(identifier)
            : identifier;

        if (isEmail && !accountIdentifier) {
            return json({
                success: false,
                message: "Enter a valid email address."
            }, 400);
        }

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        const userResult = await client.query(`
            SELECT
                id,
                full_name,
                email
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
                success: true,
                message: GENERIC_MESSAGE
            });
        }

        const user = userResult.rows[0];

        const otp = generateOtp();

        await saveOtp(client, user.id, otp);

        await client.query("COMMIT");
        transactionStarted = false;

        const safeName = String(user.full_name || "User")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");

        const emailHtml = `
            <!DOCTYPE html>
            <html>
            <body style="margin:0;padding:25px;background:#f3f6fb;font-family:Arial,sans-serif;">
                <div style="max-width:520px;margin:auto;background:#ffffff;padding:30px;border-radius:10px;">
                    <h2 style="color:#174ea6;">Fila Grades System</h2>

                    <p>Hello ${safeName},</p>

                    <p>
                        We received a request to reset the password
                        associated with your account.
                    </p>

                    <p>Your password reset confirmation code is:</p>

                    <div style="background:#f1f5f9;padding:18px;text-align:center;border-radius:8px;margin:20px 0;">
                        <strong style="font-size:30px;letter-spacing:8px;color:#174ea6;">
                            ${otp}
                        </strong>
                    </div>

                    <p>
                        This code expires in <strong>5 minutes</strong>.
                        Do not share it with anyone.
                    </p>

                    <p>
                        If you did not request a password reset,
                        you can ignore this email.
                    </p>

                    <p style="color:#64748b;font-size:13px;">
                        Fila Grades System
                    </p>
                </div>
            </body>
            </html>
        `;

        const emailText = `
Fila Grades System

Hello ${user.full_name || "User"},

We received a request to reset your password.

Your password reset confirmation code is: ${otp}

This code expires in 5 minutes. Do not share it with anyone.

If you did not request a password reset, you can ignore this email.

Fila Grades System
        `;

        try {
            await sendEmail(context, {
                to: user.email,
                subject: "Password Reset Confirmation Code",
                html: emailHtml,
                text: emailText
            });
        } catch (emailError) {
            console.error(
                "Password reset email error:",
                emailError
            );
        }

        return json({
            success: true,
            message: GENERIC_MESSAGE
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error(
            "Request password reset error:",
            error
        );

        return json({
            success: false,
            message: "Could not process your request. Please try again."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
