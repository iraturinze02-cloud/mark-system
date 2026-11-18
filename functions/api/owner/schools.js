
import { connectDB, json, requireOwner } from "../../_utils.js";

/* =====================================================
   FILA GRADES SYSTEM
   OWNER SCHOOLS API

   GET  /api/owner/schools
   POST /api/owner/schools

   Owner-created schools are independent:
   sector_id = NULL
===================================================== */


/* =====================================================
   GET: ALL SCHOOLS
===================================================== */

export async function onRequestGet(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    try {

        const db = await connectDB(context);

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
                sec.sector_code

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
    }
}


/* =====================================================
   POST: CREATE SCHOOL

   Owner-created schools NEVER belong to a sector.

   sector_id is always NULL regardless of request data.
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    try {

        const body = await context.request.json();

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

        /* REQUIRED FIELD */

        if (!school_name) {

            return json({
                success: false,
                message: "School name is required."
            }, 400);
        }

        /* CHECK DUPLICATE SCHOOL CODE */

        const db = await connectDB(context);

        if (school_code) {

            const duplicate = await db.query(`
                SELECT id
                FROM schools
                WHERE LOWER(school_code) = LOWER($1)
                LIMIT 1
            `, [school_code]);

            if (duplicate.rows.length > 0) {

                return json({
                    success: false,
                    message: "This school code already exists."
                }, 409);
            }
        }

        /* CREATE INDEPENDENT SCHOOL */

        const result = await db.query(`
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

        return json({
            success: true,
            message: "School created successfully.",
            school: result.rows[0]
        }, 201);

    } catch (error) {

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
    }
}
