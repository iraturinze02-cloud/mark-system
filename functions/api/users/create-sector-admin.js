
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

/* =====================================================
   CREATE SECTOR AND SECTOR ADMINISTRATOR
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

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

        const sectorName =
            String(data.sector_name || "").trim();

        const sectorCode =
            String(data.sector_code || "")
                .trim()
                .toUpperCase();

        const fullName =
            String(data.full_name || "").trim();

        const email =
            normalizeEmail(data.email);

        const phone =
            String(data.phone || "").trim();

        /* =============================================
           VALIDATION
        ============================================= */

        if (
            !sectorName ||
            !sectorCode ||
            !fullName ||
            !email ||
            !phone
        ) {
            return json({
                success: false,
                message: "Please complete all required fields with a valid email address."
            }, 400);
        }

        if (
            sectorName.length > 200 ||
            sectorCode.length > 30 ||
            fullName.length > 200 ||
            email.length > 254 ||
            phone.length > 30
        ) {
            return json({
                success: false,
                message: "One or more fields exceed the allowed length."
            }, 400);
        }

        const emailPattern =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(email)) {
            return json({
                success: false,
                message: "Please enter a valid email address."
            }, 400);
        }

        /* =============================================
           GENERATE INTERNAL RANDOM CREDENTIAL
        ============================================= */

        const randomBytes = new Uint8Array(32);

        crypto.getRandomValues(randomBytes);

        const temporaryCredential =
            Array.from(randomBytes)
                .map(byte => byte.toString(16).padStart(2, "0"))
                .join("");

        /* =============================================
           CONNECT TO DATABASE
        ============================================= */

        client = await connectDB(context);

        await client.query("BEGIN");

        transactionStarted = true;

        /* =============================================
           CHECK EMAIL AVAILABILITY
        ============================================= */

        const emailCheck = await client.query(
            `SELECT id
             FROM users
             WHERE LOWER(email) = LOWER($1)
             LIMIT 1`,
            [email]
        );

        if (emailCheck.rows.length > 0) {

            await client.query("ROLLBACK");

            transactionStarted = false;

            return json({
                success: false,
                message: "This email address is already registered."
            }, 409);
        }

        /* =============================================
           CHECK SECTOR CODE AVAILABILITY
        ============================================= */

        const sectorCheck = await client.query(
            `SELECT id
             FROM sectors
             WHERE UPPER(sector_code) = UPPER($1)
             LIMIT 1`,
            [sectorCode]
        );

        if (sectorCheck.rows.length > 0) {

            await client.query("ROLLBACK");

            transactionStarted = false;

            return json({
                success: false,
                message: "This sector code is already registered."
            }, 409);
        }

        /* =============================================
           CREATE SECTOR
        ============================================= */

        const sectorResult = await client.query(
            `INSERT INTO sectors (
                sector_name,
                sector_code,
                status
            )
            VALUES ($1, $2, 'active')
            RETURNING id, sector_name, sector_code`,
            [
                sectorName,
                sectorCode
            ]
        );

        const sectorId =
            sectorResult.rows[0].id;

        /* =============================================
           CREATE SECTOR ADMINISTRATOR

           email_verified = FALSE
           must_change_password = TRUE
        ============================================= */

        const adminResult = await client.query(
            `INSERT INTO users (
                full_name,
                email,
                email_verified,
                phone,
                password_hash,
                must_change_password,
                role,
                sector_id,
                school_id,
                status
            )
            VALUES (
                $1,
                $2,
                FALSE,
                $3,
                $4,
                TRUE,
                'sector_admin',
                $5,
                NULL,
                'active'
            )
            RETURNING
                id,
                full_name,
                email,
                email_verified,
                phone,
                sector_id`,
            [
                fullName,
                email,
                phone,
                temporaryCredential,
                sectorId
            ]
        );

        const admin = adminResult.rows[0];

        /* =============================================
           GENERATE AND SAVE OTP
        ============================================= */

        const otp = generateOtp();

        await saveOtp(
            client,
            admin.id,
            otp
        );

        /* =============================================
           PREPARE VERIFICATION EMAIL
        ============================================= */

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

        /* =============================================
           COMMIT TRANSACTION
        ============================================= */

        await client.query("COMMIT");

        transactionStarted = false;

        return json({
            success: true,
            message: "Sector and administrator created successfully. A verification email has been sent to the administrator.",
            sector: sectorResult.rows[0],
            admin
        }, 201);

    } catch (error) {

        if (client && transactionStarted) {

            await client.query("ROLLBACK").catch(() => {});

            transactionStarted = false;
        }

        console.error("Create sector error:", error);

        if (error.code === "23505") {

            if (
                error.constraint === "users_email_unique_idx"
            ) {
                return json({
                    success: false,
                    message: "This email address is already registered."
                }, 409);
            }

            return json({
                success: false,
                message: "Sector code or phone number already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not register sector and administrator. Please try again."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
