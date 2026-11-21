
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

import {
    normalizeEmail,
    sendEmail
} from "../../_email.js";

/* =====================================================
   ACCOUNT SETUP PAGE
===================================================== */

const ACCOUNT_SETUP_URL =
    "https://www.filagrades.online/pages/auth/complete-account-setup.html";

/* =====================================================
   ESCAPE HTML CONTENT
===================================================== */

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* =====================================================
   GET SCHOOL DOS
===================================================== */

export async function onRequestGet(context) {

    const auth = await requireSchoolAdmin(context);

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not assigned to a school."
        }, 403);
    }

    let client;

    try {

        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                id,
                full_name,
                phone,
                email,
                email_verified,
                must_change_password,
                status,
                school_id,
                role

             FROM users

             WHERE school_id = $1
               AND role = 'dos'

             LIMIT 1`,
            [auth.schoolId]
        );

        return json({
            success: true,
            dos: result.rows[0] || null
        });

    } catch (error) {

        console.error("Load DOS error:", error);

        return json({
            success: false,
            message: "Failed to load the DOS account."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}

/* =====================================================
   CREATE SCHOOL DOS
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireSchoolAdmin(context);

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not assigned to a school."
        }, 403);
    }

    let data;

    try {

        data = await context.request.json();

    } catch {

        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const fullName =
        String(data.full_name || "").trim();

    const phone =
        String(data.phone || "").trim();

    const email =
        normalizeEmail(data.email);

    /* =============================================
       VALIDATION
    ============================================= */

    if (!fullName || !phone || !email) {

        return json({
            success: false,
            message: "Full name, phone number and email are required."
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        email.length > 254
    ) {

        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {

        return json({
            success: false,
            message: "Enter a valid email address."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           LOCK SCHOOL DOS CREATION

           Prevent simultaneous creation requests
           for the same school.
        ============================================= */

        await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`dos-school-${auth.schoolId}`]
        );

        /* =============================================
           CHECK EXISTING DOS
        ============================================= */

        const existingDOS = await client.query(
            `SELECT id
             FROM users
             WHERE school_id = $1
               AND role = 'dos'
             LIMIT 1`,
            [auth.schoolId]
        );

        if (existingDOS.rowCount > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "A Director of Studies has already been registered for this school."
            }, 409);
        }

        /* =============================================
           CHECK DUPLICATE PHONE
        ============================================= */

        const duplicatePhone = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
             LIMIT 1`,
            [phone]
        );

        if (duplicatePhone.rowCount > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        /* =============================================
           CHECK DUPLICATE EMAIL
        ============================================= */

        const duplicateEmail = await client.query(
            `SELECT id
             FROM users
             WHERE LOWER(email) = LOWER($1)
             LIMIT 1`,
            [email]
        );

        if (duplicateEmail.rowCount > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This email address is already registered."
            }, 409);
        }

        /* =============================================
           GENERATE TEMPORARY PASSWORD VALUE

           The existing account setup workflow
           will allow the DOS to create a password.
        ============================================= */

        const temporaryPassword =
            `PENDING_SETUP_${crypto.randomUUID()}`;

        /* =============================================
           CREATE DOS USER ACCOUNT
        ============================================= */

        const result = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                email,
                email_verified,
                password_hash,
                role,
                school_id,
                status,
                must_change_password
            )
            VALUES (
                $1,
                $2,
                $3,
                FALSE,
                $4,
                'dos',
                $5,
                'active',
                TRUE
            )
            RETURNING
                id,
                full_name,
                phone,
                email,
                email_verified,
                must_change_password,
                school_id,
                role,
                status`,
            [
                fullName,
                phone,
                email,
                temporaryPassword,
                auth.schoolId
            ]
        );

        const dos = result.rows[0];

        /* =============================================
           COMMIT TRANSACTION
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        console.log(
            "DOS account created:",
            dos.id,
            "School:",
            auth.schoolId
        );

        /* =============================================
           SEND ACCOUNT SETUP INVITATION
        ============================================= */

        let invitationSent = false;

        try {

            const safeName = escapeHtml(fullName);
            const safeEmail = escapeHtml(email);

            await sendEmail(context, {

                to: email,

                subject: "Complete Your Fila Grades System Account Setup",

                html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;color:#222;">

                        <h2>Welcome to Fila Grades System</h2>

                        <p>Hello ${safeName},</p>

                        <p>
                            Your Director of Studies (DOS) account
                            has been created by your School Administrator.
                        </p>

                        <p>
                            To activate your account, verify your
                            email address and create your own password.
                        </p>

                        <p style="margin:30px 0;">
                            <a href="${ACCOUNT_SETUP_URL}"
                               style="background:#2563eb;color:white;padding:13px 22px;text-decoration:none;border-radius:6px;display:inline-block;">
                                Complete Account Setup
                            </a>
                        </p>

                        <p>
                            Use this email address when completing
                            your account setup:
                            <strong>${safeEmail}</strong>
                        </p>

                        <p>
                            If you were not expecting this account,
                            please contact your School Administrator.
                        </p>

                        <p>Fila Grades System</p>

                    </div>
                `,

                text: `
Welcome to Fila Grades System.

Hello ${fullName},

Your Director of Studies account has been created.

Complete your account setup, verify your email and create your own password here:

${ACCOUNT_SETUP_URL}

Use this email address: ${email}

Fila Grades System
                `
            });

            invitationSent = true;

        } catch (emailError) {

            console.error(
                "DOS setup invitation email error:",
                emailError
            );
        }

        /* =============================================
           RESPONSE
        ============================================= */

        return json({

            success: true,

            message: invitationSent
                ? "DOS account created successfully. An account setup invitation has been sent."
                : "DOS account created successfully, but the invitation email could not be sent. Share the setup link with the DOS.",

            setup_url: ACCOUNT_SETUP_URL,

            invitation_sent: invitationSent,

            dos

        }, 201);

    } catch (error) {

        if (client && transactionStarted) {

            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create DOS error:", error);

        if (error.code === "23505") {

            if (error.constraint === "one_dos_per_school") {
                return json({
                    success: false,
                    message: "A Director of Studies has already been registered for this school."
                }, 409);
            }

            return json({
                success: false,
                message: "The phone number, email address or DOS account is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create the DOS account. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}


/* =====================================================
   UPDATE SCHOOL DOS
===================================================== */

export async function onRequestPut(context) {

    const auth = await requireSchoolAdmin(context);

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not assigned to a school."
        }, 403);
    }

    let data;

    try {
        data = await context.request.json();
    } catch {
        return json({
            success: false,
            message: "Invalid JSON request."
        }, 400);
    }

    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const email = String(normalizeEmail(data.email) || "").trim();

    if (!fullName || !phone || !email) {
        return json({
            success: false,
            message: "Full name, phone number and email are required."
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        email.length > 254
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({
            success: false,
            message: "Enter a valid email address."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           FIND DOS BELONGING TO THIS SCHOOL
        ============================================= */

        const existing = await client.query(
            `SELECT
                id,
                email
             FROM users
             WHERE school_id = $1
               AND role = 'dos'
             LIMIT 1
             FOR UPDATE`,
            [auth.schoolId]
        );

        if (existing.rowCount === 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "No DOS account was found for your school."
            }, 404);
        }

        const dosId = existing.rows[0].id;

        const emailChanged =
            String(existing.rows[0].email || "").toLowerCase() !==
            email.toLowerCase();

        /* =============================================
           CHECK DUPLICATE PHONE
           EXCLUDE CURRENT DOS
        ============================================= */

        const duplicatePhone = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
               AND id <> $2
             LIMIT 1`,
            [phone, dosId]
        );

        if (duplicatePhone.rowCount > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered to another user."
            }, 409);
        }

        /* =============================================
           CHECK DUPLICATE EMAIL
           EXCLUDE CURRENT DOS
        ============================================= */

        const duplicateEmail = await client.query(
            `SELECT id
             FROM users
             WHERE LOWER(email) = LOWER($1)
               AND id <> $2
             LIMIT 1`,
            [email, dosId]
        );

        if (duplicateEmail.rowCount > 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This email address is already registered to another user."
            }, 409);
        }

        /* =============================================
           UPDATE DOS DETAILS

           - Keep role unchanged.
           - Keep school_id unchanged.
           - Keep password unchanged.
           - Keep account setup status unchanged.
           - Require email verification again if email changes.
        ============================================= */

        const result = await client.query(
            `UPDATE users
             SET
                full_name = $1,
                phone = $2,
                email = $3::varchar,
                email_verified = CASE
                    WHEN LOWER(COALESCE(email, '')) <> LOWER($3)
                    THEN FALSE
                    ELSE email_verified
                END
             WHERE id = $4
               AND school_id = $5
               AND role = 'dos'
             RETURNING
                id,
                full_name,
                phone,
                email,
                email_verified,
                must_change_password,
                school_id,
                role,
                status`,
            [
                fullName,
                phone,
                email,
                dosId,
                auth.schoolId
            ]
        );

        if (result.rowCount === 0) {

            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "The DOS account could not be updated."
            }, 404);
        }

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: emailChanged
                ? "DOS details updated successfully. The new email address must be verified."
                : "DOS details updated successfully.",
            dos: result.rows[0],
            email_changed: emailChanged
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Update DOS error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "The phone number or email address is already registered."
            }, 409);
        }

        return json({
    success: false,
    message: error.message || "Unknown database error.",
    code: error.code || null,
    detail: error.detail || null,
    constraint: error.constraint || null,
    table: error.table || null,
    column: error.column || null
}, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}

