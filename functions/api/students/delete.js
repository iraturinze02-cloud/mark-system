
import {
    connectDB,
    requireSchoolAdmin,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await requireSchoolAdmin(context);

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

    const studentId = Number(data.id);

    if (!Number.isSafeInteger(studentId) || studentId <= 0) {
        return json({
            success: false,
            message: "Invalid student ID."
        }, 400);
    }

    let client;

    try {
        client = await connectDB(context);

        const result = await client.query(
            `UPDATE students
             SET status = 'inactive'
             WHERE id = $1
               AND school_id = $2
               AND status = 'active'
             RETURNING id`,
            [studentId, auth.schoolId]
        );

        if (result.rowCount === 0) {
            return json({
                success: false,
                message: "Active student not found in your school."
            }, 404);
        }

        return json({
            success: true,
            message: "Student deactivated successfully."
        });

    } catch (error) {
        console.error("Deactivate student error:", error);

        return json({
            success: false,
            message: "Failed to deactivate student."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
