import { connectDB, json, requireOwner } from "../../../_utils.js";

/* =====================================================
   OWNER SCHOOL STATUS

   POST /api/owner/schools/status
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireOwner(context);

    if (auth.error) return auth.error;

    try {

        const body = await context.request.json();

        const id = Number(body.id);
        const status = String(body.status || "").trim().toLowerCase();

        // VALIDATE ID
        if (!Number.isInteger(id) || id <= 0) {
            return json({
                success: false,
                message: "Invalid school ID."
            }, 400);
        }

        // VALIDATE STATUS
        if (!["active", "inactive"].includes(status)) {
            return json({
                success: false,
                message: "Invalid status."
            }, 400);
        }

        const db = await connectDB(context);

        // UPDATE AND RETURN THE ACTUAL DATABASE RECORD
        const result = await db.query(`
            UPDATE schools
            SET status = $1
            WHERE id = $2
            RETURNING id, school_name, school_code, status
        `, [status, id]);

        // VERIFY UPDATE
        if (result.rows.length === 0) {

            return json({
                success: false,
                message: "School not found or status was not updated.",
                schoolId: id
            }, 404);
        }

        const updatedSchool = result.rows[0];

        // CONFIRM DATABASE STATUS
        if (updatedSchool.status !== status) {

            return json({
                success: false,
                message: "Database status verification failed.",
                school: updatedSchool
            }, 500);
        }

        return json({
            success: true,
            message: `School ${status === "active" ? "activated" : "deactivated"} successfully.`,
            school: updatedSchool
        });

    } catch (error) {

        console.error("OWNER SCHOOL STATUS ERROR:", error);

        return json({
            success: false,
            message: error.message || "Failed to change school status."
        }, 500);
    }
}
