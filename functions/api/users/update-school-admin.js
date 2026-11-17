
import {
    connectDB,
    json,
    requireSectorAdmin
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
   SYNCHRONIZE SCHOOL EDUCATION LEVELS
===================================================== */

async function syncSchoolLevels(client, schoolId, levelIds) {

    await client.query(
        `DELETE FROM school_levels
         WHERE school_id = $1
           AND NOT (level_id = ANY($2::bigint[]))`,
        [schoolId, levelIds]
    );

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
   UPDATE SCHOOL ADMIN
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
            message: "Invalid request data."
        }, 400);
    }

    const id = String(data.id || "").trim();
    const fullName = String(data.full_name || "").trim();
    const phone = String(data.phone || "").trim();
    const schoolName = String(data.school_name || "").trim();

    const levelValidation = validateLevelIds(data.level_ids);

    if (levelValidation.error) {
        return json({
            success: false,
            message: levelValidation.error
        }, 400);
    }

    const selectedLevelIds = levelValidation.levelIds;

    /* =============================================
       VALIDATE ADMINISTRATOR DETAILS
    ============================================= */

    if (
        !id ||
        !/^\d+$/.test(id) ||
        !fullName ||
        !phone ||
        !schoolName
    ) {
        return json({
            success: false,
            message: "Please provide valid administrator details."
        }, 400);
    }

    if (
        fullName.length > 200 ||
        schoolName.length > 200 ||
        phone.length > 30
    ) {
        return json({
            success: false,
            message: "One or more fields exceed the allowed length."
        }, 400);
    }

    let client;
    let transactionStarted = false;

    try {

        client = await connectDB(context);

        await client.query("BEGIN");
        transactionStarted = true;

        /* =============================================
           VERIFY SCHOOL ADMIN BELONGS TO THIS SECTOR
        ============================================= */

        const adminResult = await client.query(
            `SELECT u.id, u.school_id
             FROM users u
             INNER JOIN schools s
                ON s.id = u.school_id
             WHERE u.id = $1
               AND u.role = 'school_admin'
               AND s.sector_id = $2
             FOR UPDATE OF u`,
            [id, auth.sectorId]
        );

        if (adminResult.rows.length === 0) {
            await client.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "School administrator not found in your sector."
            }, 404);
        }

        /* =============================================
           CHECK DUPLICATE PHONE NUMBER
        ============================================= */

        const duplicate = await client.query(
            `SELECT id
             FROM users
             WHERE phone = $1
               AND id <> $2
             LIMIT 1`,
            [phone, id]
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
           FIND OR CREATE SCHOOL
        ============================================= */

        const lockKey =
            `${auth.sectorId}:${schoolName.toLowerCase()}`;

        await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1))",
            [lockKey]
        );

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
                [auth.sectorId, schoolName, schoolCode]
            );

            schoolId = newSchool.rows[0].id;
        }

        /* =============================================
           UPDATE SCHOOL EDUCATION LEVELS
        ============================================= */

        await syncSchoolLevels(
            client,
            schoolId,
            selectedLevelIds
        );

        /* =============================================
           UPDATE SCHOOL ADMINISTRATOR

           Password is not changed here.
        ============================================= */

        const result = await client.query(
            `UPDATE users
             SET full_name = $1,
                 phone = $2,
                 school_id = $3,
                 updated_at = NOW()
             WHERE id = $4
             RETURNING
                id,
                full_name,
                phone,
                school_id`,
            [
                fullName,
                phone,
                schoolId,
                id
            ]
        );

        /* =============================================
           COMMIT TRANSACTION
        ============================================= */

        await client.query("COMMIT");
        transactionStarted = false;

        return json({
            success: true,
            message: "School administrator and school education levels updated successfully.",
            admin: result.rows[0]
        });

    } catch (error) {

        if (client && transactionStarted) {
            await client.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("Update school admin error:", error);

        if (error.code === "P0001") {
            return json({
                success: false,
                message: "One or more education levels cannot be removed because existing school records still depend on them."
            }, 409);
        }

        if (error.code === "23505") {
            return json({
                success: false,
                message: "This phone number or school code is already registered."
            }, 409);
        }

        return json({
            success: false,
            message: "Could not update the school administrator and education levels."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }
    }
}
