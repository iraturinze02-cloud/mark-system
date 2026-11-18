import {
    connectDB,
    json,
    requireOwner
} from "../../_utils.js";

/* =====================================================
   GET ALL USERS — OWNER ONLY
   FILA GRADES SYSTEM
===================================================== */

export async function onRequestGet(context) {
    const auth = await requireOwner(context);

    if (auth.error) {
        return auth.error;
    }

    try {
        const db = await connectDB(context);

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
        console.error("OWNER USERS ERROR:", error);

        return json({
            success: false,
            message: "Failed to retrieve user accounts."
        }, 500);
    }
}
