
import { connectDB, json, requireOwner } from "../../../_utils.js";

/* =====================================================
   OWNER UPDATE SCHOOL

   POST /api/owner/schools/update

   Editable:
   - school_name
   - school_code
   - school_type
   - location
   - phone
   - email

   sector_id is NEVER modified.
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    try {

        const body = await context.request.json();

        const id = Number(body.id);

        const school_name = String(body.school_name || "").trim();

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

        const db = await connectDB(context);

        /* CHECK SCHOOL EXISTS */

        const existing = await db.query(`
            SELECT id, sector_id
            FROM schools
            WHERE id = $1
            LIMIT 1
        `, [id]);

        if (existing.rows.length === 0) {
            return json({
                success: false,
                message: "School not found."
            }, 404);
        }

        /* CHECK DUPLICATE CODE */

        if (school_code) {

            const duplicate = await db.query(`
                SELECT id
                FROM schools
                WHERE LOWER(school_code) = LOWER($1)
                  AND id <> $2
                LIMIT 1
            `, [school_code, id]);

            if (duplicate.rows.length > 0) {
                return json({
                    success: false,
                    message: "This school code is already used by another school."
                }, 409);
            }
        }

        /* UPDATE SCHOOL
           sector_id is deliberately excluded.
        */

        const result = await db.query(`
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

        return json({
            success: true,
            message: "School updated successfully.",
            school: result.rows[0]
        });

    } catch (error) {

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
    }
}
