
import { connectDB, json, requireOwner } from "../../_utils.js";

/* =====================================================
   OWNER SCHOOL STATUS

   POST /api/owner/schools/status

   Body:
   {
       "id": 1,
       "status": "active"
   }

   Allowed:
   active
   inactive
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    try {

        const body = await context.request.json();

        const id = Number(body.id);

        const status = String(body.status || "").trim().toLowerCase();

        /* VALIDATE ID */

        if (!Number.isInteger(id) || id <= 0) {

            return json({
                success: false,
                message: "Invalid school ID."
            }, 400);
        }

        /* VALIDATE STATUS */

        if (!["active", "inactive"].includes(status)) {

            return json({
                success: false,
                message: "Status must be active or inactive."
            }, 400);
        }

        const db = await connectDB(context);

        /* CHECK SCHOOL EXISTS */

        const existing = await db.query(`
            SELECT id, school_name, status
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

        /* UPDATE STATUS */

        const result = await db.query(`
            UPDATE schools
            SET status = $1
            WHERE id = $2
            RETURNING id, school_name, status
        `, [status, id]);

        return json({
            success: true,
            message: `School ${status === "active" ? "activated" : "deactivated"} successfully.`,
            school: result.rows[0]
        });

    } catch (error) {

        console.error("OWNER SCHOOL STATUS ERROR:", error);

        return json({
            success: false,
            message: "Failed to change school status."
        }, 500);
    }
}
