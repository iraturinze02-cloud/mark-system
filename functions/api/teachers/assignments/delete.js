
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../../_utils.js";

/* =====================================================
   DELETE TEACHER ASSIGNMENT

   Supports:
   1. Base-class default assignments.
   2. Subclass-specific assignments.

   Deletes only the selected assignment belonging
   to the authenticated school.
===================================================== */

export async function onRequestPost(context) {

    const auth = await requireSchoolAdmin(context);

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

    /* =================================================
       VALIDATE ASSIGNMENT ID
    ================================================= */

    const assignmentId = Number(data.assignment_id);

    if (
        !Number.isSafeInteger(assignmentId) ||
        assignmentId <= 0
    ) {
        return json({
            success: false,
            message: "Invalid assignment ID."
        }, 400);
    }

    let client;

    try {

        client = await connectDB(context);

        /* =============================================
           DELETE ASSIGNMENT

           The school_id condition prevents an
           administrator from deleting assignments
           belonging to another school.

           RETURNING provides information about the
           deleted assignment.
        ============================================= */

        const result = await client.query(
            `DELETE FROM teacher_assignments ta

             WHERE ta.id = $1
               AND ta.school_id = $2

             RETURNING
                ta.id AS assignment_id,
                ta.teacher_id,
                ta.class_id,
                ta.subject_id,
                ta.academic_year_id,
                ta.term_id,
                ta.subclass_id`,
            [
                assignmentId,
                auth.schoolId
            ]
        );

        /* =============================================
           CHECK WHETHER ASSIGNMENT EXISTED
        ============================================= */

        if (result.rowCount === 0) {

            return json({
                success: false,
                message: "Assignment not found."
            }, 404);

        }

        const assignment = result.rows[0];

        /* =============================================
           SUCCESS RESPONSE
        ============================================= */

        return json({
            success: true,
            message: assignment.subclass_id
                ? "Subclass-specific assignment removed successfully."
                : "Default class assignment removed successfully.",

            assignment: {
                ...assignment,

                assignment_type: assignment.subclass_id
                    ? "subclass"
                    : "default"
            }
        });

    } catch (error) {

        console.error("Delete assignment error:", {
            message: error?.message,
            code: error?.code,
            detail: error?.detail,
            constraint: error?.constraint,
            stack: error?.stack
        });

        return json({
            success: false,
            message: "Failed to remove assignment."
        }, 500);

    } finally {

        if (client) {
            await client.end().catch(() => {});
        }

    }
}
