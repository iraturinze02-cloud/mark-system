
import { connectDB, json, requireOwner } from "../../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM
   OWNER UPDATE SCHOOL

   POST /api/owner/schools/update

   Updates:
   - school_name
   - school_code
   - school_type
   - location
   - phone
   - email
   - education levels

   sector_id is NEVER modified.
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
   POST: UPDATE SCHOOL
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    let db;
    let transactionStarted = false;

    try {

        const body = await context.request.json();

        const id = Number(body.id);

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

        if (!Number.isInteger(id) || id <= 0) {

            return json({
                success: false,
                message: "Invalid school ID."
            }, 400);
        }

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
           CHECK SCHOOL EXISTS
        --------------------------------------------- */

        const existing = await db.query(`
            SELECT id, sector_id
            FROM schools
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
        `, [id]);

        if (existing.rows.length === 0) {

            await db.query("ROLLBACK");
            transactionStarted = false;

            return json({
                success: false,
                message: "School not found."
            }, 404);
        }

        /* ---------------------------------------------
           CHECK DUPLICATE SCHOOL CODE
        --------------------------------------------- */

        if (school_code) {

            const duplicate = await db.query(`
                SELECT id
                FROM schools
                WHERE LOWER(school_code) = LOWER($1)
                  AND id <> $2
                LIMIT 1
            `, [school_code, id]);

            if (duplicate.rows.length > 0) {

                await db.query("ROLLBACK");
                transactionStarted = false;

                return json({
                    success: false,
                    message: "This school code is already used by another school."
                }, 409);
            }
        }

        /* ---------------------------------------------
           VALIDATE EDUCATION LEVELS
        --------------------------------------------- */

        const levelsResult = await db.query(`
            SELECT id, level_name
            FROM education_levels
            WHERE id = ANY($1::bigint[])
            ORDER BY id
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
           UPDATE SCHOOL DETAILS

           sector_id is deliberately NOT changed.
        --------------------------------------------- */

        const schoolResult = await db.query(`
            UPDATE schools
            SET
                school_name = $1,
                school_code = $2,
                school_type = $3,
                location = $4,
                phone = $5,
                email = $6
            WHERE id = $7
            RETURNING *
        `, [
            school_name,
            school_code,
            school_type,
            location,
            phone,
            email,
            id
        ]);

        /* ---------------------------------------------
           REPLACE EDUCATION LEVELS

           Delete old selections, then insert the
           newly selected levels.
        --------------------------------------------- */

        await db.query(`
            DELETE FROM school_levels
            WHERE school_id = $1
        `, [id]);

        for (const level_id of level_ids) {

            await db.query(`
                INSERT INTO school_levels (
                    school_id,
                    level_id
                )
                VALUES ($1, $2)
            `, [
                id,
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
            message: "School updated successfully.",
            school: {
                ...schoolResult.rows[0],
                level_ids,
                levels: levelsResult.rows
            }
        });

    } catch (error) {

        if (db && transactionStarted) {
            await db.query("ROLLBACK").catch(() => {});
            transactionStarted = false;
        }

        console.error("OWNER UPDATE SCHOOL ERROR:", error);

        if (error.code === "23505") {

            return json({
                success: false,
                message: "A school with these details already exists."
            }, 409);
        }

        return json({
            success: false,
            message: "Failed to update school."
        }, 500);

    } finally {

        if (db) {
            await db.end().catch(() => {});
        }
    }
}
