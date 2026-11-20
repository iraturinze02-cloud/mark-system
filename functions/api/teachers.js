
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../_utils.js";

import {
    normalizeEmail,
    sendEmail
} from "../_email.js";

/* =====================================================
   ACCOUNT SETUP PAGE
===================================================== */

const ACCOUNT_SETUP_URL =
    "https://www.filagrades.online/pages/auth/complete-account-setup.html";

/* =====================================================
   GET TEACHERS
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireSchoolAdmin(context);
    if (auth.error) return auth.error;

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `SELECT
                t.id,
                t.user_id,
                t.staff_number,
                u.full_name,
                u.phone,
                u.email,
                u.email_verified,
                u.status,

                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'assignment_id', ta.id,
                                'class_id', c.id,
                                'class_name', c.class_name,
                                'subject_id', s.id,
                                'subject_name', s.subject_name
                            )
                            ORDER BY c.class_name, s.subject_name
                        )
                        FROM teacher_assignments ta
                        JOIN classes c
                          ON c.id = ta.class_id
                        JOIN school_levels sl
                          ON sl.school_id = ta.school_id
                         AND sl.level_id = c.level_id
                        JOIN subjects s
                          ON s.id = ta.subject_id
                        WHERE ta.teacher_id = t.id
                          AND ta.school_id = $1
                    ),
                    '[]'::json
                ) AS assignments

             FROM teachers t

             JOIN users u
               ON u.id = t.user_id

             WHERE t.school_id = $1
               AND u.school_id = $1
               AND u.role = 'teacher'

             ORDER BY u.full_name ASC`,
            [auth.schoolId]
        );

        return json({
            success: true,
            teachers: result.rows
        });

    } catch (error) {
        console.error("Load teachers error:", error);

        return json({
            success: false,
            message: "Failed to load teachers."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}

/* =====================================================
   CREATE TEACHER
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireSchoolAdmin(context);
    if (auth.error) return auth.error;

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
    const email = normalizeEmail(data.email);

    const staffNumber =
        String(data.staff_number || "").trim() || null;

    /* ================================================
       VALIDATION
    ================================================ */

    if (!fullName || !phone || !email) {
        return json({
            success: false,
            message: "Full name, phone number and email are required."
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        email.length > 254 ||
        (staffNumber && staffNumber.length > 50)
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

        /* ============================================
           CHECK DUPLICATE PHONE
        ============================================ */

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

        /* ============================================
           CHECK DUPLICATE EMAIL
        ============================================ */

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

        /* ============================================
           CREATE TEMPORARY PASSWORD VALUE

           The teacher will replace this through
           the Complete Account Setup workflow.
        ============================================ */

        const temporaryPassword =
            `PENDING_SETUP_${crypto.randomUUID()}`;

        /* ============================================
           CREATE USER ACCOUNT

           must_change_password = TRUE ensures that
           the account setup workflow can identify
           this account as awaiting password creation.
        ============================================ */

        const userResult = await client.query(
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
                $1, $2, $3, FALSE, $4,
                'teacher', $5, 'active', TRUE
            )
            RETURNING
                id,
                full_name,
                phone,
                email,
                email_verified`,
            [
                fullName,
                phone,
                email,
                temporaryPassword,
                auth.schoolId
            ]
        );

        const user = userResult.rows[0];

        /* ============================================
           CREATE TEACHER PROFILE
        ============================================ */

        const teacherResult = await client.query(
            `INSERT INTO teachers (
                user_id,
                school_id,
                staff_number
            )
            VALUES ($1, $2, $3)
            RETURNING id, user_id, staff_number`,
            [
                user.id,
                auth.schoolId,
                staffNumber
            ]
        );

        /* ============================================
           COMMIT TRANSACTION
        ============================================ */

        await client.query("COMMIT");
        transactionStarted = false;

        /* ============================================
           SEND ACCOUNT SETUP INVITATION

           OTP is NOT generated here.
           The existing account setup page handles
           OTP generation, verification and password
           creation.
        ============================================ */

        let invitationSent = false;

        try {
            await sendEmail(context, {
                to: email,
                subject: "Complete Your Fila Grades System Account Setup",
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;padding:25px;color:#222;">
                        <h2>Welcome to Fila Grades System</h2>

                        <p>Hello ${fullName},</p>

                        <p>
                            Your teacher account has been created
                            by your school administrator.
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
                            <strong>${email}</strong>
                        </p>

                        <p>
                            If you were not expecting this account,
                            please contact your school administrator.
                        </p>

                        <p>Fila Grades System</p>
                    </div>
                `,
                text: `
Welcome to Fila Grades System.

Hello ${fullName},

Your teacher account has been created.

Complete your account setup, verify your email and create your own password here:

${ACCOUNT_SETUP_URL}

Use this email address: ${email}

Fila Grades System
                `
            });

            invitationSent = true;

        } catch (emailError) {
            console.error(
                "Teacher setup invitation email error:",
                emailError
            );
        }

        /* ============================================
           RESPONSE
        ============================================ */

        return json({
            success: true,
            message: invitationSent
                ? "Teacher created successfully. An account setup invitation has been sent."
                : "Teacher created successfully, but the invitation email could not be sent. Share the setup link with the teacher.",
            setup_url: ACCOUNT_SETUP_URL,
            invitation_sent: invitationSent,
            teacher: {
                ...teacherResult.rows[0],
                full_name: user.full_name,
                phone: user.phone,
                email: user.email,
                email_verified: user.email_verified,
                assignments: []
            }
        }, 201);

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Create teacher error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "The phone number, email address or staff number is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create teacher. Please try again."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
