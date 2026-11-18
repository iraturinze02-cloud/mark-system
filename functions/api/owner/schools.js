
import { connectDB, json, requireOwner } from "../../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM
   OWNER SCHOOLS API

   GET  /api/owner/schools
   POST /api/owner/schools

   Owner-created schools:
   - sector_id = NULL
   - Education levels stored in school_levels
===================================================== */


/* =====================================================
   HELPER: VALIDATE EDUCATION LEVEL IDS
===================================================== */

function parseLevelIds(value) {

    if (!Array.isArray(value)) {
        return null;
    }

    const ids = [...new Set(
        value.map(Number)
    )];

    if (
        ids.length === 0 ||
        ids.some(id =>
            !Number.isInteger(id) || id <= 0
        )
    ) {
        return null;
    }

    return ids;
}


/* =====================================================
   GET: ALL SCHOOLS
===================================================== */

export async function onRequestGet(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let db;

    try {

        db = await connectDB(context);

        const result = await db.query(`
            SELECT
                s.id,
                s.school_name,
                s.school_code,
                s.school_type,
                s.location,
                s.phone,
                s.email,
                s.sector_id,
                s.status,
                s.created_at,

                sec.sector_name,
                sec.sector_code,

                COALESCE(
                    (
                        SELECT JSON_AGG(
                            sl.level_id
                            ORDER BY sl.level_id
                        )
                        FROM school_levels sl
                        WHERE sl.school_id = s.id
                    ),
                    '[]'::json
                ) AS level_ids,

                COALESCE(
                    (
                        SELECT JSON_AGG(
                            JSON_BUILD_OBJECT(
                                'id', el.id,
                                'level_name', el.level_name
                            )
                            ORDER BY el.id
                        )
                        FROM school_levels sl
                        JOIN education_levels el
                            ON el.id = sl.level_id
                        WHERE sl.school_id = s.id
                    ),
                    '[]'::json
                ) AS levels

            FROM schools s

            LEFT JOIN sectors sec
                ON sec.id = s.sector_id

            ORDER BY s.id DESC
        `);

        return json({
            success: true,
            schools: result.rows
        });

    } catch (error) {

        console.error("OWNER GET SCHOOLS ERROR:", error);

        return json({
            success: false,
            message: "Failed to retrieve schools."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}


/* =====================================================
   POST: CREATE SCHOOL
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let db;
    let transactionStarted = false;

    try {

        const body = await context.request.json();

        const school_name =
            String(body.school_name || "").trim();

        const school_code = body.school_code
            ? String(body.school_code).trim()
            : null;

        const school_type = body.school_type
            ? String(body.school_type).trim()
            : null;

        const location = body.location
            ? String(body.location).trim()
            : null;

        const phone = body.phone
            ? String(body.phone).trim()
            : null;

        const email = body.email
            ? String(body.email).trim().toLowerCase()
            : null;

        const level_ids = parseLevelIds(body.level_ids);

        /* ---------------------------------------------
           VALIDATION
        --------------------------------------------- */

        if (!school_name) {

            return json({
                success: false,
                message: "School name is required."
            }, 400);
        }

        if (!level_ids) {

            return json({
                success: false,
                message: "Please select at least one education level."
            }, 400);
        }

        /* ---------------------------------------------
           CONNECT DATABASE
        --------------------------------------------- */

        db = await connectDB(context);

        await db.query("BEGIN");
        transactionStarted = true;

        /* ---------------------------------------------
           CHECK DUPLICATE SCHOOL CODE
        --------------------------------------------- */

        if (school_code) {

            const duplicate = await db.query(`
                SELECT id
                FROM schools
                WHERE LOWER(school_code) = LOWER($1)
                LIMIT 1
            `, [school_code]);

            if (duplicate.rows.length > 0) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This school code already exists."
                }, 409);
            }
        }

        /* ---------------------------------------------
           VALIDATE EDUCATION LEVELS
        --------------------------------------------- */

        const levelsResult = await db.query(`
            SELECT id
            FROM education_levels
            WHERE id = ANY($1::bigint[])
        `, [level_ids]);

        if (levelsResult.rows.length !== level_ids.length) {

            await db.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "One or more selected education levels are invalid."
            }, 400);
        }

        /* ---------------------------------------------
           CREATE INDEPENDENT SCHOOL

           sector_id is ALWAYS NULL.
        --------------------------------------------- */

        const schoolResult = await db.query(`
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
                $1, $2, $3, $4, $5, $6,
                NULL,
                'active',
                NOW()
            )
            RETURNING *
        `, [
            school_name,
            school_code,
            school_type,
            location,
            phone,
            email
        ]);

        const school = schoolResult.rows[0];

        /* ---------------------------------------------
           SAVE EDUCATION LEVELS
        --------------------------------------------- */

        for (const level_id of level_ids) {

            await db.query(`
                INSERT INTO school_levels (
                    school_id,
                    level_id
                )
                VALUES ($1, $2)
            `, [
                school.id,
                level_id
            ]);
        }

        /* ---------------------------------------------
           COMMIT
        --------------------------------------------- */

        await db.query("COMMIT");
        transactionStarted = false;

        /* ---------------------------------------------
           SUCCESS
        --------------------------------------------- */

        return json({
            success: true,
            message: "School created successfully.",
            school: {
                ...school,
                level_ids,
                levels: levelsResult.rows
            }
        }, 201);

    } catch (error) {

        if (db && transactionStarted) {
            await db.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("OWNER CREATE SCHOOL ERROR:", error);

        if (error.code === "23505") {

            return json({
                success: false,
                message: "A school with these details already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to create school."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}
