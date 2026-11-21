
import {
    connectDB,
    authenticateRole,
    json
} from "../../_utils.js";

export async function onRequestPost(context) {
    const auth = await authenticateRole(
        context,
        ["school_admin", "dos"]
    );

    if (auth.error) return auth.error;

    if (!auth.schoolId) {
        return json({
            success: false,
            message: "Your account is not linked to a school."
        }, 403);
    }

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
             SET status = 'active'
             WHERE id = $1
               AND school_id = $2
               AND status = 'inactive'
             RETURNING id, full_name`,
            [studentId, auth.schoolId]
        );

        if (result.rowCount === 0) {
            return json({
                success: false,
                message: "Inactive student not found in your school."
            }, 404);
        }

        return json({
            success: true,
            message: "Student activated successfully.",
            student: result.rows[0]
        });

    } catch (error) {
        console.error("Activate student error:", error);

        return json({
            success: false,
            message: "Failed to activate student."
        }, 500);

    } finally {
        if (client) await client.end().catch(() => {});
    }
}
