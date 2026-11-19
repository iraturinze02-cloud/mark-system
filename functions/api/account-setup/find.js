
import { connectDB, json } from "../../_utils.js";

import {
    readBody,
    createAccountToken,
    maskEmail
} from "./_helpers.js";

/* =====================================================
   FIND ADMIN-CREATED ACCOUNT
===================================================== */

export async function onRequestPost(context) {

    let client;

    try {

        const body = await readBody(context.request);

        if (!body || !body.identifier) {
            return json({
                success: false,
                message: "Enter your registered email or phone number."
            }, 400);
        }

        const identifier = String(body.identifier).trim();

        if (identifier.length > 254) {
            return json({
                success: false,
                message: "Invalid account information."
            }, 400);
        }

        client = await connectDB(context);

        let result;

        /* ---------------------------------------------
           SEARCH BY EMAIL
        --------------------------------------------- */

        if (identifier.includes("@")) {

            result = await client.query(
                `SELECT
                    id,
                    full_name,
                    email,
                    email_verified,
                    must_change_password,
                    status
                 FROM users
                 WHERE LOWER(email) = LOWER($1)
                 LIMIT 1`,
                [identifier]
            );

        } else {

            /* -----------------------------------------
               SEARCH BY PHONE
            ----------------------------------------- */

            const phone = identifier.replace(/\D/g, "");

            if (phone.length < 7 || phone.length > 15) {
                return json({
                    success: false,
                    message: "Enter a valid phone number."
                }, 400);
            }

            result = await client.query(
                `SELECT
                    id,
                    full_name,
                    email,
                    email_verified,
                    must_change_password,
                    status
                 FROM users
                 WHERE regexp_replace(
                    COALESCE(phone, ''),
                    '[^0-9]',
                    '',
                    'g'
                 ) = $1
                 LIMIT 1`,
                [phone]
            );

        }

        if (result.rows.length === 0) {
            return json({
                success: false,
                message: "No account requiring setup was found. Check your details or contact your administrator."
            }, 404);
        }

        const user = result.rows[0];

        /* ---------------------------------------------
           ACCOUNT STATUS
        --------------------------------------------- */

        if (user.status !== "active") {
            return json({
                success: false,
                message: "This account is not currently active. Contact your administrator."
            }, 403);
        }

        /* ---------------------------------------------
           CHECK SETUP REQUIREMENT
        --------------------------------------------- */

        if (user.must_change_password !== true) {
            return json({
                success: false,
                message: "Your account setup has already been completed. Please log in."
            }, 409);
        }

        /* ---------------------------------------------
           EMAIL REQUIRED
        --------------------------------------------- */

        if (!user.email) {
            return json({
                success: false,
                message: "No email address is registered for this account. Contact your administrator."
            }, 400);
        }

        /* ---------------------------------------------
           GENERATE TEMPORARY ACCOUNT TOKEN
        --------------------------------------------- */

        const accountToken = await createAccountToken(
            context,
            user.id
        );

        return json({
            success: true,
            message: "Account found successfully.",
            account: {
                accountToken,
                maskedEmail: maskEmail(user.email)
            }
        });

    } catch (error) {

        console.error("Find account error:", error);

        return json({
            success: false,
            message: "Unable to find your account. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }

}
