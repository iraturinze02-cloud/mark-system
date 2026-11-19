
import { connectDB, json } from "../../_utils.js";

import {
    generateOtp,
    saveOtp,
    sendEmail
} from "../../_email.js";

import {
    readBody,
    verifyAccountToken
} from "./_helpers.js";

/* =====================================================
   SEND ACCOUNT SETUP VERIFICATION CODE
===================================================== */

export async function onRequestPost(context) {

    let client;

    try {

        const body = await readBody(context.request);

        if (!body?.accountToken) {
            return json({
                success: false,
                message: "Invalid account setup request."
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

        const result = await client.query(
            `SELECT
                id,
                full_name,
                email,
                email_verified,
                must_change_password,
                status
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [userId]
        );

        if (result.rows.length === 0) {
            return json({
                success: false,
                message: "Account not found."
            }, 404);
        }

        const user = result.rows[0];

        if (
            user.status !== "active" ||
            user.must_change_password !== true ||
            !user.email
        ) {
            return json({
                success: false,
                message: "This account cannot complete setup."
            }, 403);
        }

        /* ---------------------------------------------
           GENERATE AND SAVE OTP
        --------------------------------------------- */

        const code = generateOtp();

        await saveOtp(client, user.id, code);

        /* ---------------------------------------------
           SEND EMAIL
        --------------------------------------------- */

        const safeName = String(
            user.full_name || "User"
        ).replace(/[&<>"']/g, character => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]);

        await sendEmail(context, {
            to: user.email,

            subject: "Complete Your Fila Marks System Account Setup",

            html: `
                <div style="font-family:Arial,sans-serif;max-width:550px;margin:auto;padding:30px;color:#263445;line-height:1.7;">

                    <h2 style="color:#174b88;">
                        Complete Your Account Setup
                    </h2>

                    <p>Hello ${safeName},</p>

                    <p>
                        An administrator has created an account
                        for you on the Fila Marks System.
                    </p>

                    <p>
                        Use the verification code below to confirm
                        your account and complete your registration.
                    </p>

                    <div style="background:#eef4fc;padding:22px;text-align:center;border-radius:10px;margin:25px 0;">
                        <strong style="font-size:32px;letter-spacing:9px;color:#174b88;">
                            ${code}
                        </strong>
                    </div>

                    <p>
                        This code expires in
                        <strong>5 minutes</strong>.
                    </p>

                    <p>
                        If you did not expect this account,
                        contact your administrator.
                    </p>

                    <p>
                        Regards,<br>
                        <strong>Fila Marks System Team</strong>
                    </p>

                </div>
            `,

            text: `
Hello ${user.full_name || "User"},

An administrator has created an account for you on Fila Marks System.

Your verification code is: ${code}

This code expires in 5 minutes.

Enter this code on the Complete Account Setup page.

Fila Marks System Team
            `
        });

        return json({
            success: true,
            message: "A verification code has been sent to your registered email address."
        });

    } catch (error) {

        console.error("Send setup code error:", error);

        return json({
            success: false,
            message: "Unable to send the verification code. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}
