
import bcrypt from "bcryptjs";

import {
    connectDB,
    requireSectorAdmin,
    json
} from "../../_utils.js";

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
    const password = String(data.password || "");
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
    if (!password) missing.push("password");
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
        schoolName.length > 200
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    if (password.length < 8) {
        return json({
            success: false,
            message: "Password must contain at least 8 characters."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {
        client = await connectDB(context);

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
           SAVE SCHOOL EDUCATION LEVELS

           Existing levels are preserved.
           Missing selected levels are added.
        ============================================= */

        await ensureSchoolLevels(
            client,
            schoolId,
            selectedLevelIds
        );

        /* =============================================
           CHECK DUPLICATE PHONE NUMBER
        ============================================= */

        const duplicate = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
             LIMIT 1`,
            [phone]
        );

        if (duplicate.rows.length > 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "This phone number is already registered."
            }, 409);
        }

        /* =============================================
           HASH PASSWORD
        ============================================= */

        const passwordHash = await bcrypt.hash(password, 12);

        /* =============================================
           CREATE SCHOOL ADMINISTRATOR
        ============================================= */

        const result = await client.query(
            `INSERT INTO users (
                full_name,
                phone,
                password_hash,
                role,
                school_id,
                status
            )
            VALUES ($1, $2, $3, 'school_admin', $4, 'active')
            RETURNING id, full_name, phone, school_id, role`,
            [
                fullName,
                phone,
                passwordHash,
                schoolId
            ]
        );

        /* =============================================
           COMMIT TRANSACTION
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "School administrator created successfully.",
            admin: {
                ...result.rows[0],
                school_name: schoolName
            }
        }, 201);

    } catch (error) {
        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error(
            "Create school administrator error:",
            error
        );

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or school code is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create school administrator."
        }, 500);

    } finally {
        if (client) {
            await client.end().catch(() => {});
        }
    }
}
