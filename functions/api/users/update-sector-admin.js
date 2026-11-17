import bcrypt from "bcryptjs";

import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

import {
    normalizeEmail,
    generateOtp,
    saveOtp,
    sendEmail,
    verificationEmail
} from "../../_email.js";

export async function onRequestPost(context) {
    const auth = await requireOwner(context);
    if (auth.error) return auth.error;

    let client;
    let transactionStarted = false;

    try {
        const data = await context.request.json();

        const sectorId = data.sectorId;
        const adminId = data.adminId;

        const sectorName = String(data.sectorName || "").trim();
        const sectorCode = String(data.sectorCode || "")
            .trim()
            .toUpperCase();

        const location = String(data.location || "").trim() || null;

        const fullName = String(
            data.fullName || data.adminName || ""
        ).trim();

        const email = normalizeEmail(data.email);
        const phone = String(data.phone || "").trim();
        const password = String(data.password || "");

        /* =============================================
           VALIDATION
        ============================================= */

        if (
            !sectorId ||
            !adminId ||
            !sectorName ||
            !sectorCode ||
            !fullName ||
            !email ||
            !phone
        ) {
            return json({
                success: false,
                message: "Please complete all required fields, including a valid email address."
            }, 400);
        }

        if (password && password.length < 8) {
            return json({
                success: false,
                message: "New password must contain at least 8 characters."
            }, 400);
        }

        if (
            sectorName.length > 200 ||
            sectorCode.length > 30 ||
            fullName.length > 200 ||
            phone.length > 30
        ) {
            return json({
                success: false,
                message: "One or more fields exceed the allowed length."
            }, 400);
        }

        const passwordHash = password
            ? await bcrypt.hash(password, 12)
            : null;

        /* =============================================
           CONNECT AND START TRANSACTION
        ============================================= */

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           FIND EXISTING ADMINISTRATOR
        ============================================= */

        const existingResult = await client.query(`
            SELECT id, email, email_verified
            FROM users
            WHERE id = $1
              AND sector_id = $2
              AND role = 'sector_admin'
            LIMIT 1
        `, [adminId, sectorId]);

        if (existingResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Sector administrator not found."
            }, 404);
        }

        const existingAdmin = existingResult.rows[0];

        const emailChanged =
            String(existingAdmin.email || "").toLowerCase() !== email;

        /* =============================================
           CHECK EMAIL AVAILABILITY IF CHANGED
        ============================================= */

        if (emailChanged) {
            const emailCheck = await client.query(`
                SELECT id
                FROM users
                WHERE LOWER(email) = LOWER($1)
                  AND id <> $2
                LIMIT 1
            `, [email, adminId]);

            if (emailCheck.rowCount > 0) {
                await client.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This email address is already registered."
                }, 409);
            }
        }

        /* =============================================
           UPDATE SECTOR
        ============================================= */

        const sectorResult = await client.query(`
            UPDATE sectors
            SET
                sector_name = $1,
                sector_code = $2,
                location = $3
            WHERE id = $4
            RETURNING id
        `, [sectorName, sectorCode, location, sectorId]);

        if (sectorResult.rowCount === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "Sector not found."
            }, 404);
        }

        /* =============================================
           UPDATE ADMINISTRATOR
        ============================================= */

        await client.query(`
            UPDATE users
            SET
                full_name = $1,
                email = $2,
                email_verified = CASE
                    WHEN $3 = TRUE THEN FALSE
                    ELSE email_verified
                END,
                phone = $4,
                password_hash = COALESCE($5, password_hash),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6
              AND sector_id = $7
              AND role = 'sector_admin'
        `, [
            fullName,
            email,
            emailChanged,
            phone,
            passwordHash,
            adminId,
            sectorId
        ]);

        /* =============================================
           SEND NEW VERIFICATION CODE IF EMAIL CHANGED
        ============================================= */

        if (emailChanged) {
            const otp = generateOtp();

            await saveOtp(client, adminId, otp);

            const emailContent = verificationEmail(fullName, otp);

            await sendEmail(context, {
                to: email,
                subject: emailContent.subject,
                html: emailContent.html,
                text: emailContent.text
            });
        }

        /* =============================================
           COMMIT
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: emailChanged
                ? "Administrator updated. A new verification code has been sent to the new email address."
                : "Sector and administrator updated successfully.",
            emailChanged
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("Update sector administrator error:", error);

        if (error.code === "23505") {
            return json({
                success: false,
                message: "That sector code, phone number, or email address is already in use."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not update the sector administrator."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
