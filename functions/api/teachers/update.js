
import bcrypt from "bcryptjs";

import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

import {
    normalizeEmail,
    generateOtp,
    saveOtp,
    sendEmail,
    verificationEmail
} from "../../_email.js";


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

    const teacherId = String(data.id || "").trim();
    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const email = normalizeEmail(data.email);
    const password = String(data.password || "");
    const staffNumber =
        String(data.staff_number || "").trim() || null;


    // Validate teacher ID.

    if (!/^[1-9]\d*$/.test(teacherId)) {
        return json({
            success: false,
            message: "Invalid teacher ID."
        }, 400);
    }


    // Validate required fields.

    if (!fullName || !phone || !email) {
        return json({
            success: false,
            message: "Full name, phone number and email are required."
        }, 400);
    }


    // Validate field lengths.

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


    // Validate email format.

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({
            success: false,
            message: "Enter a valid email address."
        }, 400);
    }


    // Validate password if supplied.

    if (password && password.length < 8) {
        return json({
            success: false,
            message: "New password must contain at least 8 characters."
        }, 400);
    }


    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;


        // Confirm the teacher belongs to this school.
        // Lock the user row while updating.

        const teacherResult = await client.query(
            `SELECT
                t.id,
                t.user_id,
                u.email,
                u.email_verified
             FROM teachers t
             JOIN users u
               ON u.id = t.user_id
             WHERE t.id = $1
               AND t.school_id = $2
               AND u.school_id = $2
               AND u.role = 'teacher'
             FOR UPDATE OF t, u`,
            [teacherId, auth.schoolId]
        );

        if (teacherResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Teacher not found in your school."
            }, 404);
        }

        const teacher = teacherResult.rows[0];
        const userId = teacher.user_id;


        // Determine whether the email address has changed.

        const oldEmail = teacher.email
            ? normalizeEmail(teacher.email)
            : null;

        const emailChanged = oldEmail !== email;


        // Check duplicate phone number.

        const duplicatePhone = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
               AND id <> $2
             LIMIT 1`,
            [phone, userId]
        );

        if (duplicatePhone.rowCount > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }


        // Check duplicate email only when it changes.

        if (emailChanged) {
            const duplicateEmail = await client.query(
                `SELECT id
                 FROM users
                 WHERE LOWER(email) = LOWER($1)
                   AND id <> $2
                 LIMIT 1`,
                [email, userId]
            );

            if (duplicateEmail.rowCount > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This email address is already registered."
                }, 409);
            }
        }


        // Update teacher's account.

        let userResult;

        if (password) {
            const passwordHash = await bcrypt.hash(password, 12);

            userResult = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     email = $3,
                     email_verified = CASE
                         WHEN $4 THEN FALSE
                         ELSE email_verified
                     END,
                     password_hash = $5,
                     updated_at = NOW()
                 WHERE id = $6
                   AND school_id = $7
                   AND role = 'teacher'
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
                    emailChanged,
                    passwordHash,
                    userId,
                    auth.schoolId
                ]
            );

        } else {
            userResult = await client.query(
                `UPDATE users
                 SET full_name = $1,
                     phone = $2,
                     email = $3,
                     email_verified = CASE
                         WHEN $4 THEN FALSE
                         ELSE email_verified
                     END,
                     updated_at = NOW()
                 WHERE id = $5
                   AND school_id = $6
                   AND role = 'teacher'
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
                    emailChanged,
                    userId,
                    auth.schoolId
                ]
            );
        }


        // Update teacher profile.

        await client.query(
            `UPDATE teachers
             SET staff_number = $1
             WHERE id = $2
               AND school_id = $3`,
            [staffNumber, teacherId, auth.schoolId]
        );


        // If the email changed, generate and send a new OTP.

        if (emailChanged) {
            const otp = generateOtp();

            await saveOtp(client, userId, otp);

            const emailContent = verificationEmail(
                fullName,
                otp,
                email
            );

            await sendEmail(context, {
                to: email,
                subject: emailContent.subject,
                html: emailContent.html,
                text: emailContent.text
            });
        }


        // Commit all changes.

        await client.query("COMMIT");
        transactionStarted = false;


        return json({
            success: true,
            message: emailChanged
                ? "Teacher updated successfully. A new verification code has been sent to the new email address."
                : "Teacher updated successfully.",
            teacher: {
                id: teacherId,
                user_id: userId,
                full_name: userResult.rows[0].full_name,
                phone: userResult.rows[0].phone,
                email: userResult.rows[0].email,
                email_verified: userResult.rows[0].email_verified,
                staff_number: staffNumber
            }
        });


    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
        }

        console.error("Update teacher error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "The phone number, email address or staff number is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to update teacher."
        }, 500);


    } finally {
        if (client) await client.end().catch(() => {});
    }
}
