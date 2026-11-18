import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

import bcrypt from "bcryptjs";

import {
    normalizeEmail,
    generateOtp,
    saveOtp,
    sendEmail,
    verificationEmail
} from "../../_email.js";

/* =====================================================
   FILA GRADES SYSTEM
   OWNER USERS API

   GET  /api/owner/users
   POST /api/owner/users

   Roles:
   - sector_admin
   - school_admin
   - teacher

   Owner-created schools:
   - sector_id = NULL

   School Admin:
   - Find existing school by name
   - Create independent school if not found

   Teacher:
   - Must belong to an existing school
===================================================== */


/* =====================================================
   GET ALL USERS — OWNER ONLY
===================================================== */

export async function onRequestGet(context) {

    const auth = await requireOwner(context);

    if (auth.error) {
        return auth.error;
    }

    let db;

    try {

        db = await connectDB(context);

        const result = await db.query(`
            SELECT
                u.id,
                u.full_name,
                u.phone,
                u.email,
                u.role,
                u.sector_id,
                s.sector_name,
                s.sector_code,
                u.school_id,
                sch.school_name,
                u.status,
                u.email_verified,
                u.must_change_password,
                u.created_at,
                u.updated_at

            FROM users u

            LEFT JOIN sectors s
                ON s.id = u.sector_id

            LEFT JOIN schools sch
                ON sch.id = u.school_id

            ORDER BY u.id DESC
        `);

        return json({
            success: true,
            users: result.rows
        });

    } catch (error) {

        console.error("OWNER USERS GET ERROR:", error);

        return json({
            success: false,
            message: "Failed to retrieve user accounts."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}


/* =====================================================
   POST: CREATE USER ACCOUNT — OWNER ONLY
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) {
        return auth.error;
    }

    let db;
    let transactionStarted = false;

    try {

        const body = await context.request.json();

        /* ---------------------------------------------
           BASIC INPUT
        --------------------------------------------- */

        const full_name = String(body.full_name || "").trim();
        const phone = String(body.phone || "").trim();
        const email = normalizeEmail(body.email);
        const role = String(body.role || "").trim();

        if (!full_name) {
            return json({
                success: false,
                message: "Full name is required."
            }, 400);
        }

        if (!phone) {
            return json({
                success: false,
                message: "Phone number is required."
            }, 400);
        }

        if (!email) {
            return json({
                success: false,
                message: "A valid email address is required."
            }, 400);
        }

        const allowedRoles = [
            "sector_admin",
            "school_admin",
            "teacher"
        ];

        if (!allowedRoles.includes(role)) {
            return json({
                success: false,
                message: "Invalid account role."
            }, 400);
        }

        /* ---------------------------------------------
           ROLE-SPECIFIC INPUT
        --------------------------------------------- */

        const sector_code = role === "sector_admin"
            ? String(body.sector_code || "").trim()
            : null;

        const school_name = role === "school_admin"
            ? String(body.school_name || "").trim()
            : null;

        const school_id = role === "teacher"
            ? Number(body.school_id)
            : null;

        if (role === "sector_admin" && !sector_code) {
            return json({
                success: false,
                message: "Sector code is required."
            }, 400);
        }

        if (role === "school_admin" && !school_name) {
            return json({
                success: false,
                message: "School name is required."
            }, 400);
        }

        if (
            role === "teacher" &&
            (!school_id || !Number.isInteger(school_id))
        ) {
            return json({
                success: false,
                message: "Please select a valid school."
            }, 400);
        }

        /* ---------------------------------------------
           CONNECT DATABASE
        --------------------------------------------- */

        db = await connectDB(context);

        await db.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           CHECK DUPLICATE PHONE
        --------------------------------------------- */

        const duplicatePhone = await db.query(`
            SELECT id
            FROM users
            WHERE phone = $1
            LIMIT 1
        `, [phone]);

        if (duplicatePhone.rows.length > 0) {

            await db.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        /* ---------------------------------------------
           CHECK DUPLICATE EMAIL
        --------------------------------------------- */

        const duplicateEmail = await db.query(`
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
        `, [email]);

        if (duplicateEmail.rows.length > 0) {

            await db.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This email address is already registered."
            }, 409);
        }

        /* ---------------------------------------------
           ASSIGN SECTOR
        --------------------------------------------- */

        let assignedSectorId = null;

        if (role === "sector_admin") {

            const sectorResult = await db.query(`
                SELECT
                    id,
                    sector_name,
                    sector_code
                FROM sectors
                WHERE UPPER(TRIM(sector_code)) = UPPER(TRIM($1))
                LIMIT 1
            `, [sector_code]);

            if (sectorResult.rows.length === 0) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The sector code was not found."
                }, 404);
            }

            assignedSectorId = sectorResult.rows[0].id;
        }

        /* ---------------------------------------------
           ASSIGN SCHOOL
        --------------------------------------------- */

        let assignedSchoolId = null;
        let schoolCreated = false;

        if (role === "school_admin") {

            /*
               First search for an existing school.

               Matching is case-insensitive and ignores
               leading/trailing spaces.
            */

            const existingSchool = await db.query(`
                SELECT
                    id,
                    school_name,
                    sector_id,
                    status
                FROM schools
                WHERE LOWER(TRIM(school_name)) =
                      LOWER(TRIM($1))
                ORDER BY id ASC
                LIMIT 1
                FOR UPDATE
            `, [school_name]);

            if (existingSchool.rows.length > 0) {

                const school = existingSchool.rows[0];

                if (
                    String(school.status || "").toLowerCase()
                    !== "active"
                ) {

                    await db.query("ROLLBACK");
                    transactionStarted = false;

                    return json({
                        success: false,
                        message: "The existing school is inactive. Activate it before creating its School Admin."
                    }, 400);
                }

                assignedSchoolId = school.id;

            } else {

                /*
                   Create a new independent school.

                   IMPORTANT:
                   sector_id is explicitly NULL.
                */

                const newSchool = await db.query(`
                    INSERT INTO schools (
                        school_name,
                        school_code,
                        school_type,
                        location,
                        phone,
                        email,
                        sector_id,
                        status,
                        created_at
                    )
                    VALUES (
                        $1,
                        NULL,
                        NULL,
                        NULL,
                        NULL,
                        NULL,
                        NULL,
                        'active',
                        NOW()
                    )
                    RETURNING id, school_name, sector_id
                `, [school_name]);

                assignedSchoolId =
                    newSchool.rows[0].id;

                schoolCreated = true;
            }
        }

        /* ---------------------------------------------
           TEACHER SCHOOL VALIDATION
        --------------------------------------------- */

        if (role === "teacher") {

            const schoolResult = await db.query(`
                SELECT
                    id,
                    school_name,
                    sector_id,
                    status
                FROM schools
                WHERE id = $1
                LIMIT 1
            `, [school_id]);

            if (schoolResult.rows.length === 0) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The selected school was not found."
                }, 404);
            }

            const selectedSchool = schoolResult.rows[0];

            if (
                String(selectedSchool.status || "").toLowerCase()
                !== "active"
            ) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "The selected school is inactive."
                }, 400);
            }

            assignedSchoolId = selectedSchool.id;

            /*
               Teachers inherit the sector from
               their selected school.
            */

            assignedSectorId =
                selectedSchool.sector_id || null;
        }

        /* ---------------------------------------------
           GENERATE TEMPORARY RANDOM PASSWORD

           The user must change this password after
           completing the verification process.

           The password is never sent by email.
        --------------------------------------------- */

        const randomBytes = new Uint8Array(32);

        crypto.getRandomValues(randomBytes);

        const temporaryPassword = Array.from(randomBytes)
            .map(byte => byte.toString(16).padStart(2, "0"))
            .join("");

        const passwordHash = await bcrypt.hash(
            temporaryPassword,
            12
        );

        /* ---------------------------------------------
           CREATE USER
        --------------------------------------------- */

        const userResult = await db.query(`
            INSERT INTO users (
                full_name,
                phone,
                email,
                password_hash,
                role,
                sector_id,
                school_id,
                status,
                email_verified,
                must_change_password,
                created_at,
                updated_at
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                'active',
                FALSE,
                TRUE,
                NOW(),
                NOW()
            )
            RETURNING
                id,
                full_name,
                phone,
                email,
                role,
                sector_id,
                school_id,
                status,
                email_verified,
                must_change_password,
                created_at
        `, [
            full_name,
            phone,
            email,
            passwordHash,
            role,
            assignedSectorId,
            assignedSchoolId
        ]);

        const newUser = userResult.rows[0];

        /* ---------------------------------------------
           CREATE TEACHER PROFILE
        --------------------------------------------- */

        if (role === "teacher") {

            await db.query(`
                INSERT INTO teachers (
                    user_id,
                    school_id,
                    created_at
                )
                VALUES (
                    $1,
                    $2,
                    NOW()
                )
            `, [
                newUser.id,
                assignedSchoolId
            ]);
        }

        /* ---------------------------------------------
           GENERATE AND SAVE OTP
        --------------------------------------------- */

        const otp = generateOtp();

        await saveOtp(
            db,
            newUser.id,
            otp
        );

        /* ---------------------------------------------
           COMMIT TRANSACTION
        --------------------------------------------- */

        await db.query("COMMIT");
        transactionStarted = false;

        /* ---------------------------------------------
           SEND VERIFICATION EMAIL

           Email is sent AFTER database commit.
        --------------------------------------------- */

        let emailSent = false;
        let emailError = null;

        try {

            const emailContent = verificationEmail(
                full_name,
                otp,
                email
            );

            await sendEmail(context, {
                to: email,
                subject: emailContent.subject,
                html: emailContent.html,
                text: emailContent.text
            });

            emailSent = true;

        } catch (error) {

            console.error(
                "OWNER USER VERIFICATION EMAIL ERROR:",
                error
            );

            emailError =
                "The account was created, but the verification email could not be sent.";
        }

        /* ---------------------------------------------
           SUCCESS RESPONSE
        --------------------------------------------- */

        return json({
            success: true,
            message: emailSent
                ? "Account created successfully. Verification email sent."
                : "Account created successfully, but the verification email could not be sent.",
            user: newUser,
            school_created: schoolCreated,
            email_sent: emailSent,
            email_error: emailError
        }, 201);

    } catch (error) {

        if (db && transactionStarted) {
            await db.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("OWNER CREATE USER ERROR:", error);

        /* ---------------------------------------------
           DATABASE UNIQUE CONSTRAINTS
        --------------------------------------------- */

        if (error.code === "23505") {

            const constraint = String(
                error.constraint || ""
            ).toLowerCase();

            if (constraint.includes("phone")) {
                return json({
                    success: false,
                    message: "This phone number is already registered."
                }, 409);
            }

            if (constraint.includes("email")) {
                return json({
                    success: false,
                    message: "This email address is already registered."
                }, 409);
            }

            if (constraint.includes("staff_number")) {
                return json({
                    success: false,
                    message: "A teacher staff-number conflict occurred."
                }, 409);
            }

            return json({
                success: false,
                message: "A duplicate record already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create user account."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}
