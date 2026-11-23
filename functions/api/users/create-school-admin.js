
import {
    connectDB,
    requireSectorAdmin,
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
   EDUCATION LEVEL HELPERS
===================================================== */

const EDUCATION_LEVELS = {
    1: "Primary",
    2: "Ordinary Level",
    3: "Advanced Level"
};

function validateLevelIds(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return {
            error: "Please select at least one education level for this school."
        };
    }

    const levelIds = [
        ...new Set(
            value.map(item => {
                if (
                    typeof item !== "number" &&
                    !(
                        typeof item === "string" &&
                        /^\d+$/.test(item.trim())
                    )
                ) {
                    return NaN;
                }

                return Number(item);
            })
        )
    ];

    const invalid = levelIds.filter(
        levelId =>
            !Number.isSafeInteger(levelId) ||
            !Object.prototype.hasOwnProperty.call(
                EDUCATION_LEVELS,
                levelId
            )
    );

    if (invalid.length > 0) {
        return {
            error: "One or more selected education levels are invalid."
        };
    }

    return { levelIds };
}

/* =====================================================
   GENERATE INTERNAL TEMPORARY PASSWORD
===================================================== */

function generateTemporaryPassword() {
    const randomBytes = crypto.getRandomValues(
        new Uint8Array(32)
    );

    return Array.from(randomBytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

/* =====================================================
   SCHOOL EDUCATION LEVELS
===================================================== */

async function ensureSchoolLevels(client, schoolId, levelIds) {
    for (const levelId of levelIds) {
        await client.query(
            `INSERT INTO school_levels (
                school_id,
                level_id
            )
            VALUES ($1, $2)
            ON CONFLICT (school_id, level_id) DO NOTHING`,
            [schoolId, levelId]
        );
    }
}

/* =====================================================
   AUTOMATIC SCHOOL ACADEMIC CALENDAR SETUP

   - Uses an existing school's shared calendar.
   - Creates school-specific academic-year IDs.
   - Creates terms using the new academic-year IDs.
   - Does not overwrite existing calendar records.
   - Can complete missing records for an existing school.
===================================================== */

async function ensureSchoolAcademicCalendar(client, schoolId) {

    /* =============================================
       FIND THE MOST COMPLETE EXISTING CALENDAR
    ============================================= */

    const templateResult = await client.query(
        `SELECT ay.school_id
         FROM academic_years ay
         GROUP BY ay.school_id
         ORDER BY
            COUNT(DISTINCT ay.id) DESC,
            (
                SELECT COUNT(*)
                FROM terms t
                WHERE t.school_id = ay.school_id
            ) DESC,
            ay.school_id ASC
         LIMIT 1`
    );

    if (templateResult.rows.length === 0) {
        throw new Error(
            "No existing academic calendar is available to initialize this school."
        );
    }

    const templateSchoolId = templateResult.rows[0].school_id;

    /* =============================================
       LOAD TEMPLATE ACADEMIC YEARS AND TERMS
    ============================================= */

    const calendarResult = await client.query(
        `SELECT
            ay.id AS source_year_id,
            ay.year_name,
            ay.start_date AS year_start_date,
            ay.end_date AS year_end_date,
            ay.status AS year_status,

            t.term_number,
            t.term_name,
            t.start_date AS term_start_date,
            t.end_date AS term_end_date

         FROM academic_years ay

         LEFT JOIN terms t
            ON t.academic_year_id = ay.id
           AND t.school_id = ay.school_id

         WHERE ay.school_id = $1

         ORDER BY
            ay.start_date ASC NULLS LAST,
            ay.id ASC,
            t.term_number ASC`,
        [templateSchoolId]
    );

    if (calendarResult.rows.length === 0) {
        throw new Error(
            "The existing academic calendar contains no academic years."
        );
    }

    /* =============================================
       CREATE ACADEMIC YEARS AND THEIR TERMS
    ============================================= */

    const yearIdMap = new Map();

    for (const row of calendarResult.rows) {

        const sourceYearKey = String(row.source_year_id);

        let newYearId = yearIdMap.get(sourceYearKey);

        /* =========================================
           CREATE OR FIND THE SCHOOL'S ACADEMIC YEAR
        ========================================= */

        if (!newYearId) {

            const existingYear = await client.query(
                `SELECT id
                 FROM academic_years
                 WHERE school_id = $1
                   AND year_name = $2
                 LIMIT 1`,
                [
                    schoolId,
                    row.year_name
                ]
            );

            if (existingYear.rows.length > 0) {

                newYearId = existingYear.rows[0].id;

            } else {

                const insertedYear = await client.query(
                    `INSERT INTO academic_years (
                        school_id,
                        year_name,
                        start_date,
                        end_date,
                        status
                    )
                    VALUES ($1, $2, $3, $4, $5)
                    RETURNING id`,
                    [
                        schoolId,
                        row.year_name,
                        row.year_start_date,
                        row.year_end_date,
                        row.year_status
                    ]
                );

                newYearId = insertedYear.rows[0].id;
            }

            yearIdMap.set(sourceYearKey, newYearId);
        }

        /* =========================================
           CREATE OR FIND EACH CORRESPONDING TERM
        ========================================= */

        if (row.term_number !== null) {

            const existingTerm = await client.query(
                `SELECT id
                 FROM terms
                 WHERE school_id = $1
                   AND academic_year_id = $2
                   AND term_number = $3
                 LIMIT 1`,
                [
                    schoolId,
                    newYearId,
                    row.term_number
                ]
            );

            if (existingTerm.rows.length === 0) {

                await client.query(
                    `INSERT INTO terms (
                        school_id,
                        academic_year_id,
                        term_number,
                        term_name,
                        start_date,
                        end_date
                    )
                    VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        schoolId,
                        newYearId,
                        row.term_number,
                        row.term_name,
                        row.term_start_date,
                        row.term_end_date
                    ]
                );
            }
        }
    }

    /* =============================================
       VERIFY THAT THE SCHOOL HAS A COMPLETE COPY
    ============================================= */

    const verification = await client.query(
        `SELECT
            COUNT(DISTINCT ay.id)::int AS academic_year_count,
            COUNT(DISTINCT t.id)::int AS term_count

         FROM academic_years ay

         LEFT JOIN terms t
            ON t.academic_year_id = ay.id
           AND t.school_id = ay.school_id

         WHERE ay.school_id = $1`,
        [schoolId]
    );

    if (
        Number(verification.rows[0].academic_year_count) === 0 ||
        Number(verification.rows[0].term_count) === 0
    ) {
        throw new Error(
            "Academic years and terms could not be initialized for this school."
        );
    }

    console.log(
        "School academic calendar initialized:",
        schoolId,
        verification.rows[0]
    );
}

/* =====================================================
   CREATE SCHOOL ADMIN
===================================================== */

export async function onRequestPost(context) {
    const auth = await requireSectorAdmin(context);

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
    const schoolName = String(data.school_name || "").trim();

    /* =============================================
       VALIDATE EDUCATION LEVELS
    ============================================= */

    const levelValidation = validateLevelIds(data.level_ids);

    if (levelValidation.error) {
        return json({
            success: false,
            message: levelValidation.error
        }, 400);
    }

    const selectedLevelIds = levelValidation.levelIds;

    /* =============================================
       VALIDATE REQUIRED FIELDS
    ============================================= */

    const missing = [];

    if (!fullName) missing.push("full_name");
    if (!phone) missing.push("phone");
    if (!email) missing.push("email");
    if (!schoolName) missing.push("school_name");

    if (missing.length > 0) {
        return json({
            success: false,
            message: "Please complete all required fields.",
            missing
        }, 400);
    }

    if (
        fullName.length > 200 ||
        phone.length > 30 ||
        email.length > 254 ||
        schoolName.length > 200
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({
            success: false,
            message: "Please enter a valid email address."
        }, 400);
    }

    let client;
    let transactionStarted = false;
    let admin;

    try {
        client = await connectDB(context);

        /* =============================================
           START DATABASE TRANSACTION
        ============================================= */

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           PREVENT DUPLICATE SCHOOL CREATION
        ============================================= */

        const lockKey =
            `${auth.sectorId}:${schoolName.toLowerCase()}`;

        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

        /* =============================================
           FIND EXISTING SCHOOL
        ============================================= */

        const schoolResult = await client.query(
            `SELECT id
             FROM schools
             WHERE sector_id = $1
               AND LOWER(TRIM(school_name)) = LOWER(TRIM($2))
             LIMIT 1`,
            [auth.sectorId, schoolName]
        );

        let schoolId;

        if (schoolResult.rows.length > 0) {

            schoolId = schoolResult.rows[0].id;

        } else {

            /* =========================================
               CREATE NEW SCHOOL
            ========================================= */

            const schoolCode =
                `SCH-${Date.now()}-${crypto.randomUUID()
                    .slice(0, 8).toUpperCase()}`;

            const newSchool = await client.query(
                `INSERT INTO schools (
                    sector_id,
                    school_name,
                    school_code,
                    status
                )
                VALUES ($1, $2, $3, 'active')
                RETURNING id`,
                [
                    auth.sectorId,
                    schoolName,
                    schoolCode
                ]
            );

            schoolId = newSchool.rows[0].id;
        }

        /* =============================================
           AUTOMATICALLY SET UP ACADEMIC YEARS AND TERMS
        ============================================= */

        await ensureSchoolAcademicCalendar(
            client,
            schoolId
        );

        /* =============================================
           SAVE SCHOOL EDUCATION LEVELS
        ============================================= */

        await ensureSchoolLevels(
            client,
            schoolId,
            selectedLevelIds
        );

        /* =============================================
           CHECK DUPLICATE PHONE NUMBER
        ============================================= */

        const duplicatePhone = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
             LIMIT 1`,
            [phone]
        );

        if (duplicatePhone.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        /* =============================================
           CHECK DUPLICATE EMAIL ADDRESS
        ============================================= */

        const duplicateEmail = await client.query(
            `SELECT id
             FROM users
             WHERE LOWER(email) = LOWER($1)
             LIMIT 1`,
            [email]
        );

        if (duplicateEmail.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This email address is already registered."
            }, 409);
        }

        /* =============================================
           GENERATE INTERNAL TEMPORARY PASSWORD
        ============================================= */

        const temporaryPassword =
            generateTemporaryPassword();

        /* =============================================
           CREATE SCHOOL ADMINISTRATOR
        ============================================= */

        const result = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                email,
                email_verified,
                password_hash,
                must_change_password,
                role,
                school_id,
                status
            )
            VALUES (
                $1,
                $2,
                $3,
                FALSE,
                $4,
                TRUE,
                'school_admin',
                $5,
                'active'
            )
            RETURNING
                id,
                full_name,
                phone,
                email,
                email_verified,
                must_change_password,
                school_id,
                role`,
            [
                fullName,
                phone,
                email,
                temporaryPassword,
                schoolId
            ]
        );

        admin = result.rows[0];

        /* =============================================
           GENERATE AND SAVE EMAIL VERIFICATION OTP
        ============================================= */

        const otp = generateOtp();

        await saveOtp(
            client,
            admin.id,
            otp
        );

        /* =============================================
           COMMIT DATABASE TRANSACTION
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        console.log(
            "School administrator account created:",
            admin.id
        );

        /* =============================================
           SEND VERIFICATION EMAIL
        ============================================= */

        const emailContent = verificationEmail(
            fullName,
            otp,
            email
        );

        try {
            const emailResult = await sendEmail(context, {
                to: email,
                subject: emailContent.subject,
                html: emailContent.html,
                text: emailContent.text
            });

            console.log(
                "School administrator verification email sent:",
                emailResult
            );

            return json({
                success: true,
                email_sent: true,
                message: "School administrator created successfully. A verification code has been sent to the administrator's email address.",
                admin: {
                    ...admin,
                    school_name: schoolName
                }
            }, 201);

        } catch (emailError) {
            console.error(
                "School administrator email delivery failed:",
                emailError
            );

            return json({
                success: true,
                email_sent: false,
                message: "The school administrator account was created successfully, but the verification email could not be sent. Please check the email configuration and resend the verification email.",
                admin: {
                    ...admin,
                    school_name: schoolName
                }
            }, 201);
        }

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error(
            "Create school administrator database error:",
            error
        );

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or email address is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create school administrator. Please check the server logs for details."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
