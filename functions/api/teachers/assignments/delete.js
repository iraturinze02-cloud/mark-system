
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../../_utils.js";

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

    const assignmentId = Number(data.assignment_id);

    if (!Number.isSafeInteger(assignmentId) || assignmentId <= 0) {
        return json({
            success: false,
            message: "Invalid assignment ID."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `DELETE FROM teacher_assignments
             WHERE id = $1
               AND school_id = $2
             RETURNING id`,
            [assignmentId, auth.schoolId]
        );

        if (result.rowCount === 0) {
            return json({
                success: false,
                message: "Assignment not found."
            }, 404);
        }

        return json({
            success: true,
            message: "Assignment removed successfully."
        });

    } catch (error) {
        console.error("Delete assignment error:", error);

        return json({
            success: false,
            message: "Failed to remove assignment."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
